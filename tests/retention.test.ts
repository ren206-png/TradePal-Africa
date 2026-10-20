import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder } from "./helpers/store.js";
import { cancelStoreOrderBySeller, completeStoreOrder, confirmStoreOrder } from "../src/domain/store/orders.js";
import { anonymizeOldShopperData, retentionMonthsFromEnv, REMOVED } from "../src/domain/store/retention.js";
import { openSupportCase } from "../src/domain/store/cases.js";
import { runOperationsSweep } from "../src/queue/operationsSweep.js";

vi.setConfig({ testTimeout: 60_000 });
let testDb: TestDb;
let prisma: PrismaClient;
let k = 0;
const YEAR = 365 * 86_400_000;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

describe("shopper data retention", () => {
  it("removes the personal fields of finished orders after the retention period, keeps every amount and the history, and skips open matters", async () => {
    const s = await makeSeller(prisma, `Retain ${++k}`, { slug: `retain-${k}` });
    const done = (await placeStoreOrder(prisma, s, { qty: 2 })).order;
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: done.id });
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: done.id, code: done.pickupCode, collect: { method: "CASH" } });
    const withCase = (await placeStoreOrder(prisma, s, { qty: 1 })).order;
    await cancelStoreOrderBySeller(prisma, { businessId: s.businessId, orderId: withCase.id, reason: "Out of stock" });
    await openSupportCase(prisma, { businessId: s.businessId, orderId: withCase.id, type: "OTHER", openedBy: "CONSUMER", summary: "Still waiting for an answer", contactName: "Amaka Obi", contactPhone: "08031234567" });
    const open = (await placeStoreOrder(prisma, s, { qty: 1 })).order; // still PLACED: never touched

    const before = await s.scoped.storeOrder.findUniqueOrThrow({ where: { id: done.id } });
    expect(before.buyerName).toBe("Amaka Obi");
    expect(await anonymizeOldShopperData(prisma, new Date(Date.now() + YEAR), 24)).toEqual({ orders: 0, cases: 0 }); // not old enough yet
    const r = await anonymizeOldShopperData(prisma, new Date(Date.now() + 3 * YEAR), 24);
    expect(r.orders).toBeGreaterThanOrEqual(1);
    const after = await s.scoped.storeOrder.findUniqueOrThrow({ where: { id: done.id } });
    expect(after).toMatchObject({ buyerName: REMOVED, buyerPhone: REMOVED, buyerNote: null, addressLine: null, status: "COMPLETED" });
    expect([after.totalMinor, after.paidMinor, after.subtotalMinor]).toEqual([before.totalMinor, before.paidMinor, before.subtotalMinor]); // financial record intact
    expect(await s.scoped.journalEntry.count()).toBeGreaterThan(0);
    expect((await s.scoped.storeOrder.findUniqueOrThrow({ where: { id: withCase.id } })).buyerName).toBe("Amaka Obi"); // an unclosed case keeps it
    expect((await s.scoped.storeOrder.findUniqueOrThrow({ where: { id: open.id } })).buyerName).toBe("Amaka Obi");
    expect(await anonymizeOldShopperData(prisma, new Date(Date.now() + 3 * YEAR), 24)).toMatchObject({ orders: expect.any(Number) });
  });

  it("turns off with 0, reads its setting safely, and runs as a step of the operations sweep", async () => {
    expect(await anonymizeOldShopperData(prisma, new Date(Date.now() + 50 * YEAR), 0)).toEqual({ orders: 0, cases: 0 });
    expect(retentionMonthsFromEnv({} as NodeJS.ProcessEnv)).toBe(24);
    expect(retentionMonthsFromEnv({ SHOPPER_DATA_RETENTION_MONTHS: "12" } as unknown as NodeJS.ProcessEnv)).toBe(12);
    expect(retentionMonthsFromEnv({ SHOPPER_DATA_RETENTION_MONTHS: "0" } as unknown as NodeJS.ProcessEnv)).toBe(0);
    expect(retentionMonthsFromEnv({ SHOPPER_DATA_RETENTION_MONTHS: "banana" } as unknown as NodeJS.ProcessEnv)).toBe(24);
    const r = await runOperationsSweep(prisma, new Date(), { retention: true });
    expect(r.failures).toEqual([]);
    expect(r).toHaveProperty("shopperDataAnonymized");
  });
});
