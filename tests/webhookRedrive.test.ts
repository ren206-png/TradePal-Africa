import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  redrivePendingWebhookEvents,
  REDRIVE_GRACE_MS,
  REDRIVE_MAX_AGE_MS,
  REDRIVE_MAX_ATTEMPTS,
  type RedriveAttemptCounter,
  type RedriveQueue,
} from "../src/whatsapp/redrive.js";
import type { InboundMessageJob } from "../src/whatsapp/webhookHandler.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

class FakeQueue implements RedriveQueue {
  jobs = new Map<string, string>(); // jobId -> state
  added: InboundMessageJob[] = [];
  removed: string[] = [];
  failAddFor: string | undefined;
  async getJobState(jobId: string) {
    return this.jobs.get(jobId);
  }
  async removeJob(jobId: string) {
    this.removed.push(jobId);
    this.jobs.delete(jobId);
  }
  async addJob(job: InboundMessageJob) {
    if (job.waMessageId === this.failAddFor) throw new Error("redis is down");
    this.added.push(job);
    this.jobs.set(job.waMessageId, "waiting");
  }
}

class FakeCounter implements RedriveAttemptCounter {
  counts = new Map<string, number>();
  async increment(id: string) {
    const n = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, n);
    return n;
  }
}

let queue: FakeQueue;
let counter: FakeCounter;
const NOW = new Date("2026-10-10T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
let counterId = 0;

beforeEach(() => {
  queue = new FakeQueue();
  counter = new FakeCounter();
});

function payloadFor(id: string, from = "23276123456", text = "Hi") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "e",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "18258239920", phone_number_id: "p" },
              messages: [{ id, from, timestamp: "1", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

async function makeEvent(opts: { receivedAt: Date; status?: "PENDING" | "PROCESSED" | "FAILED"; payload?: unknown; id?: string }) {
  const waMessageId = opts.id ?? `wamid.RD.${++counterId}`;
  return prisma.webhookEvent.create({
    data: {
      waMessageId,
      payload: (opts.payload ?? payloadFor(waMessageId)) as object,
      status: opts.status ?? "PENDING",
      receivedAt: opts.receivedAt,
    },
  });
}

const run = (over: Parameters<typeof redrivePendingWebhookEvents>[3] = {}) =>
  redrivePendingWebhookEvents(prisma, queue, counter, { now: NOW, ...over });

describe("redrivePendingWebhookEvents", () => {
  it("re-queues a stuck PENDING event, rebuilding the job from its stored payload", async () => {
    const e = await makeEvent({ receivedAt: minutesAgo(30), payload: payloadFor("wamid.RD.X1", "23277000999", "sold bread 500") });
    // payload id must match waMessageId; rebuild with the actual id:
    await prisma.webhookEvent.update({ where: { id: e.id }, data: { payload: payloadFor(e.waMessageId, "23277000999") } });

    const result = await run();
    expect(result).toMatchObject({ requeued: 1, errors: 0, inFlight: 0, exhausted: 0 });
    const job = queue.added.find((j) => j.webhookEventId === e.id)!;
    expect(job).toEqual({
      webhookEventId: e.id,
      waMessageId: e.waMessageId,
      fromNumber: "23277000999",
      toNumber: "18258239920",
      messageType: "text",
    });
  });

  it("leaves recent events alone (they may still be on their way through the normal path)", async () => {
    const recent = await makeEvent({ receivedAt: new Date(NOW.getTime() - REDRIVE_GRACE_MS + 30_000) });
    await run();
    expect(queue.added.map((j) => j.webhookEventId)).not.toContain(recent.id);
  });

  it("leaves events older than the WhatsApp reply window alone (e.g. the July leftovers)", async () => {
    const ancient = await makeEvent({ receivedAt: new Date(NOW.getTime() - REDRIVE_MAX_AGE_MS - 60_000) });
    const veryOld = await makeEvent({ receivedAt: hoursAgo(24 * 80) });
    await run();
    const ids = queue.added.map((j) => j.webhookEventId);
    expect(ids).not.toContain(ancient.id);
    expect(ids).not.toContain(veryOld.id);
  });

  it("ignores events that are already PROCESSED or FAILED", async () => {
    const done = await makeEvent({ receivedAt: minutesAgo(30), status: "PROCESSED" });
    const failed = await makeEvent({ receivedAt: minutesAgo(30), status: "FAILED" });
    await run();
    const ids = queue.added.map((j) => j.webhookEventId);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(failed.id);
  });

  it("does not touch a message the queue still has waiting or active", async () => {
    const waiting = await makeEvent({ receivedAt: minutesAgo(30) });
    const active = await makeEvent({ receivedAt: minutesAgo(31) });
    queue.jobs.set(waiting.waMessageId, "waiting");
    queue.jobs.set(active.waMessageId, "active");
    const result = await run();
    expect(result.inFlight).toBeGreaterThanOrEqual(2);
    const ids = queue.added.map((j) => j.webhookEventId);
    expect(ids).not.toContain(waiting.id);
    expect(ids).not.toContain(active.id);
    expect(counter.counts.get(waiting.id)).toBeUndefined(); // in-flight checks don't burn an attempt
  });

  it("removes a finished leftover job before re-adding (BullMQ would silently ignore a duplicate jobId)", async () => {
    const e = await makeEvent({ receivedAt: minutesAgo(30) });
    queue.jobs.set(e.waMessageId, "completed"); // job ran, but the PROCESSED update never landed
    await run();
    expect(queue.removed).toContain(e.waMessageId);
    expect(queue.added.map((j) => j.webhookEventId)).toContain(e.id);
  });

  it("also clears a leftover job in BullMQ's odd \"unknown\" state (record exists, in no list) before re-adding", async () => {
    const e = await makeEvent({ receivedAt: minutesAgo(30) });
    queue.jobs.set(e.waMessageId, "unknown");
    await run();
    expect(queue.removed).toContain(e.waMessageId);
    expect(queue.added.map((j) => j.webhookEventId)).toContain(e.id);
  });

  it("gives up after the maximum number of attempts instead of looping forever", async () => {
    const e = await makeEvent({ receivedAt: minutesAgo(30) });
    for (let i = 0; i < REDRIVE_MAX_ATTEMPTS; i++) {
      queue.jobs.clear(); // the re-queued job vanished/failed each time, event still PENDING
      const r = await run();
      expect(r.requeued).toBeGreaterThanOrEqual(1);
    }
    queue.jobs.clear();
    queue.added = [];
    const last = await run();
    expect(last.exhausted).toBeGreaterThanOrEqual(1);
    expect(queue.added.map((j) => j.webhookEventId)).not.toContain(e.id);
  });

  it("counts an event it can no longer read as unreadable, without re-queueing or throwing", async () => {
    const e = await makeEvent({ receivedAt: minutesAgo(30), payload: { object: "x", entry: [] } });
    const result = await run();
    expect(result.unreadable).toBeGreaterThanOrEqual(1);
    expect(queue.added.map((j) => j.webhookEventId)).not.toContain(e.id);
  });

  it("carries on past an event it can't re-queue and counts the error", async () => {
    const bad = await makeEvent({ receivedAt: minutesAgo(40) });
    const good = await makeEvent({ receivedAt: minutesAgo(30) });
    queue.failAddFor = bad.waMessageId;
    const spy = console.error;
    console.error = () => {};
    const result = await run();
    console.error = spy;
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(queue.added.map((j) => j.webhookEventId)).toContain(good.id);
  });

  it("processes the oldest stuck events first and respects the batch limit", async () => {
    await prisma.webhookEvent.deleteMany({});
    const oldest = await makeEvent({ receivedAt: hoursAgo(10) });
    await makeEvent({ receivedAt: hoursAgo(5) });
    await makeEvent({ receivedAt: hoursAgo(2) });
    const result = await run({ limit: 2 });
    expect(result.checked).toBe(2);
    expect(queue.added[0]?.webhookEventId).toBe(oldest.id);
  });
});
