import type { CallbackInbox, PaymentAttempt, PaymentIntent, PrismaClient, ProviderConnection } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import { ProviderUnavailableError, type AdapterRegistry, type NormalizedEvent, type ProviderAdapter, type ProviderPaymentSnapshot } from "../../payments/adapter.js";
import { recordCallback } from "../callbackInbox.js";
import { MAX_POLLS, PaymentsError, nextPollDelayMs, noteProviderFailure, noteProviderSuccess, raiseProviderException, recordAttemptEvent, reviveEvent, serializeEvent, ACTIVE_ATTEMPT_STATUSES } from "./common.js";
import { applyToSubject } from "./subjects.js";
import { applyRefundOutcome, pollRefunds } from "./refunds.js";
import { recordSettlementReport } from "./settlements.js";

/**
 * The one place a provider's word about a payment is turned into business effects. Everything that can tell us a payment's state
 * (a signed callback, a status poll, an admin refresh) comes through `applyPaymentSnapshot`, so the rules are the same everywhere:
 *
 *  - ownership comes from OUR stored attempt (found by provider + provider reference), never from a claim in the message;
 *  - the reference, tenant, currency and destination in the message must match what we stored, or nothing is applied and an
 *    exception is raised for a person (scenario 8);
 *  - success is applied once: a guarded UPDATE lets exactly one caller move the attempt to SUCCEEDED; replays change nothing (7);
 *  - what the provider reported as final is final: a contradictory later report is an exception, not an edit;
 *  - money that does not fit (late, short, over) is held, never silently applied (10).
 */
export type OutcomeResult =
  | { result: "APPLIED" | "HELD" | "NOOP" | "FAILED" | "PENDING" }
  | { result: "EXCEPTION"; type: string };

export interface SnapshotInput {
  attemptId: string;
  snapshot: ProviderPaymentSnapshot;
  adapter: ProviderAdapter;
  source: "CALLBACK" | "POLL" | "ADMIN";
  claimedBusinessId?: string;
  eventId?: string;
  now?: Date;
}

