import type { CreditNote, GoodsMovementStatus, Prisma, PrismaClient, Shipment, ShipmentLine, TradeInvoice, TradeOrderLine } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../../db/tenantScope.js";
import { postJournal, postStockPurchase } from "../accounting.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { divRoundHalfUp } from "../rounding.js";
import { ensureDefaultShopFor } from "../shops.js";
import { StockError, fulfilReservation, postStockMovement } from "../stock.js";
import { FLAG_JOURNALS, TradeError, cumulativeValue, nextReference, requireTradeEnabled } from "./common.js";
import { enqueueTradeEvent, loadOrder } from "./orders.js";

/**
 * Goods movement, invoicing and receipt (expansion Phase 3). Separate state machines:
 *
 *   goods:    NOT_SHIPPED -> PARTIALLY_SHIPPED -> SHIPPED, and on the buyer's side PARTIALLY_RECEIVED -> RECEIVED
 *   invoice:  one invoice per shipment (ISSUED); payment status is derived from payments and credit notes
 *
 * "Delivery received" never implies "supplier paid", and a purchase ORDER never increases stock: only a goods
 * receipt does, and only for what the buyer confirms arrived (accepted or quarantined). Short units are not received.
 * Invoice and receipt values use cumulative rounding, so the parts add up to the order line total exactly.
 */
const DAY = 86_400_000;

export interface ShipLineInput {
  orderLineId: string;
  /** Units (in the product's BASE unit) leaving in this shipment. */
  baseQuantity: number;
}

function movementOf(lines: { baseQuantity: number; shippedBase: number; receivedBase: number }[], accountedByLine?: number[]): GoodsMovementStatus {
  const allShipped = lines.every((l) => l.shippedBase === l.baseQuantity);
  const anyShipped = lines.some((l) => l.shippedBase > 0);
  if (accountedByLine && allShipped && lines.every((l, i) => (accountedByLine[i] ?? 0) === l.baseQuantity)) return "RECEIVED";
  if (accountedByLine && lines.some((l, i) => (accountedByLine[i] ?? 0) > 0)) return "PARTIALLY_RECEIVED";
  if (!anyShipped) return "NOT_SHIPPED";
  return allShipped ? "SHIPPED" : "PARTIALLY_SHIPPED";
}

export function invoiceOutstanding(inv: Pick<TradeInvoice, "totalMinor" | "creditedMinor" | "paidMinor">): bigint {
  return inv.totalMinor - inv.creditedMinor - inv.paidMinor;
}

export function invoicePaymentView(inv: Pick<TradeInvoice, "totalMinor" | "creditedMinor" | "paidMinor" | "dueDate" | "status">, now: Date = new Date()) {
  const outstanding = invoiceOutstanding(inv);
  const paymentStatus = outstanding === 0n ? "PAID" : inv.paidMinor > 0n ? "PARTIALLY_PAID" : "UNPAID";
  const overdue = outstanding > 0n && inv.dueDate !== null && inv.dueDate < now;
  return { outstandingMinor: outstanding, paymentStatus, overdue, overdueDays: overdue && inv.dueDate ? Math.floor((now.getTime() - inv.dueDate.getTime()) / DAY) : 0 } as const;
}

// ---------------------------------------------------------------------------------------- shipping

/**
 * The seller ships all or part of an accepted order. In ONE transaction: the held stock leaves (keeping the unshipped
 * remainder reserved), the shipment and its invoice are created for exactly what shipped, and (journals on) revenue is
 * recognised: Dr Receivable, Cr Sales. The buyer's copy follows by outbox event.
 */
