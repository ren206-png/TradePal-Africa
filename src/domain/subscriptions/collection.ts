import type { BillingAttempt, CallbackInbox, PrismaClient } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction } from "../../db/tenantScope.js";
import { PawaPayApiError, checkDepositStatus, checkRefundStatus, getPublicKeys, initiateRefund, type PawaPayDeps } from "../../pawapay/client.js";
import { getPawaPayCountryForCurrency } from "../../pawapay/countries.js";
import { recordAuditLog } from "../auditLog.js";
import { recordCallback } from "../callbackInbox.js";
import { activeConf } from "./renewal.js";
import { InvalidAmountError, formatMoney, parseAmountToMinorUnits } from "../money.js";
import {
  ACTIVE_BILLING_ATTEMPT_STATUSES, BillingError, DAY_MS, INVOICE_OPEN, LEGACY_PERIOD_DAYS, MAX_POLLS, SWITCH_PROVIDER, getBillingConfig, pollDelayMs, raiseBillingException, type BillingConfig,
} from "./common.js";

/**
 * The one place a pawaPay message about a subscription charge becomes a business effect (expansion section 13). Whatever tells us a charge
 * finished (a signed callback, a status poll, an admin refresh), money is ONLY believed after an authenticated status lookup at pawaPay:
 * `applyBillingDeposit` always asks. Then:
 *   - the deposit must belong to a charge WE started, in THIS environment, in the invoice's currency and for exactly its amount, or it is
 *     held as an exception and grants nothing (scenario 15: mismatched payments grant no access);
 *   - success is claimed by guarded updates (attempt -> COMPLETED, invoice -> PAID) so exactly one caller wins, and the allocation is unique
 *     per invoice and per attempt, so a duplicate or replayed payment can never extend a period twice (scenario 15);
 *   - the period granted is contiguous when renewing in time (an early payment extends from the old end: no days are lost, none are
 *     given away) and starts at payment time when the subscription had lapsed. There is no proration anywhere.
 */
export type ApplyResult = "GRANTED" | "HELD" | "NOOP" | "FAILED" | "PENDING" | "UNREACHABLE" | "UNKNOWN_DEPOSIT" | "ENV_MISMATCH";

function amountOf(text: string | undefined, exp: number): bigint | null {
  if (text === undefined) return null;
  try {
    return parseAmountToMinorUnits(text, exp);
  } catch (error) {
    if (error instanceof InvalidAmountError) return null;
    throw error;
  }
}

