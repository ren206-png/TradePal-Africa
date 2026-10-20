import type { PaymentException, PrismaClient, StoreOrder, StorePayment, TradePaymentEvidence, TradePaymentMethod } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../../db/tenantScope.js";
import { extendReservation, reserveStock, StockError } from "../stock.js";
import { ensureDefaultShopFor } from "../shops.js";
import { StoreError } from "./common.js";
import { journalStorePaymentIn, journalStoreRefund } from "./journal.js";
import { loadStoreOrder, type StoreOrderFull } from "./orders.js";

/**
 * Store payments (expansion Phase 4). Money is tracked as evidence, never as a second sale, and every outcome that does not fit
 * the order is kept as a recoverable EXCEPTION instead of being silently applied or dropped:
 *
 *   applied        exact amount, right currency, order still live and its hold not lapsed
 *   LATE_SUCCESS   the payment arrived after the order expired or was cancelled (or its hold lapsed): the money is held;
 *                  the seller can RE-RESERVE the stock and reinstate an expired order, or REFUND. Never silently oversold.
 *   OVERPAYMENT / UNDERPAYMENT / CURRENCY_MISMATCH   held for a person to refund or (for underpayment) apply as part-payment
 *
 * A replayed callback (same provider and external id) returns the first result and changes nothing.
 */
const HOUR = 3_600_000;
const LIVE: StoreOrder["status"][] = ["PLACED", "CONFIRMED", "READY", "OUT_FOR_DELIVERY"];

async function addPaid(tx: TenantScopedClient, businessId: string, orderId: string, amountMinor: bigint): Promise<boolean> {
  const n = await tx.$executeRaw`UPDATE "StoreOrder" SET "paidMinor" = "paidMinor" + ${amountMinor} WHERE "id" = ${orderId} AND "businessId" = ${businessId} AND "paidMinor" + ${amountMinor} <= "totalMinor" AND "status" IN ('PLACED','CONFIRMED','READY','OUT_FOR_DELIVERY')`;
  return n === 1;
}

/** Records money the seller collected on an order, inside a transaction the caller owns. */
export async function insertCollectedPayment(
  tx: TenantScopedClient,
  input: { order: StoreOrder; amountMinor: bigint; method: TradePaymentMethod; now: Date; actor?: string; reference?: string },
): Promise<StorePayment> {
  if (input.amountMinor <= 0n) throw new StoreError("INVALID", "A payment must be greater than zero.");
  if (!(await addPaid(tx, input.order.businessId, input.order.id, input.amountMinor))) throw new StoreError("OVER_PAYMENT", "That is more than remains to pay on this order, or the order is closed.");
  const payment = await tx.storePayment.create({
    data: { businessId: input.order.businessId, orderId: input.order.id, direction: "IN", amountMinor: input.amountMinor, currencyCode: input.order.currencyCode, method: input.method, evidence: "MERCHANT_RECORDED", state: "APPLIED", reason: input.reference ?? null, createdBy: input.actor ?? null },
  });
  await journalStorePaymentIn(tx, { businessId: input.order.businessId, currencyCode: input.order.currencyCode, amountMinor: input.amountMinor, method: input.method, clearing: false, paymentId: payment.id, now: input.now, evidenceRef: input.reference ?? null });
  return payment;
}

/** The seller records a payment received outside the system (cash, a mobile-money transfer to the seller). */
export async function recordStorePayment(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; amountMinor: bigint; method: TradePaymentMethod; reference?: string; actor?: string; now?: Date },
): Promise<StorePayment> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  return withScopedTransaction(scoped, async (tx) => {
    const order = await loadStoreOrder(tx, input.orderId);
    return insertCollectedPayment(tx, { order, amountMinor: input.amountMinor, method: input.method, now: input.now ?? new Date(), ...(input.reference ? { reference: input.reference } : {}), ...(input.actor ? { actor: input.actor } : {}) });
  });
}

// ------------------------------------------------------------------------- provider evidence

export interface ProviderPaymentInput {
  sellerBusinessId: string;
  orderId: string;
  provider: "simulator";
  externalId: string;
  amountMinor: bigint;
  currencyCode: string;
  evidence: Extract<TradePaymentEvidence, "SIMULATOR_CONFIRMED" | "PROVIDER_CONFIRMED">;
  now?: Date;
}

