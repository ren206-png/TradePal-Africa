import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeBusiness, seedReference, enableFlag } from "./helpers/phase2.js";
import { tradeWorld } from "./helpers/trade.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { addPriceRule } from "../src/domain/pricing.js";
import { getStockLevel, receiveStock, reserveStock, reconcileStock } from "../src/domain/stock.js";
import {
  acceptQuote, acceptSalesOrder, cancelOrder, confirmUnlinkedPurchase, createPurchaseOrder, createSalesOrder, expireTradeOrders, quoteSalesOrder, renewOrderHold,
  setDraftPurchaseLines, submitPurchaseOrder,
} from "../src/domain/trade/orders.js";
import { receiveShipment, shipOrder } from "../src/domain/trade/fulfilment.js";
import { recordPayment } from "../src/domain/trade/payments.js";
import { deliverTradeEvents } from "../src/domain/trade/handlers.js";
import { acceptLink, createPartner, getSharedCatalog, inviteLink, revokeLink, setPartnerTerms, shareWholesaleList } from "../src/domain/trade/partners.js";
import { evaluateTradeCredit } from "../src/domain/trade/credit.js";

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

const soon = (ms: number) => new Date(Date.now() + ms);
const DAY = 86_400_000;

async function request(w: Awaited<ReturnType<typeof tradeWorld>>, cartons = 2) {
  const po = await createPurchaseOrder(prisma, {
    businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN",
    lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: cartons, unit: "carton" }],
  });
  await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id });
  await deliverTradeEvents(prisma);
  const buyerRow = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id } });
  const so = await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: buyerRow.counterpartOrderId! }, include: { lines: true } });
  return { po, so };
}
const acceptance = async (scoped: Awaited<ReturnType<typeof makeBusiness>>["scoped"], id: string) => (await scoped.tradeOrder.findUniqueOrThrow({ where: { id } })).acceptance;