export async function applyBillingDeposit(prisma: PrismaClient, cfg: BillingConfig, depositId: string, source: "CALLBACK" | "POLL" | "ADMIN", now: Date = new Date()): Promise<ApplyResult> {
  const attempt = await prisma.billingAttempt.findUnique({ where: { id: depositId }, include: { invoice: true } });
  if (!attempt) {
    await raiseBillingException(prisma, { type: "UNKNOWN_DEPOSIT", fingerprint: `unknown:${depositId}`, details: { depositId, source } });
    return "UNKNOWN_DEPOSIT";
  }
  if (attempt.environment !== cfg.environment) {
    await raiseBillingException(prisma, { type: "ENVIRONMENT_MISMATCH", fingerprint: `env:${attempt.id}:${cfg.environment}`, businessId: attempt.businessId, attemptId: attempt.id, details: { attemptEnvironment: attempt.environment, serverEnvironment: cfg.environment } });
    return "ENV_MISMATCH";
  }
  const scoped = getTenantScopedClient(prisma, attempt.businessId);
  const exp = (await prisma.currency.findUniqueOrThrow({ where: { code: attempt.currencyCode } })).minorUnitExp;

  let status;
  try {
    status = await checkDepositStatus(cfg.deps, depositId);
  } catch (error) {
    if (!(error instanceof PawaPayApiError) && !(error instanceof Error)) throw error;
    const polls = attempt.pollCount + 1;
    await scoped.billingAttempt.updateMany({ where: { id: attempt.id }, data: { pollCount: polls, nextPollAt: new Date(now.getTime() + pollDelayMs(polls)) } });
    if (polls >= MAX_POLLS && (ACTIVE_BILLING_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status)) await raiseUnresolved(prisma, attempt, "pawaPay could not be reached after repeated checks.");
    return "UNREACHABLE";
  }
  const polls = attempt.pollCount + 1;
  await scoped.billingAttempt.updateMany({ where: { id: attempt.id }, data: { pollCount: polls, nextPollAt: new Date(now.getTime() + pollDelayMs(polls)) } });

  if (!status.found || !status.data) {
    // pawaPay has no record: the ONLY case in which an attempt that was never accepted may be closed as failed
    if (attempt.status === "INITIATED" || attempt.status === "UNKNOWN") {
      const moved = await scoped.billingAttempt.updateMany({ where: { id: attempt.id, status: { in: ["INITIATED", "UNKNOWN"] } }, data: { status: "FAILED", failureCode: "NOT_FOUND" } });
      return moved.count === 1 ? "FAILED" : "NOOP";
    }
    await raiseUnresolved(prisma, attempt, "pawaPay has no record of a deposit we thought it accepted.");
    return "NOOP";
  }
  const d = status.data;

  if (d.status === "FAILED" || d.status === "REJECTED") {
    const moved = await scoped.billingAttempt.updateMany({ where: { id: attempt.id, status: { in: ["INITIATED", "ACCEPTED", "PROCESSING", "UNKNOWN"] } }, data: { status: d.status === "FAILED" ? "FAILED" : "REJECTED", failureCode: d.failureReason?.failureCode ?? null } });
    if (attempt.status === "COMPLETED") await raiseBillingException(prisma, { type: "UNRESOLVED_ATTEMPT", fingerprint: `contradiction:${attempt.id}`, businessId: attempt.businessId, attemptId: attempt.id, details: { had: "COMPLETED", reported: d.status } });
    return moved.count === 1 ? "FAILED" : "NOOP";
  }
  if (d.status !== "COMPLETED") {
    const next = d.status === "ACCEPTED" ? "ACCEPTED" : "PROCESSING";
    await scoped.billingAttempt.updateMany({ where: { id: attempt.id, status: { in: ["INITIATED", "ACCEPTED", "PROCESSING", "UNKNOWN"] } }, data: { status: next } });
    return "PENDING";
  }

  // COMPLETED at pawaPay: the money exists. Does it fit the invoice?
  const captured = amountOf(d.amount, exp);
  const currencyOk = d.currency === attempt.currencyCode;
  const amountOk = captured !== null && captured === attempt.invoice.amountMinor && captured === attempt.amountMinor;
  const claim = await scoped.billingAttempt.updateMany({
    where: { id: attempt.id, status: { in: ["INITIATED", "ACCEPTED", "PROCESSING", "UNKNOWN"] } },
    data: { status: "COMPLETED", capturedMinor: captured !== null && captured > 0n ? captured : attempt.amountMinor, ...(d.providerTransactionId ? { providerTransactionId: d.providerTransactionId } : {}) },
  });
  if (!currencyOk || !amountOk) {
    await raiseBillingException(prisma, {
      type: currencyOk ? "AMOUNT_MISMATCH" : "CURRENCY_MISMATCH", fingerprint: `mismatch:${attempt.id}`, businessId: attempt.businessId, attemptId: attempt.id, invoiceId: attempt.invoiceId, amountMinor: captured,
      details: { expectedMinor: attempt.invoice.amountMinor.toString(), expectedCurrency: attempt.currencyCode, gotAmount: d.amount ?? null, gotCurrency: d.currency ?? null },
    });
    return "HELD";
  }
  const granted = await allocateBillingPayment(prisma, attempt.id, now);
  if (claim.count !== 1 && granted === "EXISTS") return "NOOP";
  return granted === "GRANTED" ? "GRANTED" : "HELD";
}

async function raiseUnresolved(prisma: PrismaClient, a: Pick<BillingAttempt, "id" | "businessId" | "invoiceId" | "status">, why: string): Promise<void> {
  await raiseBillingException(prisma, { type: "UNRESOLVED_ATTEMPT", fingerprint: `unresolved:${a.id}`, businessId: a.businessId, attemptId: a.id, invoiceId: a.invoiceId, details: { why, status: a.status } });
}

