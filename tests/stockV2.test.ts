import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import {
  StockError, approveStockCount, cancelTransfer, createTransfer, dispatchTransfer, expireReservations, fulfilReservation, fulfilSale, getStockLevel,
  findLegacyStockDrift, mirrorLegacyMovement, openStockCount, postAdoptionOpening, quarantineStock, receiveStock, receiveTransfer, reconcileStock, recordCountLine,
  recordOpeningBalance, setCountLineReason, recordOwnerWithdrawal, recordSpoilage, releaseReservation, reserveStock, restockReturn, reverseStockMovement, setStockPolicy,
  writeOffQuarantined,
} from "../src/domain/stock.js";
import { applyStockMovement } from "../src/domain/inventory.js";

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

let n = 0;
async function setup() {
  const env = await makeBusiness(prisma);
  n++;
  const product = await createProduct(env.scoped, { businessId: env.businessId, name: `P${n}` });
  const variant = await createVariant(env.scoped, { businessId: env.businessId, productId: product.id, sku: `SKU-${n}`, name: "v", baseUnit: "piece" });
  const common = { businessId: env.businessId, shopId: env.shopId, variantId: variant.id };
  return { ...env, variant, common };
}
const soon = (ms = 60_000) => new Date(Date.now() + ms);

describe("balances: on hand, reserved, available, damaged (movement log is the truth)", () => {
  it("receipts and sales move on-hand, and reconcile with the movement log", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 100n, currencyCode: "NGN" });
    await fulfilSale(s.scoped, { ...s.common, quantity: 4 });
    const level = await getStockLevel(s.scoped, s.shopId, s.variant.id);
    expect(level).toMatchObject({ onHand: 6, reserved: 0, available: 6, damaged: 0, inTransit: 0 });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("is idempotent per key: a replayed message changes stock once", async () => {
    const s = await setup();
    const a = await receiveStock(s.scoped, { ...s.common, quantity: 5, idempotencyKey: "wamid.1" });
    const b = await receiveStock(s.scoped, { ...s.common, quantity: 5, idempotencyKey: "wamid.1" });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.movement.id).toBe(a.movement.id);
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).onHand).toBe(5);
  });

  it("quarantine moves units out of sellable stock; write-off removes them at average cost", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 200n, currencyCode: "NGN" });
    await quarantineStock(s.scoped, { ...s.common, quantity: 3 });
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 7, damaged: 3, available: 7 });
    const off = await writeOffQuarantined(s.scoped, { ...s.common, quantity: 2, currencyCode: "NGN" });
    expect(off.movement.costMinor).toBe(400n);
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 7, damaged: 1 });
    await expect(writeOffQuarantined(s.scoped, { ...s.common, quantity: 5 })).rejects.toMatchObject({ code: "INVALID" });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("explicit owner withdrawal and spoilage are their own kinds, with cost", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 50n, currencyCode: "NGN" });
    const w = await recordOwnerWithdrawal(s.scoped, { ...s.common, quantity: 2, currencyCode: "NGN" });
    const sp = await recordSpoilage(s.scoped, { ...s.common, quantity: 1, currencyCode: "NGN" });
    expect(w.movement).toMatchObject({ kind: "OWNER_WITHDRAWAL", costMinor: 100n });
    expect(sp.movement).toMatchObject({ kind: "SPOILAGE", costMinor: 50n });
  });

  it("refuses bad quantities", async () => {
    const s = await setup();
    await expect(receiveStock(s.scoped, { ...s.common, quantity: 0 })).rejects.toBeInstanceOf(StockError);
    await expect(receiveStock(s.scoped, { ...s.common, quantity: 1.5 })).rejects.toBeInstanceOf(StockError);
    await expect(fulfilSale(s.scoped, { ...s.common, quantity: -1 })).rejects.toBeInstanceOf(StockError);
  });

  it("will not touch a variant or shop from another business", async () => {
    const a = await setup();
    const b = await setup();
    await expect(receiveStock(b.scoped, { businessId: b.businessId, shopId: b.shopId, variantId: a.variant.id, quantity: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(receiveStock(b.scoped, { businessId: b.businessId, shopId: a.shopId, variantId: b.variant.id, quantity: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reversing a movement swaps it exactly, once", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 100n, currencyCode: "NGN" });
    const sale = await fulfilSale(s.scoped, { ...s.common, quantity: 3, currencyCode: "NGN" });
    const r1 = await reverseStockMovement(s.scoped, sale.movement.id);
    const r2 = await reverseStockMovement(s.scoped, sale.movement.id);
    expect(r2.replayed).toBe(true);
    expect(r2.movement.id).toBe(r1.movement.id);
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).onHand).toBe(10);
    await expect(reverseStockMovement(s.scoped, r1.movement.id)).rejects.toMatchObject({ code: "INVALID" });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });
});

describe("costing: moving weighted average, honest about missing costs", () => {
  it("averages costed receipts and costs a sale at the average", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 100n, currencyCode: "NGN" });
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 200n, currencyCode: "NGN" });
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).avgCostMinor).toBe(150n);
    const sale = await fulfilSale(s.scoped, { ...s.common, quantity: 5, currencyCode: "NGN" });
    expect(sale.movement).toMatchObject({ costMinor: 750n, unitCostMinor: 150n, costIncomplete: false });
  });

  it("rounds the average half away from zero (3@100 + 1@101 = 100.25 -> 100; 1@100 + 1@101 = 100.5 -> 101)", async () => {
    const a = await setup();
    await receiveStock(a.scoped, { ...a.common, quantity: 3, unitCostMinor: 100n });
    await receiveStock(a.scoped, { ...a.common, quantity: 1, unitCostMinor: 101n });
    expect((await getStockLevel(a.scoped, a.shopId, a.variant.id)).avgCostMinor).toBe(100n);
    const b = await setup();
    await receiveStock(b.scoped, { ...b.common, quantity: 1, unitCostMinor: 100n });
    await receiveStock(b.scoped, { ...b.common, quantity: 1, unitCostMinor: 101n });
    expect((await getStockLevel(b.scoped, b.shopId, b.variant.id)).avgCostMinor).toBe(101n);
  });

  it("units that arrived without a cost are tracked, consumed first, and flag the sale as cost-incomplete", async () => {
    const s = await setup();
    await recordOpeningBalance(s.scoped, { ...s.common, quantity: 10 }); // no cost known
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 200n, currencyCode: "NGN" });
    const lvl = await getStockLevel(s.scoped, s.shopId, s.variant.id);
    expect(lvl).toMatchObject({ onHand: 20, uncostedQty: 10, avgCostMinor: 200n });
    const sale = await fulfilSale(s.scoped, { ...s.common, quantity: 12, currencyCode: "NGN" });
    expect(sale.movement).toMatchObject({ costMinor: 400n, costIncomplete: true }); // only the 2 costed units are costed
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).uncostedQty).toBe(0);
    const clean = await fulfilSale(s.scoped, { ...s.common, quantity: 3, currencyCode: "NGN" });
    expect(clean.movement).toMatchObject({ costMinor: 600n, costIncomplete: false });
  });

  it("with no cost anywhere there is no cost, never a guess", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 5 });
    const sale = await fulfilSale(s.scoped, { ...s.common, quantity: 2 });
    expect(sale.movement.costMinor).toBeNull();
    expect(sale.movement.costIncomplete).toBe(true);
  });

  it("selling below zero is allowed by default (legacy behaviour), costs only what was on hand, and is flagged", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 2, unitCostMinor: 100n });
    const sale = await fulfilSale(s.scoped, { ...s.common, quantity: 5 });
    expect(sale.movement).toMatchObject({ costMinor: 200n, costIncomplete: true });
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).onHand).toBe(-3);
  });

  it("a sellable return restocks at the cost the units left at", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 100n });
    const sale = await fulfilSale(s.scoped, { ...s.common, quantity: 2 });
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 300n }); // average moves to ~
    const back = await restockReturn(s.scoped, { ...s.common, quantity: 1, unitCostMinor: sale.movement.unitCostMinor! });
    expect(back.movement.unitCostMinor).toBe(100n);
  });
});

