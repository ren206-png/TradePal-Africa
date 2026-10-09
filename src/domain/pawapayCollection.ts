import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { recordAuditLog } from "./auditLog.js";
import { recordTransaction } from "./ledger.js";
import { formatMoney } from "./money.js";
import { notifyMerchantsOfPaymentReceived, type PaymentRequestOutboundGateway } from "./paymentRequests.js";
import { sendWithRetry } from "./outboundSendRetry.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { sendWhatsAppTextMessage } from "../whatsapp/outboundGateway.js";
import {
  checkDepositStatus,
  getActiveConfiguration,
  initiateDeposit,
  PawaPayApiError,
  predictProvider,
  type ActiveConfigurationResult,
  type PawaPayDeps,
} from "../pawapay/client.js";
import { getPawaPayCountryForCurrency } from "../pawapay/countries.js";
import { MerchantNotFoundError } from "./payments.js";

/**
 * Customer-to-merchant mobile-money collection through PawaPay (`/collect`), the mobile-money
 * counterpart of the Flutterwave `/paylink` flow in paymentRequests.ts: same PaymentRequest rows,
 * same ledger entry (PAYMENT_RECEIVED) and same "payment received" WhatsApp notice to the merchant.
 * The differences are inherent to mobile money — instead of a hosted checkout link, the customer's
 * phone gets a PIN prompt, so the merchant supplies the payer's number.
 *
 * Standard #9: that number is sent to PawaPay once and never stored (only its last 4 digits are
 * kept, so the merchant can recognise the payment), and TradePal never messages the customer.
 *
 * Lifecycle: PaymentRequest PENDING + PawaPayDeposit INITIATED → ACCEPTED (PawaPay accepted it)
 * → COMPLETED/FAILED, driven by PawaPay's callback (pawapay/webhookRoute.ts) and, for missed
 * callbacks, by reconcilePendingPawaPayDeposits (run from the hourly payment-request sweep).
 * Nothing is ever credited on the callback payload alone: settlePawaPayDeposit re-checks the
 * deposit with PawaPay's API first.
 */
export const PAWAPAY_WEBHOOK_ACTOR_ID = "pawapay-webhook";
const PAWAPAY_PROVIDER_CODE = "PAWAPAY";

/** Statuses after which a deposit never changes again. */
const TERMINAL_DEPOSIT_STATUSES = new Set(["COMPLETED", "FAILED", "REJECTED"]);
/** PaymentRequest statuses a verified PawaPay COMPLETED may still settle: money received wins over our own bookkeeping. */
const SETTLEABLE_REQUEST_STATUSES = ["PENDING", "EXPIRED", "FAILED"];

// ── Errors (all carry a message that is safe to show the merchant) ─────────────

export class PawaPayCollectionError extends Error {}
export class InvalidPayerPhoneError extends PawaPayCollectionError {}
export class PawaPayUnavailableError extends PawaPayCollectionError {}
export class PawaPayAmountError extends PawaPayCollectionError {}
export class PawaPayRejectedError extends PawaPayCollectionError {}
export class PawaPayDepositNotFoundError extends Error {}

// ── Active-configuration cache (provider status and limits change rarely) ──────

const CONFIG_TTL_MS = 10 * 60 * 1000;
const configCache = new Map<string, { value: ActiveConfigurationResult; expiresAt: number }>();

async function getCachedActiveConfiguration(pawapay: PawaPayDeps, country: string): Promise<ActiveConfigurationResult> {
  // Keyed by base URL too, so sandbox and production configs never mix within one process.
  const key = `${pawapay.apiBaseUrl ?? "sandbox"}|${country}`;
  const hit = configCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await getActiveConfiguration(pawapay, country, "DEPOSIT");
  configCache.set(key, { value, expiresAt: Date.now() + CONFIG_TTL_MS });
  return value;
}

/** Test hook. */
export function resetPawaPayConfigCacheForTests(): void {
  configCache.clear();
}

// ── Initiate ──────────────────────────────────────────────────────────────────

export interface InitiatePawaPayCollectionInput {
  businessId: string;
  customerId?: string;
  description: string;
  amountMinor: bigint;
  currencyCode: string;
  initiatedByMerchantId: string;
  /** The customer's mobile-money number as the merchant typed it; validated and sanitised via PawaPay. */
  payerPhone: string;
}