/** Grants the billing period a COMPLETED, correctly-sized payment bought. One transaction; idempotent; safe to run again after a crash. */
export async function allocateBillingPayment(prisma: PrismaClient, attemptId: string, now: Date): Promise<"GRANTED" | "EXISTS" | "HELD" | "SKIPPED"> {
  const probe = await prisma.billingAttempt.findUnique({ where: { id: attemptId } });
  if (!probe || probe.status !== "COMPLETED") return "SKIPPED";
  const scoped = getTenantScopedClient(prisma, probe.businessId);
  return withScopedTransaction(scoped, async (tx) => {
    if (await tx.billingAllocation.findUnique({ where: { attemptId } })) return "EXISTS" as const;
    const attempt = await tx.billingAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: attempt.invoiceId }, include: { subscription: true } });
    if (invoice.amountMinor !== attempt.capturedMinor) return "HELD" as const;
    const hold = async (type: "DUPLICATE_PAYMENT" | "PAYMENT_AFTER_CANCELLATION") => {
      await raiseBillingException(prisma, { type, fingerprint: `${type.toLowerCase()}:${attempt.id}`, businessId: attempt.businessId, attemptId: attempt.id, invoiceId: invoice.id, amountMinor: attempt.capturedMinor, details: { invoiceStatus: invoice.status } });
      return "HELD" as const;
    };
    if (invoice.status === "PAID" || invoice.status === "PARTIALLY_REFUNDED" || invoice.status === "REFUNDED") return hold("DUPLICATE_PAYMENT");
    if (!(INVOICE_OPEN as readonly string[]).includes(invoice.status)) return hold("PAYMENT_AFTER_CANCELLATION");
    const claimed = await tx.invoice.updateMany({ where: { id: invoice.id, status: { in: [...INVOICE_OPEN] } }, data: { status: "PAID", paidAt: now, paidMinor: attempt.capturedMinor } });
    if (claimed.count !== 1) return hold("DUPLICATE_PAYMENT");

    const sub = invoice.subscription;
    const bought = invoice.planVersionId ? await tx.planVersion.findUnique({ where: { id: invoice.planVersionId } }) : null;
    const held = sub.planVersionId ? await tx.planVersion.findUnique({ where: { id: sub.planVersionId } }) : null;
    const grace = held?.graceDays ?? 3;
    const wasEntitled = (sub.status === "ACTIVE" || sub.status === "PAST_DUE") && now.getTime() < sub.currentPeriodEnd.getTime() + grace * DAY_MS;
    const start = wasEntitled ? new Date(Math.max(now.getTime(), sub.currentPeriodEnd.getTime())) : now;
    const end = new Date(start.getTime() + (bought?.billingPeriodDays ?? LEGACY_PERIOD_DAYS) * DAY_MS);
    const planCode = bought?.planCode ?? sub.planCode;
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: "ACTIVE", planCode, planVersionId: bought?.id ?? sub.planVersionId, currentPeriodStart: start, currentPeriodEnd: end,
        pendingPlanVersionId: sub.pendingPlanVersionId && sub.pendingPlanVersionId === bought?.id ? null : sub.pendingPlanVersionId, cancelAtPeriodEnd: false, cancelledAt: null,
      },
    });
    await tx.invoice.update({ where: { id: invoice.id }, data: { periodStart: start, periodEnd: end } });
    await tx.billingAllocation.create({ data: { businessId: attempt.businessId, attemptId: attempt.id, invoiceId: invoice.id, subscriptionId: sub.id, planVersionId: bought?.id ?? null, periodStart: start, periodEnd: end, amountMinor: attempt.capturedMinor } });
    const kind = !wasEntitled && sub.status === "PENDING" ? "GRANTED" : planCode !== sub.planCode ? "PLAN_CHANGED" : wasEntitled ? "EXTENDED" : "GRANTED";
    await tx.entitlementEvent.create({ data: { businessId: attempt.businessId, subscriptionId: sub.id, kind, fromPlanCode: sub.planCode, toPlanCode: planCode, periodStart: start, periodEnd: end, source: "PAYMENT", invoiceId: invoice.id } });
    await recordAuditLog(tx, {
      businessId: attempt.businessId, actorType: "SYSTEM", actorId: "pawapay-billing", action: "SUBSCRIPTION_PAYMENT_CONFIRMED", entityType: "Subscription", entityId: sub.id,
      metadata: { invoiceId: invoice.id, reference: invoice.reference, depositId: attempt.id, planCode, periodStart: start.toISOString(), periodEnd: end.toISOString() },
    });
    return "GRANTED" as const;
  });
}

// ------------------------------------------------------------------------------------ reconciliation