describe("linking is explicit, one-time and reversible", () => {
  it("the invitation token is single-use, expires, and cannot be accepted by the inviter or after a link already exists", async () => {
    const w = await tradeWorld(prisma, { link: false });
    const inviteA = await inviteLink(prisma, { inviterBusinessId: w.R.businessId, partnerId: w.rPartner.id });
    expect(inviteA.link.tokenHash).not.toContain(inviteA.token); // only a hash is stored
    await expect(acceptLink(prisma, { inviteeBusinessId: w.R.businessId, token: inviteA.token })).rejects.toMatchObject({ code: "FORBIDDEN_PARTY" });
    await expect(acceptLink(prisma, { inviteeBusinessId: w.W.businessId, token: "not-a-real-token" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(acceptLink(prisma, { inviteeBusinessId: w.W.businessId, token: inviteA.token, now: new Date(Date.now() + 8 * DAY) })).rejects.toMatchObject({ code: "EXPIRED" });
    const link = await acceptLink(prisma, { inviteeBusinessId: w.W.businessId, token: inviteA.token });
    expect(link.status).toBe("ACTIVE");
    await expect(acceptLink(prisma, { inviteeBusinessId: w.W.businessId, token: inviteA.token })).rejects.toMatchObject({ code: "WRONG_STATE" });
    const third = await makeBusiness(prisma, "Third Party");
    await expect(acceptLink(prisma, { inviteeBusinessId: third.businessId, token: inviteA.token })).rejects.toMatchObject({ code: "WRONG_STATE" }); // a stolen token cannot be reused
    // both sides now have a LINKED partner pointing at the other business
    expect(await w.R.scoped.tradePartner.findFirstOrThrow({ where: { linkStatus: "LINKED" } })).toMatchObject({ linkedBusinessId: w.W.businessId });
    expect(await w.W.scoped.tradePartner.findFirstOrThrow({ where: { linkStatus: "LINKED" } })).toMatchObject({ linkedBusinessId: w.R.businessId, role: "CUSTOMER" });
  });

  it("a non-wholesale list cannot be shared, and unshared lists are invisible to the buyer", async () => {
    const w = await tradeWorld(prisma, { share: false });
    expect(await getSharedCatalog(prisma, { buyerBusinessId: w.R.businessId, linkId: w.link!.id })).toEqual([]);
    await expect(createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 1, unit: "carton" }] }))
      .rejects.toMatchObject({ code: "NO_PRICE" });
    const retail = await w.W.scoped.priceList.create({ data: { businessId: w.W.businessId, name: "Retail", kind: "RETAIL", currencyCode: "NGN" } });
    await expect(shareWholesaleList(prisma, { businessId: w.W.businessId, priceListId: retail.id, linkId: w.link!.id })).rejects.toMatchObject({ code: "INVALID" });
    const other = await makeBusiness(prisma);
    await expect(shareWholesaleList(prisma, { businessId: other.businessId, priceListId: w.wList.id, linkId: w.link!.id })).rejects.toMatchObject({ code: "NOT_LINKED" });
  });

  it("a buyer outside the link cannot read the catalog; drafts and unpublished items are never exposed", async () => {
    const w = await tradeWorld(prisma);
    const stranger = await makeBusiness(prisma);
    await expect(getSharedCatalog(prisma, { buyerBusinessId: stranger.businessId, linkId: w.link!.id })).rejects.toMatchObject({ code: "NOT_LINKED" });
    await w.W.scoped.productVariant.update({ where: { id: w.wVariant.id }, data: { status: "DRAFT" } });
    expect(await getSharedCatalog(prisma, { buyerBusinessId: w.R.businessId, linkId: w.link!.id })).toEqual([]);
  });

  it("revoking stops new orders and the shared list, but agreed documents carry on", async () => {
    const w = await tradeWorld(prisma);
    const { po, so } = await request(w, 1);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id });
    await deliverTradeEvents(prisma);
    await revokeLink(prisma, { businessId: w.R.businessId, linkId: w.link!.id, by: "r-owner" });
    expect(await getSharedCatalog(prisma, { buyerBusinessId: w.R.businessId, linkId: w.link!.id }).catch((e) => e.code)).toBe("NOT_LINKED");
    // a new request over the revoked link: the partner is no longer LINKED, so it cannot be submitted
    const again = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, quantity: 24, unitPriceMinor: 9_000n }] });
    await expect(submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: again.id })).rejects.toMatchObject({ code: "NOT_LINKED" });
    // the already-agreed order still ships, is mirrored and can be received
    await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 24 }] });
    await deliverTradeEvents(prisma);
    const inbound = await w.R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY" }, include: { lines: true } });
    await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: inbound.lines[0]!.id, acceptedBase: 24 }] });
    expect((await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).onHand).toBe(24);
    void po;
  });
});

