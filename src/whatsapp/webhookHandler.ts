import type { Prisma, PrismaClient } from "@prisma/client";
import type { InboundMessageRateLimiter } from "./inboundRateLimiter.js";
import { extractInboundMessages, parseWhatsAppWebhookPayload } from "./webhookPayload.js";

export interface InboundMessageJob {
  webhookEventId: string;
  waMessageId: string;
  fromNumber: string;
  toNumber: string;
  messageType: string;
}

export interface WebhookHandlerDeps {
  prisma: PrismaClient;
  enqueueInboundMessage: (job: InboundMessageJob) => Promise<void>;
  /**
   * Phase 19: optional per-sender rate limiter, keyed by the WhatsApp
   * sender's phone number (`message.from`), guarding against a flood of
   * inbound traffic from a single number on this otherwise-public (signature-
   * verified but not otherwise access-controlled) webhook endpoint.
   * Undefined — the default for callers that construct `WebhookHandlerDeps`
   * directly, e.g. most of `tests/webhookHandler.test.ts` — means unlimited,
   * so existing tests that don't care about rate-limiting behavior don't
   * need updating. `src/whatsapp/webhookRoute.ts`'s `createWebhookPostHandler`
   * always supplies a real `InMemoryInboundMessageRateLimiter` in production,
   * constructed once at server startup so its counters persist across
   * requests (not per-call, which would defeat the point).
   */
  rateLimiter?: InboundMessageRateLimiter;
}

export interface ProcessWebhookResult {
  accepted: boolean;
  messagesEnqueued: number;
}

/**
 * Dedupes on WebhookEvent.waMessageId (Non-Negotiable Standard: exactly-once
 * webhook processing). Meta retries webhook deliveries aggressively, so a
 * retried delivery must not be re-enqueued. Uses `createMany` +
 * `skipDuplicates` (ON CONFLICT DO NOTHING) rather than `create` + catch
 * P2002: a retried delivery is an expected, routine occurrence, not an
 * exceptional one, so it shouldn't be modeled as a thrown error. The BullMQ
 * job is also keyed by waMessageId (jobId) as a second layer of dedupe at
 * the queue level.
 */
export async function processIncomingWebhook(
  deps: WebhookHandlerDeps,
  rawPayload: unknown,
): Promise<ProcessWebhookResult> {
  const parsed = parseWhatsAppWebhookPayload(rawPayload);
  if (!parsed.success) {
    return { accepted: false, messagesEnqueued: 0 };
  }

  let messagesEnqueued = 0;

  for (const { message, toNumber } of extractInboundMessages(parsed.data)) {
    if (deps.rateLimiter) {
      const rateLimit = await deps.rateLimiter.consume(message.from);
      if (!rateLimit.allowed) {
        console.warn(
          `Rate-limited inbound WhatsApp message from ${message.from}; retry after ${rateLimit.retryAfterSeconds}s`,
        );
        continue;
      }
    }

    const inserted = await deps.prisma.webhookEvent.createMany({
      data: [{ waMessageId: message.id, payload: rawPayload as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      continue;
    }

    const webhookEvent = await deps.prisma.webhookEvent.findUniqueOrThrow({
      where: { waMessageId: message.id },
    });

    await deps.enqueueInboundMessage({
      webhookEventId: webhookEvent.id,
      waMessageId: message.id,
      fromNumber: message.from,
      toNumber,
      messageType: message.type,
    });
    messagesEnqueued += 1;
  }

  return { accepted: true, messagesEnqueued };
}
