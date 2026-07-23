import "dotenv/config";
import { Worker } from "bullmq";
import { prisma } from "./db/client.js";
import { expireStalePaymentRequests } from "./domain/paymentRequestExpiry.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import {
  PAYMENT_REQUEST_EXPIRY_QUEUE_NAME,
  schedulePaymentRequestExpirySweep,
} from "./queue/paymentRequestExpiryQueue.js";

/**
 * The scheduled counterpart to src/subscriptionExpiryWorker.ts, same shape:
 * registers (and then services) a BullMQ *repeatable* job that ticks once
 * an hour and calls expireStalePaymentRequests — the sweep Phase 24's own
 * findings disclosed as missing. Run via `npm run dev:payment-request-expiry-worker`,
 * as its own process, so a slow/stuck expiry scan can never block or be
 * blocked by inbound WhatsApp message throughput. Unlike
 * subscriptionExpiryWorker.ts, this worker needs no WhatsApp outbound
 * gateway at all — expireStalePaymentRequests never sends a notification
 * (see its own doc comment for why), so there's nothing here to configure
 * or warn about missing.
 */
async function main() {
  await schedulePaymentRequestExpirySweep();

  const worker = new Worker(
    PAYMENT_REQUEST_EXPIRY_QUEUE_NAME,
    async () => {
      const result = await expireStalePaymentRequests(prisma);
      if (result.expiredCount > 0) {
        console.log(`Payment request expiry sweep: expired ${result.expiredCount} payment request(s).`);
      }
      return result;
    },
    { connection: getRedisConnectionOptions() },
  );

  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id ?? "(unknown)"} failed:`, error);
  });

  console.log(
    `TradePal payment-request-expiry worker listening on queue "${PAYMENT_REQUEST_EXPIRY_QUEUE_NAME}" (hourly sweep).`,
  );
}

main().catch((error) => {
  console.error("paymentRequestExpiryWorker failed to start:", error);
  process.exit(1);
});
