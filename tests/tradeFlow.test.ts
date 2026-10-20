import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { tradeWorld, type World } from "./helpers/trade.js";
import { accountNet, trialBalance } from "../src/domain/accounting.js";
import { getStockLevel, reconcileStock } from "../src/domain/stock.js";
import { acceptSalesOrder, createPurchaseOrder, submitPurchaseOrder } from "../src/domain/trade/orders.js";
import { issueShortDeliveryCredit, invoicePaymentView, receiveShipment, shipOrder } from "../src/domain/trade/fulfilment.js";
import { confirmPayment, recordPayment } from "../src/domain/trade/payments.js";
import { deliverTradeEvents } from "../src/domain/trade/handlers.js";
import { getSharedCatalog } from "../src/domain/trade/partners.js";
import { recordCallback } from "../src/domain/callbackInbox.js";
import { deliverCallback, simulatorWorld, startPayment } from "./helpers/payments.js";
import { receiveProviderCallback } from "../src/domain/merchantPayments/outcomes.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});


async function net(biz: { scoped: Parameters<typeof accountNet>[0] }, key: Parameters<typeof accountNet>[1]) {
  return accountNet(biz.scoped, key, { currencyCode: "NGN" });
}

/** Retailer orders 3 cartons, wholesaler accepts: the common starting point. */
async function acceptedOrder(w: World, cartons = 3) {
  const po = await createPurchaseOrder(prisma, {
    businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN",
    lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: cartons, unit: "carton" }],
  });
  await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id });
  await deliverTradeEvents(prisma);
  const buyerRow = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
  const so = await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: buyerRow.counterpartOrderId! }, include: { lines: true } });
  return { po, so };
}