export async function reconcileBilling(prisma: PrismaClient, now: Date = new Date(), limit = 25) {
  const out = { polled: 0, granted: 0, unreachable: 0, repaired: 0, refundsPolled: 0, invoicesOverdue: 0, expiryNoted: 0, cancelledAtPeriodEnd: 0 };
  const cfg = getBillingConfig();
  if (cfg.ok) {
    const due = await prisma.billingAttempt.findMany({
      where: { status: { in: [...ACTIVE_BILLING_ATTEMPT_STATUSES] }, environment: cfg.config.environment, OR: [{ nextPollAt: { lte: now } }, { nextPollAt: null, createdAt: { lte: new Date(now.getTime() - 30_000) } }] },
      orderBy: { createdAt: "asc" }, take: limit, select: { id: true },
    });
    for (const a of due) {
      const r = await applyBillingDeposit(prisma, cfg.config, a.id, "POLL", now);
      out.polled++;
      if (r === "GRANTED") out.granted++;
      if (r === "UNREACHABLE") out.unreachable++;
    }
    const unallocated = await prisma.billingAttempt.findMany({ where: { status: "COMPLETED", allocation: { is: null }, environment: cfg.config.environment }, take: limit, select: { id: true } });
    for (const a of unallocated) if ((await allocateBillingPayment(prisma, a.id, now)) === "GRANTED") out.repaired++;
    out.refundsPolled = await pollBillingRefunds(prisma, cfg.config, now, limit);
  }
  out.invoicesOverdue = (await prisma.invoice.updateMany({ where: { status: "PENDING", providerCode: "PAWAPAY", dueDate: { lt: now } }, data: { status: "OVERDUE" } })).count;
  // note expiry once per lapsed period (history only: entitlement itself is computed from the clock, never from this)
  const lapsed = await prisma.subscription.findMany({ where: { status: { in: ["ACTIVE", "PAST_DUE"] }, currentPeriodEnd: { lt: now } }, take: 200, include: { planVersion: true } });
  for (const s of lapsed) {
    const graceEnd = new Date(s.currentPeriodEnd.getTime() + (s.planVersion?.graceDays ?? 3) * DAY_MS);
    if (now < graceEnd) continue;
    const scoped = getTenantScopedClient(prisma, s.businessId);
    if (!(await scoped.entitlementEvent.findFirst({ where: { subscriptionId: s.id, kind: "EXPIRY_NOTED", periodEnd: s.currentPeriodEnd } }))) {
      await scoped.entitlementEvent.create({ data: { businessId: s.businessId, subscriptionId: s.id, kind: "EXPIRY_NOTED", fromPlanCode: s.planCode, periodEnd: s.currentPeriodEnd, source: "SWEEP" } });
      out.expiryNoted++;
    }
    if (s.cancelAtPeriodEnd && s.status !== "CANCELED") {
      await scoped.subscription.update({ where: { id: s.id }, data: { status: "CANCELED" } });
      await scoped.entitlementEvent.create({ data: { businessId: s.businessId, subscriptionId: s.id, kind: "CANCELLED", fromPlanCode: s.planCode, periodEnd: s.currentPeriodEnd, source: "SWEEP" } });
      out.cancelledAtPeriodEnd++;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------ refunds (subscription charges only)

export interface RefundInput {
  invoiceId: string;
  amountMinor?: bigint;
  reason: string;
  adminUserId: string;
  /** Also end the paid period now (only meaningful for a full refund). Off by default: a refund returns money, it does not by itself revoke service. */
  revokeEntitlement?: boolean;
  now?: Date;
}

/**
 * Refunds a SUBSCRIPTION charge (and nothing else) back to the payer through pawaPay. Authorised by a named admin with a reason, audited,
 * bounded by what was paid (a guarded UPDATE plus a database CHECK), one refund in flight per deposit (pawaPay's own rule), and the invoice
 * moves to PARTIALLY_REFUNDED or REFUNDED only when pawaPay confirms. Funds are reserved before the call and released on failure.
 */
export async function refundSubscriptionCharge(prisma: PrismaClient, input: RefundInput) {
  const now = input.now ?? new Date();
  const cfgResult = getBillingConfig();
  if (!cfgResult.ok) throw new BillingError("NOT_CONFIGURED", "pawaPay is not configured in this environment.", { reason: cfgResult.reason });
  const cfg = cfgResult.config;
  if (input.reason.trim().length < 10) throw new BillingError("INVALID", "Give a reason of at least 10 characters.");
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId }, include: { subscription: true } });
  if (!invoice) throw new BillingError("NOT_FOUND", "No such invoice.");
  if (invoice.purpose !== "PLATFORM_SUBSCRIPTION") throw new BillingError("NOT_ALLOWED", "Only subscription charges can be refunded here.");
  if (invoice.status !== "PAID" && invoice.status !== "PARTIALLY_REFUNDED") throw new BillingError("NOT_REFUNDABLE", "Only a paid subscription invoice can be refunded.");
  const scoped = getTenantScopedClient(prisma, invoice.subscription.businessId);
  const attempt = await scoped.billingAttempt.findFirst({ where: { invoiceId: invoice.id, status: "COMPLETED", allocation: { isNot: null } } });
  if (!attempt) throw new BillingError("NOT_REFUNDABLE", "There is no collected pawaPay payment behind this invoice.");
  if (attempt.environment !== cfg.environment) throw new BillingError("ENV_MISMATCH", "That payment was made in a different pawaPay environment from this server's.");
  if (await scoped.billingRefund.findFirst({ where: { attemptId: attempt.id, status: { in: ["REQUESTED", "ACCEPTED", "PROCESSING"] } } })) throw new BillingError("REFUND_IN_PROGRESS", "A refund for this payment is already in progress.");

  const remaining = invoice.paidMinor - invoice.refundedMinor;
  const amount = input.amountMinor ?? remaining;
  if (amount <= 0n || amount > remaining) throw new BillingError("REFUND_LIMIT", "That is more than remains refundable on this invoice.");
  const exp = (await prisma.currency.findUniqueOrThrow({ where: { code: attempt.currencyCode } })).minorUnitExp;
  const unit = 10n ** BigInt(exp);
  const country = getPawaPayCountryForCurrency(attempt.currencyCode);
  if (!country) throw new BillingError("NOT_AVAILABLE", "Refunds are not available for this currency.");
  const conf = await activeConf(cfg.deps, country.country);
  const decimals = conf.countries.find((c) => c.country === country.country)?.providers.find((p) => p.provider === attempt.providerCode)?.currencies.find((c) => c.currency === attempt.currencyCode)?.operationTypes.DEPOSIT?.decimalsInAmount;
  if (decimals === "NONE" && amount % unit !== 0n) throw new BillingError("AMOUNT_UNSUPPORTED", "That provider only moves whole amounts, so refund a whole number.");

  const reserved = await prisma.$executeRaw`UPDATE "Invoice" SET "refundedMinor" = "refundedMinor" + ${amount} WHERE "id" = ${invoice.id} AND "status" IN ('PAID', 'PARTIALLY_REFUNDED') AND "refundedMinor" + ${amount} <= "paidMinor"`;
  if (reserved !== 1) throw new BillingError("REFUND_LIMIT", "That is more than remains refundable on this invoice.");
  const refundId = (await import("node:crypto")).randomUUID();
  await scoped.billingRefund.create({ data: { id: refundId, businessId: attempt.businessId, invoiceId: invoice.id, attemptId: attempt.id, amountMinor: amount, reason: input.reason.trim().slice(0, 300), adminUserId: input.adminUserId, revokeEntitlement: input.revokeEntitlement ?? false } });
  await recordAuditLog(scoped, { businessId: attempt.businessId, actorType: "ADMIN", actorId: input.adminUserId, action: "SUBSCRIPTION_REFUND_REQUESTED", entityType: "Invoice", entityId: invoice.id, metadata: { refundId, amountMinor: amount.toString(), reason: input.reason.trim().slice(0, 300) } });

  const amountText = decimals === "NONE" ? (amount / unit).toString() : formatMoney(amount, exp);
  try {
    const r = await initiateRefund(cfg.deps, { refundId, depositId: attempt.id, amount: amountText, currency: attempt.currencyCode });
    if (r.status === "REJECTED") {
      await failRefund(prisma, refundId, r.rejectionReason?.rejectionCode ?? "REJECTED");
      throw new BillingError("REJECTED", `pawaPay rejected the refund: ${r.rejectionReason?.rejectionMessage ?? r.rejectionReason?.rejectionCode ?? "no reason given"}.`);
    }
    await scoped.billingRefund.updateMany({ where: { id: refundId, status: "REQUESTED" }, data: { status: "ACCEPTED", nextPollAt: new Date(now.getTime() + pollDelayMs(0)) } });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    // Unknown outcome: do not assume it failed. The reservation stays; a status lookup decides (NOT_FOUND = it never happened).
    await scoped.billingRefund.updateMany({ where: { id: refundId, status: "REQUESTED" }, data: { nextPollAt: new Date(now.getTime() + pollDelayMs(0)) } });
    throw new BillingError("UNCONFIRMED", "pawaPay did not confirm the refund request. It will be checked automatically; do not request it again yet.", { refundId });
  }
  return scoped.billingRefund.findUniqueOrThrow({ where: { id: refundId } });
}