/** Applies one authenticated payment event to a store order, or holds it as an exception. Idempotent per (provider, externalId). */
export async function applyStoreProviderPayment(prisma: PrismaClient, input: ProviderPaymentInput): Promise<{ payment: StorePayment; replayed: boolean; exception: PaymentException | null }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.sellerBusinessId);
  const existing = await scoped.storePayment.findFirst({ where: { provider: input.provider, externalId: input.externalId } });
  if (existing) return { payment: existing, replayed: true, exception: null };
  const order = await scoped.storeOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new StoreError("NOT_FOUND", "No such order for this seller.");

  const remaining = order.totalMinor - order.paidMinor;
  const holdLapsed = order.status === "PLACED" && order.reservedUntil !== null && order.reservedUntil <= now;
  let exceptionType: PaymentException["type"] | null = null;
  if (input.amountMinor <= 0n) exceptionType = "UNDERPAYMENT";
  else if (input.currencyCode !== order.currencyCode) exceptionType = "CURRENCY_MISMATCH";
  else if (order.status === "EXPIRED" || order.status === "CANCELLED" || holdLapsed) exceptionType = "LATE_SUCCESS";
  else if (order.status === "COMPLETED" || remaining <= 0n || input.amountMinor > remaining) exceptionType = "OVERPAYMENT";
  else if (input.amountMinor < remaining) exceptionType = "UNDERPAYMENT";

  return withScopedTransaction(scoped, async (tx) => {
    const base = {
      businessId: input.sellerBusinessId, orderId: order.id, direction: "IN" as const, amountMinor: input.amountMinor > 0n ? input.amountMinor : 1n, currencyCode: input.currencyCode,
      method: "MOBILE_MONEY" as const, evidence: input.evidence, provider: input.provider, externalId: input.externalId,
    };
    if (exceptionType) {
      const payment = await tx.storePayment.create({ data: { ...base, state: "HELD", reason: `Held: ${exceptionType.toLowerCase().replace(/_/g, " ")}` } });
      // the money exists (the provider collected it), so it is booked as an advance even though it is not applied to the order
      await journalStorePaymentIn(tx, { businessId: input.sellerBusinessId, currencyCode: input.currencyCode, amountMinor: base.amountMinor, method: "MOBILE_MONEY", clearing: true, paymentId: payment.id, now, evidenceRef: `${input.provider}:${input.externalId}` });
      const exception = await tx.paymentException.create({
        data: { businessId: input.sellerBusinessId, orderId: order.id, type: exceptionType, amountMinor: base.amountMinor, paymentId: payment.id, details: { orderStatus: order.status, orderTotalMinor: order.totalMinor.toString(), paidMinor: order.paidMinor.toString(), currencyOnOrder: order.currencyCode, holdLapsed } },
      });
      return { payment, replayed: false, exception };
    }
    if (!(await addPaid(tx, input.sellerBusinessId, order.id, input.amountMinor))) throw new StoreError("OVER_PAYMENT", "The order cannot take that payment.");
    const payment = await tx.storePayment.create({ data: { ...base, state: "APPLIED" } });
    await journalStorePaymentIn(tx, { businessId: input.sellerBusinessId, currencyCode: input.currencyCode, amountMinor: input.amountMinor, method: "MOBILE_MONEY", clearing: true, paymentId: payment.id, now, evidenceRef: `${input.provider}:${input.externalId}` });
    if (order.status === "PLACED" && order.paymentMethod === "ONLINE_SIMULATED") {
      const sf = await tx.storefront.findFirstOrThrow({ where: {} });
      const until = new Date(now.getTime() + sf.pickupHoldHours * HOUR);
      const lines = await tx.storeOrderLine.findMany({ where: { orderId: order.id } });
      for (const l of lines) if (l.reservationId) await extendReservation(tx, l.reservationId, until);
      await tx.storeOrder.updateMany({ where: { id: order.id, status: "PLACED" }, data: { status: "CONFIRMED", confirmedAt: now, reservedUntil: until } });
    }
    return { payment, replayed: false, exception: null };
  });
}

// -------------------------------------------------------------------------------- exceptions

export type ExceptionAction = "REFUND" | "RE_RESERVE" | "APPLY";

/**
 * Resolves an open payment exception with a documented outcome:
 *  REFUND      give the held money back (any exception type)
 *  RE_RESERVE  LATE_SUCCESS on an EXPIRED order only: take the stock again for every line and reinstate the order, paid.
 *              If any line can no longer be supplied, nothing changes and the seller must refund. A CANCELLED order is
 *              never reinstated (the buyer chose to cancel).
 *  APPLY       UNDERPAYMENT on a live order: apply it as a part-payment (the balance is still due)
 */