export async function applyPaymentSnapshot(prisma: PrismaClient, input: SnapshotInput): Promise<OutcomeResult> {
  const now = input.now ?? new Date();
  const found = await prisma.paymentAttempt.findUnique({ where: { id: input.attemptId }, include: { connection: true } });
  if (!found) return { result: "NOOP" };
  const { connection, ...attempt } = found;
  const scoped = getTenantScopedClient(prisma, attempt.businessId);
  const s = input.snapshot;
  const ctx = { businessId: attempt.businessId, provider: attempt.provider, attemptId: attempt.id, intentId: attempt.intentId };
  const fp = (kind: string) => `${kind}:${attempt.id}:${input.eventId ?? `${s.status}:${s.amountMinor ?? ""}`}`;

  const reject = async (type: Parameters<typeof raiseProviderException>[1]["type"], details: Record<string, unknown>): Promise<OutcomeResult> => {
    await raiseProviderException(prisma, { type, fingerprint: fp(type), ...ctx, amountMinor: s.amountMinor, currencyCode: s.currencyCode, details: { source: input.source, status: s.status, ...details } });
    return { result: "EXCEPTION", type };
  };

  if (s.status === "NOT_FOUND") return { result: "NOOP" };
  if (s.merchantReference !== null && s.merchantReference !== attempt.id) return reject("UNKNOWN_REFERENCE", { expected: attempt.id, got: s.merchantReference });
  if (input.claimedBusinessId && input.claimedBusinessId !== attempt.businessId) return reject("WRONG_TENANT", { claimed: input.claimedBusinessId });
  if (s.destinationKey !== null && s.destinationKey !== connection.destinationKey) return reject("DESTINATION_MISMATCH", { expected: connection.destinationKey, got: s.destinationKey });
  if (s.currencyCode !== null && s.currencyCode !== attempt.currencyCode) return reject("CURRENCY_MISMATCH", { expected: attempt.currencyCode, got: s.currencyCode });

  if (s.status === "PENDING") {
    const moved = await scoped.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["CREATED", "UNKNOWN"] } }, data: { status: "PENDING", ...(s.externalRef && !attempt.externalRef ? { externalRef: s.externalRef } : {}) } });
    if (moved.count === 1) await recordAttemptEvent(scoped, attempt.businessId, attempt.id, attempt.status, "PENDING", input.source);
    return { result: "PENDING" };
  }

  if (s.status === "FAILED") {
    if (attempt.status === "SUCCEEDED") return reject("CONTRADICTORY_STATUS", { had: "SUCCEEDED", reported: "FAILED" });
    const moved = await scoped.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["CREATED", "PENDING", "UNKNOWN", "EXPIRED", "CANCELLED"] } }, data: { status: "FAILED", failureReason: "The provider reported the payment failed." } });
    if (moved.count === 1) await recordAttemptEvent(scoped, attempt.businessId, attempt.id, attempt.status, "FAILED", input.source);
    return { result: moved.count === 1 ? "FAILED" : "NOOP" };
  }

  // SUCCEEDED
  if (attempt.status === "FAILED") return reject("CONTRADICTORY_STATUS", { had: "FAILED", reported: "SUCCEEDED" });
  if (s.amountMinor === null || s.amountMinor <= 0n) return reject("AMOUNT_MISMATCH", { reason: "The provider did not state an amount." });
  const captured = s.amountMinor;
  const moved = await scoped.paymentAttempt.updateMany({
    where: { id: attempt.id, status: { in: ["CREATED", "PENDING", "UNKNOWN", "EXPIRED", "CANCELLED"] } },
    data: { status: "SUCCEEDED", capturedMinor: captured, ...(s.feeMinor !== null ? { feeMinor: s.feeMinor } : {}), ...(s.externalRef && !attempt.externalRef ? { externalRef: s.externalRef } : {}) },
  });
  if (moved.count === 1) {
    await recordAttemptEvent(scoped, attempt.businessId, attempt.id, attempt.status, "SUCCEEDED", input.source, { capturedMinor: captured.toString() });
    if (captured !== attempt.amountMinor) {
      await raiseProviderException(prisma, { type: "AMOUNT_MISMATCH", fingerprint: fp("AMOUNT_MISMATCH"), ...ctx, amountMinor: captured, currencyCode: attempt.currencyCode, details: { expectedMinor: attempt.amountMinor.toString(), capturedMinor: captured.toString() } });
    }
  }
  // Whether we just moved it or it was already SUCCEEDED (a replay, or an earlier crash before allocation), make sure the money has a home.
  const allocation = await ensureAllocation(prisma, attempt.id, input.adapter, now);
  if (moved.count !== 1 && allocation === "EXISTS") return { result: "NOOP" };
  return { result: allocation === "HELD" ? "HELD" : "APPLIED" };
}

/** Gives a SUCCEEDED attempt's money its allocation (applied to the subject, or held). Idempotent and safe to run again after a crash. */
export async function ensureAllocation(prisma: PrismaClient, attemptId: string, adapter: Pick<ProviderAdapter, "evidence">, now: Date): Promise<"APPLIED" | "HELD" | "EXISTS" | "SKIPPED"> {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { id: attemptId }, include: { allocation: true, intent: true } });
  if (!attempt || attempt.status !== "SUCCEEDED") return "SKIPPED";
  if (attempt.allocation) return "EXISTS";
  const { intent } = attempt;
  const scoped = getTenantScopedClient(prisma, attempt.businessId);
  const applied = await applyToSubject(prisma, attempt, intent, attempt.capturedMinor, adapter.evidence, now);
  const created = await scoped.paymentAllocation.createMany({
    data: [{ businessId: attempt.businessId, attemptId: attempt.id, intentId: intent.id, subjectType: intent.subjectType, subjectId: intent.subjectId, amountMinor: attempt.capturedMinor, state: applied.state, ...(applied.storePaymentId ? { storePaymentId: applied.storePaymentId } : {}), ...(applied.tradePaymentId ? { tradePaymentId: applied.tradePaymentId } : {}) }],
    skipDuplicates: true,
  });
  if (created.count === 1 && applied.state === "APPLIED") {
    await prisma.$executeRaw`UPDATE "PaymentIntent" SET "paidMinor" = "paidMinor" + ${attempt.capturedMinor},
      "status" = CASE WHEN "status" = 'OPEN' AND "paidMinor" + ${attempt.capturedMinor} >= "amountMinor" THEN 'PAID'::"PaymentIntentStatus" ELSE "status" END
      WHERE "id" = ${intent.id}`;
  }
  return applied.state;
}

