import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, isRetryExhausted } from "../src/domain/retryPolicy.js";
import { claimDueOutboxEvents, enqueueOutboxEvent, getOutboxStats, processOutbox, replayDeadOutboxEvent } from "../src/domain/outbox.js";
import { claimDueCallbacks, getInboxStats, processInbox, recordCallback, replayDeadCallback } from "../src/domain/callbackInbox.js";

let testDb: TestDb;
let prisma: PrismaClient;
let db: PGlite;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  db = testDb.db;
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

// A fixed clock just ahead of the real one: rows inserted with the default availableAt (now) are already due at T0.
const T0 = new Date(Date.now() + 60_000);
const after = (ms: number) => new Date(T0.getTime() + ms);
const FAST_RETRY = { baseDelayMs: 1_000, maxDelayMs: 8_000, maxAttempts: 3 };

describe("retry policy", () => {
  it("backs off exponentially up to a cap and gives up after the attempt budget", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n));
    expect(delays[0]).toBe(30_000);
    expect(delays[1]).toBe(60_000);
    expect(delays[2]).toBe(120_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
    expect(backoffDelayMs(50)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
    expect(backoffDelayMs(3, FAST_RETRY, (ms) => ms / 2)).toBe(2_000);
    expect(isRetryExhausted(7)).toBe(false);
    expect(isRetryExhausted(8)).toBe(true);
  });
});

