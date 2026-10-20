import { randomUUID } from "node:crypto";
import type { PaymentAttempt, PaymentIntent, PaymentSubjectType, PrismaClient, ProviderConnection } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import { PAYMENT_PROVIDER_IDS, assertProviderAllowedForPurpose, type PaymentProviderId } from "../paymentPurpose.js";
import {
  CapabilityError, ProviderRejectedError, ProviderUnavailableError, requireCapability, type AdapterRegistry,
} from "../../payments/adapter.js";
import { ACTIVE_ATTEMPT_STATUSES, PROVIDER_UNAVAILABLE_MESSAGE, PaymentsError, circuitOpen, nextPollDelayMs, noteProviderFailure, noteProviderSuccess, recordAttemptEvent } from "./common.js";
import { describeSubject } from "./subjects.js";
import { simulatedPaymentsAllowed } from "../store/common.js";

// ------------------------------------------------------------------------------------ connections

const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]{2,60}$/;

/**
 * Registers one merchant's own arrangement with one provider. Only a provider the purpose policy allows for MERCHANT_SALE can be
 * connected, so pawaPay and Flutterwave (subscription money) are refused here, in code. No secret is accepted: `credentialRef` is the
 * NAME of a server-side secret. Secrets are never requested through WhatsApp or any merchant-facing surface.
 */
export async function registerConnection(
  prisma: PrismaClient,
  input: { businessId: string; provider: string; arrangementRef: string; destinationKey: string; destinationLabel: string; credentialRef?: string; createdBy?: string },
): Promise<ProviderConnection> {
  if (!(PAYMENT_PROVIDER_IDS as readonly string[]).includes(input.provider)) throw new PaymentsError("UNKNOWN_PROVIDER", `'${input.provider}' is not a known provider.`);
  assertProviderAllowedForPurpose(input.provider as PaymentProviderId, "MERCHANT_SALE");
  if (input.provider === "simulator" && !simulatedPaymentsAllowed()) throw new PaymentsError("SIMULATOR_DISABLED", "The simulator is not available in this environment.");
  if (input.credentialRef !== undefined && !CREDENTIAL_REF.test(input.credentialRef)) throw new PaymentsError("INVALID", "credentialRef must be the NAME of a server-side secret (for example ORANGE_MERCHANT_KEY), never the secret itself.");
  for (const [k, v] of [["arrangementRef", input.arrangementRef], ["destinationKey", input.destinationKey], ["destinationLabel", input.destinationLabel]] as const) {
    if (!v.trim() || v.length > 100) throw new PaymentsError("INVALID", `${k} is required (up to 100 characters).`);
  }
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const existing = await scoped.providerConnection.findFirst({ where: { provider: input.provider } });
  if (existing) throw new PaymentsError("DUPLICATE", "This business already has a connection to that provider.");
  return scoped.providerConnection.create({
    data: { businessId: input.businessId, provider: input.provider, arrangementRef: input.arrangementRef.trim(), destinationKey: input.destinationKey.trim(), destinationLabel: input.destinationLabel.trim(), credentialRef: input.credentialRef ?? null, createdBy: input.createdBy ?? null },
  });
}

/** Development and CI only: gives a business a simulator connection so a test checkout works. Refused whenever the simulator is not allowed. */
export async function ensureSimulatorConnection(prisma: PrismaClient, businessId: string): Promise<ProviderConnection> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const existing = await scoped.providerConnection.findFirst({ where: { provider: "simulator" } });
  if (existing) return existing;
  return registerConnection(prisma, { businessId, provider: "simulator", arrangementRef: "SIMULATOR", destinationKey: `sim-dest-${businessId.slice(0, 8)}`, destinationLabel: "Simulated wallet (no real money)" });
}

// ------------------------------------------------------------------------------------ intents

export async function createPaymentIntent(
  prisma: PrismaClient,
  /** `amountMinor` asks to pay part of what is owing (an invoice paid in instalments); it can never exceed what is owing. */
  input: { businessId: string; subjectType: PaymentSubjectType; subjectId: string; amountMinor?: bigint; now?: Date },
): Promise<PaymentIntent> {
  const now = input.now ?? new Date();
  const info = await describeSubject(prisma, input.businessId, input.subjectType, input.subjectId, now);
  const amount = input.amountMinor ?? info.owedMinor;
  if (amount <= 0n || amount > info.owedMinor) throw new PaymentsError("INVALID", "That is not an amount this can be paid.");
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const idempotencyKey = `intent:${input.subjectType}:${input.subjectId}:${info.owedMinor}:${amount}`;
  const found = await scoped.paymentIntent.findFirst({ where: { idempotencyKey } });
  if (found) return found;
  await scoped.paymentIntent.createMany({
    data: [{ businessId: input.businessId, subjectType: input.subjectType, subjectId: input.subjectId, reference: info.reference, amountMinor: amount, currencyCode: info.currencyCode, idempotencyKey, expiresAt: info.expiresAt }],
    skipDuplicates: true,
  });
  return scoped.paymentIntent.findFirstOrThrow({ where: { idempotencyKey } });
}

export { closeIntentsForSubject } from "./close.js";

// ------------------------------------------------------------------------------------ attempts

export interface StartedAttempt {
  attempt: PaymentAttempt;
  /** True when an active attempt already existed and is returned as is (a double click, a page reload). */
  reused: boolean;
}

/**
 * Starts (or returns) the one active collection attempt for an intent.
 *  - Provider acceptance is PENDING, never paid.
 *  - Only one attempt per intent may be active (a partial unique index enforces it): a retry, a second tab or a "fallback" cannot
 *    create a second collection while the first may still complete. An attempt whose outcome is UNKNOWN blocks until it is resolved.
 *  - A provider that is down (circuit open) is refused up front with a plain message; reconciling existing attempts is unaffected.
 */