// ------------------------------------------------------------------------------------ status checks

export interface RefreshResult {
  outcome: OutcomeResult | { result: "UNREACHABLE" } | { result: "NOT_FOUND" };
  snapshot?: ProviderPaymentSnapshot;
}

/**
 * Asks the provider (authenticated) where an attempt stands and applies the answer. A provider that cannot be reached leaves the
 * attempt exactly as it was, schedules the next look with bounded backoff, and after MAX_POLLS raises an exception for a person.
 */
export async function refreshAttempt(prisma: PrismaClient, registry: AdapterRegistry, attemptId: string, source: "POLL" | "ADMIN", now: Date): Promise<RefreshResult> {
  const found = await prisma.paymentAttempt.findUnique({ where: { id: attemptId }, include: { connection: true } });
  if (!found) throw new PaymentsError("NOT_FOUND", "No such attempt.");
  const { connection, ...attempt } = found;
  const adapter = registry.get(attempt.provider);
  if (!adapter) throw new PaymentsError("NO_CONNECTION", "That provider is not available in this environment.");
  const scoped = getTenantScopedClient(prisma, attempt.businessId);
  let snapshot: ProviderPaymentSnapshot;
  try {
    snapshot = await adapter.getStatus({ externalRef: attempt.externalRef, merchantReference: attempt.id, destinationKey: connection.destinationKey });
  } catch (error) {
    if (!(error instanceof ProviderUnavailableError)) throw error;
    await noteProviderFailure(prisma, connection, now);
    const pollCount = attempt.pollCount + 1;
    await scoped.paymentAttempt.updateMany({ where: { id: attempt.id }, data: { pollCount, lastPolledAt: now, nextPollAt: new Date(now.getTime() + nextPollDelayMs(pollCount)) } });
    if (pollCount >= MAX_POLLS) await raiseUnresolved(prisma, attempt, "The provider could not be reached after repeated checks.");
    return { outcome: { result: "UNREACHABLE" } };
  }
  await noteProviderSuccess(prisma, connection, now);
  const pollCount = attempt.pollCount + 1;
  await scoped.paymentAttempt.updateMany({ where: { id: attempt.id }, data: { pollCount, lastPolledAt: now, nextPollAt: new Date(now.getTime() + nextPollDelayMs(pollCount)) } });

  if (snapshot.status === "NOT_FOUND") {
    if (attempt.externalRef === null && attempt.status !== "SUCCEEDED") {
      // We never got an acceptance and the provider (authenticated) has no record: it never collected. Safe to close.
      const moved = await scoped.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["CREATED", "UNKNOWN"] } }, data: { status: "FAILED", failureReason: "The provider has no record of this request." } });
      if (moved.count === 1) await recordAttemptEvent(scoped, attempt.businessId, attempt.id, attempt.status, "FAILED", source, { reason: "provider has no record" });
      return { outcome: { result: "NOT_FOUND" }, snapshot };
    }
    await raiseUnresolved(prisma, attempt, "The provider has no record of a payment we thought it accepted.");
    return { outcome: { result: "NOT_FOUND" }, snapshot };
  }
  const outcome = await applyPaymentSnapshot(prisma, { attemptId: attempt.id, snapshot, adapter, source, now });
  if (snapshot.status === "PENDING" && pollCount >= MAX_POLLS) await raiseUnresolved(prisma, attempt, "Still pending at the provider after repeated checks.");
  return { outcome, snapshot };
}

async function raiseUnresolved(prisma: PrismaClient, attempt: PaymentAttempt, why: string): Promise<void> {
  await raiseProviderException(prisma, { type: "UNRESOLVED_ATTEMPT", fingerprint: `unresolved:${attempt.id}`, businessId: attempt.businessId, provider: attempt.provider, attemptId: attempt.id, intentId: attempt.intentId, amountMinor: attempt.amountMinor, currencyCode: attempt.currencyCode, details: { why, status: attempt.status } });
}

