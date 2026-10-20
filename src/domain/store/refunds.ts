import type { PrismaClient, StorePayment, StoreRefundKind, StoreRefundRequest, TradePaymentMethod } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction } from "../../db/tenantScope.js";
import { divRoundHalfUp } from "../rounding.js";
import { restockReturn } from "../stock.js";
import { ensureDefaultShopFor } from "../shops.js";
import { StoreError } from "./common.js";
import { journalStoreRefund } from "./journal.js";
import { loadStoreOrder, refundPolicy } from "./orders.js";

/**
 * Returns and refunds (expansion Phase 4). A refund REQUEST is not a refund:
 *   1. the buyer asks (only after hand-over, inside the seller's own return window);
 *   2. the seller approves or denies;
 *   3. for a RETURN the goods come back, are received and accepted line by line (only then do they go back into stock, at the
 *      cost they left at), and the approved amount is the value of what was accepted;
 *   4. the seller records the refund, which can never take total refunds above what was actually paid (a guarded update plus
 *      a database CHECK, so two simultaneous refunds cannot both succeed beyond the limit).
 * Orders cancelled or expired after payment owe the buyer their money back without a request; the seller records that refund
 * the same way.
 */
export async function requestRefund(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; kind: StoreRefundKind; reason: string; lines?: { orderLineId: string; quantityBase: number }[]; requestedAmountMinor?: bigint; now?: Date },
): Promise<StoreRefundRequest> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const order = await loadStoreOrder(scoped, input.orderId);
  const sf = await scoped.storefront.findFirst({ where: {} });
  const policy = refundPolicy(order, sf?.returnWindowDays ?? null, now);
  if (!policy.allowed) throw new StoreError("NOT_ALLOWED", policy.message);
  const reason = input.reason.trim();
  if (reason.length < 5) throw new StoreError("INVALID", "Tell the seller what is wrong.");

  return withScopedTransaction(scoped, async (tx) => {
    const open = await tx.storeRefundRequest.findMany({ where: { orderId: order.id, status: { in: ["REQUESTED", "APPROVED", "GOODS_RECEIVED"] } }, include: { lines: true } });
    if (input.kind === "RETURN") {
      if (!input.lines?.length) throw new StoreError("INVALID", "Choose what you are returning.");
      for (const l of input.lines) {
        const ol = order.lines.find((x) => x.id === l.orderLineId);
        if (!ol) throw new StoreError("INVALID", "One of those items is not on this order.");
        if (!Number.isInteger(l.quantityBase) || l.quantityBase < 1) throw new StoreError("INVALID", "Return a whole number of items.");
        const pending = open.flatMap((r) => r.lines).filter((x) => x.orderLineId === ol.id).reduce((n, x) => n + x.quantityBase, 0);
        if (l.quantityBase > ol.baseQuantity - ol.returnedBase - pending) throw new StoreError("OVER_QUANTITY", `You cannot return more than you received (${ol.description}).`);
      }
      return tx.storeRefundRequest.create({
        data: { businessId: input.businessId, orderId: order.id, kind: "RETURN", reason: reason.slice(0, 500), lines: { create: input.lines.map((l) => ({ businessId: input.businessId, orderLineId: l.orderLineId, quantityBase: l.quantityBase })) } },
      });
    }
    const amount = input.requestedAmountMinor;
    if (amount === undefined || amount <= 0n) throw new StoreError("INVALID", "Say how much you are asking to be refunded.");
    if (amount > order.paidMinor - order.refundedMinor) throw new StoreError("REFUND_LIMIT", "That is more than you paid and have not been refunded.");
    return tx.storeRefundRequest.create({ data: { businessId: input.businessId, orderId: order.id, kind: "REFUND_ONLY", reason: reason.slice(0, 500), requestedAmountMinor: amount } });
  });
}

export async function decideRefund(
  prisma: PrismaClient,
  input: { businessId: string; requestId: string; approve: boolean; approvedAmountMinor?: bigint; note?: string; actor?: string; now?: Date },
): Promise<StoreRefundRequest> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const req = await scoped.storeRefundRequest.findUnique({ where: { id: input.requestId } });
  if (!req) throw new StoreError("NOT_FOUND", "Request not found.");
  if (req.status !== "REQUESTED") throw new StoreError("WRONG_STATE", `That request is already ${req.status.toLowerCase().replace(/_/g, " ")}.`);
  let approved: bigint | null = null;
  if (input.approve && req.kind === "REFUND_ONLY") {
    const order = await loadStoreOrder(scoped, req.orderId);
    approved = input.approvedAmountMinor ?? req.requestedAmountMinor ?? null;
    if (approved === null || approved <= 0n) throw new StoreError("INVALID", "Say how much to refund.");
    if (approved > order.paidMinor - order.refundedMinor) throw new StoreError("REFUND_LIMIT", "That is more than has been paid and not yet refunded.");
  }
  return scoped.storeRefundRequest.update({
    where: { id: req.id }, data: { status: input.approve ? "APPROVED" : "DENIED", approvedAmountMinor: approved, decisionNote: input.note?.trim().slice(0, 300) ?? null, decidedBy: input.actor ?? null, decidedAt: input.now ?? new Date() },
  });
}