describe("negative-stock policy and approval", () => {
  it("BLOCK refuses a sale beyond available stock unless an approver is named", async () => {
    const s = await setup();
    await setStockPolicy(s.scoped, s.businessId, { negativeStock: "BLOCK" });
    await receiveStock(s.scoped, { ...s.common, quantity: 3 });
    await expect(fulfilSale(s.scoped, { ...s.common, quantity: 5 })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", available: 3 });
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).onHand).toBe(3); // nothing moved
    const approved = await fulfilSale(s.scoped, { ...s.common, quantity: 5, approvedBy: "owner-1" });
    expect(approved.movement.note).toContain("approved by owner-1");
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).onHand).toBe(-2);
  });
});

describe("reservations: no overselling (scenario 2)", () => {
  it("holds stock, reduces available, and refuses what is not available", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10 });
    const r = await reserveStock(s.scoped, { ...s.common, quantity: 7, reference: "order:1", idempotencyKey: "res-1", expiresAt: soon() });
    expect(r.replayed).toBe(false);
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 10, reserved: 7, available: 3 });
    await expect(reserveStock(s.scoped, { ...s.common, quantity: 4, reference: "order:2", idempotencyKey: "res-2", expiresAt: soon() })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", available: 3 });
    // a normal sale cannot dip into reserved stock when strict
    await expect(fulfilSale(s.scoped, { ...s.common, quantity: 4, requireAvailable: true })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    // a retried request returns the same reservation and holds nothing extra
    const again = await reserveStock(s.scoped, { ...s.common, quantity: 7, reference: "order:1", idempotencyKey: "res-1", expiresAt: soon() });
    expect(again.replayed).toBe(true);
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).reserved).toBe(7);
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("a B2C basket and a B2B order compete for the last units: exactly one wins", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 5 });
    const results = await Promise.allSettled([
      reserveStock(s.scoped, { ...s.common, quantity: 5, reference: "b2c:basket-9", idempotencyKey: "b2c-9", expiresAt: soon() }),
      reserveStock(s.scoped, { ...s.common, quantity: 5, reference: "b2b:order-3", idempotencyKey: "b2b-3", expiresAt: soon() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    const lvl = await getStockLevel(s.scoped, s.shopId, s.variant.id);
    expect(lvl).toMatchObject({ onHand: 5, reserved: 5, available: 0 });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("many concurrent single-unit reservations never exceed stock", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => reserveStock(s.scoped, { ...s.common, quantity: 1, reference: `o:${i}`, idempotencyKey: `many-${i}`, expiresAt: soon() })),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(3);
    const lvl = await getStockLevel(s.scoped, s.shopId, s.variant.id);
    expect(lvl.reserved).toBe(3);
    expect(lvl.available).toBe(0);
  });

  it("backorders can be enabled explicitly", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 1 });
    await setStockPolicy(s.scoped, s.businessId, { allowBackorder: true });
    await reserveStock(s.scoped, { ...s.common, quantity: 4, reference: "o", idempotencyKey: "bo", expiresAt: soon() });
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).available).toBe(-3);
  });

  it("release and expiry give the units back, and are safe to repeat", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10 });
    const a = await reserveStock(s.scoped, { ...s.common, quantity: 4, reference: "a", idempotencyKey: "rel-a", expiresAt: soon() });
    const b = await reserveStock(s.scoped, { ...s.common, quantity: 3, reference: "b", idempotencyKey: "rel-b", expiresAt: new Date(Date.now() + 5_000) });
    expect(await releaseReservation(s.scoped, a.reservation.id)).toBe(true);
    expect(await releaseReservation(s.scoped, a.reservation.id)).toBe(false);
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).reserved).toBe(3);
    expect(await expireReservations(s.scoped, new Date(Date.now() + 10_000))).toBe(1);
    expect(await expireReservations(s.scoped, new Date(Date.now() + 10_000))).toBe(0);
    const lvl = await getStockLevel(s.scoped, s.shopId, s.variant.id);
    expect(lvl).toMatchObject({ reserved: 0, available: 10 });
    expect((await s.scoped.stockReservation.findUniqueOrThrow({ where: { id: b.reservation.id } })).status).toBe("EXPIRED");
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("fulfilment consumes the hold and takes the units; an expired or released hold cannot be fulfilled", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10, unitCostMinor: 100n, currencyCode: "NGN" });
    const r = await reserveStock(s.scoped, { ...s.common, quantity: 6, reference: "o1", idempotencyKey: "ful-1", expiresAt: soon() });
    const out = await fulfilReservation(s.scoped, r.reservation.id, { currencyCode: "NGN" });
    expect(out.movement).toMatchObject({ kind: "SALE_FULFILLMENT", onHandDelta: -6, costMinor: 600n });
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 4, reserved: 0 });
    await expect(fulfilReservation(s.scoped, r.reservation.id)).rejects.toMatchObject({ code: "RESERVATION_CLOSED" });

    const r2 = await reserveStock(s.scoped, { ...s.common, quantity: 2, reference: "o2", idempotencyKey: "ful-2", expiresAt: soon() });
    await releaseReservation(s.scoped, r2.reservation.id);
    await expect(fulfilReservation(s.scoped, r2.reservation.id)).rejects.toMatchObject({ code: "RESERVATION_CLOSED" });

    const r3 = await reserveStock(s.scoped, { ...s.common, quantity: 1, reference: "o3", idempotencyKey: "ful-3", expiresAt: new Date(Date.now() + 2_000) });
    await expect(fulfilReservation(s.scoped, r3.reservation.id, { now: new Date(Date.now() + 5_000) })).rejects.toMatchObject({ code: "RESERVATION_CLOSED" });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("partial fulfilment takes only what shipped and releases the rest of the hold", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 10 });
    const r = await reserveStock(s.scoped, { ...s.common, quantity: 6, reference: "o", idempotencyKey: "part", expiresAt: soon() });
    await fulfilReservation(s.scoped, r.reservation.id, { quantity: 4 });
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 6, reserved: 0, available: 6 });
    await expect(fulfilReservation(s.scoped, (await reserveStock(s.scoped, { ...s.common, quantity: 2, reference: "x", idempotencyKey: "part2", expiresAt: soon() })).reservation.id, { quantity: 3 })).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("stock counts explain discrepancies before adjusting", () => {
  it("snapshots expected, requires a reason, adjusts once, and keeps later sales", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 12, unitCostMinor: 100n, currencyCode: "NGN" });
    const count = await openStockCount(s.scoped, { businessId: s.businessId, shopId: s.shopId, openedBy: "u1" });
    const line = await recordCountLine(s.scoped, { businessId: s.businessId, countId: count.id, variantId: s.variant.id, countedQty: 10 });
    expect(line).toMatchObject({ expectedQty: 12, countedQty: 10, discrepancy: -2 });
    await expect(approveStockCount(s.scoped, count.id, { id: "owner" }, "NGN")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await fulfilSale(s.scoped, { ...s.common, quantity: 3 }); // a sale after the count must not be undone by it
    await setCountLineReason(s.scoped, count.id, s.variant.id, "2 cartons dropped and broken");
    const out = await approveStockCount(s.scoped, count.id, { id: "owner" }, "NGN");
    expect(out.adjustments).toBe(1);
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).onHand).toBe(7); // 12 - 3 sale - 2 count loss
    await expect(approveStockCount(s.scoped, count.id, { id: "owner" })).rejects.toMatchObject({ code: "COUNT_CLOSED" });
    await expect(recordCountLine(s.scoped, { businessId: s.businessId, countId: count.id, variantId: s.variant.id, countedQty: 5 })).rejects.toMatchObject({ code: "COUNT_CLOSED" });
    const adj = await s.scoped.stockMovement.findFirstOrThrow({ where: { kind: "COUNT_ADJUSTMENT" } });
    expect(adj).toMatchObject({ onHandDelta: -2, note: "2 cartons dropped and broken", actorId: "owner" });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("a matching count needs no reason and creates no adjustment", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 4 });
    const count = await openStockCount(s.scoped, { businessId: s.businessId, shopId: s.shopId });
    await recordCountLine(s.scoped, { businessId: s.businessId, countId: count.id, variantId: s.variant.id, countedQty: 4 });
    expect((await approveStockCount(s.scoped, count.id, { id: "owner" })).adjustments).toBe(0);
  });

  it("the database refuses a count line whose discrepancy is not counted minus expected", async () => {
    const s = await setup();
    const count = await openStockCount(s.scoped, { businessId: s.businessId, shopId: s.shopId });
    await expect(
      testDb.db.query(`INSERT INTO "StockCountLine" (id,"businessId","countId","variantId","expectedQty","countedQty",discrepancy) VALUES ('cl-x','${s.businessId}','${count.id}','${s.variant.id}',5,3,7)`),
    ).rejects.toThrow(/check constraint|discrepancy_check/);
  });
});

