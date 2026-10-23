import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder } from "./helpers/store.js";
import { cancelStoreOrderByBuyer, completeStoreOrder, confirmStoreOrder, decideCancellationRequest } from "../src/domain/store/orders.js";
import { requestRefund } from "../src/domain/store/refunds.js";
import { escalateUnansweredRequests } from "../src/domain/store/escalation.js";
import { runOperationsSweep } from "../src/queue/operationsSweep.js";

vi.setConfig({ testTimeout: 60_000 });
let testDb: TestDb;
let prisma: PrismaClient;
let k = 0;
const DAY = 86_400_000;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

describe("a seller cannot sit on a shopper's request forever", () => {
  it("escalates an unanswered cancellation request after 5 days, once, to a case TradePal answers for, and decides nothing itself", async () => {
    const s = await makeSeller(prisma, `Escalate ${++k}`, { slug: `escalate-${k}` });
    const { order } = await placeStoreOrder(prisma, s, { qty: 2 });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    const asked = await cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: order.id, reason: "I found it cheaper elsewhere" });
    expect(asked.outcome).toBe("REQUESTED");

    expect((await escalateUnansweredRequests(prisma, new Date(Date.now() + 4 * DAY))).escalated).toBe(0); // not yet
    const first = await escalateUnansweredRequests(prisma, new Date(Date.now() + 6 * DAY));
    expect(first.escalated).toBeGreaterThanOrEqual(1);
    const cases = await s.scoped.supportCase.findMany({ where: { orderId: order.id } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ handledBy: "PLATFORM", openedBy: "ADMIN", status: "OPEN" });
    expect(cases[0]!.summary).toContain("has not answered");
    expect((await escalateUnansweredRequests(prisma, new Date(Date.now() + 7 * DAY))).escalated).toBe(0); // once
    expect(await s.scoped.supportCase.count({ where: { orderId: order.id } })).toBe(1);
    // nothing was decided for the seller: the order is still confirmed and the request still open
    expect((await s.scoped.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CONFIRMED");
    expect((await s.scoped.storeCancellationRequest.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("REQUESTED");
  });

  it("does not escalate a request the seller answered, and escalates an unanswered refund request", async () => {
    const s = await makeSeller(prisma, `Escalate ${++k}`, { slug: `escalate-${k}` });
    const a = (await placeStoreOrder(prisma, s, { qty: 1 })).order;
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: a.id });
    await cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: a.id, reason: "Changed my mind about it" });
    const req = await s.scoped.storeCancellationRequest.findFirstOrThrow({ where: { orderId: a.id } });
    await decideCancellationRequest(prisma, { businessId: s.businessId, requestId: req.id, approve: false });
    const b = (await placeStoreOrder(prisma, s, { qty: 1 })).order;
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: b.id });
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: b.id, code: b.pickupCode, collect: { method: "CASH" } });
    await requestRefund(prisma, { businessId: s.businessId, orderId: b.id, kind: "REFUND_ONLY", reason: "arrived damaged", requestedAmountMinor: 5_000n });
    await escalateUnansweredRequests(prisma, new Date(Date.now() + 6 * DAY));
    expect(await s.scoped.supportCase.count({ where: { orderId: a.id } })).toBe(0);
    const c = await s.scoped.supportCase.findFirstOrThrow({ where: { orderId: b.id } });
    expect(c).toMatchObject({ type: "REFUND", handledBy: "PLATFORM" });
  });

  it("runs as a step of the operations sweep", async () => {
    const r = await runOperationsSweep(prisma, new Date(Date.now() + 30 * DAY));
    expect(r.failures).toEqual([]);
    expect(r).toHaveProperty("requestsEscalated");
  });
});
