import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { getRedisConnectionOptions } from "./connection.js";
import type { AlertEmailDeps } from "../monitoring/alerts.js";
import { reportIncident } from "../monitoring/alerts.js";
import {
  redrivePendingWebhookEvents,
  REDRIVE_MAX_ATTEMPTS,
  type RedriveAttemptCounter,
  type RedriveQueue,
} from "../whatsapp/redrive.js";
import type { InboundMessageJob } from "../whatsapp/webhookHandler.js";

const SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60 * 1000; // soon after boot, so a redeploy catches what the old process missed
const ATTEMPT_KEY_TTL_SECONDS = 48 * 60 * 60;

/** Adapts the real BullMQ queue to the small interface the redrive logic needs. */
export function createBullMqRedriveQueue(queue: Queue<InboundMessageJob>): RedriveQueue {
  return {
    async getJobState(jobId) {
      const job = await queue.getJob(jobId);
      if (!job) return undefined;
      return job.getState();
    },
    async removeJob(jobId) {
      const job = await queue.getJob(jobId);
      await job?.remove();
    },
    async addJob(job) {
      await queue.add("process-inbound-message", job, { jobId: job.waMessageId });
    },
  };
}

/** Attempt counts live in Redis (expiring, so no schema change); its own small connection, like the rate limiters'. */
export function createRedisAttemptCounter(client: Redis): RedriveAttemptCounter {
  return {
    async increment(webhookEventId) {
      const key = `webhook-redrive-attempts:${webhookEventId}`;
      const attempts = await client.incr(key);
      if (attempts === 1) await client.expire(key, ATTEMPT_KEY_TTL_SECONDS);
      return attempts;
    },
  };
}

export interface WebhookRedriveSweep {
  stop(): void;
}

/**
 * Runs the redrive on a timer inside the inbound-message worker process (the one that already owns
 * the queue). Never overlaps itself, never throws, and reports an incident whenever it actually had
 * to re-queue something — a stuck message means the live path failed, which is worth knowing.
 */
export function startWebhookRedriveSweep(deps: {
  prisma: PrismaClient;
  queue: Queue<InboundMessageJob>;
  alerts: AlertEmailDeps | undefined;
  serviceName: string;
}): WebhookRedriveSweep {
  const redriveQueue = createBullMqRedriveQueue(deps.queue);
  const redis = new Redis(getRedisConnectionOptions());
  // A Redis hiccup must not crash the worker: errors surface through the sweep's own try/catch instead.
  redis.on("error", (error) => console.error("webhook redrive: Redis error:", error.message));
  const counter = createRedisAttemptCounter(redis);
  let running = false;

  async function sweep(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await redrivePendingWebhookEvents(deps.prisma, redriveQueue, counter);
      if (result.requeued > 0 || result.exhausted > 0) {
        console.warn(`webhook redrive: ${JSON.stringify(result)}`);
        await reportIncident(deps.alerts, {
          service: deps.serviceName,
          title:
            result.exhausted > 0
              ? "Inbound WhatsApp message(s) still failing after repeated re-queues"
              : "Re-queued stuck inbound WhatsApp message(s)",
          detail:
            `${result.requeued} stuck message(s) re-queued, ${result.exhausted} gave up after ${REDRIVE_MAX_ATTEMPTS} attempts ` +
            `(${JSON.stringify(result)}). They had been PENDING for several minutes: the live enqueue or the worker failed.`,
        });
      }
    } catch (error) {
      console.error("webhook redrive sweep failed (will retry next interval):", error);
    } finally {
      running = false;
    }
  }

  const first = setTimeout(() => void sweep(), FIRST_SWEEP_DELAY_MS);
  const interval = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  // Timers must never keep the process alive on their own (graceful shutdown relies on exit).
  first.unref();
  interval.unref();

  return {
    stop() {
      clearTimeout(first);
      clearInterval(interval);
      redis.disconnect();
    },
  };
}