describe("scenario 1: wholesaler sells to retailer; partial goods receipt updates only received stock; records stay tenant-isolated", () => {
  it("runs the whole flow with exact totals, coherent books on both sides, and nothing leaking across businesses", async () => {
    const w = await tradeWorld(prisma);

    // --- the supplier's shared catalog shows published fields only
    const catalog = await getSharedCatalog(prisma, { buyerBusinessId: w.R.businessId, linkId: w.link!.id });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ sku: "COLA-330", baseUnit: "piece", packs: [{ name: "carton", baseQuantity: 24 }] });
    expect(catalog[0]!.prices.map((p) => [p.unit, p.minQuantity, p.unitPriceMinor])).toEqual([["carton", 1, "220000"], ["carton", 5, "210000"]]);
    expect(JSON.stringify(catalog)).not.toMatch(/cost|avg|onHand|reserved|margin|8000/i);

    // --- retailer orders 3 cartons (72 pieces at 220,000 per carton = 660,000) and sends it
    const po = await createPurchaseOrder(prisma, {
      businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN",
      lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 3, unit: "carton" }],
    });
    expect(po).toMatchObject({ acceptance: "DRAFT", side: "BUY", totalMinor: 660_000n, reference: "PO-000001" });
    expect(po.lines[0]).toMatchObject({ unit: "carton", packBaseQuantity: 24, baseQuantity: 72, unitPriceMinor: 220_000n, lineTotalMinor: 660_000n });
    await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id });
    // before delivery the wholesaler knows nothing yet
    expect(await w.W.scoped.tradeOrder.count({ where: {} })).toBe(0);
    await deliverTradeEvents(prisma);

    // --- the wholesaler's own row now exists, linked, with the agreed fields only
    const rRow = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(rRow.acceptance).toBe("REQUESTED");
    const so = await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: rRow.counterpartOrderId! }, include: { lines: true } });
    expect(so).toMatchObject({ side: "SELL", acceptance: "REQUESTED", reference: "SO-000001", counterpartOrderId: po.id, totalMinor: 660_000n });
    expect(so.lines[0]).toMatchObject({ sku: "COLA-330", baseQuantity: 72, unitPriceMinor: 220_000n, variantId: w.wVariant.id, counterpartVariantId: w.rVariant.id });
    expect(rRow.lines[0]!.counterpartLineId).toBe(so.lines[0]!.id);

    // --- the wholesaler accepts: 72 pieces are HELD, terms frozen, buyer mirrored
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id, actor: "w-owner" });
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ onHand: 200, reserved: 72, available: 128 });
    await deliverTradeEvents(prisma);
    const accepted = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(accepted.acceptance).toBe("ACCEPTED");
    expect((accepted.frozenTerms as { totalMinor: string }).totalMinor).toBe("660000");

    // --- shipment 1: 2 cartons (48). Invoice for exactly what shipped; the unshipped 24 stay held
    const s1 = await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 48 }], waybillRef: "WB-1", actor: "w-owner" });
    expect(s1.invoice).toMatchObject({ totalMinor: 440_000n, number: "INV-000001", status: "ISSUED" });
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ onHand: 152, reserved: 24, available: 128 });
    expect((await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: so.id } })).movement).toBe("PARTIALLY_SHIPPED");
    expect(await net(w.W, "AR")).toBe(440_000n);
    expect(await net(w.W, "SALES_REVENUE")).toBe(-440_000n);
    expect(await net(w.W, "COGS")).toBe(384_000n); // 48 x 8,000 cost, known only to the wholesaler
    await deliverTradeEvents(prisma);

    // --- the retailer sees an inbound shipment and the bill, but has NOT received any stock yet
    const inbound = await w.R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY" }, include: { lines: true } });
    expect(inbound).toMatchObject({ number: 1, waybillRef: "WB-1", status: "DISPATCHED" });
    const bill1 = await w.R.scoped.tradeInvoice.findFirstOrThrow({ where: { side: "BUY" } });
    expect(bill1).toMatchObject({ totalMinor: 440_000n, externalNumber: "INV-000001", number: "BILL-000001" });
    expect((await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).onHand).toBe(0);
    expect(await net(w.R, "INVENTORY")).toBe(0n);
    expect((await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id } })).movement).toBe("PARTIALLY_SHIPPED");

    // --- PARTIAL receipt of the first shipment: only 40 of 48 confirmed so far
    const r1 = await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: inbound.lines[0]!.id, acceptedBase: 40 }], actor: "r-owner" });
    expect(r1.shipmentComplete).toBe(false);
    expect(await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).toMatchObject({ onHand: 40, damaged: 0 }); // only what was received
    expect(r1.bookedMinor).toBe(366_667n); // 660,000 x 40/72, cumulative rounding
    expect(await net(w.R, "INVENTORY")).toBe(366_667n);
    expect(await net(w.R, "AP")).toBe(-366_667n);
    await deliverTradeEvents(prisma);
    expect((await w.W.scoped.shipment.findFirstOrThrow({ where: { side: "SELL" }, include: { lines: true } })).lines[0]).toMatchObject({ acceptedBase: 40, damagedBase: 0, shortBase: 0 });
    expect((await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: so.id } })).movement).toBe("PARTIALLY_RECEIVED");

    // --- the rest of shipment 1: 6 accepted, 1 damaged (quarantined), 1 short (never arrived)
    const r2 = await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: inbound.lines[0]!.id, acceptedBase: 6, damagedBase: 1, shortBase: 1, reason: "1 can crushed, 1 missing from the carton" }] });
    expect(r2.shipmentComplete).toBe(true);
    expect(await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).toMatchObject({ onHand: 46, damaged: 1 });
    expect(await net(w.R, "AP")).toBe(-430_833n); // 660,000 x 47/72 received; the short unit is not booked
    await deliverTradeEvents(prisma);

    // --- the short unit: the wholesaler credits it (derived from the retailer's receipt, not typed)
    const credit = await issueShortDeliveryCredit(prisma, { businessId: w.W.businessId, invoiceId: s1.invoice.id, actor: "w-owner" });
    expect(credit.amountMinor).toBe(9_167n); // 440,000 x 1/48
    await deliverTradeEvents(prisma);
    const wInv1 = await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: s1.invoice.id } });
    const rBill1 = await w.R.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: bill1.id } });
    expect(wInv1.creditedMinor).toBe(9_167n);
    expect(rBill1.creditedMinor).toBe(9_167n);
    // the invoice now says exactly what the retailer's books owe for the shipment
    expect(440_000n - 9_167n).toBe(430_833n);
    expect(invoicePaymentView(rBill1).outstandingMinor).toBe(430_833n);
    expect(await net(w.W, "SALES_RETURNS")).toBe(9_167n);
    expect(await net(w.W, "AR")).toBe(430_833n);

    // --- shipment 2: the last 24. Invoices add up to the order total EXACTLY (no drift)
    const s2 = await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 24 }] });
    expect(s2.invoice.totalMinor).toBe(220_000n);
    expect(s1.invoice.totalMinor + s2.invoice.totalMinor).toBe(660_000n);
    expect((await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: so.id } })).movement).toBe("SHIPPED");
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ onHand: 128, reserved: 0 });
    await deliverTradeEvents(prisma);
    const inbound2 = await w.R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY", number: 2 }, include: { lines: true } });
    await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound2.id, lines: [{ shipmentLineId: inbound2.lines[0]!.id, acceptedBase: 24 }] });
    await deliverTradeEvents(prisma);
    expect(await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).toMatchObject({ onHand: 70, damaged: 1 }); // 46 + 24
    expect((await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id } })).movement).toBe("RECEIVED");
    expect((await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: so.id } })).movement).toBe("RECEIVED");
    // booked payable = what the invoices say is owing after the credit
    expect(await net(w.R, "AP")).toBe(-(660_000n - 9_167n) );

    // --- books balance on both sides, stock reconciles on both sides
    for (const b of [w.W, w.R]) {
      const tb = await trialBalance(b.scoped, { currencyCode: "NGN" });
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
      expect(await reconcileStock(b.scoped)).toEqual([]);
    }

    // --- isolation: each business sees only its own rows; the other's numbers never appear in its books
    expect((await w.R.scoped.tradeOrder.findMany({ where: {} })).every((o) => o.businessId === w.R.businessId)).toBe(true);
    expect(await w.R.scoped.stockMovement.count({ where: { variantId: w.wVariant.id } })).toBe(0);
    expect(await w.W.scoped.stockMovement.count({ where: { variantId: w.rVariant.id } })).toBe(0);
    expect(await w.R.scoped.tradeOrder.findUnique({ where: { id: so.id } })).toBeNull(); // the wholesaler's row is not reachable by id
    expect(await w.W.scoped.tradeOrder.findUnique({ where: { id: po.id } })).toBeNull();
    const rRowsJson = JSON.stringify(await w.R.scoped.tradeOrderLine.findMany({ where: {} }), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(rRowsJson).not.toContain("8000"); // the wholesaler's cost price is nowhere in the retailer's data
  });

  it("a receipt can never exceed what was shipped, and short/over quantities are refused", async () => {
    const w = await tradeWorld(prisma);
    const { so } = await acceptedOrder(w, 1);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id });
    await deliverTradeEvents(prisma);
    await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 24 }] });
    await deliverTradeEvents(prisma);
    const inbound = await w.R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY" }, include: { lines: true } });
    const line = inbound.lines[0]!.id;
    await expect(receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: line, acceptedBase: 25 }] })).rejects.toMatchObject({ code: "OVER_QUANTITY" });
    await expect(receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: line, acceptedBase: 0 }] })).rejects.toMatchObject({ code: "INVALID" });
    await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: line, acceptedBase: 20, shortBase: 2 }] });
    await expect(receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: line, acceptedBase: 3 }] })).rejects.toMatchObject({ code: "OVER_QUANTITY" });
    expect((await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).onHand).toBe(20);
  });
});

