import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "./connection.js";
import { PAYMENT_REQUEST_EXPIRY_JOB_NAME } from "../domain/paymentRequestExpiry.js";

export const PAYMENT_REQUEST_EXPIRY_QUEUE_NAME = "payment-request-expiry-sweep";

/** Same hourly cadence as subscriptionExpiryQueue.ts's own repeatable job — frequent
 * enough that a stale PaymentRequest's stored status goes out of date for at most ~an
 * hour past its 24-hour staleness window, infrequent enough not to warrant anything
 * more elaborate for what is, today, a single lightweight scan-and-update query. */
const REPEAT_CRON_PATTERN = "0 * * * *";

let queue: Queue | undefined;

export function getPaymentRequestExpiryQueue(): Queue {
  if (!queue) {
    queue = new Queue(PAYMENT_REQUEST_EXPIRY_QUEUE_NAME, { connection: getRedisConnectionOptions() });
  }
  return queue;
}

/**
 * Registers the repeatable job definition. Safe to call on every worker
 * boot: BullMQ keys a repeatable job by its name + repeat options, so
 * calling `add` again with the same pattern is a no-op against an
 * already-registered schedule rather than creating a duplicate.
 */
export async function schedulePaymentRequestExpirySweep(): Promise<void> {
  await getPaymentRequestExpiryQueue().add(
    PAYMENT_REQUEST_EXPIRY_JOB_NAME,
    {},
    { repeat: { pattern: REPEAT_CRON_PATTERN } },
  );
}
