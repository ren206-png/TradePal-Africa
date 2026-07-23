import "dotenv/config";
import { Worker } from "bullmq";
import { buildBusinessDigestOutboundGatewayFromEnv } from "./config/outboundGatewayEnv.js";
import { prisma } from "./db/client.js";
import { sendWeeklyBusinessDigests } from "./domain/businessDigest.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { WEEKLY_DIGEST_QUEUE_NAME, scheduleWeeklyDigestSweep } from "./queue/businessDigestQueue.js";

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
  });

  console.log(`TradePal business-digest worker listening on queue "${WEEKLY_DIGEST_QUEUE_NAME}" (hourly tick).`);
}

main().catch((error) => {
  console.error("businessDigestWorker failed to start:", error);
  process.exit(1);
});