describe("transfers: destination stock increases only on receipt", () => {
  async function twoShops() {
    const s = await setup();
    const other = await s.scoped.shop.create({ data: { businessId: s.businessId, name: "Second shop" } });
    return { ...s, otherShopId: other.id };
  }

  it("dispatch moves stock to in-transit; receipt makes it on-hand; a short receipt is recorded and written off", async () => {
    const s = await twoShops();
    await receiveStock(s.scoped, { ...s.common, quantity: 20, unitCostMinor: 100n, currencyCode: "NGN" });
    const t = await createTransfer(s.scoped, { businessId: s.businessId, fromShopId: s.shopId, toShopId: s.otherShopId, lines: [{ variantId: s.variant.id, quantity: 8 }] });
    const sent = await dispatchTransfer(s.scoped, t.id);
    expect(sent.status).toBe("DISPATCHED");
    expect(sent.lines[0]?.unitCostMinor).toBe(100n);
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 12 });
    expect(await getStockLevel(s.scoped, s.otherShopId, s.variant.id)).toMatchObject({ onHand: 0, inTransit: 8 });

    const done = await receiveTransfer(s.scoped, t.id, [{ variantId: s.variant.id, quantity: 7 }], { currencyCode: "NGN" });
    expect(done.status).toBe("RECEIVED");
    expect(done.lines[0]?.quantityReceived).toBe(7);
    const dest = await getStockLevel(s.scoped, s.otherShopId, s.variant.id);
    expect(dest).toMatchObject({ onHand: 7, inTransit: 0, avgCostMinor: 100n });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("refuses over-receipt, double dispatch, double receipt and cancelling a dispatched transfer", async () => {
    const s = await twoShops();
    await receiveStock(s.scoped, { ...s.common, quantity: 10 });
    const t = await createTransfer(s.scoped, { businessId: s.businessId, fromShopId: s.shopId, toShopId: s.otherShopId, lines: [{ variantId: s.variant.id, quantity: 5 }] });
    await dispatchTransfer(s.scoped, t.id);
    await expect(dispatchTransfer(s.scoped, t.id)).rejects.toMatchObject({ code: "TRANSFER_STATE" });
    await expect(cancelTransfer(s.scoped, t.id)).rejects.toMatchObject({ code: "TRANSFER_STATE" });
    await expect(receiveTransfer(s.scoped, t.id, [{ variantId: s.variant.id, quantity: 6 }])).rejects.toMatchObject({ code: "OVER_RECEIPT" });
    await expect(receiveTransfer(s.scoped, t.id, [])).rejects.toMatchObject({ code: "INVALID" });
    await receiveTransfer(s.scoped, t.id, [{ variantId: s.variant.id, quantity: 5 }]);
    await expect(receiveTransfer(s.scoped, t.id, [{ variantId: s.variant.id, quantity: 5 }])).rejects.toMatchObject({ code: "TRANSFER_STATE" });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("cannot dispatch more than is available, and a failed dispatch leaves nothing half-done", async () => {
    const s = await twoShops();
    await receiveStock(s.scoped, { ...s.common, quantity: 3 });
    const t = await createTransfer(s.scoped, { businessId: s.businessId, fromShopId: s.shopId, toShopId: s.otherShopId, lines: [{ variantId: s.variant.id, quantity: 5 }] });
    await expect(dispatchTransfer(s.scoped, t.id)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect((await s.scoped.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DRAFT"); // rolled back
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 3, inTransit: 0 });
    await cancelTransfer(s.scoped, t.id);
  });

  it("validates transfer creation", async () => {
    const s = await twoShops();
    await expect(createTransfer(s.scoped, { businessId: s.businessId, fromShopId: s.shopId, toShopId: s.shopId, lines: [{ variantId: s.variant.id, quantity: 1 }] })).rejects.toMatchObject({ code: "INVALID" });
    await expect(createTransfer(s.scoped, { businessId: s.businessId, fromShopId: s.shopId, toShopId: s.otherShopId, lines: [] })).rejects.toMatchObject({ code: "INVALID" });
    await expect(createTransfer(s.scoped, { businessId: s.businessId, fromShopId: s.shopId, toShopId: "nope", lines: [{ variantId: s.variant.id, quantity: 1 }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reconciliation and database protection", () => {
  it("detects a balance that no longer matches the movement log", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 5 });
    await testDb.db.query(`UPDATE "StockBalance" SET "onHand" = 99 WHERE "variantId" = '${s.variant.id}'`);
    expect(await reconcileStock(s.scoped)).toEqual([{ shopId: s.shopId, variantId: s.variant.id, field: "onHand", balance: 99, expected: 5 }]);
  });

  it("stock movements are append-only at the database", async () => {
    const s = await setup();
    const m = await receiveStock(s.scoped, { ...s.common, quantity: 5 });
    await expect(testDb.db.query(`UPDATE "StockMovement" SET "onHandDelta" = 6 WHERE id = '${m.movement.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "StockMovement" WHERE id = '${m.movement.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`TRUNCATE "StockMovement"`)).rejects.toThrow(/TRUNCATE/);
  });

  it("negative reserved / damaged / in-transit are refused by the database", async () => {
    const s = await setup();
    await receiveStock(s.scoped, { ...s.common, quantity: 5 });
    await expect(testDb.db.query(`UPDATE "StockBalance" SET "reserved" = -1 WHERE "variantId" = '${s.variant.id}'`)).rejects.toThrow(/check constraint|nonnegative/);
  });
});

describe("legacy inventory bridge (flag stockV2, default off)", () => {
  it("does nothing while the flag is off, and mirrors legacy movements for adopted items once on", async () => {
    const s = await setup();
    const item = await s.scoped.inventoryItem.create({ data: { businessId: s.businessId, name: "Beans", normalizedName: "beans", estimatedStockQty: 0 } });
    const variant = await createVariant(s.scoped, {
      businessId: s.businessId, productId: (await createProduct(s.scoped, { businessId: s.businessId, name: "Beans" })).id, sku: `BEANS-${n}`, name: "Beans", baseUnit: "kg",
    });
    await s.scoped.productVariant.update({ where: { id: variant.id }, data: { inventoryItemId: item.id } });

    await applyStockMovement(s.scoped, s.businessId, item, 5, "PURCHASE");
    expect(await s.scoped.stockMovement.count({ where: {} })).toBe(0); // flag off: legacy path unchanged

    await enableFlag(prisma, s.businessId, "stockV2");
    const fresh = await s.scoped.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    await applyStockMovement(s.scoped, s.businessId, fresh, -2, "SALE");
    const mirrored = await s.scoped.stockMovement.findMany({ where: {} });
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({ kind: "LEGACY_MIRROR", onHandDelta: -2 });
    const legacy = await s.scoped.inventoryMovement.findFirstOrThrow({ where: { quantityDelta: -2 } });
    expect(mirrored[0]?.sourceId).toBe(legacy.id);

    // a replay of the same legacy movement is a no-op
    await mirrorLegacyMovement(s.scoped, { businessId: s.businessId, inventoryItemId: item.id, legacyMovementId: legacy.id, quantityDelta: -2 });
    expect(await s.scoped.stockMovement.count({ where: {} })).toBe(1);
    // an item that never adopted a variant is ignored
    const loose = await s.scoped.inventoryItem.create({ data: { businessId: s.businessId, name: "Loose", normalizedName: "loose", estimatedStockQty: 0 } });
    await applyStockMovement(s.scoped, s.businessId, loose, 3, "PURCHASE");
    expect(await s.scoped.stockMovement.count({ where: {} })).toBe(1);
  });
});

describe("legacy stock drift detection", () => {
  it("reports an adopted item whose two counts have parted, and nothing when they agree", async () => {
    const s = await setup();
    await enableFlag(prisma, s.businessId, "stockV2");
    const item = await s.scoped.inventoryItem.create({ data: { businessId: s.businessId, name: "Oil", normalizedName: "oil", estimatedStockQty: 6 } });
    const variant = await createVariant(s.scoped, { businessId: s.businessId, productId: (await createProduct(s.scoped, { businessId: s.businessId, name: "Oil" })).id, sku: `OIL-${n}`, name: "Oil", baseUnit: "litre" });
    await s.scoped.productVariant.update({ where: { id: variant.id }, data: { inventoryItemId: item.id } });
    await postAdoptionOpening(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: variant.id, item });
    expect(await findLegacyStockDrift(s.scoped, s.shopId)).toEqual([]);
    await applyStockMovement(s.scoped, s.businessId, item, -2, "SALE"); // mirrored: still equal
    expect(await findLegacyStockDrift(s.scoped, s.shopId)).toEqual([]);
    await enableFlag(prisma, s.businessId, "stockV2", false); // mirror off: legacy moves alone
    await applyStockMovement(s.scoped, s.businessId, await s.scoped.inventoryItem.findUniqueOrThrow({ where: { id: item.id } }), -1, "SALE");
    expect(await findLegacyStockDrift(s.scoped, s.shopId)).toEqual([{ inventoryItemId: item.id, variantId: variant.id, sku: variant.sku, legacyEstimate: 3, v2OnHand: 4 }]);
  });
});