export interface InitiatePawaPayCollectionResult {
  paymentRequestId: string;
  depositId: string;
  /** Human-readable provider name, e.g. "Afrimoney". */
  providerName: string;
  payerPhoneLast4: string;
}

const REJECTION_MESSAGES: Record<string, string> = {
  PAYER_NOT_FOUND: "That number isn't registered for mobile money.",
  PAYER_LIMIT_REACHED: "That customer has reached their mobile-money limit.",
  AMOUNT_OUT_OF_BOUNDS: "That amount is outside what the customer's mobile-money provider allows.",
  PROVIDER_TEMPORARILY_UNAVAILABLE: "The customer's mobile-money provider is temporarily unavailable. Please try again shortly.",
  DEPOSITS_NOT_ALLOWED: "That number can't receive payment requests.",
};

function rejectionMessage(code: string | undefined): string {
  return (code && REJECTION_MESSAGES[code]) || "The payment request was rejected. Please check the number and try again.";
}

export async function initiatePawaPayCollection(
  prisma: PrismaClient,
  input: InitiatePawaPayCollectionInput,
  pawapay: PawaPayDeps,
): Promise<InitiatePawaPayCollectionResult> {
  const countryInfo = getPawaPayCountryForCurrency(input.currencyCode);
  if (!countryInfo) {
    throw new PawaPayUnavailableError("Mobile-money collection isn't available in your country yet.");
  }

  const scoped = getTenantScopedClient(prisma, input.businessId);
  const merchant = await scoped.merchant.findUnique({ where: { id: input.initiatedByMerchantId } });
  if (!merchant) throw new MerchantNotFoundError(`Merchant '${input.initiatedByMerchantId}' not found.`);

  const currency = await prisma.currency.findUniqueOrThrow({ where: { code: input.currencyCode } });

  // 1. Validate/sanitise the payer's number and find their provider.
  const prediction = await predictProvider(pawapay, input.payerPhone.trim());
  if (!prediction) {
    throw new InvalidPayerPhoneError("That doesn't look like a valid mobile-money number. Include the country code, e.g. 23276123456.");
  }
  if (prediction.country !== countryInfo.country) {
    throw new InvalidPayerPhoneError(`That isn't a ${countryInfo.name} mobile-money number. Customers must pay from a ${countryInfo.name} number.`);
  }

  // 2. Check the provider is open and the amount is acceptable BEFORE creating anything.
  const config = await getCachedActiveConfiguration(pawapay, countryInfo.country);
  const providerEntry = config.countries
    .find((c) => c.country === countryInfo.country)
    ?.providers.find((p) => p.provider === prediction.provider);
  const depositConfig = providerEntry?.currencies.find((c) => c.currency === input.currencyCode)?.operationTypes.DEPOSIT;
  if (!providerEntry || !depositConfig || depositConfig.status !== "OPERATIONAL") {
    throw new PawaPayUnavailableError(
      `${providerEntry?.displayName ?? "That mobile-money provider"} isn't accepting payments right now. Please try again later.`,
    );
  }

  const unit = 10n ** BigInt(currency.minorUnitExp);
  let amountText = formatMoney(input.amountMinor, currency.minorUnitExp);
  if (depositConfig.decimalsInAmount === "NONE") {
    if (input.amountMinor % unit !== 0n) {
      throw new PawaPayAmountError(`${providerEntry.displayName} only accepts whole amounts (no cents). Please use a whole number.`);
    }
    amountText = (input.amountMinor / unit).toString();
  }
  const amountNumber = Number(amountText);
  if (amountNumber < Number(depositConfig.minAmount) || amountNumber > Number(depositConfig.maxAmount)) {
    throw new PawaPayAmountError(
      `${providerEntry.displayName} accepts payments between ${depositConfig.minAmount} and ${depositConfig.maxAmount} ${input.currencyCode}.`,
    );
  }

  // 3. Persist BEFORE calling PawaPay: the depositId is the only handle for reconciling a dropped call.
  const depositId = crypto.randomUUID();
  const payerPhoneLast4 = prediction.phoneNumber.replace(/\D/g, "").slice(-4);

  const paymentRequest = await scoped.paymentRequest.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId ?? null,
      description: input.description,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      status: "PENDING",
      providerCode: PAWAPAY_PROVIDER_CODE,
      providerReference: depositId,
    },
  });
  await scoped.pawaPayDeposit.create({
    data: {
      id: depositId,
      businessId: input.businessId,
      paymentRequestId: paymentRequest.id,
      status: "INITIATED",
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      provider: prediction.provider,
      payerPhoneLast4,
    },
  });

  // 4. Ask PawaPay to prompt the customer.
  let status: string;
  let failureCode: string | undefined;
  let failureMessage: string | undefined;
  try {
    const result = await initiateDeposit(pawapay, {
      depositId,
      amount: amountText,
      currency: input.currencyCode,
      phoneNumber: prediction.phoneNumber,
      provider: prediction.provider,
    });
    status = result.status;
    failureCode = result.failureReason?.failureCode;
    failureMessage = result.failureReason?.failureMessage;
  } catch (error) {
    if (error instanceof PawaPayApiError && error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      // A definitive 4xx: PawaPay did not create the deposit.
      await markDepositFailed(prisma, depositId, "REJECTED", `HTTP_${error.statusCode}`, error.message);
      throw new PawaPayRejectedError("PawaPay couldn't start that payment. Please check the number and amount and try again.");
    }
    // Network error / timeout / 5xx: the outcome is unknown — PawaPay may or may not have created
    // the deposit. Leave it INITIATED; the callback or the reconciliation sweep will resolve it.
    throw new PawaPayUnavailableError(
      "Couldn't reach the payment provider to confirm. If your customer gets a prompt and approves it, it will still be recorded.",
    );
  }

  if (status === "REJECTED" || status === "FAILED" || status === "DUPLICATE_IGNORED") {
    await markDepositFailed(prisma, depositId, "REJECTED", failureCode, failureMessage);
    throw new PawaPayRejectedError(rejectionMessage(failureCode));
  }

  await prisma.pawaPayDeposit.update({ where: { id: depositId }, data: { status: "ACCEPTED" } });

  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "MERCHANT",
    actorId: input.initiatedByMerchantId,
    action: "PAYMENT_REQUEST_INITIATED",
    entityType: "PaymentRequest",
    entityId: paymentRequest.id,
    metadata: {
      amountMinor: input.amountMinor.toString(),
      currencyCode: input.currencyCode,
      providerCode: PAWAPAY_PROVIDER_CODE,
      depositId,
      mobileMoneyProvider: prediction.provider,
      payerPhoneLast4,
    },
  });

  return { paymentRequestId: paymentRequest.id, depositId, providerName: providerEntry.displayName, payerPhoneLast4 };
}

