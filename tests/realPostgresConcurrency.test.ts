import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder } from "./helpers/store.js";
import { tradeWorld } from "./helpers/trade.js";
import { getStockLevel } from "../src/domain/stock.js";
import { acceptSalesOrder, createPurchaseOrder, submitPurchaseOrder } from "../src/domain/trade/orders.js";
import { setPartnerTerms } from "../src/domain/trade/partners.js";
import { deliverTradeEvents } from "../src/domain/trade/handlers.js";
import { recordCallback, processInbox } from "../src/domain/callbackInbox.js";
import { fakeJpeg } from "./helpers/images.js";
import { MAX_IMAGES_PER_PRODUCT, addProductImage } from "../src/domain/productImages.js";
import { applyBulkChanges } from "../src/domain/bulkCatalog.js";
import { enableFlag } from "./helpers/phase2.js";
import { confirmStoreOrder } from "../src/domain/store/orders.js";
import { createShipment } from "../src/domain/store/shipments.js";
import { CourierRegistry } from "../src/couriers/adapter.js";

/**
 * These races only mean something on a REAL Postgres (several genuine connections, real row locks). They run when TEST_PG_ADMIN_URL
 * points at a throw-away local server (see tests/helpers/db.ts) and are skipped on the in-process test database, which serialises sessions.
 */
const REAL = !!process.env["TEST_PG_ADMIN_URL"];
vi.setConfig({ testTimeout: 120_000 });

let testDb: TestDb;
let prisma: PrismaClient;
beforeAll(async () => {
  if (!REAL) return;
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  if (REAL) await testDb.teardown();
});

describe.skipIf(!REAL)("real concurrency (genuine parallel connections)", () => {
  it("shoppers racing for the last units: never more reserved than on hand, and the right number win", async () => {
    const s = await makeSeller(prisma, "Race Shop", { stock: 6 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => placeStoreOrder(prisma, s, { qty: 2 })));
    const won = results.filter((r) => r.status === "fulfilled").length;
    const level = await getStockLevel(s.scoped, s.shopId, s.variant.id);
    expect(level.reserved).toBeLessThanOrEqual(level.onHand);
    expect(level.available).toBeGreaterThanOrEqual(0);
    expect(won).toBeLessThanOrEqual(3); // 6 units / 2 each
    expect(level.reserved).toBe(won * 2);
    expect(won).toBeGreaterThanOrEqual(1);
  });

  it("simultaneous orders for one seller never share an order number", async () => {
    const s = await makeSeller(prisma, "Numbering Shop", { stock: 200 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => placeStoreOrder(prisma, s, { qty: 1 })));
    const orders = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.order] : []));
    const refs = orders.map((o) => o.reference);
    expect(new Set(refs).size).toBe(refs.length);
    expect(orders.length).toBeGreaterThanOrEqual(1);
    console.log(`order-number race: ${orders.length}/10 placed at once, ${results.length - orders.length} asked to retry`);
  });

  it("several order acceptances at once cannot together exceed the buyer's credit limit", async () => {
    const w = await tradeWorld(prisma);
    await setPartnerTerms(w.W.scoped, w.wPartnerId!, { creditLimitMinor: 700_000n }); // one 3-carton order is 660,000
    const soIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const po = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 3, unit: "carton" }] });
      await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id });
    }
    await deliverTradeEvents(prisma);
    for (const o of await w.W.scoped.tradeOrder.findMany({ where: { side: "SELL" } })) soIds.push(o.id);
    expect(soIds).toHaveLength(4);
    const results = await Promise.allSettled(soIds.map((id) => acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: id })));
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    expect(accepted).toBe(1);
  });

  it("the same callback processed by several workers at once is applied by exactly one", async () => {
    const received = await Promise.all(Array.from({ length: 4 }, (_, i) => recordCallback(prisma, { provider: "race-test", externalId: "evt-same", payload: { n: i }, signatureVerified: true })));
    expect(received.filter((r) => r.inserted)).toHaveLength(1); // the unique key lets exactly one racing insert win
    expect(new Set(received.map((r) => r.id)).size).toBe(1);
    let handled = 0;
    const handlers = { "race-test": async () => { handled++; await new Promise((r) => setTimeout(r, 30)); } };
    await Promise.all(Array.from({ length: 4 }, () => processInbox(prisma, handlers, { now: new Date(Date.now() + 1000) })));
    expect(handled).toBe(1);
  });

  it("many phones uploading photos for one product at once never exceed the limit and never store the same picture twice", async () => {
    const s = await makeSeller(prisma, "Photo Race Shop", { stock: 5 });
    const base = { businessId: s.businessId, productId: s.product.id };
    const pics = Array.from({ length: 14 }, (_, i) => fakeJpeg(900, 900, i % 10)); // 10 different pictures, 4 repeats
    const results = await Promise.allSettled(pics.map((data) => addProductImage(s.scoped, { ...base, data })));
    const live = await s.scoped.productImage.findMany({ where: { productId: s.product.id, removedAt: null } });
    expect(live.length).toBeLessThanOrEqual(MAX_IMAGES_PER_PRODUCT);
    expect(live.length).toBe(MAX_IMAGES_PER_PRODUCT);
    expect(new Set(live.map((x) => x.sha256)).size).toBe(live.length);
    expect(new Set(live.map((x) => x.position)).size).toBe(live.length);
    expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
  });

  it("the same bulk-edit batch sent several times at once is applied exactly once", async () => {
    const s = await makeSeller(prisma, "Bulk Race Shop", { stock: 5 });
    const ctx = { businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, role: "OWNER" as const, actorId: "m-1" };
    const rows = [{ sku: "COLA", retailPrice: "175" }];
    const results = await Promise.all(Array.from({ length: 6 }, () => applyBulkChanges(prisma, ctx, { batchId: "race-batch-0001", rows })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await s.scoped.auditLog.count({ where: { action: "catalog.bulk_edit" } })).toBe(1);
    expect(await s.scoped.priceRule.count({ where: { variantId: s.variant.id, status: "ACTIVE", packConversionId: null, minQuantity: 1 } })).toBe(1);
  });

  it("two courier bookings for one order at once create one live job and dispatch the order once", async () => {
    process.env["COURIERS_ENABLED"] = "true";
    const s = await makeSeller(prisma, "Courier Race Shop", { stock: 20 });
    await enableFlag(prisma, s.businessId, "storeCourier");
    const { order } = await placeStoreOrder(prisma, s, { qty: 2, fulfilment: "DELIVERY" });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    const results = await Promise.allSettled([1, 2, 3].map(() => createShipment(prisma, new CourierRegistry(), { businessId: s.businessId, orderId: order.id, courier: "manual" })));
    delete process.env["COURIERS_ENABLED"];
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await s.scoped.deliveryShipment.count({ where: { orderId: order.id, status: { in: ["BOOKED", "PICKED_UP", "IN_TRANSIT"] } } })).toBe(1);
    expect((await s.scoped.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("OUT_FOR_DELIVERY");
    const level = await getStockLevel(s.scoped, s.shopId, s.variant.id);
    expect(level.onHand).toBe(18); // 20 - 2: the goods left once
  });
});
