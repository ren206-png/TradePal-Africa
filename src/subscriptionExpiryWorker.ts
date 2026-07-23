import "dotenv/config";
import { Worker } from "bullmq";
import { buildSubscriptionExpiryOutboundGatewayFromEnv } from "./config/outboundGatewayEnv.js";
import { prisma } from "./db/client.js";
import { expireLapsedSubscriptions } from "./domain/subscriptionExpiry.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { SUBSCRIPTION_EXPIRY_QUEUE_NAME, scheduleSubscriptionExpirySweep } from "./queue/subscriptionExpiryQueue.js";

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
  });

  console.log(
    `TradePal subscription-expiry worker listening on queue "${SUBSCRIPTION_EXPIRY_QUEUE_NAME}" (hourly sweep).`,
  );
}

main().catch((error) => {
  console.error("subscriptionExpiryWorker failed to start:", error);
  process.exit(1);
});
