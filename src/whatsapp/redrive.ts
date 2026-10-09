import type { PrismaClient } from "@prisma/client";
import type { InboundMessageJob } from "./webhookHandler.js";
import { extractInboundMessages, parseWhatsAppWebhookPayload } from "./webhookPayload.js";

/**
 * Safety net for inbound WhatsApp messages that were durably recorded (WebhookEvent) but never made
 * it through processing.
 *
 * The webhook route stores the event first and only then enqueues the BullMQ job, answering Meta 200
 * either way — so if the enqueue fails (Redis briefly unavailable, a deploy at the wrong moment) the
 * event stays PENDING forever: Meta isn't told to retry, and a retry would be dropped by the
 * WebhookEvent dedupe anyway. dispatchInboundMessage always marks an event PROCESSED once it runs, so
 * an event that is still PENDING after the grace period below was never run (or its worker died
 * mid-job). This re-queues those, oldest first.
 *
 * Bounds, deliberately conservative:
 *  - GRACE: normal processing takes about a second (max observed in production: 13s), so only events
 *    older than a few minutes count as stuck — never race the live path.
 *  - MAX AGE: WhatsApp only allows free-form replies within 24h of the customer's message, so
 *    re-running a much older message would record its effect but could not answer it (and the
 *    onboarding flow rolls back when its reply can't be sent). Older events are left alone — that is
 *    also why the July 2026 leftovers are not resurrected.
 *  - MAX ATTEMPTS: a message that keeps failing is re-queued a few times, then reported and left.
 */
export const REDRIVE_GRACE_MS = 5 * 60 * 1000;
export const REDRIVE_MAX_AGE_MS = 20 * 60 * 60 * 1000;
export const REDRIVE_MAX_ATTEMPTS = 3;
const REDRIVE_BATCH_SIZE = 50;

/** BullMQ job states in which the queue will still handle the job on its own. */
const IN_FLIGHT_STATES = new Set(["waiting", "active", "delayed", "waiting-children", "prioritized"]);

/** The slice of the BullMQ queue this needs — an interface so it can be tested without Redis. */
export interface RedriveQueue {
  /** State of the job with this id, or undefined when there is no such job. */
  getJobState(jobId: string): Promise<string | undefined>;
  removeJob(jobId: string): Promise<void>;
  addJob(job: InboundMessageJob): Promise<void>;
}

/** Counts how many times an event has been re-queued (kept outside Postgres: no schema change needed). */
export interface RedriveAttemptCounter {
  /** Increments and returns the new attempt count for this webhook event. */
  increment(webhookEventId: string): Promise<number>;
}

export interface RedriveResult {
  checked: number;
  requeued: number;
  /** Already waiting/active in the queue — the queue will get to it. */
  inFlight: number;
  /** Re-queued REDRIVE_MAX_ATTEMPTS times already; left alone. */
  exhausted: number;
  /** The stored payload no longer contains the message (can't rebuild a job). */
  unreadable: number;
  errors: number;
}

export async function redrivePendingWebhookEvents(
  prisma: PrismaClient,
  queue: RedriveQueue,
  counter: RedriveAttemptCounter,
  options: { now?: Date; graceMs?: number; maxAgeMs?: number; limit?: number } = {},
): Promise<RedriveResult> {
  const now = options.now ?? new Date();
  const newest = new Date(now.getTime() - (options.graceMs ?? REDRIVE_GRACE_MS));
  const oldest = new Date(now.getTime() - (options.maxAgeMs ?? REDRIVE_MAX_AGE_MS));

  const events = await prisma.webhookEvent.findMany({
    where: { status: "PENDING", receivedAt: { lt: newest, gt: oldest } },
    orderBy: { receivedAt: "asc" },
    take: options.limit ?? REDRIVE_BATCH_SIZE,
  });

  const result: RedriveResult = { checked: 0, requeued: 0, inFlight: 0, exhausted: 0, unreadable: 0, errors: 0 };

  for (const event of events) {
    result.checked++;
    try {
      const parsed = parseWhatsAppWebhookPayload(event.payload);
      const found = parsed.success ? extractInboundMessages(parsed.data).find((m) => m.message.id === event.waMessageId) : undefined;
      if (!found) {
        result.unreadable++;
        continue;
      }

      const state = await queue.getJobState(event.waMessageId);
      if (state !== undefined && IN_FLIGHT_STATES.has(state)) {
        result.inFlight++;
        continue;
      }

      const attempts = await counter.increment(event.id);
      if (attempts > REDRIVE_MAX_ATTEMPTS) {
        result.exhausted++;
        continue;
      }

      // BullMQ ignores an add() whose jobId already exists (its addStandardJob script checks the job
      // record) — even for a finished job, or one in the odd "unknown" state — so any leftover has to be
      // removed first or the re-queue would silently do nothing. (Waiting/active jobs never reach here.)
      if (state !== undefined) await queue.removeJob(event.waMessageId);
      await queue.addJob({
        webhookEventId: event.id,
        waMessageId: event.waMessageId,
        fromNumber: found.message.from,
        toNumber: found.toNumber,
        messageType: found.message.type,
      });
      result.requeued++;
    } catch (error) {
      result.errors++;
      console.error(`webhook redrive: could not re-queue event ${event.id}:`, error);
    }
  }
  return result;
}