async function markDepositFailed(
  prisma: PrismaClient,
  depositId: string,
  depositStatus: "FAILED" | "REJECTED",
  failureCode: string | undefined,
  failureMessage: string | undefined,
): Promise<void> {
  const deposit = await prisma.pawaPayDeposit.update({
    where: { id: depositId },
    data: {
      status: depositStatus,
      failureCode: failureCode ?? null,
      failureMessage: failureMessage?.slice(0, 500) ?? null,
    },
  });
  // Only a still-open request flips to FAILED — never overwrite one that was already PAID.
  await prisma.paymentRequest.updateMany({ where: { id: deposit.paymentRequestId, status: "PENDING" }, data: { status: "FAILED" } });
}

// ── Settle (callback + reconciliation) ─────────────────────────────────────────

export type SettlePawaPayDepositOutcome = "paid" | "failed" | "already_processed" | "pending" | "verification_failed";

export interface SettlePawaPayDepositResult {
  outcome: SettlePawaPayDepositOutcome;
  transactionId?: string;
}

/**
 * Brings one deposit up to date with PawaPay's own record of it. Idempotent and safe to call from
 * both the callback and the reconciliation sweep, even concurrently: the PENDING → PAID move is a
 * single conditional UPDATE, so exactly one caller records the ledger entry.
 *
 * Throws PawaPayDepositNotFoundError for a depositId TradePal never created (the webhook route
 * swallows that — the endpoint may receive foreign traffic).
 */
