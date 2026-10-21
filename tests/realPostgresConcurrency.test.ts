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
});