/** One sweep: look at every unresolved attempt that is due, close lapsed intents and repair any success that never got its allocation. Idempotent. */
export async function reconcilePayments(prisma: PrismaClient, registry: AdapterRegistry, now: Date = new Date(), limit = 25): Promise<{ polled: number; applied: number; unreachable: number; lapsedIntents: number; repaired: number; refundsPolled: number }> {
  const out = { polled: 0, applied: 0, unreachable: 0, lapsedIntents: 0, repaired: 0, refundsPolled: 0 };
  const due = await prisma.paymentAttempt.findMany({
    where: { status: { in: [...ACTIVE_ATTEMPT_STATUSES] }, OR: [{ nextPollAt: { lte: now } }, { nextPollAt: null, createdAt: { lte: new Date(now.getTime() - 30_000) } }] },
    orderBy: { createdAt: "asc" }, take: limit, select: { id: true },
  });
  for (const a of due) {
    try {
      const r = await refreshAttempt(prisma, registry, a.id, "POLL", now);
      out.polled++;
      if (r.outcome.result === "UNREACHABLE") out.unreachable++;
      else if (r.outcome.result === "APPLIED" || r.outcome.result === "HELD") out.applied++;
    } catch (error) {
      if (!(error instanceof PaymentsError)) throw error;
    }
  }
  out.lapsedIntents = (await prisma.paymentIntent.updateMany({ where: { status: "OPEN", expiresAt: { lte: now } }, data: { status: "EXPIRED" } })).count;
  const unallocated = await prisma.paymentAttempt.findMany({ where: { status: "SUCCEEDED", allocation: { is: null } }, take: limit, select: { id: true, provider: true } });
  for (const a of unallocated) {
    const adapter = registry.get(a.provider);
    if (adapter && (await ensureAllocation(prisma, a.id, adapter, now)) !== "SKIPPED") out.repaired++;
  }
  out.refundsPolled = await pollRefunds(prisma, registry, now, limit);
  return out;
}

/**
 * Admin: close an attempt as failed or cancelled, but ONLY after an authenticated check says the provider did not collect.
 * If the provider says it was paid, the payment is applied instead and the request to close it is refused.
 */
export async function closeAttemptAfterCheck(
  prisma: PrismaClient, registry: AdapterRegistry, input: { attemptId: string; as: "FAILED" | "CANCELLED"; adminUserId: string; reason: string; now?: Date },
): Promise<{ closed: boolean; providerSays: string }> {
  const now = input.now ?? new Date();
  const refreshed = await refreshAttempt(prisma, registry, input.attemptId, "ADMIN", now);
  if (refreshed.outcome.result === "UNREACHABLE") throw new PaymentsError("CANNOT_VERIFY", "The provider could not be reached, so we cannot confirm it did not collect. Try again when it is available.");
  const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: input.attemptId } });
  if (attempt.status === "SUCCEEDED") return { closed: false, providerSays: "SUCCEEDED" };
  if (attempt.status === "FAILED") return { closed: true, providerSays: "FAILED" };
  const snapshotStatus = refreshed.snapshot?.status ?? "UNKNOWN";
  if (snapshotStatus === "PENDING") throw new PaymentsError("STILL_PENDING", "The provider still reports this payment as pending, so it may still be collected. It cannot be closed yet.");
  if (snapshotStatus !== "NOT_FOUND") throw new PaymentsError("CANNOT_VERIFY", "The provider's answer does not show the payment is dead.");
  if (input.as === "FAILED" && attempt.status !== "CANCELLED") {
    const scoped = getTenantScopedClient(prisma, attempt.businessId);
    const moved = await scoped.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["CREATED", "PENDING", "UNKNOWN", "EXPIRED"] } }, data: { status: "FAILED", failureReason: `Closed by an admin after a provider check: ${input.reason.slice(0, 150)}` } });
    if (moved.count === 1) await recordAttemptEvent(scoped, attempt.businessId, attempt.id, attempt.status, "FAILED", "ADMIN", { adminUserId: input.adminUserId, reason: input.reason });
    return { closed: true, providerSays: snapshotStatus };
  }
  const scoped = getTenantScopedClient(prisma, attempt.businessId);
  const moved = await scoped.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["CREATED", "PENDING", "UNKNOWN", "EXPIRED"] } }, data: { status: "CANCELLED", failureReason: `Cancelled by an admin after a provider check: ${input.reason.slice(0, 150)}` } });
  if (moved.count === 1) await recordAttemptEvent(scoped, attempt.businessId, attempt.id, attempt.status, "CANCELLED", "ADMIN", { adminUserId: input.adminUserId, reason: input.reason });
  return { closed: moved.count === 1, providerSays: snapshotStatus };
}