export async function shipOrder(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; lines: ShipLineInput[]; waybillRef?: string; carrier?: string; actor?: string; now?: Date },
): Promise<{ shipment: Shipment & { lines: ShipmentLine[] }; invoice: TradeInvoice }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "SELL" || order.acceptance !== "ACCEPTED") throw new TradeError("WRONG_STATE", "Only an accepted sales order can ship.");
  if (input.lines.length === 0) throw new TradeError("INVALID", "A shipment needs at least one line.");
  const seen = new Set<string>();
  for (const sl of input.lines) {
    const l = order.lines.find((x) => x.id === sl.orderLineId);
    if (!l) throw new TradeError("INVALID", "A shipment line is not on this order.");
    if (seen.has(sl.orderLineId)) throw new TradeError("INVALID", "List each order line once per shipment.");
    seen.add(sl.orderLineId);
    if (!Number.isInteger(sl.baseQuantity) || sl.baseQuantity <= 0) throw new TradeError("INVALID", "Shipped quantity must be a positive whole number.");
    if (sl.baseQuantity > l.baseQuantity - l.shippedBase) throw new TradeError("OVER_QUANTITY", `Line ${l.lineNo}: only ${l.baseQuantity - l.shippedBase} left to ship.`);
  }

  return withScopedTransaction(scoped, async (tx) => {
    const existing = await tx.shipment.findMany({ where: { orderId: order.id }, select: { number: true } });
    const number = existing.reduce((m, s) => Math.max(m, s.number), 0) + 1;
    const shipment = await tx.shipment.create({
      data: {
        businessId: input.businessId, orderId: order.id, side: "SELL", number, waybillRef: input.waybillRef ?? null, carrier: input.carrier ?? null, dispatchedAt: now, createdBy: input.actor ?? null,
        lines: { create: input.lines.map((sl) => ({ businessId: input.businessId, orderLineId: sl.orderLineId, baseQuantity: sl.baseQuantity })) },
      },
      include: { lines: true },
    });

    const invoiceLines: Prisma.TradeInvoiceLineUncheckedCreateWithoutInvoiceInput[] = [];
    let invoiceTotal = 0n;
    for (const sl of input.lines) {
      const l = order.lines.find((x) => x.id === sl.orderLineId)!;
      const variant = l.variantId ? await tx.productVariant.findUnique({ where: { id: l.variantId } }) : null;
      if (variant?.trackStock) {
        if (!l.reservationId) throw new TradeError("RESERVATION_CLOSED", `Line ${l.lineNo} has no stock hold. Renew the hold first.`);
        try {
          await fulfilReservation(tx, l.reservationId, {
            quantity: sl.baseQuantity, keepRemainder: true, currencyCode: order.currencyCode, sourceType: "TRADE_SHIPMENT", sourceId: shipment.id, now,
            ...(input.actor ? { actor: { type: "MERCHANT" as const, id: input.actor } } : {}),
          });
        } catch (error) {
          if (error instanceof StockError && error.code === "RESERVATION_CLOSED") throw new TradeError("RESERVATION_CLOSED", `The stock hold for line ${l.lineNo} has expired. Renew the hold, then ship.`);
          throw error;
        }
      }
      const newShipped = l.shippedBase + sl.baseQuantity;
      const moved = await tx.tradeOrderLine.updateMany({ where: { id: l.id, shippedBase: l.shippedBase }, data: { shippedBase: newShipped } });
      if (moved.count !== 1) throw new TradeError("WRONG_STATE", "The order was just changed by someone else.");
      const value = cumulativeValue(l.lineTotalMinor, l.baseQuantity, newShipped) - cumulativeValue(l.lineTotalMinor, l.baseQuantity, l.shippedBase);
      invoiceTotal += value;
      invoiceLines.push({
        businessId: input.businessId, orderLineId: l.id, description: l.description, sku: l.sku, unit: l.unit, packBaseQuantity: l.packBaseQuantity, baseQuantity: sl.baseQuantity,
        unitPriceMinor: l.unitPriceMinor, lineTotalMinor: value,
      });
    }
    if (invoiceTotal <= 0n) throw new TradeError("UNPRICED", "The shipment has no value to invoice.");

    const fresh = await loadOrder(tx, order.id);
    await tx.tradeOrder.update({ where: { id: order.id }, data: { movement: movementOf(fresh.lines) } });

    const terms = order.paymentTermsDays;
    const invoice = await tx.tradeInvoice.create({
      data: {
        businessId: input.businessId, side: "SELL", partnerId: order.partnerId, orderId: order.id, shipmentId: shipment.id, number: await nextReference(tx, "SELL", "invoice"),
        currencyCode: order.currencyCode, totalMinor: invoiceTotal, issuedAt: now, dueDate: terms !== null ? new Date(now.getTime() + terms * DAY) : null,
        lines: { create: invoiceLines },
      },
    });

    if (await isFeatureEnabled(tx, input.businessId, FLAG_JOURNALS)) {
      await postJournal(tx, {
        businessId: input.businessId, currencyCode: order.currencyCode, kind: "SALE", occurredAt: now, idempotencyKey: `trade-invoice:${invoice.id}`,
        source: { type: "TRADE_INVOICE", id: invoice.id }, memo: `Invoice ${invoice.number}`, actor: { type: "MERCHANT", ...(input.actor ? { id: input.actor } : {}) },
        lines: [{ account: "AR", debitMinor: invoiceTotal }, { account: "SALES_REVENUE", creditMinor: invoiceTotal }],
      });
    }
    if (order.counterpartOrderId) {
      await enqueueTradeEvent(tx, {
        businessId: input.businessId, orderId: order.id, eventType: "trade.shipment.dispatched", dedupeKey: `trade.shipment.dispatched:${shipment.id}`,
        payload: { sellerBusinessId: input.businessId, shipmentId: shipment.id, invoiceId: invoice.id },
      });
    }
    return { shipment, invoice };
  });
}

