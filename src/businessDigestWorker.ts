import "dotenv/config";
import { Worker } from "bullmq";
import { buildBusinessDigestOutboundGatewayFromEnv } from "./config/outboundGatewayEnv.js";
import { buildAlertEmailDepsFromEnv } from "./config/monitoringEnv.js";
import { prisma } from "./db/client.js";
import { sendWeeklyBusinessDigests } from "./domain/businessDigest.js";
import { reportIncident } from "./monitoring/alerts.js";
import { installCrashReporting, installGracefulShutdown } from "./monitoring/processGuards.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { WEEKLY_DIGEST_QUEUE_NAME, scheduleWeeklyDigestSweep } from "./queue/businessDigestQueue.js";

const SERVICE_NAME = "business-digest-worker";

// Optional, same as subscriptionExpiryWorker.ts and for the same reason: a
// deployment without WhatsApp send credentials configured yet (or with the
// weeklyBusinessDigest flag off for every business) should still be able to
// run this worker without crash-looping over an off-by-default feature.
const outboundGateway = buildBusinessDigestOutboundGatewayFromEnv();

if (!outboundGateway) {
  console.warn(
    "businessDigestWorker: WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID not set — " +
      "the sweep will still run, but weekly business-digest WhatsApp messages " +
      "will be skipped for every business, even where the feature flag is on.",
  );
}

// Same optionality as outboundGateway above: this worker boots exactly as
// before this monitoring phase when no email-alerting provider is
// configured yet — reportIncident's own console.error is the fallback.
const alerts = buildAlertEmailDepsFromEnv();
if (!alerts) {
  console.warn(
    "businessDigestWorker: ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set — " +
      "crash/incident alerts will only be logged to console, not emailed.",
  );
}
installCrashReporting(SERVICE_NAME, alerts);

/**
 * The scheduled counterpart to src/subscriptionExpiryWorker.ts: registers
 * (and then services) a BullMQ repeatable job that ticks hourly and calls
 * sendWeeklyBusinessDigests (see businessDigest.ts for why hourly, despite
 * the digest itself being weekly). Run via
 * `npm run dev:business-digest-worker`, as its own process — a slow/stuck
 * digest sweep must never block or be blocked by inbound WhatsApp message
 * throughput or the subscription-expiry sweep.
 */
async function main() {
  await scheduleWeeklyDigestSweep();

  const worker = new Worker(
    WEEKLY_DIGEST_QUEUE_NAME,
    async () => {
      const result = await sendWeeklyBusinessDigests(prisma, new Date(), outboundGateway);
      if (result.processedBusinessIds.length > 0) {
        console.log(`Weekly business digest sweep: processed ${result.processedBusinessIds.length} business(es).`);
      }
      return result;
    },
    { connection: getRedisConnectionOptions() },
  );

  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id ?? "(unknown)"} failed:`, error);
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "Weekly-digest sweep job failed",
      detail: `Job ${job?.id ?? "(unknown)"}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    });
  });

  // See worker.ts's own doc comment on the identical listener for why this
  // is required (Node's EventEmitter throws on an unhandled "error" event).
  worker.on("error", (error) => {
    console.error("Business-digest worker connection error:", error);
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "Worker connection error",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });

  console.log(`TradePal business-digest worker listening on queue "${WEEKLY_DIGEST_QUEUE_NAME}" (hourly tick).`);

  // See processGuards.ts's own doc comment: SIGTERM (sent by Railway on
  // every redeploy) previously had no listener here, so Node's default
  // behavior — terminate immediately — could cut off a digest sweep
  // mid-send rather than letting BullMQ's own Worker.close() finish it.
  installGracefulShutdown(SERVICE_NAME, [
    { name: "bullmq-worker", close: () => worker.close() },
    { name: "prisma", close: () => prisma.$disconnect() },
  ]);
}

main().catch((error) => {
  console.error("businessDigestWorker failed to start:", error);
  process.exit(1);
});