export async function settlePawaPayDeposit(
  prisma: PrismaClient,
  depositId: string,
  pawapay: PawaPayDeps,
  outboundGateway?: PaymentRequestOutboundGateway,
): Promise<SettlePawaPayDepositResult> {
  const deposit = await prisma.pawaPayDeposit.findUnique({ where: { id: depositId }, include: { paymentRequest: true } });
  if (!deposit) throw new PawaPayDepositNotFoundError(`No PawaPay deposit '${depositId}'.`);

  if (TERMINAL_DEPOSIT_STATUSES.has(deposit.status)) {
    return deposit.paymentRequest.transactionId
      ? { outcome: "already_processed", transactionId: deposit.paymentRequest.transactionId }
      : { outcome: "already_processed" };
  }

  const verified = await checkDepositStatus(pawapay, depositId);
  const scoped = getTenantScopedClient(prisma, deposit.businessId);
  const currency = await prisma.currency.findUniqueOrThrow({ where: { code: deposit.currencyCode } });

  if (!verified.found || !verified.data) {
    // PawaPay has no record: the initiation never reached it, so the payment definitively didn't
    // happen. Only an INITIATED deposit can be in that state.
    if (deposit.status === "INITIATED") {
      await markDepositFailed(prisma, depositId, "FAILED", "NOT_FOUND_AT_PROVIDER", "PawaPay has no record of this deposit.");
      await notifyPaymentFailed(prisma, scoped, deposit, currency.minorUnitExp, outboundGateway);
      return { outcome: "failed" };
    }
    return { outcome: "pending" };
  }

  const remote = verified.data;

  if (remote.status === "COMPLETED") {
    const expected = Number(formatMoney(deposit.amountMinor, currency.minorUnitExp));
    const matches = remote.currency === deposit.currencyCode && Number(remote.amount) === expected;
    if (!matches) {
      await recordAuditLog(scoped, {
        businessId: deposit.businessId,
        actorType: "SYSTEM",
        actorId: PAWAPAY_WEBHOOK_ACTOR_ID,
        action: "PAYMENT_REQUEST_VERIFICATION_FAILED",
        entityType: "PaymentRequest",
        entityId: deposit.paymentRequestId,
        metadata: { depositId, verifiedStatus: remote.status, verifiedAmount: remote.amount, verifiedCurrency: remote.currency },
      });
      return { outcome: "verification_failed" };
    }

    // Claim the PENDING (or wrongly-expired/failed) request in one conditional UPDATE.
    const claimed = await prisma.paymentRequest.updateMany({
      where: { id: deposit.paymentRequestId, status: { in: SETTLEABLE_REQUEST_STATUSES } },
      data: { status: "PAID", paidAt: new Date() },
    });
    if (claimed.count === 0) {
      await prisma.pawaPayDeposit.update({ where: { id: depositId }, data: { status: "COMPLETED" } });
      return { outcome: "already_processed" };
    }

    let transactionId: string;
    try {
      const transaction = await recordTransaction(scoped, {
        businessId: deposit.businessId,
        type: "PAYMENT_RECEIVED",
        amountMinor: deposit.amountMinor,
        currencyCode: deposit.currencyCode,
        paymentStatus: "PAID",
        description: deposit.paymentRequest.description,
        ...(deposit.paymentRequest.customerId ? { customerId: deposit.paymentRequest.customerId } : {}),
      });
      transactionId = transaction.id;
      await prisma.paymentRequest.update({ where: { id: deposit.paymentRequestId }, data: { transactionId } });
    } catch (error) {
      // Couldn't write the ledger entry: release the claim so the next callback/sweep retries.
      await prisma.paymentRequest.updateMany({
        where: { id: deposit.paymentRequestId, transactionId: null },
        data: { status: deposit.paymentRequest.status, paidAt: null },
      });
      throw error;
    }

    await prisma.pawaPayDeposit.update({
      where: { id: depositId },
      data: { status: "COMPLETED", providerTransactionId: remote.providerTransactionId ?? null },
    });
    await recordAuditLog(scoped, {
      businessId: deposit.businessId,
      actorType: "SYSTEM",
      actorId: PAWAPAY_WEBHOOK_ACTOR_ID,
      action: "PAYMENT_REQUEST_CONFIRMED",
      entityType: "PaymentRequest",
      entityId: deposit.paymentRequestId,
      metadata: { depositId, transactionId, providerTransactionId: remote.providerTransactionId ?? null },
    });
    await notifyMerchantsOfPaymentReceived(
      prisma,
      scoped,
      deposit.paymentRequest,
      currency.minorUnitExp,
      PAWAPAY_WEBHOOK_ACTOR_ID,
      outboundGateway,
    );
    return { outcome: "paid", transactionId };
  }

  if (remote.status === "FAILED" || remote.status === "REJECTED") {
    await markDepositFailed(
      prisma,
      depositId,
      remote.status === "REJECTED" ? "REJECTED" : "FAILED",
      remote.failureReason?.failureCode,
      remote.failureReason?.failureMessage,
    );
    await recordAuditLog(scoped, {
      businessId: deposit.businessId,
      actorType: "SYSTEM",
      actorId: PAWAPAY_WEBHOOK_ACTOR_ID,
      action: "PAYMENT_REQUEST_PAYMENT_FAILED",
      entityType: "PaymentRequest",
      entityId: deposit.paymentRequestId,
      metadata: { depositId, failureCode: remote.failureReason?.failureCode ?? null },
    });
    await notifyPaymentFailed(prisma, scoped, deposit, currency.minorUnitExp, outboundGateway, remote.failureReason?.failureCode);
    return { outcome: "failed" };
  }

  // ACCEPTED / PROCESSING: still waiting on the customer.
  if (deposit.status === "INITIATED") {
    await prisma.pawaPayDeposit.update({ where: { id: depositId }, data: { status: "ACCEPTED" } });
  }
  return { outcome: "pending" };
}

