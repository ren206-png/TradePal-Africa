import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { processIncomingWebhook, type InboundMessageJob } from "../src/whatsapp/webhookHandler.js";
import type { InboundMessageRateLimiter, RateLimitResult } from "../src/whatsapp/inboundRateLimiter.js";

let testDb: TestDb;
let prisma: PrismaClient;
let enqueuedJobs: InboundMessageJob[];

const enqueueInboundMessage = async (job: InboundMessageJob): Promise<void> => {
  enqueuedJobs.push(job);
};

function buildPayload(messageId: string, from = "2348012345678") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "pn-1" },
              messages: [{ id: messageId, from, timestamp: "1700000000", type: "text", text: { body: "sold 2 bread 1000" } }],
            },
          },
        ],
      },
    ],
  };
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
}, 60_000);

beforeEach(() => {
  enqueuedJobs = [];
});

afterAll(async () => {
  await testDb.teardown();
});

describe("processIncomingWebhook", () => {
  it("records a WebhookEvent and enqueues a job for a new message", async () => {
    const payload = buildPayload("wamid.AAA");
    const result = await processIncomingWebhook({ prisma, enqueueInboundMessage }, payload);

    expect(result).toEqual({ accepted: true, messagesEnqueued: 1 });
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]?.waMessageId).toBe("wamid.AAA");

    const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { waMessageId: "wamid.AAA" } });
    expect(stored.status).toBe("PENDING");
  });

  it("does not re-enqueue when Meta retries the same waMessageId", async () => {
    const payload = buildPayload("wamid.BBB");

    const first = await processIncomingWebhook({ prisma, enqueueInboundMessage }, payload);
    const second = await processIncomingWebhook({ prisma, enqueueInboundMessage }, payload);

    expect(first.messagesEnqueued).toBe(1);
    expect(second).toEqual({ accepted: true, messagesEnqueued: 0 });
    expect(enqueuedJobs).toHaveLength(1);

    const count = await prisma.webhookEvent.count({ where: { waMessageId: "wamid.BBB" } });
    expect(count).toBe(1);
  });

  it("rejects a payload that doesn't match the expected WhatsApp webhook shape", async () => {
    const result = await processIncomingWebhook({ prisma, enqueueInboundMessage }, { garbage: true });
    expect(result).toEqual({ accepted: false, messagesEnqueued: 0 });
    expect(enqueuedJobs).toHaveLength(0);
  });

  it("ignores non-message changes (e.g. status receipts) without erroring", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              field: "statuses",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550001111", phone_number_id: "pn-1" },
              },
            },
          ],
        },
      ],
    };

    const result = await processIncomingWebhook({ prisma, enqueueInboundMessage }, payload);
    expect(result).toEqual({ accepted: true, messagesEnqueued: 0 });
    expect(enqueuedJobs).toHaveLength(0);
  });

  it("Phase 19: skips a message blocked by rateLimiter — no WebhookEvent row, no enqueue", async () => {
    const blockingRateLimiter: InboundMessageRateLimiter = {
      consume: (): Promise<RateLimitResult> => Promise.resolve({ allowed: false, retryAfterSeconds: 42 }),
    };
    const payload = buildPayload("wamid.RATE_LIMITED");

    const result = await processIncomingWebhook({ prisma, enqueueInboundMessage, rateLimiter: blockingRateLimiter }, payload);

    expect(result).toEqual({ accepted: true, messagesEnqueued: 0 });
    expect(enqueuedJobs).toHaveLength(0);

    const stored = await prisma.webhookEvent.findUnique({ where: { waMessageId: "wamid.RATE_LIMITED" } });
    expect(stored).toBeNull();
  });

  it("Phase 19: a rateLimiter that allows the message doesn't change normal processing", async () => {
    const allowingRateLimiter: InboundMessageRateLimiter = {
      consume: (): Promise<RateLimitResult> => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    };
    const payload = buildPayload("wamid.RATE_ALLOWED");

    const result = await processIncomingWebhook({ prisma, enqueueInboundMessage, rateLimiter: allowingRateLimiter }, payload);

    expect(result).toEqual({ accepted: true, messagesEnqueued: 1 });
    expect(enqueuedJobs).toHaveLength(1);
  });
});