// --------------------------------------------------------------------------------------- receiving

export interface ReceiveLineInput {
  shipmentLineId: string;
  acceptedBase: number;
  damagedBase?: number;
  shortBase?: number;
  reason?: string;
}

/**
 * The buyer confirms what actually arrived on a shipment, line by line: accepted (sellable stock), damaged (goes to
 * quarantine, still owned and paid for) and short (never arrived: not received, not booked). A receipt can be partial;
 * each one adds only what it records. Stock increases here and nowhere else, and (journals on) Dr Inventory, Cr
 * Payables is booked for the value received.
 */
export async function receiveShipment(
  prisma: PrismaClient,
  input: { businessId: string; shipmentId: string; lines: ReceiveLineInput[]; note?: string; actor?: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const shipment = await scoped.shipment.findUnique({ where: { id: input.shipmentId }, include: { lines: true } });
  if (!shipment || shipment.side !== "BUY") throw new TradeError("NOT_FOUND", "Inbound shipment not found.");
  if (shipment.status === "RECEIVED") throw new TradeError("WRONG_STATE", "This shipment is already fully accounted for.");
  if (input.lines.length === 0) throw new TradeError("INVALID", "Record at least one line.");
  const seen = new Set<string>();
  for (const rl of input.lines) {
    const sl = shipment.lines.find((x) => x.id === rl.shipmentLineId);
    if (!sl) throw new TradeError("INVALID", "A receipt line is not on this shipment.");
    if (seen.has(rl.shipmentLineId)) throw new TradeError("INVALID", "List each shipment line once per receipt.");
    seen.add(rl.shipmentLineId);
    const parts = [rl.acceptedBase, rl.damagedBase ?? 0, rl.shortBase ?? 0];
    if (parts.some((n) => !Number.isInteger(n) || n < 0)) throw new TradeError("INVALID", "Quantities must be whole numbers, zero or more.");
    const total = parts[0]! + parts[1]! + parts[2]!;
    if (total === 0) throw new TradeError("INVALID", "Each line needs a quantity.");
    if (sl.acceptedBase + sl.damagedBase + sl.shortBase + total > sl.baseQuantity) throw new TradeError("OVER_QUANTITY", `Only ${sl.baseQuantity - sl.acceptedBase - sl.damagedBase - sl.shortBase} left to account for on this line.`);
  }

  return withScopedTransaction(scoped, async (tx) => {
    const shop = await ensureDefaultShopFor(tx, input.businessId);
    const order = await loadOrder(tx, shipment.orderId);
    const receipt = await tx.goodsReceipt.create({ data: { businessId: input.businessId, shipmentId: shipment.id, note: input.note ?? null, receivedBy: input.actor ?? null, receivedAt: now } });
    let bookedTotal = 0n;

    for (const rl of input.lines) {
      const sl = shipment.lines.find((x) => x.id === rl.shipmentLineId)!;
      const ol = order.lines.find((x) => x.id === sl.orderLineId);
      if (!ol) throw new TradeError("NOT_FOUND", "The order line for this shipment is missing.");
      const accepted = rl.acceptedBase;
      const damaged = rl.damagedBase ?? 0;
      const short = rl.shortBase ?? 0;
      const newReceived = ol.receivedBase + accepted + damaged;
      const value = cumulativeValue(ol.lineTotalMinor, ol.baseQuantity, newReceived) - cumulativeValue(ol.lineTotalMinor, ol.baseQuantity, ol.receivedBase);
      bookedTotal += value;

      const line = await tx.goodsReceiptLine.create({
        data: { businessId: input.businessId, receiptId: receipt.id, shipmentLineId: sl.id, acceptedBase: accepted, damagedBase: damaged, shortBase: short, reason: rl.reason ?? null, valueMinor: value },
      });
      await tx.shipmentLine.update({ where: { id: sl.id }, data: { acceptedBase: sl.acceptedBase + accepted, damagedBase: sl.damagedBase + damaged, shortBase: sl.shortBase + short } });
      const moved = await tx.tradeOrderLine.updateMany({ where: { id: ol.id, receivedBase: ol.receivedBase }, data: { receivedBase: newReceived } });
      if (moved.count !== 1) throw new TradeError("WRONG_STATE", "The order was just changed by someone else.");

      if ((accepted > 0 || damaged > 0) && ol.variantId) {
        const variant = await tx.productVariant.findUnique({ where: { id: ol.variantId } });
        if (variant?.trackStock) {
          // cost is per BASE unit; the price is per ordered unit (pack), so divide by the pack size
          const unitCost = divRoundHalfUp(ol.unitPriceMinor, BigInt(ol.packBaseQuantity));
          await postStockMovement(tx, {
            businessId: input.businessId, shopId: shop.id, variantId: variant.id, kind: "RECEIPT", onHandDelta: accepted, damagedDelta: damaged, unitCostMinor: unitCost,
            currencyCode: order.currencyCode, occurredAt: now, sourceType: "GOODS_RECEIPT", sourceId: receipt.id, idempotencyKey: `receipt:${line.id}`,
            provenance: "DOCUMENT_SUPPORTED", ...(input.actor ? { actor: { type: "MERCHANT" as const, id: input.actor } } : {}),
            ...(rl.reason ? { note: rl.reason } : {}),
          });
        }
      }
    }

    // shipment and order status, from what has now been accounted for
    const sLines = await tx.shipmentLine.findMany({ where: { shipmentId: shipment.id } });
    const done = sLines.every((l) => l.acceptedBase + l.damagedBase + l.shortBase === l.baseQuantity);
    await tx.shipment.update({ where: { id: shipment.id }, data: { status: done ? "RECEIVED" : "PARTIALLY_RECEIVED" } });
    const freshOrder = await loadOrder(tx, order.id);
    const allShipmentLines = await tx.shipmentLine.findMany({ where: { orderLineId: { in: freshOrder.lines.map((l) => l.id) } } });
    const accounted = freshOrder.lines.map((l) => allShipmentLines.filter((s) => s.orderLineId === l.id).reduce((n, s) => n + s.acceptedBase + s.damagedBase + s.shortBase, 0));
    await tx.tradeOrder.update({ where: { id: order.id }, data: { movement: movementOf(freshOrder.lines, accounted) } });

    if (bookedTotal > 0n && (await isFeatureEnabled(tx, input.businessId, FLAG_JOURNALS))) {
      await postStockPurchase(tx, {
        businessId: input.businessId, currencyCode: order.currencyCode, idempotencyKey: `trade-receipt:${receipt.id}`, amountMinor: bookedTotal, paidWith: "CREDIT", occurredAt: now,
        source: { type: "GOODS_RECEIPT", id: receipt.id }, provenance: "DOCUMENT_SUPPORTED", memo: `Goods received on ${order.reference}`,
        actor: { type: "MERCHANT", ...(input.actor ? { id: input.actor } : {}) },
      });
    }
    if (shipment.counterpartShipmentId) {
      await enqueueTradeEvent(tx, {
        businessId: input.businessId, orderId: order.id, eventType: "trade.receipt.recorded", dedupeKey: `trade.receipt.recorded:${receipt.id}`,
        payload: { buyerBusinessId: input.businessId, shipmentId: shipment.id, receiptId: receipt.id },
      });
    }
    return { receipt, bookedMinor: bookedTotal, shipmentComplete: done };
  });
}

// -------------------------------------------------------------------------------------- credit note

/**
 * Short delivery: the seller credits the value of units the buyer reported as not arrived. The amount is DERIVED from the
 * buyer's receipt, not typed in. Credit: Dr Sales returns, Cr Receivable. The buyer never booked the short units, so
 * their ledger needs no entry; only the invoice document is adjusted (price disputes and returned goods are a later
 * workflow).
 */
export async function issueShortDeliveryCredit(prisma: PrismaClient, input: { businessId: string; invoiceId: string; actor?: string; now?: Date }): Promise<CreditNote> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const invoice = await scoped.tradeInvoice.findUnique({ where: { id: input.invoiceId }, include: { lines: true } });
  if (!invoice || invoice.side !== "SELL") throw new TradeError("NOT_FOUND", "Sales invoice not found.");
  const shipmentLines = await scoped.shipmentLine.findMany({ where: { shipmentId: invoice.shipmentId } });
  let shortValue = 0n;
  for (const il of invoice.lines) {
    const sl = shipmentLines.find((s) => s.orderLineId === il.orderLineId);
    if (sl && sl.shortBase > 0) shortValue += divRoundHalfUp(il.lineTotalMinor * BigInt(sl.shortBase), BigInt(il.baseQuantity));
  }
  const creditable = shortValue - invoice.creditedMinor;
  if (creditable <= 0n) throw new TradeError("INVALID", "Nothing to credit: the buyer has not reported any short delivery on this invoice, or it is already credited.");

  return withScopedTransaction(scoped, async (tx) => {
    const done = await tx.$executeRaw`UPDATE "TradeInvoice" SET "creditedMinor" = "creditedMinor" + ${creditable} WHERE "id" = ${invoice.id} AND "businessId" = ${input.businessId} AND "creditedMinor" + "paidMinor" + ${creditable} <= "totalMinor"`;
    if (done !== 1) throw new TradeError("OVER_PAYMENT", "The invoice has been paid beyond what remains after this credit; settle the difference directly.");
    const note = await tx.creditNote.create({
      data: { businessId: input.businessId, side: "SELL", invoiceId: invoice.id, number: await nextReference(tx, "SELL", "credit"), amountMinor: creditable, reason: "Short delivery", createdBy: input.actor ?? null },
    });
    if (await isFeatureEnabled(tx, input.businessId, FLAG_JOURNALS)) {
      await postJournal(tx, {
        businessId: input.businessId, currencyCode: invoice.currencyCode, kind: "CREDIT_NOTE", occurredAt: now, idempotencyKey: `trade-credit:${note.id}`,
        source: { type: "CREDIT_NOTE", id: note.id }, memo: `Credit note ${note.number} on ${invoice.number}`, actor: { type: "MERCHANT", ...(input.actor ? { id: input.actor } : {}) },
        lines: [{ account: "SALES_RETURNS", debitMinor: creditable }, { account: "AR", creditMinor: creditable }],
      });
    }
    if (invoice.counterpartInvoiceId) {
      await enqueueTradeEvent(tx, {
        businessId: input.businessId, orderId: invoice.orderId, eventType: "trade.credit_note.issued", dedupeKey: `trade.credit_note.issued:${note.id}`,
        payload: { sellerBusinessId: input.businessId, creditNoteId: note.id },
      });
    }
    return note;
  });
}

export type { TradeOrderLine };
export type { TenantScopedClient };
