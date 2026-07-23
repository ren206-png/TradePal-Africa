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