describe("order lifecycle: separate acceptance state, quotes hold stock, expiry releases it", () => {
  it("rejecting, cancelling and withdrawing close both sides and release held stock", async () => {
    const w = await tradeWorld(prisma);
    const a = await request(w, 1);
    await cancelOrder(prisma, { businessId: w.W.businessId, orderId: a.so.id, reason: "out of that line" }); // seller declines a request = REJECTED
    await deliverTradeEvents(prisma);
    expect(await acceptance(w.W.scoped, a.so.id)).toBe("REJECTED");
    expect(await acceptance(w.R.scoped, a.po.id)).toBe("REJECTED");

    const b = await request(w, 2);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: b.so.id });
    expect((await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).reserved).toBe(48);
    await cancelOrder(prisma, { businessId: w.R.businessId, orderId: b.po.id, reason: "changed my mind" }); // buyer withdraws after acceptance
    await deliverTradeEvents(prisma);
    expect(await acceptance(w.R.scoped, b.po.id)).toBe("CANCELLED");
    expect(await acceptance(w.W.scoped, b.so.id)).toBe("CANCELLED");
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ reserved: 0, available: 200 });
    await expect(cancelOrder(prisma, { businessId: w.W.businessId, orderId: b.so.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
    expect(await reconcileStock(w.W.scoped)).toEqual([]);
  });

  it("goods that have shipped can no longer be cancelled", async () => {
    const w = await tradeWorld(prisma);
    const { so, po } = await request(w, 1);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id });
    await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 10 }] });
    await expect(cancelOrder(prisma, { businessId: w.W.businessId, orderId: so.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await deliverTradeEvents(prisma);
    await expect(cancelOrder(prisma, { businessId: w.R.businessId, orderId: po.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("a quote changes quantity/price, holds the stock, and the buyer's acceptance finalises it", async () => {
    const w = await tradeWorld(prisma);
    const { so, po } = await request(w, 3);
    await quoteSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id, changes: [{ lineNo: 1, quantity: 2, unitPriceMinor: 215_000n }], validUntil: soon(3_600_000), note: "only 2 cartons this week" });
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ reserved: 48 }); // held while quoted
    await deliverTradeEvents(prisma);
    const rRow = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(rRow).toMatchObject({ acceptance: "QUOTED", totalMinor: 430_000n });
    expect(rRow.lines[0]).toMatchObject({ quantity: 2, baseQuantity: 48, unitPriceMinor: 215_000n });

    await acceptQuote(prisma, { businessId: w.R.businessId, orderId: po.id });
    await deliverTradeEvents(prisma);
    expect(await acceptance(w.W.scoped, so.id)).toBe("ACCEPTED");
    expect(await acceptance(w.R.scoped, po.id)).toBe("ACCEPTED");
    const r = await w.W.scoped.stockReservation.findFirstOrThrow({ where: { reference: `order:${so.id}`, status: "ACTIVE" } });
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 10 * DAY); // extended to the hold period
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ reserved: 48 });
  });

  it("an expired quote cannot be accepted; expiry closes both rows and releases the stock", async () => {
    const w = await tradeWorld(prisma);
    const { so, po } = await request(w, 2);
    const validUntil = soon(60_000);
    await quoteSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id, changes: [], validUntil });
    await deliverTradeEvents(prisma);
    const later = new Date(validUntil.getTime() + 1_000);
    await expect(acceptQuote(prisma, { businessId: w.R.businessId, orderId: po.id, now: later })).rejects.toMatchObject({ code: "EXPIRED" });
    expect(await expireTradeOrders(prisma, later)).toBe(2); // each business expires its own row
    expect(await acceptance(w.W.scoped, so.id)).toBe("EXPIRED");
    expect(await acceptance(w.R.scoped, po.id)).toBe("EXPIRED");
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ reserved: 0 });
    expect(await expireTradeOrders(prisma, later)).toBe(0);
    await expect(acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("an accepted order cannot be accepted again, and an order past its validity cannot be accepted", async () => {
    const w = await tradeWorld(prisma);
    const { so } = await request(w, 1);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id });
    await expect(acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
    const w2 = await tradeWorld(prisma);
    const po = await createPurchaseOrder(prisma, { businessId: w2.R.businessId, partnerId: w2.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w2.rVariant.id, counterpartVariantId: w2.wVariant.id, quantity: 1, unit: "carton" }], validUntil: soon(60_000) });
    await submitPurchaseOrder(prisma, { businessId: w2.R.businessId, orderId: po.id });
    await deliverTradeEvents(prisma);
    const row = await w2.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id } });
    await expect(acceptSalesOrder(prisma, { businessId: w2.W.businessId, orderId: row.counterpartOrderId!, now: soon(120_000) })).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("the supplier's price changing between 'send' and delivery rejects the request with a reason instead of guessing", async () => {
    const w = await tradeWorld(prisma);
    const po = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 1, unit: "carton" }] });
    await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id });
    // the wholesaler retires the 220,000 price and publishes 230,000 before the request is delivered
    await addPriceRule(w.W.scoped, { businessId: w.W.businessId, priceListId: w.wList.id, variantId: w.wVariant.id, unit: "carton", unitPriceMinor: 230_000n, minQuantity: 1 });
    await w.W.scoped.priceRule.updateMany({ where: { unitPriceMinor: 220_000n }, data: { status: "RETIRED" } });
    await deliverTradeEvents(prisma);
    const row = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(row.acceptance).toBe("REJECTED");
    expect(row.note).toContain("prices changed");
    expect(await w.W.scoped.tradeOrder.count({ where: {} })).toBe(0);
  });

  it("units must agree between supplier and buyer (no silent bottle/piece mix-ups)", async () => {
    const w = await tradeWorld(prisma);
    const p = await createProduct(w.R.scoped, { businessId: w.R.businessId, name: "Cola bottles" });
    const bottles = await createVariant(w.R.scoped, { businessId: w.R.businessId, productId: p.id, sku: "COLA-BTL", name: "x", baseUnit: "bottle" });
    await expect(createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: bottles.id, counterpartVariantId: w.wVariant.id, quantity: 1, unit: "carton" }] }))
      .rejects.toMatchObject({ code: "INVALID" });
  });

  it("draft purchase orders can be rebuilt; once sent their lines are protected by the database", async () => {
    const w = await tradeWorld(prisma);
    const po = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 1, unit: "carton" }] });
    const rebuilt = await setDraftPurchaseLines(prisma, { businessId: w.R.businessId, orderId: po.id, lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 5, unit: "carton" }] });
    expect(rebuilt).toMatchObject({ totalMinor: 1_050_000n }); // 5 cartons hits the 210,000 break
    await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id });
    await expect(setDraftPurchaseLines(prisma, { businessId: w.R.businessId, orderId: po.id, lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 1, unit: "carton" }] })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(testDb.db.query(`DELETE FROM "TradeOrderLine" WHERE "orderId" = '${po.id}'`)).rejects.toThrow(/not permitted once an order has left DRAFT/);
  });
});

