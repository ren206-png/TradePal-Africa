import "dotenv/config";
import { Worker } from "bullmq";
import { buildAlertEmailDepsFromEnv } from "./config/monitoringEnv.js";
import { prisma } from "./db/client.js";
import { expireStalePaymentRequests } from "./domain/paymentRequestExpiry.js";
import { reportIncident } from "./monitoring/alerts.js";
import { installCrashReporting, installGracefulShutdown } from "./monitoring/processGuards.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import {
  PAYMENT_REQUEST_EXPIRY_QUEUE_NAME,
  schedulePaymentRequestExpirySweep,
} from "./queue/paymentRequestExpiryQueue.js";

const SERVICE_NAME = "payment-request-expiry-worker";

// This worker has no WhatsApp send credentials to be optional about (see
// this file's own top-of-file doc comment), but email alerting is still its
// own independent optional dep, same treatment as every other worker.
const alerts = buildAlertEmailDepsFromEnv();
if (!alerts) {
  console.warn(
    "paymentRequestExpiryWorker: ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set — " +
      "crash/incident alerts will only be logged to console, not emailed.",
  );
}
installCrashReporting(SERVICE_NAME, alerts);

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
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "Payment-request-expiry sweep job failed",
      detail: `Job ${job?.id ?? "(unknown)"}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    });
  });

  // See worker.ts's own doc comment on the identical listener for why this
  // is required (Node's EventEmitter throws on an unhandled "error" event).
  worker.on("error", (error) => {
    console.error("Payment-request-expiry worker connection error:", error);
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "Worker connection error",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });

  console.log(
    `TradePal payment-request-expiry worker listening on queue "${PAYMENT_REQUEST_EXPIRY_QUEUE_NAME}" (hourly sweep).`,
  );

  // See processGuards.ts's own doc comment: SIGTERM (sent by Railway on
  // every redeploy) previously had no listener here, so Node's default
  // behavior — terminate immediately — could cut off a sweep mid-run rather
  // than letting BullMQ's own Worker.close() finish it.
  installGracefulShutdown(SERVICE_NAME, [
    { name: "bullmq-worker", close: () => worker.close() },
    { name: "prisma", close: () => prisma.$disconnect() },
  ]);
}

main().catch((error) => {
  console.error("paymentRequestExpiryWorker failed to start:", error);
  process.exit(1);
});