export async function resolvePaymentException(
  prisma: PrismaClient,
  input: { businessId: string; exceptionId: string; action: ExceptionAction; refundMethod?: TradePaymentMethod; actor?: string; now?: Date },
): Promise<{ exception: PaymentException; order: StoreOrderFull }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  return withScopedTransaction(scoped, async (tx) => {
    const ex = await tx.paymentException.findUnique({ where: { id: input.exceptionId } });
    if (!ex) throw new StoreError("NOT_FOUND", "Exception not found.");
    if (ex.status !== "OPEN") throw new StoreError("WRONG_STATE", "This exception is already resolved.");
    const order = await loadStoreOrder(tx, ex.orderId);
    const held = ex.paymentId ? await tx.storePayment.findUnique({ where: { id: ex.paymentId } }) : null;
    if (!held || held.state !== "HELD") throw new StoreError("WRONG_STATE", "There is no held payment to resolve.");
    let resolution: string;

    if (input.action === "REFUND") {
      const refund = await tx.storePayment.create({
        data: { businessId: input.businessId, orderId: order.id, direction: "OUT", amountMinor: held.amountMinor, currencyCode: held.currencyCode, method: input.refundMethod ?? "MOBILE_MONEY", evidence: "MERCHANT_RECORDED", state: "APPLIED", reason: `Refund of held payment ${held.id}`, createdBy: input.actor ?? null },
      });
      await journalStoreRefund(tx, { order, amountMinor: held.amountMinor, method: refund.method, clearing: held.evidence !== "MERCHANT_RECORDED", paymentId: refund.id, now, afterHandover: false });
      await tx.storePayment.update({ where: { id: held.id }, data: { reason: `Held payment refunded (${refund.id})` } });
      resolution = "REFUNDED";
    } else if (input.action === "RE_RESERVE") {
      if (ex.type !== "LATE_SUCCESS") throw new StoreError("INVALID", "Only a late payment can be resolved by re-reserving the stock.");
      if (order.status !== "EXPIRED") throw new StoreError("WRONG_STATE", order.status === "CANCELLED" ? "The buyer cancelled this order, so it cannot be reinstated. Refund the payment." : "This order is not expired.");
      if (held.amountMinor !== order.totalMinor - order.paidMinor) throw new StoreError("INVALID", "The held amount is not the amount due on this order. Refund it.");
      const sf = await tx.storefront.findFirstOrThrow({ where: {} });
      const until = new Date(now.getTime() + sf.pickupHoldHours * HOUR);
      const shop = await ensureDefaultShopFor(tx, input.businessId);
      for (const l of order.lines) {
        const variant = await tx.productVariant.findUnique({ where: { id: l.variantId } });
        if (!variant?.trackStock) continue;
        try {
          const r = await reserveStock(tx, { businessId: input.businessId, shopId: shop.id, variantId: l.variantId, quantity: l.baseQuantity, reference: `store:${order.id}`, idempotencyKey: `store:${order.id}:${l.lineNo}:reinstate:${ex.id}`, expiresAt: until, now });
          await tx.storeOrderLine.update({ where: { id: l.id }, data: { reservationId: r.reservation.id } });
        } catch (error) {
          if (error instanceof StockError && error.code === "INSUFFICIENT_STOCK") throw new StoreError("UNAVAILABLE", `${l.description}: not enough stock to reinstate this order. Refund the payment instead.`);
          throw error;
        }
      }
      await tx.storeOrder.updateMany({ where: { id: order.id, status: "EXPIRED" }, data: { status: "CONFIRMED", confirmedAt: now, reservedUntil: until, cancelledAt: null, cancelledBy: null, cancelReason: null } });
      if (!(await addPaid(tx, input.businessId, order.id, held.amountMinor))) throw new StoreError("OVER_PAYMENT", "The order cannot take that payment.");
      await tx.storePayment.update({ where: { id: held.id }, data: { state: "APPLIED", reason: `Applied after re-reserving stock (exception ${ex.id})` } });
      resolution = "RE_RESERVED";
    } else {
      if (ex.type !== "UNDERPAYMENT") throw new StoreError("INVALID", "Only an underpayment can be applied as a part-payment.");
      if (!LIVE.includes(order.status)) throw new StoreError("WRONG_STATE", "This order is closed. Refund the payment.");
      if (!(await addPaid(tx, input.businessId, order.id, held.amountMinor))) throw new StoreError("OVER_PAYMENT", "The order cannot take that payment.");
      await tx.storePayment.update({ where: { id: held.id }, data: { state: "APPLIED", reason: `Applied as a part-payment (exception ${ex.id})` } });
      resolution = "APPLIED_PARTIAL";
    }
    const done = await tx.paymentException.update({ where: { id: ex.id }, data: { status: "RESOLVED", resolution, resolvedBy: input.actor ?? null, resolvedAt: now } });
    return { exception: done, order: await loadStoreOrder(tx, order.id) };
  });
}
