import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "./connection.js";
import type { InboundMessageJob } from "../whatsapp/webhookHandler.js";

export const INBOUND_MESSAGE_QUEUE_NAME = "inbound-whatsapp-messages";

let queue: Queue<InboundMessageJob> | undefined;

export function getInboundMessageQueue(): Queue<InboundMessageJob> {
  if (!queue) {
    queue = new Queue<InboundMessageJob>(INBOUND_MESSAGE_QUEUE_NAME, { connection: getRedisConnectionOptions() });
  }
  return queue;
}

/** jobId = waMessageId: a second, queue-level layer of dedupe alongside the WebhookEvent unique constraint. */
export async function enqueueInboundMessage(job: InboundMessageJob): Promise<void> {
  await getInboundMessageQueue().add("process-inbound-message", job, { jobId: job.waMessageId });
}

/**
 * Puts a message that never finished back on the queue (admin replay). BullMQ ignores an add() whose jobId already exists, so a leftover
 * finished or failed job is removed first; a job that is still waiting or running is left alone and reported as in flight.
 */
export async function replayInboundMessage(job: InboundMessageJob): Promise<"QUEUED" | "IN_FLIGHT"> {
  const q = getInboundMessageQueue();
  const existing = await q.getJob(job.waMessageId);
  if (existing) {
    const state = await existing.getState();
    if (["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(state)) return "IN_FLIGHT";
    await existing.remove();
  }
  await q.add("process-inbound-message", job, { jobId: job.waMessageId });
  return "QUEUED";
}