describe("acceptance freezes terms, enforced by the database", () => {
  it("an accepted order's quantities and prices cannot be changed even by direct SQL; an unpriced order cannot be accepted", async () => {
    const w = await tradeWorld(prisma);
    const { so } = await request(w, 1);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id });
    await expect(testDb.db.query(`UPDATE "TradeOrderLine" SET "unitPriceMinor" = 1, "lineTotalMinor" = 1 WHERE "orderId" = '${so.id}'`)).rejects.toThrow(/frozen/);
    await expect(testDb.db.query(`UPDATE "TradeOrderLine" SET "quantity" = 2, "baseQuantity" = 48, "lineTotalMinor" = 440000 WHERE "orderId" = '${so.id}'`)).rejects.toThrow(/frozen/);
    await expect(testDb.db.query(`DELETE FROM "TradeOrder" WHERE id = '${so.id}'`)).rejects.toThrow(/not permitted/);
    // shipped/received counters may still move (they are not terms)
    await expect(testDb.db.query(`UPDATE "TradeOrderLine" SET "shippedBase" = 999 WHERE "orderId" = '${so.id}'`)).rejects.toThrow(/check constraint|values_check/);

    const w2 = await tradeWorld(prisma);
    const manual = await createSalesOrder(prisma, { businessId: w2.W.businessId, partnerId: (await createPartner(w2.W.scoped, { businessId: w2.W.businessId, name: "Walk-in Buyer", role: "CUSTOMER" })).id, currencyCode: "NGN", lines: [{ variantId: w2.wVariant.id, quantity: 5 }] });
    await expect(acceptSalesOrder(prisma, { businessId: w2.W.businessId, orderId: manual.id })).rejects.toMatchObject({ code: "UNPRICED" });
    await expect(testDb.db.query(`UPDATE "TradeOrder" SET "acceptance" = 'ACCEPTED' WHERE id = '${manual.id}'`)).rejects.toThrow(/must be priced/);
  });
});

