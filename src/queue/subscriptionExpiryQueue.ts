import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "./connection.js";
import { SUBSCRIPTION_EXPIRY_JOB_NAME } from "../domain/subscriptionExpiry.js";

export const SUBSCRIPTION_EXPIRY_QUEUE_NAME = "subscription-expiry-sweep";

/** Runs at the top of every hour — frequent enough that a lapsed subscription's stored status
 * goes stale for at most ~an hour, infrequent enough not to warrant anything more elaborate for
 * what is, today, a single lightweight scan-and-update query. */
const REPEAT_CRON_PATTERN = "0 * * * *";

let queue: Queue | undefined;

export function getSubscriptionExpiryQueue(): Queue {
  if (!queue) {
    queue = new Queue(SUBSCRIPTION_EXPIRY_QUEUE_NAME, { connection: getRedisConnectionOptions() });
  }
  return queue;
}

/**
 * Registers the repeatable job definition. Safe to call on every worker
 * boot: BullMQ keys a repeatable job by its name + repeat options, so
 * calling `add` again with the same pattern is a no-op against an
 * already-registered schedule rather than creating a duplicate.
 */
export async function scheduleSubscriptionExpirySweep(): Promise<void> {
  await getSubscriptionExpiryQueue().add(
    SUBSCRIPTION_EXPIRY_JOB_NAME,
    {},
    { repeat: { pattern: REPEAT_CRON_PATTERN } },
  );
}
