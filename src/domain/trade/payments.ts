import type { PrismaClient, TradePayment, TradePaymentMethod } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../../db/tenantScope.js";
import { postJournal, type SystemAccountKey } from "../accounting.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { FLAG_JOURNALS, TradeError, requireTradeEnabled } from "./common.js";
import { enqueueTradeEvent } from "./orders.js";

/**
 * Payments against trade invoices (expansion Phase 3): external payments are TRACKED here, they are never a second sale.
 *
 *  - A payment the business records itself is APPLIED at once (MERCHANT_RECORDED) and is mirrored to the other side as a
 *    PROPOSAL (COUNTERPARTY_REPORTED). A proposal changes nothing in the other business's receivable/payable until that
 *    business confirms it. Nothing a counterparty says counts as provider-confirmed evidence.
 *  - Authenticated evidence (the simulator today, a real provider in Phase 5) is applied directly with its own evidence label.
 *  - A payment can never push an invoice past what remains owing (a guarded update plus a database CHECK).
 *  - Payment completion is separate from settlement: collected-by-provider money sits in Provider clearing until settled.
 */
const METHOD_ACCOUNT: Record<TradePaymentMethod, SystemAccountKey> = { CASH: "CASH", MOBILE_MONEY: "MOBILE_MONEY", BANK: "BANK", OTHER: "UNCLASSIFIED_FUNDS" };

/** Raises paidMinor only if the invoice can still absorb it. Returns false when it cannot. */
export async function applyToInvoice(tx: TenantScopedClient, businessId: string, invoiceId: string, amountMinor: bigint): Promise<boolean> {
  const n = await tx.$executeRaw`UPDATE "TradeInvoice" SET "paidMinor" = "paidMinor" + ${amountMinor} WHERE "id" = ${invoiceId} AND "businessId" = ${businessId} AND "status" = 'ISSUED' AND "paidMinor" + "creditedMinor" + ${amountMinor} <= "totalMinor"`;
  return n === 1;
}

async function journalPayment(
  tx: TenantScopedClient,
  input: { businessId: string; currencyCode: string; direction: "IN" | "OUT"; method: TradePaymentMethod; amountMinor: bigint; paymentId: string; now: Date; evidenceRef?: string | null; clearing?: boolean },
): Promise<void> {
  if (!(await isFeatureEnabled(tx, input.businessId, FLAG_JOURNALS))) return;
  const money: SystemAccountKey = input.clearing ? "PROVIDER_CLEARING" : METHOD_ACCOUNT[input.method];
  await postJournal(tx, {
    businessId: input.businessId, currencyCode: input.currencyCode, kind: input.direction === "IN" ? "DEBT_PAYMENT" : "SUPPLIER_PAYMENT", occurredAt: input.now, idempotencyKey: `trade-pay:${input.paymentId}`,
    source: { type: "TRADE_PAYMENT", id: input.paymentId }, memo: input.direction === "IN" ? "Payment received on invoice" : "Payment made on invoice",
    ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
    lines: input.direction === "IN"
      ? [{ account: money, debitMinor: input.amountMinor }, { account: "AR", creditMinor: input.amountMinor }]
      : [{ account: "AP", debitMinor: input.amountMinor }, { account: money, creditMinor: input.amountMinor }],
  });
}

/** The business records a payment it made (buyer) or received (seller) on one of ITS invoices. */
export async function recordPayment(
  prisma: PrismaClient,
  input: { businessId: string; invoiceId: string; amountMinor: bigint; method: TradePaymentMethod; reference?: string; actor?: string; now?: Date },
): Promise<TradePayment> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  if (input.amountMinor <= 0n) throw new TradeError("INVALID", "A payment must be greater than zero.");
  const invoice = await scoped.tradeInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new TradeError("NOT_FOUND", "Invoice not found.");
  if (invoice.status !== "ISSUED") throw new TradeError("WRONG_STATE", "This invoice is not open for payment.");
  const direction = invoice.side === "SELL" ? "IN" : "OUT";

  return withScopedTransaction(scoped, async (tx) => {
    if (!(await applyToInvoice(tx, input.businessId, invoice.id, input.amountMinor))) {
      throw new TradeError("OVER_PAYMENT", "That is more than remains owing on this invoice.");
    }
    const payment = await tx.tradePayment.create({
      data: {
        businessId: input.businessId, invoiceId: invoice.id, direction, amountMinor: input.amountMinor, currencyCode: invoice.currencyCode, method: input.method,
        evidence: "MERCHANT_RECORDED", state: "APPLIED", reference: input.reference ?? null, createdBy: input.actor ?? null, appliedAt: now,
      },
    });
    await journalPayment(tx, { businessId: input.businessId, currencyCode: invoice.currencyCode, direction, method: input.method, amountMinor: input.amountMinor, paymentId: payment.id, now, evidenceRef: input.reference ?? null });
    if (invoice.counterpartInvoiceId) {
      await enqueueTradeEvent(tx, {
        businessId: input.businessId, orderId: invoice.orderId, eventType: "trade.payment.reported", dedupeKey: `trade.payment.reported:${payment.id}`,
        payload: { fromBusinessId: input.businessId, paymentId: payment.id },
      });
    }
    return payment;
  });
}