/** The goods are back. Each accepted line returns to stock at the cost it left at, and fixes the refund amount. */
export async function receiveReturn(
  prisma: PrismaClient,
  input: { businessId: string; requestId: string; accepted: { orderLineId: string; quantityBase: number }[]; actor?: string; now?: Date },
): Promise<StoreRefundRequest> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  return withScopedTransaction(scoped, async (tx) => {
    const req = await tx.storeRefundRequest.findUnique({ where: { id: input.requestId }, include: { lines: true } });
    if (!req) throw new StoreError("NOT_FOUND", "Request not found.");
    if (req.kind !== "RETURN" || req.status !== "APPROVED") throw new StoreError("WRONG_STATE", "Only an approved return can be received.");
    const order = await loadStoreOrder(tx, req.orderId);
    const shop = await ensureDefaultShopFor(tx, input.businessId);
    let value = 0n;
    for (const a of input.accepted) {
      const rl = req.lines.find((x) => x.orderLineId === a.orderLineId);
      const ol = order.lines.find((x) => x.id === a.orderLineId);
      if (!rl || !ol) throw new StoreError("INVALID", "That item is not part of this return.");
      if (!Number.isInteger(a.quantityBase) || a.quantityBase < 0 || a.quantityBase > rl.quantityBase) throw new StoreError("OVER_QUANTITY", "You cannot accept more than was requested.");
      if (a.quantityBase === 0) continue;
      const original = ol.fulfilMovementId ? await tx.stockMovement.findUnique({ where: { id: ol.fulfilMovementId } }) : null;
      const variant = await tx.productVariant.findUnique({ where: { id: ol.variantId } });
      if (variant?.trackStock) {
        await restockReturn(tx, {
          businessId: input.businessId, shopId: shop.id, variantId: ol.variantId, quantity: a.quantityBase, currencyCode: order.currencyCode, occurredAt: now, sourceType: "STORE_RETURN", sourceId: req.id,
          idempotencyKey: `store-return:${req.id}:${ol.id}`, ...(original?.unitCostMinor != null ? { unitCostMinor: original.unitCostMinor } : {}), ...(input.actor ? { actor: { type: "MERCHANT" as const, id: input.actor } } : {}),
        });
      }
      await tx.storeOrderLine.update({ where: { id: ol.id }, data: { returnedBase: ol.returnedBase + a.quantityBase } });
      await tx.storeRefundLine.update({ where: { id: rl.id }, data: { receivedBase: a.quantityBase } });
      value += divRoundHalfUp(ol.lineTotalMinor * BigInt(a.quantityBase), BigInt(ol.baseQuantity));
    }
    if (value <= 0n) throw new StoreError("INVALID", "Accept at least one item, or deny the return.");
    return tx.storeRefundRequest.update({ where: { id: req.id }, data: { status: "GOODS_RECEIVED", approvedAmountMinor: value } });
  });
}

/**
 * Records money handed back. Bounded by what was paid: refunds can never total more than paidMinor. For a request, the amount
 * is the one approved (a return's value, or the approved refund); each request is refunded once.
 */
export async function issueStoreRefund(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; amountMinor?: bigint; method: TradePaymentMethod; requestId?: string; actor?: string; now?: Date },
): Promise<StorePayment> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  return withScopedTransaction(scoped, async (tx) => {
    const order = await loadStoreOrder(tx, input.orderId);
    let amount = input.amountMinor;
    let request: StoreRefundRequest | null = null;
    if (input.requestId) {
      request = await tx.storeRefundRequest.findUnique({ where: { id: input.requestId } });
      if (!request || request.orderId !== order.id) throw new StoreError("NOT_FOUND", "Request not found for this order.");
      if (request.status === "REFUNDED") throw new StoreError("WRONG_STATE", "This request has already been refunded.");
      const ready = request.kind === "RETURN" ? request.status === "GOODS_RECEIVED" : request.status === "APPROVED";
      if (!ready || request.approvedAmountMinor === null) throw new StoreError("WRONG_STATE", request.kind === "RETURN" ? "Receive the returned goods before refunding." : "Approve the request before refunding.");
      if (amount !== undefined && amount !== request.approvedAmountMinor) throw new StoreError("REFUND_LIMIT", "A request is refunded exactly as approved.");
      amount = request.approvedAmountMinor;
    } else if (order.status !== "CANCELLED" && order.status !== "EXPIRED") {
      throw new StoreError("NOT_ALLOWED", "Refund a completed order through a return or refund request.");
    }
    if (amount === undefined || amount <= 0n) throw new StoreError("INVALID", "Say how much to refund.");
    const done = await tx.$executeRaw`UPDATE "StoreOrder" SET "refundedMinor" = "refundedMinor" + ${amount} WHERE "id" = ${order.id} AND "businessId" = ${input.businessId} AND "refundedMinor" + ${amount} <= "paidMinor"`;
    if (done !== 1) throw new StoreError("REFUND_LIMIT", "That would refund more than was paid.");
    const providerPaid = (await tx.storePayment.count({ where: { orderId: order.id, direction: "IN", state: "APPLIED", evidence: { not: "MERCHANT_RECORDED" } } })) > 0;
    const payment = await tx.storePayment.create({
      data: { businessId: input.businessId, orderId: order.id, direction: "OUT", amountMinor: amount, currencyCode: order.currencyCode, method: input.method, evidence: "MERCHANT_RECORDED", state: "APPLIED", reason: request ? `Refund for request ${request.id}` : "Refund of a cancelled order", createdBy: input.actor ?? null },
    });
    await journalStoreRefund(tx, { order, amountMinor: amount, method: input.method, clearing: providerPaid, paymentId: payment.id, now, afterHandover: order.status === "COMPLETED" });
    if (request) await tx.storeRefundRequest.update({ where: { id: request.id }, data: { status: "REFUNDED" } });
    return payment;
  });
}
