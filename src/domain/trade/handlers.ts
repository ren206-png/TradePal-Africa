import type { OutboxEvent, PrismaClient } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction } from "../../db/tenantScope.js";
import { processInbox, type CallbackHandler } from "../callbackInbox.js";
import { processOutbox, type OutboxHandler } from "../outbox.js";
import { PriceError } from "../pricing.js";
import { simulatorCallbackHandler, SIMULATOR_PROVIDER } from "../../payments/simulator.js";
import { TradeError, isUniqueViolation, nextReference } from "./common.js";
import { enqueueTradeEvent, finaliseQuoteAcceptance, freezeTerms, closeOrderRow, loadOrder } from "./orders.js";
import { getActiveLink, resolveSharedPrice } from "./partners.js";

/**
 * Outbox handlers that keep the two businesses' rows of the same document in step (expansion Phase 3).
 *
 * Rules every handler follows:
 *  - it writes each business's rows through THAT business's tenant-scoped client, in that business's own transaction;
 *  - it copies only agreed fields (quantities, agreed prices, statuses, references): never costs, stock levels, notes about
 *    the other party, or anything from the other business's books;
 *  - it is idempotent and order-independent: delivery is at-least-once, so state is SET from the source row (never
 *    "added to"), and creation is guarded by the unique counterpart ids.
 */
const payloadOf = (e: OutboxEvent) => e.payload as Record<string, string>;

async function otherSide(prisma: PrismaClient, fromBusinessId: string, fromPartnerId: string): Promise<string> {
  const partner = await prisma.tradePartner.findFirst({ where: { id: fromPartnerId, businessId: fromBusinessId } });
  if (!partner?.linkedBusinessId) throw new Error("The partner is not linked to a business.");
  return partner.linkedBusinessId;
}

async function rejectBuyerOrder(prisma: PrismaClient, businessId: string, orderId: string, reason: string, now = new Date()) {
  const scoped = getTenantScopedClient(prisma, businessId);
  await withScopedTransaction(scoped, async (tx) => {
    const o = await loadOrder(tx, orderId);
    if (o.acceptance !== "REQUESTED") return;
    await closeOrderRow(tx, o, "REJECTED", reason, now);
  });
}

// ---------------------------------------------------------------------- order lifecycle