describe("no overselling across channels (scenario 2, B2B side)", () => {
  it("a consumer sale and a trade order compete for the last cartons: exactly one wins, nothing goes negative", async () => {
    const w = await tradeWorld(prisma, { wholesalerStock: 48 });
    const { so } = await request(w, 2); // 48 pieces = all the stock
    const results = await Promise.allSettled([
      acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id }),
      reserveStock(w.W.scoped, { businessId: w.W.businessId, shopId: w.W.shopId, variantId: w.wVariant.id, quantity: 30, reference: "b2c:basket", idempotencyKey: "b2c-last", expiresAt: soon(600_000) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    const lvl = await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id);
    expect(lvl.available).toBeGreaterThanOrEqual(0);
    expect(await reconcileStock(w.W.scoped)).toEqual([]);
    // a failed acceptance leaves the order requested and holds nothing
    if ((await acceptance(w.W.scoped, so.id)) === "REQUESTED") expect(lvl.reserved).toBe(30);
  });

  it("an acceptance that cannot hold every line holds nothing and stays requested", async () => {
    const w = await tradeWorld(prisma, { wholesalerStock: 30 });
    const { so } = await request(w, 2); // needs 48, has 30
    await expect(acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", available: 30 });
    expect(await acceptance(w.W.scoped, so.id)).toBe("REQUESTED");
    expect(await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).toMatchObject({ reserved: 0 });
  });

  it("an expired stock hold must be renewed before shipping, and renewal fails if the stock has gone", async () => {
    const w = await tradeWorld(prisma, { wholesalerStock: 48 });
    const { so } = await request(w, 2);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id, holdDays: 1 });
    const { expireReservations } = await import("../src/domain/stock.js");
    expect(await expireReservations(w.W.scoped, new Date(Date.now() + 2 * DAY))).toBe(1);
    await expect(shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 24 }] })).rejects.toMatchObject({ code: "RESERVATION_CLOSED" });
    await renewOrderHold(prisma, { businessId: w.W.businessId, orderId: so.id });
    const shipped = await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 24 }] });
    expect(shipped.invoice.totalMinor).toBe(220_000n);
    await expect(shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 25 }] })).rejects.toMatchObject({ code: "OVER_QUANTITY" });
  });
});

describe("trade credit: terms are the seller's own, and an override needs a person and a reason", () => {
  it("a limit blocks acceptance; overriding is audited; an overdue invoice blocks when the seller's rule says so", async () => {
    const w = await tradeWorld(prisma);
    await setPartnerTerms(w.W.scoped, w.wPartnerId!, { creditLimitMinor: 500_000n, blockWhenOverdueDays: 7, paymentTermsDays: 14 });
    const first = await request(w, 2); // 440,000 within the limit
    expect((await evaluateTradeCredit(w.W.scoped, { partnerId: w.wPartnerId!, additionalMinor: first.so.totalMinor })).allowed).toBe(true);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: first.so.id });

    const second = await request(w, 1); // 440,000 accepted + 220,000 > 500,000
    await expect(acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: second.so.id })).rejects.toMatchObject({ code: "CREDIT_BLOCKED" });
    await expect(acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: second.so.id, creditOverride: { by: "w-owner", reason: "  " } })).rejects.toMatchObject({ code: "CREDIT_BLOCKED" });
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: second.so.id, creditOverride: { by: "w-owner", reason: "long-standing customer, paid in full last month" } });
    const audit = await w.W.scoped.auditLog.findFirstOrThrow({ where: { action: "trade.credit.override" } });
    expect(audit).toMatchObject({ actorId: "w-owner", entityId: second.so.id });
    expect((audit.metadata as { reason: string }).reason).toContain("paid in full");

    // overdue: ship, invoice due in 14 days, then evaluate 30 days later
    await shipOrder(prisma, { businessId: w.W.businessId, orderId: first.so.id, lines: [{ orderLineId: first.so.lines[0]!.id, baseQuantity: 48 }] });
    const later = new Date(Date.now() + 30 * DAY);
    const ev = await evaluateTradeCredit(w.W.scoped, { partnerId: w.wPartnerId!, additionalMinor: 1n, now: later });
    expect(ev.oldestOverdueDays).toBeGreaterThanOrEqual(15);
    expect(ev.reasons.map((r) => r.code)).toContain("OVERDUE_BLOCK");
  });
});