/** Tells the merchants the customer's payment did not go through. Never throws. */
async function notifyPaymentFailed(
  prisma: PrismaClient,
  scoped: ReturnType<typeof getTenantScopedClient>,
  deposit: { businessId: string; paymentRequestId: string; amountMinor: bigint; paymentRequest: { description: string } },
  minorUnitExp: number,
  outboundGateway?: PaymentRequestOutboundGateway,
  failureCode?: string,
): Promise<void> {
  if (!outboundGateway) return;
  const merchants = await scoped.merchant.findMany({ where: { businessId: deposit.businessId, removedAt: null } });
  const reason = failureCode ? REJECTION_MESSAGES[failureCode] : undefined;
  const body =
    `Payment not completed: ${formatMoney(deposit.amountMinor, minorUnitExp)} for "${deposit.paymentRequest.description}".` +
    `${reason ? ` ${reason}` : ""} You can send a new request with /collect.`;
  for (const merchant of merchants) {
    try {
      await sendWithRetry(
        () => sendWhatsAppTextMessage({ prisma, ...outboundGateway }, { toPhoneNumber: merchant.phoneNumber, body }),
        (message) => new Error(message),
      );
    } catch (error) {
      await recordAuditLog(scoped, {
        businessId: deposit.businessId,
        actorType: "SYSTEM",
        actorId: PAWAPAY_WEBHOOK_ACTOR_ID,
        action: "PAYMENT_REQUEST_NOTIFICATION_FAILED",
        entityType: "Merchant",
        entityId: merchant.id,
        metadata: { paymentRequestId: deposit.paymentRequestId, sendMethod: "text", error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export interface ReconcilePawaPayResult {
  checked: number;
  paid: number;
  failed: number;
  pending: number;
  errors: number;
}

/**
 * Safety net for missed callbacks (PawaPay retries, but an outage on our side can outlast that):
 * asks PawaPay about every deposit still INITIATED/ACCEPTED after a grace period and settles it.
 * One bad deposit never stops the rest.
 */
export async function reconcilePendingPawaPayDeposits(
  prisma: PrismaClient,
  pawapay: PawaPayDeps,
  outboundGateway?: PaymentRequestOutboundGateway,
  options: { now?: Date; olderThanMs?: number; limit?: number } = {},
): Promise<ReconcilePawaPayResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMs ?? 10 * 60 * 1000));
  const deposits = await prisma.pawaPayDeposit.findMany({
    where: { status: { in: ["INITIATED", "ACCEPTED"] }, createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 50,
    select: { id: true },
  });

  const result: ReconcilePawaPayResult = { checked: 0, paid: 0, failed: 0, pending: 0, errors: 0 };
  for (const { id } of deposits) {
    result.checked++;
    try {
      const settled = await settlePawaPayDeposit(prisma, id, pawapay, outboundGateway);
      if (settled.outcome === "paid") result.paid++;
      else if (settled.outcome === "failed") result.failed++;
      else if (settled.outcome === "pending") result.pending++;
    } catch (error) {
      result.errors++;
      console.error(`pawapay reconcile: deposit ${id} failed`, error);
    }
  }
  return result;
}