// ------------------------------------------------------------------------------------ callbacks

export type ReceiveResult = { status: "recorded" | "duplicate" } | { status: "rejected"; reason: "BAD_SIGNATURE" | "BAD_BODY" | "PURPOSE_FORBIDDEN" | "UNKNOWN_PROVIDER" };

/**
 * The HTTP edge for a provider callback: authenticate per that provider's scheme, persist, acknowledge. Nothing is applied here.
 * A weak scheme stores the message as an unverified hint that triggers an authenticated status check instead of being trusted.
 */
export async function receiveProviderCallback(prisma: PrismaClient, registry: AdapterRegistry, provider: string, rawBody: string, headers: Record<string, string | undefined>): Promise<ReceiveResult> {
  const adapter = registry.get(provider);
  if (!adapter) return { status: "rejected", reason: "UNKNOWN_PROVIDER" };
  const verdict = adapter.receiveCallback(rawBody, headers);
  if (!verdict.ok) {
    if (verdict.reason === "PURPOSE_FORBIDDEN") {
      // Validly signed but claiming money that is not a merchant sale: record it for a person, apply nothing.
      await raiseProviderException(prisma, { type: "PURPOSE_MISMATCH", fingerprint: `purpose:${provider}:${verdict.eventId ?? rawBody.length}`, provider, details: { detail: verdict.detail ?? null } }).catch(() => undefined);
    }
    return { status: "rejected", reason: verdict.reason };
  }
  const r = await recordCallback(prisma, { provider, externalId: verdict.event.eventId, payload: { event: serializeEvent(verdict.event) } as never, signatureVerified: adapter.callbackAuth === "STRONG" });
  return { status: r.inserted ? "recorded" : "duplicate" };
}

/** Inbox handler for one stored provider callback. Idempotent: replays and concurrent deliveries produce one business effect. */
export function providerCallbackHandler(prisma: PrismaClient, registry: AdapterRegistry) {
  return async (callback: CallbackInbox): Promise<void> => {
    const adapter = registry.get(callback.provider);
    if (!adapter) throw new Error(`No adapter registered for provider '${callback.provider}'.`);
    const event = reviveEvent<NormalizedEvent>((callback.payload as { event: unknown }).event);
    const now = new Date();
    if (event.kind === "payment") {
      const ref = event.snapshot.externalRef;
      const attempt = ref ? await prisma.paymentAttempt.findFirst({ where: { provider: callback.provider, externalRef: ref } }) : null;
      if (!attempt) {
        await raiseProviderException(prisma, { type: "UNKNOWN_REFERENCE", fingerprint: `unknown:${callback.provider}:${event.eventId}`, provider: callback.provider, amountMinor: event.snapshot.amountMinor, currencyCode: event.snapshot.currencyCode, details: { externalRef: ref, merchantReference: event.snapshot.merchantReference, status: event.snapshot.status } });
        return;
      }
      if (!callback.signatureVerified) {
        // a weak callback is only a hint: ask the provider (authenticated) and act on THAT answer
        await refreshAttempt(prisma, registry, attempt.id, "POLL", now);
        return;
      }
      await applyPaymentSnapshot(prisma, { attemptId: attempt.id, snapshot: event.snapshot, adapter, source: "CALLBACK", eventId: event.eventId, ...(event.sellerBusinessId ? { claimedBusinessId: event.sellerBusinessId } : {}), now });
      return;
    }
    if (event.kind === "refund") {
      await applyRefundOutcome(prisma, registry, { provider: callback.provider, paymentExternalRef: event.paymentExternalRef, refundExternalRef: event.refundExternalRef, status: event.status, amountMinor: event.amountMinor, ...(event.failureReason ? { failureReason: event.failureReason } : {}), now });
      return;
    }
    await recordSettlementReport(prisma, { provider: callback.provider, report: event.report, evidence: adapter.evidence, eventId: event.eventId, now });
  };
}

export type { PaymentIntent, ProviderConnection };
