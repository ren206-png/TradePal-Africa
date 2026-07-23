import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "./connection.js";
import { WEEKLY_DIGEST_JOB_NAME } from "../domain/businessDigest.js";

export const WEEKLY_DIGEST_QUEUE_NAME = "weekly-business-digest";

/**
 * Ticks hourly, same cadence as subscriptionExpiryQueue.ts — not because the
 * digest itself is hourly (it's weekly, per business, per
 * getWeekBoundsInTimezone), but so that whichever hour a given business's
 * local Monday actually starts in (the 4 launch countries span UTC+0 to
 * UTC+3), that business's digest goes out within an hour of its week
 * completing rather than waiting for a once-a-day tick to happen to land
 * after local midnight. sendWeeklyBusinessDigests's own idempotency check
 * (see businessDigest.ts) makes every other hourly tick that week a no-op
 * for that business.
 */
const REPEAT_CRON_PATTERN = "0 * * * *";

let queue: Queue | undefined;

export function getWeeklyDigestQueue(): Queue {
  if (!queue) {
    queue = new Queue(WEEKLY_DIGEST_QUEUE_NAME, { connection: getRedisConnectionOptions() });
  }
  return queue;
}

/**
 * Registers the repeatable job definition. Safe to call on every worker
 * boot: BullMQ keys a repeatable job by its name + repeat options, so
 * calling `add` again with the same pattern is a no-op against an
 * already-registered schedule rather than creating a duplicate.
 */
export async function scheduleWeeklyDigestSweep(): Promise<void> {
  await getWeeklyDigestQueue().add(WEEKLY_DIGEST_JOB_NAME, {}, { repeat: { pattern: REPEAT_CRON_PATTERN } });
}
