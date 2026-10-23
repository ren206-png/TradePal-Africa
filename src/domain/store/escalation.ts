import type { PrismaClient } from "@prisma/client";
import { openSupportCase } from "./cases.js";

/**
 * A seller who sits on a shopper's request must not be able to leave it unanswered forever (Phase 4 gap, closed by decision). A cancellation
 * or refund request that has had no decision for `afterDays` days (default 5) is escalated ONCE to a support case that TradePal itself
 * answers for. The request stays the seller's to decide: nothing is cancelled, refunded or decided on their behalf, and no money moves.
 * Idempotent: each request is escalated at most once (its id is in the case summary).
 */
export const ESCALATE_AFTER_DAYS = 5;

export async function escalateUnansweredRequests(prisma: PrismaClient, now: Date = new Date(), afterDays: number = ESCALATE_AFTER_DAYS): Promise<{ escalated: number }> {
  const cutoff = new Date(now.getTime() - afterDays * 86_400_000);
  let escalated = 0;
  const refunds = await prisma.storeRefundRequest.findMany({ where: { status: "REQUESTED", createdAt: { lte: cutoff } }, include: { order: { select: { id: true, reference: true, buyerName: true, buyerPhone: true, businessId: true } } } });
  const cancels = await prisma.storeCancellationRequest.findMany({ where: { status: "REQUESTED", createdAt: { lte: cutoff } }, include: { order: { select: { id: true, reference: true, buyerName: true, buyerPhone: true, businessId: true } } } });
  const work = [
    ...refunds.map((r) => ({ id: r.id, kind: "refund" as const, type: "REFUND" as const, order: r.order })),
    ...cancels.map((c) => ({ id: c.id, kind: "cancellation" as const, type: "OTHER" as const, order: c.order })),
  ];
  for (const w of work) {
    const marker = `[request ${w.id}]`;
    const existing = await prisma.supportCase.findFirst({ where: { orderId: w.order.id, summary: { contains: marker } }, select: { id: true } });
    if (existing) continue;
    await openSupportCase(prisma, {
      businessId: w.order.businessId, orderId: w.order.id, type: w.type, openedBy: "ADMIN", handledBy: "PLATFORM",
      summary: `${marker} The seller has not answered this shopper's ${w.kind} request on order ${w.order.reference} for ${afterDays} days. TradePal support is following up with the seller.`,
      contactName: w.order.buyerName, contactPhone: w.order.buyerPhone,
    }).catch((error: unknown) => {
      // too many open reports on the order already: the seller is already being chased
      if (!(error instanceof Error) || !/several open reports/.test(error.message)) throw error;
    });
    escalated++;
  }
  return { escalated };
}

/**
 * A delivery that has been "out for delivery" for `afterDays` days (default 7) with no hand-over, failure or cancellation is escalated ONCE to a
 * support case that TradePal follows up, so a parcel cannot be lost between a seller and a courier without anyone looking. The order stays the
 * seller's to complete or fail: nothing is changed on their behalf. Idempotent: each order is escalated at most once.
 */
export const STUCK_DELIVERY_DAYS = 7;

export async function escalateStuckDeliveries(prisma: PrismaClient, now: Date = new Date(), afterDays: number = STUCK_DELIVERY_DAYS): Promise<{ escalated: number }> {
  const cutoff = new Date(now.getTime() - afterDays * 86_400_000);
  const stuck = await prisma.storeOrder.findMany({ where: { status: "OUT_FOR_DELIVERY", dispatchedAt: { lte: cutoff } }, select: { id: true, reference: true, buyerName: true, buyerPhone: true, businessId: true }, take: 200 });
  let escalated = 0;
  for (const o of stuck) {
    const marker = `[delivery ${o.id}]`;
    if (await prisma.supportCase.findFirst({ where: { orderId: o.id, summary: { contains: marker } }, select: { id: true } })) continue;
    await openSupportCase(prisma, {
      businessId: o.businessId, orderId: o.id, type: "DELIVERY", openedBy: "ADMIN", handledBy: "PLATFORM",
      summary: `${marker} Order ${o.reference} has been out for delivery for ${afterDays} days with no hand-over. TradePal support is checking with the seller.`,
      contactName: o.buyerName, contactPhone: o.buyerPhone,
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !/several open reports/.test(error.message)) throw error;
    });
    escalated++;
  }
  return { escalated };
}