/** Confirms a PROPOSED payment (what the other business reported). Only now does it reduce what is owing. */
export async function confirmPayment(prisma: PrismaClient, input: { businessId: string; paymentId: string; actor?: string; now?: Date }): Promise<TradePayment> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const payment = await scoped.tradePayment.findUnique({ where: { id: input.paymentId } });
  if (!payment) throw new TradeError("NOT_FOUND", "Payment not found.");
  if (payment.state !== "PROPOSED") throw new TradeError("WRONG_STATE", `This payment is already ${payment.state.toLowerCase()}.`);
  const invoice = await scoped.tradeInvoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });

  const updated = await withScopedTransaction(scoped, async (tx) => {
    const claimed = await tx.tradePayment.updateMany({ where: { id: payment.id, state: "PROPOSED" }, data: { state: "APPLIED", evidence: "COUNTERPARTY_CONFIRMED", appliedAt: now } });
    if (claimed.count !== 1) throw new TradeError("WRONG_STATE", "The payment was just handled by someone else.");
    if (!(await applyToInvoice(tx, input.businessId, invoice.id, payment.amountMinor))) {
      throw new TradeError("OVER_PAYMENT", "Confirming this would pay the invoice beyond what remains owing. Reject it if it duplicates a payment you already recorded.");
    }
    await journalPayment(tx, { businessId: input.businessId, currencyCode: payment.currencyCode, direction: payment.direction, method: payment.method, amountMinor: payment.amountMinor, paymentId: payment.id, now, evidenceRef: payment.reference });
    if (payment.counterpartPaymentId) {
      await enqueueTradeEvent(tx, {
        businessId: input.businessId, orderId: invoice.orderId, eventType: "trade.payment.resolved", dedupeKey: `trade.payment.resolved:${payment.id}`,
        payload: { fromBusinessId: input.businessId, paymentId: payment.id, state: "APPLIED" },
      });
    }
    return tx.tradePayment.findUniqueOrThrow({ where: { id: payment.id } });
  });
  return updated;
}

export async function rejectPayment(prisma: PrismaClient, input: { businessId: string; paymentId: string; reason: string; actor?: string }): Promise<TradePayment> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const payment = await scoped.tradePayment.findUnique({ where: { id: input.paymentId } });
  if (!payment) throw new TradeError("NOT_FOUND", "Payment not found.");
  if (payment.state !== "PROPOSED") throw new TradeError("WRONG_STATE", `This payment is already ${payment.state.toLowerCase()}.`);
  if (!input.reason.trim()) throw new TradeError("INVALID", "Say why you are rejecting it.");
  const invoice = await scoped.tradeInvoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
  return withScopedTransaction(scoped, async (tx) => {
    const claimed = await tx.tradePayment.updateMany({ where: { id: payment.id, state: "PROPOSED" }, data: { state: "REJECTED", reason: input.reason.trim() } });
    if (claimed.count !== 1) throw new TradeError("WRONG_STATE", "The payment was just handled by someone else.");
    if (payment.counterpartPaymentId) {
      await enqueueTradeEvent(tx, {
        businessId: input.businessId, orderId: invoice.orderId, eventType: "trade.payment.resolved", dedupeKey: `trade.payment.resolved:${payment.id}`,
        payload: { fromBusinessId: input.businessId, paymentId: payment.id, state: "REJECTED", reason: input.reason.trim() },
      });
    }
    return tx.tradePayment.findUniqueOrThrow({ where: { id: payment.id } });
  });
}

/**
 * Authenticated-evidence payment on a SELLER's invoice (used by the simulator callback and, in Phase 5, real providers).
 * Idempotent per (provider, externalId): a replayed callback returns the first result and posts nothing again. A payment
 * that does not fit (wrong currency, more than owing, closed invoice) is stored HELD for a human, never applied.
 */
