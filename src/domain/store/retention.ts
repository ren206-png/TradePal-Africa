import type { PrismaClient } from "@prisma/client";

/**
 * Shopper data retention (decision on OPEN-8). A shopper's name, phone number, delivery address and notes are needed to fulfil an order and to
 * deal with a return or complaint, not for ever. After `months` months (default 24, `SHOPPER_DATA_RETENTION_MONTHS`; 0 turns it off) from the
 * last event on a finished order, the PERSONAL fields are replaced; the order's amounts, items, status history and journals are financial records
 * and are never touched. Orders with anything still open (a refund or cancellation request, a payment exception, an unclosed support case) are
 * skipped. Consent and opt-out records are kept: an opt-out must be honoured for as long as the number could be contacted.
 */
export const DEFAULT_SHOPPER_RETENTION_MONTHS = 24;
export const REMOVED = "(removed)";

export function retentionMonthsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["SHOPPER_DATA_RETENTION_MONTHS"];
  if (raw === undefined || raw === "") return DEFAULT_SHOPPER_RETENTION_MONTHS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 240 ? n : DEFAULT_SHOPPER_RETENTION_MONTHS;
}

export async function anonymizeOldShopperData(prisma: PrismaClient, now: Date = new Date(), months: number = retentionMonthsFromEnv()): Promise<{ orders: number; cases: number }> {
  if (months <= 0) return { orders: 0, cases: 0 };
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const candidates = await prisma.storeOrder.findMany({
    where: { status: { in: ["COMPLETED", "CANCELLED", "EXPIRED"] }, buyerName: { not: REMOVED }, OR: [{ completedAt: { lte: cutoff } }, { completedAt: null, cancelledAt: { lte: cutoff } }, { completedAt: null, cancelledAt: null, placedAt: { lte: cutoff } }] },
    select: { id: true, businessId: true },
    take: 500,
  });
  let orders = 0;
  for (const c of candidates) {
    const open =
      (await prisma.storeRefundRequest.count({ where: { orderId: c.id, status: { in: ["REQUESTED", "APPROVED", "GOODS_RECEIVED"] } } })) +
      (await prisma.storeCancellationRequest.count({ where: { orderId: c.id, status: "REQUESTED" } })) +
      (await prisma.paymentException.count({ where: { orderId: c.id, status: "OPEN" } })) +
      (await prisma.supportCase.count({ where: { orderId: c.id, status: { not: "CLOSED" } } }));
    if (open > 0) continue;
    await prisma.storeOrder.update({ where: { id: c.id }, data: { buyerName: REMOVED, buyerPhone: REMOVED, buyerNote: null, addressLine: null, landmark: null, area: null, latitude: null, longitude: null } });
    orders++;
  }
  const cases = (await prisma.supportCase.updateMany({ where: { status: "CLOSED", closedAt: { lte: cutoff }, OR: [{ contactName: { not: null } }, { contactPhone: { not: null } }] }, data: { contactName: null, contactPhone: null } })).count;
  return { orders, cases };
}
