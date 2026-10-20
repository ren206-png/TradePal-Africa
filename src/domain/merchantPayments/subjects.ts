import type { PaymentAttempt, PaymentIntent, PaymentSubjectType, PrismaClient, TradePaymentEvidence } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import { applyStoreProviderPayment } from "../store/payments.js";
import { applyProviderPayment, applyProviderPaymentToBuyer } from "../trade/payments.js";
import { PaymentsError } from "./common.js";

/**
 * What a payment intent pays for. Two subject types exist: a consumer store order and a B2B sales invoice. The payment layer asks
 * the subject how much is owed and where the money goes; it never edits an order or an invoice itself.
 */
export interface SubjectInfo {
  reference: string;
  owedMinor: bigint;
  currencyCode: string;
  /** When the offer to pay lapses (an order's stock hold; an invoice stays payable much longer). */
  expiresAt: Date;
}

const INVOICE_INTENT_TTL_MS = 14 * 86_400_000;
const ORDER_FALLBACK_TTL_MS = 60 * 60_000;

export async function describeSubject(prisma: PrismaClient, businessId: string, type: PaymentSubjectType, id: string, now: Date): Promise<SubjectInfo> {
  const scoped = getTenantScopedClient(prisma, businessId);
  if (type === "STORE_ORDER") {
    const o = await scoped.storeOrder.findUnique({ where: { id } });
    if (!o) throw new PaymentsError("NOT_FOUND", "No such order.");
    if (o.paymentMethod !== "ONLINE_SIMULATED") throw new PaymentsError("NOT_PAYABLE", "This order is paid on collection, not online.");
    if (o.status !== "PLACED") throw new PaymentsError("NOT_PAYABLE", `This order is ${o.status.toLowerCase().replace(/_/g, " ")}; it cannot take a payment.`);
    const owed = o.totalMinor - o.paidMinor;
    if (owed <= 0n) throw new PaymentsError("NOT_PAYABLE", "This order is already paid.");
    return { reference: o.reference, owedMinor: owed, currencyCode: o.currencyCode, expiresAt: o.reservedUntil ?? new Date(now.getTime() + ORDER_FALLBACK_TTL_MS) };
  }
  const inv = await scoped.tradeInvoice.findUnique({ where: { id } });
  if (!inv || inv.side !== "SELL") throw new PaymentsError("NOT_FOUND", "No such sales invoice.");
  if (inv.status !== "ISSUED") throw new PaymentsError("NOT_PAYABLE", "This invoice is not open.");
  const owed = inv.totalMinor - inv.creditedMinor - inv.paidMinor;
  if (owed <= 0n) throw new PaymentsError("NOT_PAYABLE", "This invoice is already paid.");
  return { reference: inv.number, owedMinor: owed, currencyCode: inv.currencyCode, expiresAt: new Date(now.getTime() + INVOICE_INTENT_TTL_MS) };
}

export interface SubjectApplication {
  state: "APPLIED" | "HELD";
  storePaymentId?: string;
  tradePaymentId?: string;
}

/**
 * Applies one confirmed attempt to its subject. Idempotent: the subject's own payment row is unique per (provider, externalId), so a
 * retry after a crash converges. When the intent is no longer open the money is HELD (a late success is an exception, never silent).
 */
export async function applyToSubject(
  prisma: PrismaClient, attempt: PaymentAttempt, intent: PaymentIntent, capturedMinor: bigint, evidence: Extract<TradePaymentEvidence, "SIMULATOR_CONFIRMED" | "PROVIDER_CONFIRMED">, now: Date,
): Promise<SubjectApplication> {
  const externalId = attempt.externalRef!;
  const forceHold = intent.status !== "OPEN";
  if (intent.subjectType === "STORE_ORDER") {
    const r = await applyStoreProviderPayment(prisma, {
      sellerBusinessId: attempt.businessId, orderId: intent.subjectId, provider: attempt.provider, externalId, amountMinor: capturedMinor, currencyCode: attempt.currencyCode, evidence, forceHold, now,
    });
    return { state: r.payment.state === "APPLIED" ? "APPLIED" : "HELD", storePaymentId: r.payment.id };
  }
  const seller = getTenantScopedClient(prisma, attempt.businessId);
  const invoice = await seller.tradeInvoice.findUnique({ where: { id: intent.subjectId } });
  if (!invoice) throw new PaymentsError("NOT_FOUND", "The invoice named by this payment no longer exists.");
  const { payment } = await applyProviderPayment(prisma, {
    sellerBusinessId: attempt.businessId, invoiceId: intent.subjectId, provider: attempt.provider, externalId, amountMinor: capturedMinor, currencyCode: attempt.currencyCode, evidence,
    ...(forceHold ? { forceHold: "The payment request had already closed (expired or cancelled)." } : {}), now,
  });
  if (payment.state === "APPLIED" && invoice.counterpartInvoiceId) {
    const buyerInvoice = await prisma.tradeInvoice.findUnique({ where: { id: invoice.counterpartInvoiceId } });
    if (buyerInvoice) {
      const mirrored = await applyProviderPaymentToBuyer(prisma, {
        buyerBusinessId: buyerInvoice.businessId, buyerInvoiceId: buyerInvoice.id, provider: attempt.provider, externalId, amountMinor: capturedMinor, evidence, counterpartPaymentId: payment.id, now,
      });
      if (mirrored && !payment.counterpartPaymentId) await seller.tradePayment.update({ where: { id: payment.id }, data: { counterpartPaymentId: mirrored.id } });
    }
  }
  return { state: payment.state === "APPLIED" ? "APPLIED" : "HELD", tradePaymentId: payment.id };
}