describe("partners who are not on TradePal", () => {
  it("the buyer records the supplier's confirmation (with evidence) and the order freezes; no mirror is created", async () => {
    const w = await tradeWorld(prisma, { link: false });
    const manual = await createPartner(w.R.scoped, { businessId: w.R.businessId, name: "Market Trader", role: "SUPPLIER" });
    const po = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: manual.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, quantity: 30, unitPriceMinor: 9_000n }] });
    expect(po.totalMinor).toBe(270_000n);
    await expect(confirmUnlinkedPurchase(prisma, { businessId: w.R.businessId, orderId: po.id, evidenceNote: "  " })).rejects.toMatchObject({ code: "INVALID" });
    await expect(submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id })).rejects.toMatchObject({ code: "NOT_LINKED" });
    const confirmed = await confirmUnlinkedPurchase(prisma, { businessId: w.R.businessId, orderId: po.id, evidenceNote: "Confirmed by phone, 20 Oct, price 90.00 each", actor: "r-owner" });
    expect(confirmed.acceptance).toBe("ACCEPTED");
    expect((confirmed.frozenTerms as { evidence: string }).evidence).toContain("Confirmed by phone");
    expect(await prisma.outboxEvent.count({ where: { aggregateId: po.id } })).toBe(0);
    const unpriced = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: manual.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, quantity: 3 }] });
    await expect(confirmUnlinkedPurchase(prisma, { businessId: w.R.businessId, orderId: unpriced.id, evidenceNote: "phone" })).rejects.toMatchObject({ code: "UNPRICED" });
  });

  it("a seller sells to a customer who is not on TradePal: order, hold, ship, invoice and payment all work without any mirror", async () => {
    const w = await tradeWorld(prisma, { link: false });
    const buyer = await createPartner(w.W.scoped, { businessId: w.W.businessId, name: "Mama Put Eatery", role: "CUSTOMER", paymentTermsDays: 7 });
    const so = await createSalesOrder(prisma, { businessId: w.W.businessId, partnerId: buyer.id, currencyCode: "NGN", lines: [{ variantId: w.wVariant.id, quantity: 2, unit: "carton", priceListId: w.wList.id }] });
    expect(so.totalMinor).toBe(440_000n);
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: so.id });
    const shipped = await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 48 }] });
    expect(shipped.invoice.dueDate!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    await recordPayment(prisma, { businessId: w.W.businessId, invoiceId: shipped.invoice.id, amountMinor: 440_000n, method: "CASH" });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: so.id } })).toBe(0);
    // a linked customer must order through TradePal instead
    const w2 = await tradeWorld(prisma);
    await expect(createSalesOrder(prisma, { businessId: w2.W.businessId, partnerId: w2.wPartnerId!, currencyCode: "NGN", lines: [{ variantId: w2.wVariant.id, quantity: 1, unitPriceMinor: 5n }] })).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("feature flag and permissions of the domain", () => {
  it("everything is refused while tradeOrders is off for the business", async () => {
    const w = await tradeWorld(prisma);
    await enableFlag(prisma, w.R.businessId, "tradeOrders", false);
    await expect(createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 1, unit: "carton" }] })).rejects.toMatchObject({ code: "FEATURE_OFF" });
  });

  it("one business cannot act on another's documents, and a buyer cannot use the seller's variant as its own", async () => {
    const w = await tradeWorld(prisma);
    const { po, so } = await request(w, 1);
    await expect(acceptSalesOrder(prisma, { businessId: w.R.businessId, orderId: so.id })).rejects.toMatchObject({ code: "NOT_FOUND" }); // the buyer cannot reach the seller's row
    await expect(cancelOrder(prisma, { businessId: w.W.businessId, orderId: po.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.wVariant.id, counterpartVariantId: w.wVariant.id, quantity: 1, unit: "carton" }] })).rejects.toMatchObject({ code: "INVALID" });
    await expect(receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: "nope", lines: [{ shipmentLineId: "x", acceptedBase: 1 }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