async function failRefund(prisma: PrismaClient, refundId: string, code: string): Promise<void> {
  const r = await prisma.billingRefund.findUniqueOrThrow({ where: { id: refundId } });
  const moved = await prisma.billingRefund.updateMany({ where: { id: refundId, status: { in: ["REQUESTED", "ACCEPTED", "PROCESSING"] } }, data: { status: "FAILED", failureCode: code } });
  if (moved.count !== 1) return;
  await prisma.$executeRaw`UPDATE "Invoice" SET "refundedMinor" = "refundedMinor" - ${r.amountMinor} WHERE "id" = ${r.invoiceId} AND "refundedMinor" >= ${r.amountMinor}`;
  await raiseBillingException(prisma, { type: "REFUND_FAILED", fingerprint: `refund-failed:${refundId}`, businessId: r.businessId, invoiceId: r.invoiceId, amountMinor: r.amountMinor, details: { refundId, code } });
}

/** Applies pawaPay's word on a refund (always via an authenticated lookup). Idempotent. */
export async function applyBillingRefund(prisma: PrismaClient, cfg: BillingConfig, refundId: string, now: Date = new Date()): Promise<"COMPLETED" | "FAILED" | "PENDING" | "UNKNOWN" | "UNREACHABLE" | "NOOP"> {
  const refund = await prisma.billingRefund.findUnique({ where: { id: refundId }, include: { invoice: true } });
  if (!refund) {
    await raiseBillingException(prisma, { type: "UNKNOWN_DEPOSIT", fingerprint: `unknown-refund:${refundId}`, details: { refundId } });
    return "UNKNOWN";
  }
  if (refund.status === "COMPLETED" || refund.status === "FAILED" || refund.status === "REJECTED") return "NOOP";
  let s;
  try {
    s = await checkRefundStatus(cfg.deps, refundId);
  } catch {
    const polls = refund.pollCount + 1;
    await prisma.billingRefund.updateMany({ where: { id: refundId }, data: { pollCount: polls, nextPollAt: new Date(now.getTime() + pollDelayMs(polls)) } });
    return "UNREACHABLE";
  }
  const polls = refund.pollCount + 1;
  await prisma.billingRefund.updateMany({ where: { id: refundId }, data: { pollCount: polls, nextPollAt: new Date(now.getTime() + pollDelayMs(polls)) } });
  if (!s.found || !s.data) {
    if (refund.status === "REQUESTED") await failRefund(prisma, refundId, "NOT_FOUND");
    return "FAILED";
  }
  if (s.data.status === "FAILED" || s.data.status === "REJECTED") {
    await failRefund(prisma, refundId, s.data.failureReason?.failureCode ?? "FAILED");
    return "FAILED";
  }
  if (s.data.status !== "COMPLETED") {
    await prisma.billingRefund.updateMany({ where: { id: refundId, status: { in: ["REQUESTED", "ACCEPTED"] } }, data: { status: s.data.status === "ACCEPTED" || s.data.status === "ENQUEUED" ? "ACCEPTED" : "PROCESSING" } });
    return "PENDING";
  }
  const moved = await prisma.billingRefund.updateMany({ where: { id: refundId, status: { in: ["REQUESTED", "ACCEPTED", "PROCESSING"] } }, data: { status: "COMPLETED" } });
  if (moved.count !== 1) return "NOOP";
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: refund.invoiceId } });
  const completed = (await prisma.billingRefund.aggregate({ where: { invoiceId: inv.id, status: "COMPLETED" }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
  await prisma.invoice.updateMany({ where: { id: inv.id, status: { in: ["PAID", "PARTIALLY_REFUNDED"] } }, data: { status: completed >= inv.paidMinor ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
  const scoped = getTenantScopedClient(prisma, refund.businessId);
  if (refund.revokeEntitlement && completed >= inv.paidMinor) {
    const sub = await scoped.subscription.findUnique({ where: { id: inv.subscriptionId } });
    if (sub && sub.currentPeriodEnd > now) {
      await scoped.subscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: now, status: "PAST_DUE" } });
      await scoped.entitlementEvent.create({ data: { businessId: refund.businessId, subscriptionId: sub.id, kind: "REFUND_REVOKED", fromPlanCode: sub.planCode, periodEnd: now, source: "ADMIN", invoiceId: inv.id, adminUserId: refund.adminUserId, reason: refund.reason } });
    }
  }
  await recordAuditLog(scoped, { businessId: refund.businessId, actorType: "SYSTEM", actorId: "pawapay-billing", action: "SUBSCRIPTION_REFUND_COMPLETED", entityType: "Invoice", entityId: inv.id, metadata: { refundId, amountMinor: refund.amountMinor.toString() } });
  return "COMPLETED";
}

export async function pollBillingRefunds(prisma: PrismaClient, cfg: BillingConfig, now: Date, limit: number): Promise<number> {
  const open = await prisma.billingRefund.findMany({ where: { status: { in: ["REQUESTED", "ACCEPTED", "PROCESSING"] }, OR: [{ nextPollAt: { lte: now } }, { nextPollAt: null }] }, take: limit, orderBy: { createdAt: "asc" }, select: { id: true } });
  for (const r of open) await applyBillingRefund(prisma, cfg, r.id, now);
  return open.length;
}

// ------------------------------------------------------------------------------------ signing keys

const KEY_REFRESH_MIN_MS = 30_000;
const lastRefresh = new Map<string, number>();
export function resetKeyRefreshForTests(): void {
  lastRefresh.clear();
}

/**
 * Resolves a callback's `keyid` to a PEM public key. Keys are cached in the database per environment; an unknown id triggers ONE refresh
 * from pawaPay's public-keys endpoint (at most every 30 s per environment), which is how key rotation is handled. Still unknown: null,
 * and the callback is rejected.
 */
export function createKeyResolver(prisma: PrismaClient, cfg: BillingConfig, deps: Pick<PawaPayDeps, "apiToken"> & PawaPayDeps = cfg.deps) {
  return async (keyId: string): Promise<string | null> => {
    const read = () => prisma.providerSigningKey.findUnique({ where: { provider_environment_keyId: { provider: SWITCH_PROVIDER, environment: cfg.environment, keyId } } });
    const hit = await read();
    if (hit) return hit.pem;
    const key = `${cfg.environment}`;
    const last = lastRefresh.get(key) ?? 0;
    if (Date.now() - last < KEY_REFRESH_MIN_MS) return null;
    lastRefresh.set(key, Date.now());
    try {
      for (const k of await getPublicKeys(deps)) {
        await prisma.providerSigningKey.createMany({ data: [{ provider: SWITCH_PROVIDER, environment: cfg.environment, keyId: k.id, pem: k.key }], skipDuplicates: true });
      }
    } catch {
      return null;
    }
    return (await read())?.pem ?? null;
  };
}

// ------------------------------------------------------------------------------------ inbox

export const BILLING_INBOX_PROVIDER = "pawapay-billing";

export async function storeBillingCallback(prisma: PrismaClient, body: Record<string, unknown>, rawDigest: string, verified: boolean): Promise<{ inserted: boolean } | null> {
  const id = typeof body["depositId"] === "string" ? (body["depositId"] as string) : typeof body["refundId"] === "string" ? (body["refundId"] as string) : null;
  const status = typeof body["status"] === "string" ? (body["status"] as string) : "";
  if (!id || !/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  const kind = typeof body["depositId"] === "string" ? "deposit" : "refund";
  const r = await recordCallback(prisma, { provider: BILLING_INBOX_PROVIDER, externalId: `${kind}:${id}:${status}:${rawDigest.slice(0, 16)}`, payload: { kind, id, status }, signatureVerified: verified });
  return { inserted: r.inserted };
}

/** Inbox handler: whatever the callback says, the money decision is made by an authenticated lookup. Idempotent. */
export function billingCallbackHandler(prisma: PrismaClient) {
  return async (callback: CallbackInbox): Promise<void> => {
    const cfg = getBillingConfig();
    if (!cfg.ok) throw new Error(`Billing configuration is not usable: ${cfg.reason}`);
    const p = callback.payload as { kind: "deposit" | "refund"; id: string };
    if (p.kind === "deposit") await applyBillingDeposit(prisma, cfg.config, p.id, "CALLBACK");
    else await applyBillingRefund(prisma, cfg.config, p.id);
  };
}