describe("transactional outbox", () => {
  it("is idempotent on the dedupe key: the same business effect is queued once", async () => {
    const input = { aggregateType: "Order", aggregateId: "o-1", eventType: "order.placed", payload: { n: 1 }, dedupeKey: "order.placed:o-1" };
    const first = await enqueueOutboxEvent(prisma, input);
    const again = await enqueueOutboxEvent(prisma, { ...input, payload: { n: 999 } });
    expect(again.id).toBe(first.id);
    expect(again.payload).toEqual({ n: 1 }); // the original, untouched
    expect(await prisma.outboxEvent.count({ where: { dedupeKey: input.dedupeKey } })).toBe(1);
  });

  it("commits with the business change or not at all (a rolled-back change leaves no event)", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueOutboxEvent(tx, { aggregateType: "Order", aggregateId: "o-2", eventType: "order.placed", payload: {}, dedupeKey: "order.placed:o-2" });
        throw new Error("business change failed");
      }),
    ).rejects.toThrow("business change failed");
    expect(await prisma.outboxEvent.count({ where: { dedupeKey: "order.placed:o-2" } })).toBe(0);

    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, { aggregateType: "Order", aggregateId: "o-3", eventType: "order.placed", payload: {}, dedupeKey: "order.placed:o-3" });
    });
    expect(await prisma.outboxEvent.count({ where: { dedupeKey: "order.placed:o-3" } })).toBe(1);
  });

  it("delivers to the registered handler once and marks it PUBLISHED; later sweeps find nothing", async () => {
    const event = await enqueueOutboxEvent(prisma, { aggregateType: "Pay", aggregateId: "p-1", eventType: "pay.settled", payload: { amount: 5 }, dedupeKey: "pay.settled:p-1", availableAt: T0 });
    const handler = vi.fn().mockResolvedValue(undefined);

    const first = await processOutbox(prisma, { "pay.settled": handler }, { now: T0 });
    expect(first).toMatchObject({ claimed: 1, published: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("PUBLISHED");

    const second = await processOutbox(prisma, { "pay.settled": handler }, { now: after(60_000) });
    expect(second.claimed).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves events with no registered handler untouched (never dead-lettered just because nobody listens yet)", async () => {
    const event = await enqueueOutboxEvent(prisma, { aggregateType: "X", aggregateId: "x", eventType: "future.event", payload: {}, dedupeKey: "future:x", availableAt: T0 });
    const result = await processOutbox(prisma, { "something.else": vi.fn() }, { now: T0 });
    expect(result.claimed).toBe(0);
    const reloaded = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("retries a failing handler with backoff, then dead-letters it, and a failure never blocks other events", async () => {
    const bad = await enqueueOutboxEvent(prisma, { aggregateType: "Pay", aggregateId: "bad", eventType: "pay.flaky", payload: {}, dedupeKey: "pay.flaky:bad", availableAt: T0 });
    const good = await enqueueOutboxEvent(prisma, { aggregateType: "Pay", aggregateId: "good", eventType: "pay.flaky", payload: { ok: true }, dedupeKey: "pay.flaky:good", availableAt: T0 });
    const handler = vi.fn(async (e: { aggregateId: string }) => {
      if (e.aggregateId === "bad") throw new Error("provider down");
    });

    const r1 = await processOutbox(prisma, { "pay.flaky": handler }, { now: T0, retry: FAST_RETRY });
    expect(r1).toMatchObject({ claimed: 2, published: 1, retried: 1, dead: 0 });
    let badRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } });
    expect(badRow).toMatchObject({ status: "PENDING", attempts: 1, lastError: "provider down" });
    expect(badRow.availableAt.getTime()).toBe(after(1_000).getTime()); // base delay
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: good.id } })).status).toBe("PUBLISHED");

    // not yet due
    expect((await processOutbox(prisma, { "pay.flaky": handler }, { now: after(500), retry: FAST_RETRY })).claimed).toBe(0);
    // second failure doubles the delay
    await processOutbox(prisma, { "pay.flaky": handler }, { now: after(1_000), retry: FAST_RETRY });
    badRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } });
    expect(badRow.attempts).toBe(2);
    expect(badRow.availableAt.getTime()).toBe(after(1_000 + 2_000).getTime());
    // third failure exhausts the budget
    const r3 = await processOutbox(prisma, { "pay.flaky": handler }, { now: after(3_000), retry: FAST_RETRY });
    expect(r3.dead).toBe(1);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe("DEAD");

    // dead-letter replay gives a fresh budget (an audited admin action in the console)
    const replayed = await replayDeadOutboxEvent(prisma, bad.id, after(10_000));
    expect(replayed).toMatchObject({ status: "PENDING", attempts: 0 });
    await expect(replayDeadOutboxEvent(prisma, good.id)).rejects.toThrow(/Only a DEAD/);
  });

  it("makes an abandoned claim reclaimable after the visibility timeout (a crashed worker never strands an event)", async () => {
    const event = await enqueueOutboxEvent(prisma, { aggregateType: "Pay", aggregateId: "orphan", eventType: "pay.orphan", payload: {}, dedupeKey: "pay.orphan:1", availableAt: T0 });
    const first = await claimDueOutboxEvents(prisma, { eventTypes: ["pay.orphan"], now: T0, visibilityTimeoutMs: 60_000 });
    expect(first.map((e) => e.id)).toEqual([event.id]);
    // while the claim is fresh, nobody else gets it
    expect(await claimDueOutboxEvents(prisma, { eventTypes: ["pay.orphan"], now: after(30_000), visibilityTimeoutMs: 60_000 })).toEqual([]);
    // the worker died; once the claim is stale another worker takes over, with the attempt counted
    const second = await claimDueOutboxEvents(prisma, { eventTypes: ["pay.orphan"], now: after(61_000), visibilityTimeoutMs: 60_000 });
    expect(second.map((e) => [e.id, e.attempts])).toEqual([[event.id, 2]]);
  });

  it("keeps a published event immutable at the database", async () => {
    const event = await enqueueOutboxEvent(prisma, { aggregateType: "Pay", aggregateId: "imm", eventType: "pay.imm", payload: {}, dedupeKey: "pay.imm:1", availableAt: T0 });
    await processOutbox(prisma, { "pay.imm": async () => undefined }, { now: T0 });
    await expect(db.query(`UPDATE "OutboxEvent" SET "eventType" = 'tampered' WHERE id = $1`, [event.id])).rejects.toThrow(/immutable/);
  });

  it("reports queue depth and the age of the oldest waiting event for the health view", async () => {
    const stats = await getOutboxStats(prisma, after(3_600_000));
    expect(stats.published).toBeGreaterThan(0);
    expect(stats.pending).toBeGreaterThan(0);
    expect(stats.oldestPendingAgeSeconds).toBeGreaterThan(0);
  });
});