export async function applyProviderPayment(
  prisma: PrismaClient,
  input: { sellerBusinessId: string; invoiceId: string; provider: string; externalId: string; amountMinor: bigint; currencyCode: string; evidence: "SIMULATOR_CONFIRMED" | "PROVIDER_CONFIRMED"; forceHold?: string; now?: Date },
): Promise<{ payment: TradePayment; replayed: boolean }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.sellerBusinessId);
  const existing = await scoped.tradePayment.findFirst({ where: { provider: input.provider, externalId: input.externalId } });
  if (existing) return { payment: existing, replayed: true };
  const invoice = await scoped.tradeInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice || invoice.side !== "SELL") throw new TradeError("NOT_FOUND", "No such sales invoice for this seller.");

  const reason =
    input.forceHold ? input.forceHold
    : input.amountMinor <= 0n ? "Amount must be positive."
    : input.currencyCode !== invoice.currencyCode ? `Currency ${input.currencyCode} does not match the invoice (${invoice.currencyCode}).`
    : invoice.status !== "ISSUED" ? "The invoice is not open."
    : input.amountMinor > invoice.totalMinor - invoice.creditedMinor - invoice.paidMinor ? "More than remains owing on the invoice."
    : null;

  return withScopedTransaction(scoped, async (tx) => {
    if (reason) {
      const held = await tx.tradePayment.create({
        data: { businessId: input.sellerBusinessId, invoiceId: invoice.id, direction: "IN", amountMinor: input.amountMinor > 0n ? input.amountMinor : 1n, currencyCode: input.currencyCode, method: "MOBILE_MONEY", evidence: input.evidence, state: "HELD", provider: input.provider, externalId: input.externalId, reason },
      });
      return { payment: held, replayed: false };
    }
    if (!(await applyToInvoice(tx, input.sellerBusinessId, invoice.id, input.amountMinor))) throw new TradeError("OVER_PAYMENT", "More than remains owing on the invoice.");
    const payment = await tx.tradePayment.create({
      data: {
        businessId: input.sellerBusinessId, invoiceId: invoice.id, direction: "IN", amountMinor: input.amountMinor, currencyCode: invoice.currencyCode, method: "MOBILE_MONEY",
        evidence: input.evidence, state: "APPLIED", provider: input.provider, externalId: input.externalId, appliedAt: now,
      },
    });
    // collected by the provider, not yet settled to the seller: Provider clearing, never revenue
    await journalPayment(tx, { businessId: input.sellerBusinessId, currencyCode: invoice.currencyCode, direction: "IN", method: "MOBILE_MONEY", amountMinor: input.amountMinor, paymentId: payment.id, now, evidenceRef: `${input.provider}:${input.externalId}`, clearing: true });
    return { payment, replayed: false };
  });
}

/** The buyer's matching record of a payment made through authenticated evidence on the seller's invoice. Idempotent. */
export async function applyProviderPaymentToBuyer(
  prisma: PrismaClient,
  input: { buyerBusinessId: string; buyerInvoiceId: string; provider: string; externalId: string; amountMinor: bigint; evidence: "SIMULATOR_CONFIRMED" | "PROVIDER_CONFIRMED"; counterpartPaymentId: string; now?: Date },
): Promise<TradePayment | null> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.buyerBusinessId);
  const existing = await scoped.tradePayment.findFirst({ where: { provider: input.provider, externalId: input.externalId } });
  if (existing) return existing;
  const invoice = await scoped.tradeInvoice.findUnique({ where: { id: input.buyerInvoiceId } });
  if (!invoice || invoice.side !== "BUY" || invoice.status !== "ISSUED") return null;
  return withScopedTransaction(scoped, async (tx) => {
    if (!(await applyToInvoice(tx, input.buyerBusinessId, invoice.id, input.amountMinor))) return null;
    const payment = await tx.tradePayment.create({
      data: {
        businessId: input.buyerBusinessId, invoiceId: invoice.id, direction: "OUT", amountMinor: input.amountMinor, currencyCode: invoice.currencyCode, method: "MOBILE_MONEY",
        evidence: input.evidence, state: "APPLIED", provider: input.provider, externalId: input.externalId, counterpartPaymentId: input.counterpartPaymentId, appliedAt: now,
      },
    });
    await journalPayment(tx, { businessId: input.buyerBusinessId, currencyCode: invoice.currencyCode, direction: "OUT", method: "MOBILE_MONEY", amountMinor: input.amountMinor, paymentId: payment.id, now, evidenceRef: `${input.provider}:${input.externalId}` });
    return payment;
  });
}