describe("payments are tracked as evidence, never a second sale", () => {
  async function shippedAndReceived() {
    const w = await tradeWorld(prisma);
    const { so, po } = await acceptedOrder(w, 3);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id });
    await deliverTradeEvents(prisma);
    const s = await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 72 }] });
    await deliverTradeEvents(prisma);
    const inbound = await w.R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY" }, include: { lines: true } });
    await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: inbound.lines[0]!.id, acceptedBase: 72 }] });
    await deliverTradeEvents(prisma);
    const bill = await w.R.scoped.tradeInvoice.findFirstOrThrow({ where: { side: "BUY" } });
    return { w, so, po, wInvoice: s.invoice, bill };
  }

  it("a buyer's payment is a PROPOSAL until the seller confirms it; only then does the receivable fall", async () => {
    const { w, wInvoice, bill } = await shippedAndReceived();
    const paid = await recordPayment(prisma, { businessId: w.R.businessId, invoiceId: bill.id, amountMinor: 200_000n, method: "CASH", reference: "receipt 118" });
    expect(paid).toMatchObject({ state: "APPLIED", direction: "OUT", evidence: "MERCHANT_RECORDED" });
    expect(await net(w.R, "AP")).toBe(-660_000n + 200_000n);
    await deliverTradeEvents(prisma);

    const proposal = await w.W.scoped.tradePayment.findFirstOrThrow({ where: { invoiceId: wInvoice.id } });
    expect(proposal).toMatchObject({ state: "PROPOSED", direction: "IN", evidence: "COUNTERPARTY_REPORTED", amountMinor: 200_000n, reference: "receipt 118" });
    expect((await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: wInvoice.id } })).paidMinor).toBe(0n); // not applied
    expect(await net(w.W, "AR")).toBe(660_000n);
    expect(await net(w.W, "CASH")).toBe(0n);

    const confirmed = await confirmPayment(prisma, { businessId: w.W.businessId, paymentId: proposal.id, actor: "w-owner" });
    expect(confirmed).toMatchObject({ state: "APPLIED", evidence: "COUNTERPARTY_CONFIRMED" });
    expect(await net(w.W, "AR")).toBe(460_000n);
    expect(await net(w.W, "CASH")).toBe(200_000n);
    expect(await net(w.W, "SALES_REVENUE")).toBe(-660_000n); // the payment is not a second sale
    await deliverTradeEvents(prisma);
    expect((await w.R.scoped.tradePayment.findUniqueOrThrow({ where: { id: paid.id } })).evidence).toBe("COUNTERPARTY_CONFIRMED");
    await expect(confirmPayment(prisma, { businessId: w.W.businessId, paymentId: proposal.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("a payment can never take an invoice past what is owing", async () => {
    const { w, wInvoice, bill } = await shippedAndReceived();
    await expect(recordPayment(prisma, { businessId: w.R.businessId, invoiceId: bill.id, amountMinor: 660_001n, method: "BANK" })).rejects.toMatchObject({ code: "OVER_PAYMENT" });
    await expect(recordPayment(prisma, { businessId: w.W.businessId, invoiceId: wInvoice.id, amountMinor: 0n, method: "BANK" })).rejects.toMatchObject({ code: "INVALID" });
    await recordPayment(prisma, { businessId: w.W.businessId, invoiceId: wInvoice.id, amountMinor: 660_000n, method: "BANK" });
    await expect(recordPayment(prisma, { businessId: w.W.businessId, invoiceId: wInvoice.id, amountMinor: 1n, method: "BANK" })).rejects.toMatchObject({ code: "OVER_PAYMENT" });
    const view = invoicePaymentView(await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: wInvoice.id } }));
    expect(view).toMatchObject({ outstandingMinor: 0n, paymentStatus: "PAID" });
  });

  it("simulator: a signed callback pays the invoice once; replays and bad callbacks change nothing", async () => {
    const { w, wInvoice, bill } = await shippedAndReceived();
    const { sim, registry } = simulatorWorld(prisma);
    const pay = async (amount: bigint) => {
      const { attempt } = await startPayment(prisma, registry, { businessId: w.W.businessId, subjectType: "TRADE_INVOICE", subjectId: wInvoice.id, amountMinor: amount });
      return attempt;
    };

    const a1 = await pay(300_000n);
    expect(a1.status).toBe("PENDING"); // the provider accepted the request: pending, never paid
    expect((await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: wInvoice.id } })).paidMinor).toBe(0n);
    const first = await sim.completePayment(a1.externalRef!);
    expect(await deliverCallback(prisma, registry, first)).toEqual({ status: "recorded" });
    expect(await deliverCallback(prisma, registry, first)).toEqual({ status: "duplicate" }); // redelivery
    await deliverTradeEvents(prisma);
    await deliverTradeEvents(prisma);

    const inv = await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: wInvoice.id } });
    expect(inv.paidMinor).toBe(300_000n);
    const payments = await w.W.scoped.tradePayment.findMany({ where: { invoiceId: wInvoice.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ state: "APPLIED", evidence: "SIMULATOR_CONFIRMED", provider: "simulator", method: "MOBILE_MONEY" });
    // seller: collected by the provider, sitting in clearing, not revenue, not yet in the bank
    expect(await net(w.W, "PROVIDER_CLEARING")).toBe(300_000n);
    expect(await net(w.W, "AR")).toBe(360_000n);
    expect(await net(w.W, "SALES_REVENUE")).toBe(-660_000n);
    // buyer: their payable fell by the same amount through authenticated evidence
    const billNow = await w.R.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billNow.paidMinor).toBe(300_000n);
    expect((await w.R.scoped.tradePayment.findFirstOrThrow({ where: { invoiceId: bill.id } }))).toMatchObject({ direction: "OUT", evidence: "SIMULATOR_CONFIRMED", state: "APPLIED" });

    // bad signature, forged purpose, malformed body: refused at the door, nothing stored
    const a2 = await pay(100_000n);
    const claim = (extra: Record<string, unknown>) => sim.signedEvent({ event: "payment.updated", eventId: "evt-x-0001", purpose: "MERCHANT_SALE", externalRef: a2.externalRef, merchantReference: a2.id, status: "SUCCEEDED", amountMinor: "100000", currencyCode: "NGN", destinationKey: "x", ...extra });
    const bad = claim({ eventId: "evt-bad-0001" });
    expect(await receiveProviderCallback(prisma, registry, "simulator", bad.body, { "x-simulator-signature": "00".repeat(32) })).toEqual({ status: "rejected", reason: "BAD_SIGNATURE" });
    const forged = claim({ eventId: "evt-forged-001", purpose: "PLATFORM_SUBSCRIPTION" });
    expect(await deliverCallback(prisma, registry, forged)).toEqual({ status: "rejected", reason: "PURPOSE_FORBIDDEN" });
    expect(await receiveProviderCallback(prisma, registry, "simulator", "not json", { "x-simulator-signature": "ab" })).toMatchObject({ status: "rejected" });
    expect(await prisma.callbackInbox.count({ where: { externalId: { in: ["evt-bad-0001", "evt-forged-001"] } } })).toBe(0);

    // an UNVERIFIED stored row is never trusted as evidence: it only triggers an authenticated status check, and the provider says PENDING
    await recordCallback(prisma, { provider: "simulator", externalId: "sim-unverified-0001", signatureVerified: false, payload: { event: { kind: "payment", eventId: "sim-unverified-0001", purpose: "MERCHANT_SALE", snapshot: { status: "SUCCEEDED", externalRef: a2.externalRef, merchantReference: a2.id, amountMinor: { $bigint: "100000" }, currencyCode: "NGN", destinationKey: null, feeMinor: null } } } });
    await deliverTradeEvents(prisma);
    expect((await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: wInvoice.id } })).paidMinor).toBe(300_000n);

    // the provider says it collected MORE than owing: the surplus is held for a human, never applied; the exception is visible
    const a3 = await pay(360_000n);
    const over = await sim.completePayment(a3.externalRef!, { amountMinor: 900_000n });
    await deliverCallback(prisma, registry, over);
    await deliverTradeEvents(prisma);
    const held = await w.W.scoped.tradePayment.findFirstOrThrow({ where: { state: "HELD" } });
    expect(held.reason).toContain("More than remains owing");
    expect((await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: wInvoice.id } })).paidMinor).toBe(300_000n);
    expect(await prisma.providerException.count({ where: { attemptId: a3.id, type: "AMOUNT_MISMATCH" } })).toBe(1);
  });

});