export async function startPaymentAttempt(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  input: { businessId: string; intentId: string; provider: string; now?: Date },
): Promise<StartedAttempt> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const intent = await scoped.paymentIntent.findUnique({ where: { id: input.intentId } });
  if (!intent) throw new PaymentsError("NOT_FOUND", "No such payment request.");
  if (intent.status !== "OPEN" || intent.expiresAt <= now) throw new PaymentsError("INTENT_CLOSED", "This payment request has closed. Please ask the seller for a new one.");

  const adapter = registry.get(input.provider);
  const connection = await scoped.providerConnection.findFirst({ where: { provider: input.provider, status: "ACTIVE" } });
  if (!adapter || !connection) throw new PaymentsError("NO_CONNECTION", "Online payment is not set up for this seller.");
  requireCapability(adapter, "createPayment");

  const active = await scoped.paymentAttempt.findFirst({ where: { intentId: intent.id, status: { in: [...ACTIVE_ATTEMPT_STATUSES] } }, orderBy: { createdAt: "desc" } });
  if (active) {
    if (active.status === "UNKNOWN") throw new PaymentsError("ATTEMPT_UNRESOLVED", "A previous payment request may still complete. Please wait a few minutes before trying again.", { attemptId: active.id });
    return { attempt: active, reused: true };
  }
  if (circuitOpen(connection, now)) throw new PaymentsError("PROVIDER_UNAVAILABLE", PROVIDER_UNAVAILABLE_MESSAGE);

  // the subject may have changed since the intent was made (partly paid, expired): stale amounts are never sent to a provider
  const info = await describeSubject(prisma, input.businessId, intent.subjectType, intent.subjectId, now);
  if (info.owedMinor < intent.amountMinor) {
    await scoped.paymentIntent.updateMany({ where: { id: intent.id, status: "OPEN" }, data: { status: "CANCELLED" } });
    throw new PaymentsError("AMOUNT_CHANGED", "The amount owing has changed. Please start the payment again.");
  }

  const prior = await scoped.paymentAttempt.count({ where: { intentId: intent.id } });
  const attemptId = randomUUID();
  const created = await scoped.paymentAttempt.createMany({
    data: [{ id: attemptId, businessId: input.businessId, intentId: intent.id, connectionId: connection.id, provider: input.provider, amountMinor: intent.amountMinor, currencyCode: intent.currencyCode, idempotencyKey: `attempt:${intent.id}:${prior}`, expiresAt: intent.expiresAt }],
    skipDuplicates: true,
  });
  if (created.count !== 1) {
    const raced = await scoped.paymentAttempt.findFirst({ where: { intentId: intent.id, status: { in: [...ACTIVE_ATTEMPT_STATUSES] } } });
    if (raced) return { attempt: raced, reused: true };
    throw new PaymentsError("ATTEMPT_ACTIVE", "A payment is already being set up. Please wait a moment.");
  }
  await recordAttemptEvent(scoped, input.businessId, attemptId, null, "CREATED", "CREATE");

  try {
    const result = await adapter.createPayment({
      merchantReference: attemptId, amountMinor: intent.amountMinor, currencyCode: intent.currencyCode, destinationKey: connection.destinationKey,
      description: `Order ${intent.reference}`, expiresAt: intent.expiresAt, idempotencyKey: `attempt:${attemptId}`,
    });
    await scoped.paymentAttempt.updateMany({ where: { id: attemptId, status: "CREATED" }, data: { status: "PENDING", externalRef: result.externalRef, checkoutUrl: result.checkoutUrl, nextPollAt: new Date(now.getTime() + nextPollDelayMs(0)) } });
    await recordAttemptEvent(scoped, input.businessId, attemptId, "CREATED", "PENDING", "CREATE", { externalRef: result.externalRef });
    await noteProviderSuccess(prisma, connection, now);
  } catch (error) {
    if (error instanceof ProviderRejectedError) {
      await scoped.paymentAttempt.updateMany({ where: { id: attemptId, status: "CREATED" }, data: { status: "FAILED", failureReason: error.message.slice(0, 200) } });
      await recordAttemptEvent(scoped, input.businessId, attemptId, "CREATED", "FAILED", "CREATE", { reason: error.message });
      throw new PaymentsError("PROVIDER_REJECTED", `The payment provider refused the request: ${error.message}`);
    }
    if (error instanceof CapabilityError) {
      await scoped.paymentAttempt.updateMany({ where: { id: attemptId, status: "CREATED" }, data: { status: "FAILED", failureReason: "capability unsupported" } });
      throw error;
    }
    // Could not tell whether the provider created it: it MAY collect, so it is UNKNOWN (blocks a second attempt) and reconciled by polling.
    await scoped.paymentAttempt.updateMany({ where: { id: attemptId, status: "CREATED" }, data: { status: "UNKNOWN", nextPollAt: new Date(now.getTime() + nextPollDelayMs(0)), failureReason: "No answer from the provider." } });
    await recordAttemptEvent(scoped, input.businessId, attemptId, "CREATED", "UNKNOWN", "CREATE", { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof ProviderUnavailableError) {
      await noteProviderFailure(prisma, connection, now);
      throw new PaymentsError("PAYMENT_UNCONFIRMED", "We could not confirm that your payment request was sent. Please wait a few minutes before trying again; if you were asked to pay, the order will update by itself.", { attemptId });
    }
    throw error;
  }
  return { attempt: await scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } }), reused: false };
}
