import "dotenv/config";
import { Worker } from "bullmq";
import { buildSubscriptionExpiryOutboundGatewayFromEnv } from "./config/outboundGatewayEnv.js";
import { buildAlertEmailDepsFromEnv } from "./config/monitoringEnv.js";
import { prisma } from "./db/client.js";
import { expireLapsedSubscriptions } from "./domain/subscriptionExpiry.js";
import { reportIncident } from "./monitoring/alerts.js";
import { installCrashReporting, installGracefulShutdown } from "./monitoring/processGuards.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { SUBSCRIPTION_EXPIRY_QUEUE_NAME, scheduleSubscriptionExpirySweep } from "./queue/subscriptionExpiryQueue.js";

const SERVICE_NAME = "subscription-expiry-worker";

// Same WhatsApp Cloud API credentials src/worker.ts uses — this process (not
// the message worker) is what actually sends the per-business
// subscription-lapse notification (see subscriptionExpiry.ts). Optional
// (not requireEnv), unlike src/worker.ts: this worker's core job — expiring
// lapsed subscriptions (Phase 6, billing correctness) — must keep running
// even for a deployment that hasn't configured WhatsApp send credentials yet
// (e.g. still pending Meta app review), or that has the Phase 7
// subscriptionLapseNotification flag off everywhere. Requiring these here
// would make the entire hourly sweep fail to boot over a feature that's
// off-by-default and optional on top of it.
const outboundGateway = buildSubscriptionExpiryOutboundGatewayFromEnv();

if (!outboundGateway) {
  console.warn(
    "subscriptionExpiryWorker: WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID not set — " +
      "the hourly sweep will still run, but subscription-lapse WhatsApp notifications " +
      "(Phase 7) will be skipped for every business, even where the feature flag is on.",
  );
}

// Same optionality as outboundGateway above: this worker boots exactly as
// before this monitoring phase when no email-alerting provider is
// configured yet — reportIncident's own console.error is the fallback.
const alerts = buildAlertEmailDepsFromEnv();
if (!alerts) {
  console.warn(
    "subscriptionExpiryWorker: ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set — " +
      "crash/incident alerts will only be logged to console, not emailed.",
  );
}
installCrashReporting(SERVICE_NAME, alerts);

/**
 * The scheduled counterpart to src/worker.ts's event-driven message worker:
 * this process registers (and then services) a BullMQ *repeatable* job that
 * ticks once an hour and calls expireLapsedSubscriptions — the actual
 * "cron/worker" that Phases 4 and 5 disclosed as missing. Run via
 * `npm run dev:subscription-expiry-worker`, as its own process (like the
 * message worker), so a slow/stuck expiry scan can never block or be
 * blocked by inbound WhatsApp message throughput.
 */
async function main() {
  await scheduleSubscriptionExpirySweep();

  const worker = new Worker(
    SUBSCRIPTION_EXPIRY_QUEUE_NAME,
    async () => {
      const result = await expireLapsedSubscriptions(prisma, new Date(), outboundGateway);
      if (result.expiredCount > 0) {
        console.log(`Subscription expiry sweep: expired ${result.expiredCount} subscription(s).`);
      }
      return result;
    },
    { connection: getRedisConnectionOptions() },
  );

  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id ?? "(unknown)"} failed:`, error);
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "Subscription-expiry sweep job failed",
      detail: `Job ${job?.id ?? "(unknown)"}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    });
  });

  // See worker.ts's own doc comment on the identical listener for why this
  // is required (Node's EventEmitter throws on an unhandled "error" event).
  worker.on("error", (error) => {
    console.error("Subscription-expiry worker connection error:", error);
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "Worker connection error",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });

  console.log(
    `TradePal subscription-expiry worker listening on queue "${SUBSCRIPTION_EXPIRY_QUEUE_NAME}" (hourly sweep).`,
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
  console.error("subscriptionExpiryWorker failed to start:", error);
  process.exit(1);
});