describe("durable callback inbox (scenarios 7 and 8)", () => {
  it("stores a callback before acknowledgement and deduplicates replays on (provider, externalId)", async () => {
    const first = await recordCallback(prisma, { provider: "psp-a", externalId: "evt-1", payload: { amount: 100 }, signatureVerified: true });
    const dup = await recordCallback(prisma, { provider: "psp-a", externalId: "evt-1", payload: { amount: 100 }, signatureVerified: true });
    expect(first.inserted).toBe(true);
    expect(dup).toEqual({ id: first.id, inserted: false });
    // the same external id from a DIFFERENT provider is a different event
    expect((await recordCallback(prisma, { provider: "psp-b", externalId: "evt-1", payload: {}, signatureVerified: true })).inserted).toBe(true);
    expect(await prisma.callbackInbox.count({ where: { externalId: "evt-1" } })).toBe(2);
  });

  it("applies one business effect no matter how many times a callback is delivered or the inbox is swept", async () => {
    for (let i = 0; i < 5; i++) await recordCallback(prisma, { provider: "psp-once", externalId: "pay-77", payload: { credit: 50 }, signatureVerified: true });
    let credited = 0;
    const handlers = { "psp-once": async () => { credited += 50; } };

    const sweeps = [await processInbox(prisma, handlers, { now: T0 }), await processInbox(prisma, handlers, { now: after(1_000) }), await processInbox(prisma, handlers, { now: after(2_000) })];
    expect(sweeps.map((s) => s.processed)).toEqual([1, 0, 0]);
    expect(credited).toBe(50);
  });

  it("records an unauthenticated callback as such, so a handler can refuse to treat it as evidence", async () => {
    await recordCallback(prisma, { provider: "psp-forged", externalId: "f-1", payload: { status: "SUCCESS" }, signatureVerified: false });
    let applied = false;
    await processInbox(prisma, {
      "psp-forged": async (cb) => {
        if (!cb.signatureVerified) throw new Error("callback authentication not verified");
        applied = true;
      },
    }, { now: T0, retry: { ...FAST_RETRY, maxAttempts: 1 } });
    expect(applied).toBe(false);
    const row = await prisma.callbackInbox.findFirstOrThrow({ where: { provider: "psp-forged" } });
    expect(row).toMatchObject({ status: "DEAD", signatureVerified: false });
    expect(row.lastError).toContain("not verified");
    expect((await replayDeadCallback(prisma, row.id, after(5_000))).status).toBe("RECEIVED");
  });

  it("retries with backoff, reclaims an orphaned claim, and keeps a processed callback immutable", async () => {
    await recordCallback(prisma, { provider: "psp-retry", externalId: "r-1", payload: {}, signatureVerified: true });
    const flaky = vi.fn().mockRejectedValueOnce(new Error("db blip")).mockResolvedValue(undefined);

    expect(await processInbox(prisma, { "psp-retry": flaky }, { now: T0, retry: FAST_RETRY })).toMatchObject({ retried: 1 });
    expect((await processInbox(prisma, { "psp-retry": flaky }, { now: after(500), retry: FAST_RETRY })).claimed).toBe(0); // backing off
    expect(await processInbox(prisma, { "psp-retry": flaky }, { now: after(1_000), retry: FAST_RETRY })).toMatchObject({ processed: 1 });

    const row = await prisma.callbackInbox.findFirstOrThrow({ where: { provider: "psp-retry" } });
    await expect(db.query(`UPDATE "CallbackInbox" SET "payload" = '{"x":1}' WHERE id = $1`, [row.id])).rejects.toThrow(/immutable/);

    await recordCallback(prisma, { provider: "psp-orphan", externalId: "o-1", payload: {}, signatureVerified: true });
    expect((await claimDueCallbacks(prisma, { providers: ["psp-orphan"], now: T0, visibilityTimeoutMs: 60_000 })).length).toBe(1);
    expect((await claimDueCallbacks(prisma, { providers: ["psp-orphan"], now: after(30_000), visibilityTimeoutMs: 60_000 })).length).toBe(0);
    expect((await claimDueCallbacks(prisma, { providers: ["psp-orphan"], now: after(61_000), visibilityTimeoutMs: 60_000 })).length).toBe(1);
  });

  it("exposes inbox depth for the health view", async () => {
    const stats = await getInboxStats(prisma, after(3_600_000));
    expect(stats.processed).toBeGreaterThan(0);
    expect(stats.dead + stats.received + stats.processing).toBeGreaterThanOrEqual(0);
  });
});

describe("outbox sweep wiring", () => {
  it("is off unless OUTBOX_SWEEP_ENABLED=true; the registered handlers are exactly the Phase 3 trade events and the registered payment providers", async () => {
    const { outboxSweepEnabled } = await import("../src/queue/outboxSweep.js");
    const { buildOutboxHandlers, buildCallbackHandlers } = await import("../src/domain/eventHandlers.js");
    expect(outboxSweepEnabled({})).toBe(false);
    expect(outboxSweepEnabled({ OUTBOX_SWEEP_ENABLED: "false" })).toBe(false);
    expect(outboxSweepEnabled({ OUTBOX_SWEEP_ENABLED: "true" })).toBe(true);
    expect(Object.keys(buildOutboxHandlers(prisma)).sort()).toEqual([
      "trade.credit_note.issued", "trade.order.accepted", "trade.order.closed", "trade.order.quoted", "trade.order.requested",
      "trade.payment.reported", "trade.payment.resolved", "trade.quote.accepted", "trade.receipt.recorded", "trade.shipment.dispatched",
    ]);
    // callback handlers follow the registered payment providers: none by default (and none in production), the simulator only when allowed
    const { setAdapterRegistry } = await import("../src/payments/registry.js");
    setAdapterRegistry(null);
    expect(Object.keys(buildCallbackHandlers(prisma))).toEqual([]);
    const { simulatorWorld } = await import("./helpers/payments.js");
    simulatorWorld(prisma);
    expect(Object.keys(buildCallbackHandlers(prisma))).toEqual(["simulator"]);
    delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
    setAdapterRegistry(null);
  });
});