async function onOrderRequested(prisma: PrismaClient, e: OutboxEvent): Promise<void> {
  const { buyerBusinessId, buyerOrderId } = payloadOf(e) as { buyerBusinessId: string; buyerOrderId: string };
  const buyer = getTenantScopedClient(prisma, buyerBusinessId);
  const bo = await loadOrder(buyer, buyerOrderId);
  if (bo.counterpartOrderId || bo.acceptance !== "REQUESTED") return;

  let active;
  try {
    active = await getActiveLink(prisma, buyerBusinessId, bo.partnerId);
  } catch (error) {
    if (error instanceof TradeError) return rejectBuyerOrder(prisma, buyerBusinessId, bo.id, "The link with this supplier is no longer active.");
    throw error;
  }
  const seller = getTenantScopedClient(prisma, active.counterpartBusinessId);

  const rebuilt: { bl: (typeof bo.lines)[number]; sv: { id: string; sku: string; name: string; productName: string } }[] = [];
  for (const bl of bo.lines) {
    const sv = bl.counterpartVariantId ? await seller.productVariant.findUnique({ where: { id: bl.counterpartVariantId }, include: { product: true } }) : null;
    if (!sv || sv.status !== "PUBLISHED") return rejectBuyerOrder(prisma, buyerBusinessId, bo.id, `${bl.sku} is no longer offered.`);
    try {
      const price = await resolveSharedPrice(prisma, {
        buyerBusinessId, linkId: active.link.id, sellerVariantId: sv.id, quantity: bl.quantity, unit: bl.unit, currencyCode: bo.currencyCode,
      });
      if (price.unitPriceMinor !== bl.unitPriceMinor || price.baseQuantity !== bl.baseQuantity) {
        return rejectBuyerOrder(prisma, buyerBusinessId, bo.id, "The supplier's prices changed after you sent this. Send it again to get the new prices.");
      }
    } catch (error) {
      if (error instanceof PriceError) return rejectBuyerOrder(prisma, buyerBusinessId, bo.id, `Price no longer valid: ${error.message}`);
      throw error;
    }
    rebuilt.push({ bl, sv: { id: sv.id, sku: sv.sku, name: sv.name, productName: sv.product.name } });
  }

  const sellerPartner = await seller.tradePartner.findUniqueOrThrow({ where: { id: active.counterpartPartnerId } });
  let so;
  try {
    const reference = await nextReference(seller, "SELL", "order");
    so = await seller.tradeOrder.create({
      data: {
        businessId: active.counterpartBusinessId, side: "SELL", partnerId: sellerPartner.id, counterpartOrderId: bo.id, reference, currencyCode: bo.currencyCode, acceptance: "REQUESTED",
        totalMinor: bo.totalMinor, paymentTermsDays: sellerPartner.paymentTermsDays ?? bo.paymentTermsDays, validUntil: bo.validUntil,
        lines: {
          create: rebuilt.map(({ bl, sv }) => ({
            businessId: active.counterpartBusinessId, lineNo: bl.lineNo, variantId: sv.id, counterpartVariantId: bl.variantId, counterpartLineId: bl.id,
            description: `${sv.productName}${sv.name && sv.name !== sv.productName ? ` ${sv.name}` : ""}`, sku: sv.sku, unit: bl.unit, packBaseQuantity: bl.packBaseQuantity,
            quantity: bl.quantity, baseQuantity: bl.baseQuantity, unitPriceMinor: bl.unitPriceMinor, lineTotalMinor: bl.lineTotalMinor,
          })),
        },
      },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    so = await seller.tradeOrder.findFirstOrThrow({ where: { counterpartOrderId: bo.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  }
  await withScopedTransaction(buyer, async (tx) => {
    await tx.tradeOrder.update({ where: { id: bo.id }, data: { counterpartOrderId: so.id } });
    for (const sl of so.lines) {
      const bl = bo.lines.find((x) => x.lineNo === sl.lineNo)!;
      await tx.tradeOrderLine.update({ where: { id: bl.id }, data: { counterpartLineId: sl.id } });
    }
  });
}

/** Copies the seller's agreed lines onto the buyer's row (set, not add). */
async function syncBuyerFromSeller(prisma: PrismaClient, sellerBusinessId: string, sellerOrderId: string, to: "QUOTED" | "ACCEPTED", now = new Date()) {
  const seller = getTenantScopedClient(prisma, sellerBusinessId);
  const so = await loadOrder(seller, sellerOrderId);
  if (!so.counterpartOrderId) return;
  const buyerId = await otherSide(prisma, sellerBusinessId, so.partnerId);
  const buyer = getTenantScopedClient(prisma, buyerId);
  const bo = await loadOrder(buyer, so.counterpartOrderId);
  if (bo.acceptance === to) return;
  if (!["REQUESTED", "QUOTED"].includes(bo.acceptance)) return;
  await withScopedTransaction(buyer, async (tx) => {
    for (const sl of so.lines) {
      const bl = bo.lines.find((x) => x.counterpartLineId === sl.id);
      if (!bl) throw new Error(`Buyer line for seller line ${sl.id} is missing.`);
      await tx.tradeOrderLine.update({
        where: { id: bl.id }, data: { quantity: sl.quantity, baseQuantity: sl.baseQuantity, unitPriceMinor: sl.unitPriceMinor, lineTotalMinor: sl.lineTotalMinor, unit: sl.unit, packBaseQuantity: sl.packBaseQuantity },
      });
    }
    await tx.tradeOrder.update({
      where: { id: bo.id },
      data: { totalMinor: so.totalMinor, validUntil: so.validUntil, paymentTermsDays: so.paymentTermsDays, ...(to === "QUOTED" ? { acceptance: "QUOTED" } : {}) },
    });
    if (to === "ACCEPTED") {
      const fresh = await loadOrder(tx, bo.id);
      await tx.tradeOrder.update({ where: { id: bo.id }, data: { acceptance: "ACCEPTED", acceptedAt: so.acceptedAt ?? now, frozenTerms: freezeTerms(fresh, so.acceptedAt ?? now) } });
    }
  });
}

async function onOrderQuoted(prisma: PrismaClient, e: OutboxEvent) {
  const { sellerBusinessId, sellerOrderId } = payloadOf(e) as { sellerBusinessId: string; sellerOrderId: string };
  await syncBuyerFromSeller(prisma, sellerBusinessId, sellerOrderId, "QUOTED");
}

async function onOrderAccepted(prisma: PrismaClient, e: OutboxEvent) {
  const { sellerBusinessId, sellerOrderId } = payloadOf(e) as { sellerBusinessId: string; sellerOrderId: string };
  await syncBuyerFromSeller(prisma, sellerBusinessId, sellerOrderId, "ACCEPTED");
}

async function onQuoteAccepted(prisma: PrismaClient, e: OutboxEvent) {
  const { buyerBusinessId, buyerOrderId } = payloadOf(e) as { buyerBusinessId: string; buyerOrderId: string };
  const buyer = getTenantScopedClient(prisma, buyerBusinessId);
  const bo = await loadOrder(buyer, buyerOrderId);
  if (!bo.counterpartOrderId) throw new Error("The buyer order has no seller counterpart yet.");
  const sellerId = await otherSide(prisma, buyerBusinessId, bo.partnerId);
  const result = await finaliseQuoteAcceptance(prisma, { sellerBusinessId: sellerId, sellerOrderId: bo.counterpartOrderId });
  if (result === "NOT_QUOTED") {
    // the quote lapsed or was withdrawn first: tell the buyer what the seller's row says
    const seller = getTenantScopedClient(prisma, sellerId);
    const so = await loadOrder(seller, bo.counterpartOrderId);
    if (["REJECTED", "CANCELLED", "EXPIRED"].includes(so.acceptance)) {
      await withScopedTransaction(seller, async (tx) => {
        await enqueueTradeEvent(tx, {
          businessId: sellerId, orderId: so.id, eventType: "trade.order.closed", dedupeKey: `trade.order.closed:${so.id}`,
          payload: { fromBusinessId: sellerId, orderId: so.id, status: so.acceptance, reason: "The quote was no longer available." },
        });
      });
    }
  }
}

async function onOrderClosed(prisma: PrismaClient, e: OutboxEvent) {
  const { fromBusinessId, orderId, status, reason } = payloadOf(e) as { fromBusinessId: string; orderId: string; status: "REJECTED" | "CANCELLED" | "EXPIRED"; reason?: string | null };
  const from = getTenantScopedClient(prisma, fromBusinessId);
  const fo = await loadOrder(from, orderId);
  if (!fo.counterpartOrderId) return;
  const toId = await otherSide(prisma, fromBusinessId, fo.partnerId);
  const to = getTenantScopedClient(prisma, toId);
  await withScopedTransaction(to, async (tx) => {
    const o = await loadOrder(tx, fo.counterpartOrderId!);
    if (!["DRAFT", "REQUESTED", "QUOTED", "ACCEPTED"].includes(o.acceptance)) return;
    if (o.lines.some((l) => l.shippedBase > 0)) return;
    // a buyer withdrawing shows as CANCELLED on the seller's side too; REJECTED only ever originates from the seller
    const mine = o.side === "SELL" && status === "REJECTED" ? "CANCELLED" : status;
    await closeOrderRow(tx, o, mine, reason ?? undefined, new Date());
  });
}

// ------------------------------------------------------------------- shipment, receipt, invoice

async function onShipmentDispatched(prisma: PrismaClient, e: OutboxEvent) {
  const { sellerBusinessId, shipmentId } = payloadOf(e) as { sellerBusinessId: string; shipmentId: string };
  const seller = getTenantScopedClient(prisma, sellerBusinessId);
  const ss = await seller.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { lines: true } });
  const so = await loadOrder(seller, ss.orderId);
  if (!so.counterpartOrderId) return;
  const buyerId = await otherSide(prisma, sellerBusinessId, so.partnerId);
  const buyer = getTenantScopedClient(prisma, buyerId);
  const bo = await loadOrder(buyer, so.counterpartOrderId);
  const sellerInvoice = await seller.tradeInvoice.findFirstOrThrow({ where: { shipmentId: ss.id }, include: { lines: true } });
  const buyerPartnerId = bo.partnerId;

  const existing = await buyer.shipment.findFirst({ where: { counterpartShipmentId: ss.id } });
  const bs = existing ??
    (await withScopedTransaction(buyer, async (tx) => {
      const created = await tx.shipment.create({
        data: {
          businessId: buyerId, orderId: bo.id, side: "BUY", number: ss.number, waybillRef: ss.waybillRef, carrier: ss.carrier, dispatchedAt: ss.dispatchedAt, counterpartShipmentId: ss.id,
          lines: {
            create: ss.lines.map((l) => {
              const sl = so.lines.find((x) => x.id === l.orderLineId)!;
              const bl = bo.lines.find((x) => x.counterpartLineId === sl.id);
              if (!bl) throw new Error("Buyer order line for a shipped line is missing.");
              return { businessId: buyerId, orderLineId: bl.id, baseQuantity: l.baseQuantity };
            }),
          },
        },
        include: { lines: true },
      });
      // shipped quantities are SET from the seller's lines, then movement status recomputed
      for (const sl of so.lines) {
        const bl = bo.lines.find((x) => x.counterpartLineId === sl.id);
        if (bl) await tx.tradeOrderLine.update({ where: { id: bl.id }, data: { shippedBase: sl.shippedBase } });
      }
      const fresh = await loadOrder(tx, bo.id);
      const all = fresh.lines.every((l) => l.shippedBase === l.baseQuantity);
      await tx.tradeOrder.update({ where: { id: bo.id }, data: { movement: all ? "SHIPPED" : "PARTIALLY_SHIPPED" } });
      return created;
    }));

  const existingInvoice = await buyer.tradeInvoice.findFirst({ where: { counterpartInvoiceId: sellerInvoice.id } });
  const buyerInvoice =
    existingInvoice ??
    (await withScopedTransaction(buyer, async (tx) => {
      return tx.tradeInvoice.create({
        data: {
          businessId: buyerId, side: "BUY", partnerId: buyerPartnerId, orderId: bo.id, shipmentId: bs.id, counterpartInvoiceId: sellerInvoice.id, number: await nextReference(tx, "BUY", "invoice"),
          externalNumber: sellerInvoice.number, currencyCode: sellerInvoice.currencyCode, totalMinor: sellerInvoice.totalMinor, issuedAt: sellerInvoice.issuedAt, dueDate: sellerInvoice.dueDate,
          lines: {
            create: sellerInvoice.lines.map((il) => {
              const sl = so.lines.find((x) => x.id === il.orderLineId)!;
              const bl = bo.lines.find((x) => x.counterpartLineId === sl.id)!;
              return {
                businessId: buyerId, orderLineId: bl.id, description: il.description, sku: il.sku, unit: il.unit, packBaseQuantity: il.packBaseQuantity, baseQuantity: il.baseQuantity,
                unitPriceMinor: il.unitPriceMinor, lineTotalMinor: il.lineTotalMinor,
              };
            }),
          },
        },
      });
    }));
  await withScopedTransaction(seller, async (tx) => {
    await tx.shipment.update({ where: { id: ss.id }, data: { counterpartShipmentId: bs.id } });
    await tx.tradeInvoice.update({ where: { id: sellerInvoice.id }, data: { counterpartInvoiceId: buyerInvoice.id } });
  });
}

async function onReceiptRecorded(prisma: PrismaClient, e: OutboxEvent) {
  const { buyerBusinessId, shipmentId } = payloadOf(e) as { buyerBusinessId: string; shipmentId: string };
  const buyer = getTenantScopedClient(prisma, buyerBusinessId);
  const bs = await buyer.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { lines: true } });
  if (!bs.counterpartShipmentId) return;
  const bo = await loadOrder(buyer, bs.orderId);
  const sellerId = await otherSide(prisma, buyerBusinessId, bo.partnerId);
  const seller = getTenantScopedClient(prisma, sellerId);
  const ss = await seller.shipment.findUniqueOrThrow({ where: { id: bs.counterpartShipmentId }, include: { lines: true } });
  const so = await loadOrder(seller, ss.orderId);
  await withScopedTransaction(seller, async (tx) => {
    for (const bl of bs.lines) {
      const bOrderLine = bo.lines.find((x) => x.id === bl.orderLineId);
      const sOrderLine = so.lines.find((x) => x.id === bOrderLine?.counterpartLineId);
      const sl = ss.lines.find((x) => x.orderLineId === sOrderLine?.id);
      if (!sl) continue;
      await tx.shipmentLine.update({ where: { id: sl.id }, data: { acceptedBase: bl.acceptedBase, damagedBase: bl.damagedBase, shortBase: bl.shortBase } });
    }
    await tx.shipment.update({ where: { id: ss.id }, data: { status: bs.status } });
    // seller's per-line receivedBase and the order's goods-movement status are recomputed from the synced shipment lines
    const fresh = await loadOrder(tx, so.id);
    const lines = await tx.shipmentLine.findMany({ where: { orderLineId: { in: fresh.lines.map((l) => l.id) } } });
    const accounted: number[] = [];
    for (const l of fresh.lines) {
      const ls = lines.filter((x) => x.orderLineId === l.id);
      accounted.push(ls.reduce((n, x) => n + x.acceptedBase + x.damagedBase + x.shortBase, 0));
      await tx.tradeOrderLine.update({ where: { id: l.id }, data: { receivedBase: ls.reduce((n, x) => n + x.acceptedBase + x.damagedBase, 0) } });
    }
    const allShipped = fresh.lines.every((l) => l.shippedBase === l.baseQuantity);
    const allAccounted = fresh.lines.every((l, i) => accounted[i] === l.baseQuantity);
    await tx.tradeOrder.update({
      where: { id: so.id },
      data: { movement: allShipped && allAccounted ? "RECEIVED" : accounted.some((n) => n > 0) ? "PARTIALLY_RECEIVED" : allShipped ? "SHIPPED" : "PARTIALLY_SHIPPED" },
    });
  });
}

// ------------------------------------------------------------------------- payments, credit

async function onPaymentReported(prisma: PrismaClient, e: OutboxEvent) {
  const { fromBusinessId, paymentId } = payloadOf(e) as { fromBusinessId: string; paymentId: string };
  const from = getTenantScopedClient(prisma, fromBusinessId);
  const fp = await from.tradePayment.findUniqueOrThrow({ where: { id: paymentId } });
  const fi = await from.tradeInvoice.findUniqueOrThrow({ where: { id: fp.invoiceId } });
  if (!fi.counterpartInvoiceId) return;
  const toInvoice = await prisma.tradeInvoice.findUniqueOrThrow({ where: { id: fi.counterpartInvoiceId } });
  const to = getTenantScopedClient(prisma, toInvoice.businessId);
  const existing = await to.tradePayment.findFirst({ where: { counterpartPaymentId: fp.id } });
  if (existing) return;
  const created = await to.tradePayment.create({
    data: {
      businessId: toInvoice.businessId, invoiceId: toInvoice.id, direction: fp.direction === "OUT" ? "IN" : "OUT", amountMinor: fp.amountMinor, currencyCode: fp.currencyCode,
      method: fp.method, evidence: "COUNTERPARTY_REPORTED", state: "PROPOSED", reference: fp.reference, counterpartPaymentId: fp.id,
    },
  });
  await withScopedTransaction(from, async (tx) => {
    await tx.tradePayment.update({ where: { id: fp.id }, data: { counterpartPaymentId: created.id } });
  });
}

async function onPaymentResolved(prisma: PrismaClient, e: OutboxEvent) {
  const { fromBusinessId, paymentId, state, reason } = payloadOf(e) as { fromBusinessId: string; paymentId: string; state: "APPLIED" | "REJECTED"; reason?: string };
  const from = getTenantScopedClient(prisma, fromBusinessId);
  const fp = await from.tradePayment.findUniqueOrThrow({ where: { id: paymentId } });
  if (!fp.counterpartPaymentId) return;
  const orig = await prisma.tradePayment.findUniqueOrThrow({ where: { id: fp.counterpartPaymentId } });
  const to = getTenantScopedClient(prisma, orig.businessId);
  await withScopedTransaction(to, async (tx) => {
    const row = await tx.tradePayment.findUniqueOrThrow({ where: { id: orig.id } });
    if (state === "APPLIED") {
      // the other side acknowledged: our own record now carries confirmed evidence
      if (row.evidence === "MERCHANT_RECORDED") await tx.tradePayment.update({ where: { id: row.id }, data: { evidence: "COUNTERPARTY_CONFIRMED" } });
    } else if (row.state === "APPLIED") {
      // disputed: kept as recorded (money did move on our side) but flagged for a human, never silently reversed
      await tx.tradePayment.update({ where: { id: row.id }, data: { state: "HELD", reason: `Not confirmed by the other business: ${reason ?? "no reason given"}` } });
    }
  });
}

async function onCreditNoteIssued(prisma: PrismaClient, e: OutboxEvent) {
  const { sellerBusinessId, creditNoteId } = payloadOf(e) as { sellerBusinessId: string; creditNoteId: string };
  const seller = getTenantScopedClient(prisma, sellerBusinessId);
  const cn = await seller.creditNote.findUniqueOrThrow({ where: { id: creditNoteId } });
  const si = await seller.tradeInvoice.findUniqueOrThrow({ where: { id: cn.invoiceId } });
  if (!si.counterpartInvoiceId) return;
  const bi = await prisma.tradeInvoice.findUniqueOrThrow({ where: { id: si.counterpartInvoiceId } });
  const buyer = getTenantScopedClient(prisma, bi.businessId);
  if (await buyer.creditNote.findFirst({ where: { counterpartCreditNoteId: cn.id } })) return;
  await withScopedTransaction(buyer, async (tx) => {
    const n = await tx.$executeRaw`UPDATE "TradeInvoice" SET "creditedMinor" = "creditedMinor" + ${cn.amountMinor} WHERE "id" = ${bi.id} AND "businessId" = ${bi.businessId} AND "creditedMinor" + "paidMinor" + ${cn.amountMinor} <= "totalMinor"`;
    if (n !== 1) throw new Error("The credit would take the buyer's copy of the invoice below zero owing.");
    await tx.creditNote.create({
      data: { businessId: bi.businessId, side: "BUY", invoiceId: bi.id, number: await nextReference(tx, "BUY", "credit"), externalNumber: cn.number, amountMinor: cn.amountMinor, reason: cn.reason, counterpartCreditNoteId: cn.id },
    });
  });
}

// --------------------------------------------------------------------------------- registry

/** Outbox handlers for trade documents, bound to a database client. */
export function buildTradeOutboxHandlers(prisma: PrismaClient): Record<string, OutboxHandler> {
  const wrap = (fn: (p: PrismaClient, e: OutboxEvent) => Promise<void>): OutboxHandler => (e) => fn(prisma, e);
  return {
    "trade.order.requested": wrap(onOrderRequested),
    "trade.order.quoted": wrap(onOrderQuoted),
    "trade.order.accepted": wrap(onOrderAccepted),
    "trade.quote.accepted": wrap(onQuoteAccepted),
    "trade.order.closed": wrap(onOrderClosed),
    "trade.shipment.dispatched": wrap(onShipmentDispatched),
    "trade.receipt.recorded": wrap(onReceiptRecorded),
    "trade.payment.reported": wrap(onPaymentReported),
    "trade.payment.resolved": wrap(onPaymentResolved),
    "trade.credit_note.issued": wrap(onCreditNoteIssued),
  };
}

export function buildTradeCallbackHandlers(prisma: PrismaClient): Record<string, CallbackHandler> {
  return { [SIMULATOR_PROVIDER]: simulatorCallbackHandler(prisma) };
}

/**
 * Delivers pending trade events and stored callbacks now. The domain functions call nothing cross-business themselves; the
 * worker sweep does this every few seconds, and callers that want the other side up to date immediately (tests, the demo)
 * call this after committing.
 */
export async function deliverTradeEvents(prisma: PrismaClient, rounds = 8): Promise<void> {
  const outbox = buildTradeOutboxHandlers(prisma);
  const inbox = buildTradeCallbackHandlers(prisma);
  for (let i = 0; i < rounds; i++) {
    const a = await processOutbox(prisma, outbox, { limit: 100 });
    const b = await processInbox(prisma, inbox, { limit: 100 });
    if (a.claimed + b.claimed === 0) return;
  }
}
