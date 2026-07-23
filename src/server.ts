import "dotenv/config";
import cors from "cors";
import express from "express";
import { Redis } from "ioredis";
import { createAdminRouter } from "./admin/adminRoutes.js";
import { RedisLoginRateLimiter } from "./admin/rateLimiter.js";
import {
  buildDeletionResolutionOutboundGatewayFromEnv,
  buildSubscriptionExpiryOutboundGatewayFromEnv,
} from "./config/outboundGatewayEnv.js";
import {
  buildFlutterwaveDepsFromEnv,
  buildPaymentRequestOutboundGatewayFromEnv,
  buildPaymentsOutboundGatewayFromEnv,
} from "./config/paymentsEnv.js";
import { prisma } from "./db/client.js";
import { createFlutterwaveWebhookPostHandler } from "./flutterwave/webhookRoute.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { enqueueInboundMessage } from "./queue/inboundMessageQueue.js";
import { RedisInboundMessageRateLimiter } from "./whatsapp/inboundRateLimiter.js";
import { createWebhookPostHandler, verifyWebhookSubscription, type RequestWithRawBody } from "./whatsapp/webhookRoute.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const appSecret = requireEnv("WHATSAPP_APP_SECRET");
const verifyToken = requireEnv("WHATSAPP_VERIFY_TOKEN");
const adminJwtSecret = requireEnv("ADMIN_JWT_SECRET");

// Optional (not requireEnv): the API server process doesn't otherwise need
// WhatsApp send credentials (src/worker.ts is what normally sends messages),
// so this deployment isn't forced to configure them just to boot. When
// present, the admin manual expire-subscriptions trigger can also send the
// subscription-lapse notification (see adminRoutes.ts, subscriptionExpiry.ts);
// when absent, that route still runs the sweep, just without notifications.
const outboundGateway = buildSubscriptionExpiryOutboundGatewayFromEnv();

// Same optionality as outboundGateway above, for the Phase 18 deletion-request
// resolution notification (see adminRoutes.ts, domain/deletion.ts) instead of
// the subscription-lapse one.
const deletionResolutionOutboundGateway = buildDeletionResolutionOutboundGatewayFromEnv();

// Phase 22: FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_SECRET_HASH are
// both optional (not requireEnv) — a deployment that hasn't set up
// Flutterwave yet should still boot this server with the payment webhook
// route simply unmounted, not fail to start over an off-by-default feature
// (paymentCollection). Both are required together for the route to make any
// sense at all: the secret key is what confirmSubscriptionPayment uses to
// verify a transaction server-to-server, and the webhook secret hash is what
// authenticates the inbound webhook call itself — mounting the route with
// only one configured would either be unreachable or unable to act on what
// it receives.
const flutterwave = buildFlutterwaveDepsFromEnv();
const flutterwaveWebhookSecretHash = process.env["FLUTTERWAVE_WEBHOOK_SECRET_HASH"];
const paymentsOutboundGateway = buildPaymentsOutboundGatewayFromEnv();
// Phase 24 counterpart, for confirmPaymentRequestPayment's own merchant notification.
const paymentRequestOutboundGateway = buildPaymentRequestOutboundGatewayFromEnv();

/**
 * Phase 20: opt-in Redis-backed rate limiting, closing the gap
 * `InMemoryLoginRateLimiter`/`InMemoryInboundMessageRateLimiter` have both
 * disclosed since Phase 2/19 — in-memory counters aren't shared across
 * replicas. Defaults to "memory" (the existing, zero-config behavior) so
 * every deployment that hasn't set this var — including every test in this
 * suite, and today's single-`server`-replica docker-compose.yml — is
 * completely unaffected. Set RATE_LIMIT_BACKEND=redis once this API is
 * actually scaled to more than one replica; both limiters then share one
 * ioredis connection built from the same REDIS_URL the BullMQ queues
 * already use (see queue/connection.ts), so no separate Redis credential
 * needs configuring.
 */
const rateLimitBackend = process.env["RATE_LIMIT_BACKEND"] ?? "memory";
const rateLimitRedisClient = rateLimitBackend === "redis" ? new Redis(getRedisConnectionOptions()) : undefined;
const loginRateLimiter = rateLimitRedisClient ? new RedisLoginRateLimiter(rateLimitRedisClient) : undefined;
const inboundMessageRateLimiter = rateLimitRedisClient
  ? new RedisInboundMessageRateLimiter(rateLimitRedisClient)
  : undefined;

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RequestWithRawBody).rawBody = Buffer.from(buf);
    },
  }),
);

app.get("/webhooks/whatsapp", (req, res) => {
  verifyWebhookSubscription(req, res, verifyToken);
});

app.post(
  "/webhooks/whatsapp",
  createWebhookPostHandler(
    { prisma, enqueueInboundMessage, ...(inboundMessageRateLimiter ? { rateLimiter: inboundMessageRateLimiter } : {}) },
    appSecret,
  ),
);

if (flutterwave && flutterwaveWebhookSecretHash) {
  app.post(
    "/webhooks/flutterwave",
    createFlutterwaveWebhookPostHandler(
      {
        prisma,
        flutterwave,
        ...(paymentsOutboundGateway ? { outboundGateway: paymentsOutboundGateway } : {}),
        ...(paymentRequestOutboundGateway ? { paymentRequestOutboundGateway } : {}),
      },
      flutterwaveWebhookSecretHash,
    ),
  );
} else {
  console.warn(
    "FLUTTERWAVE_SECRET_KEY / FLUTTERWAVE_WEBHOOK_SECRET_HASH not set — the /webhooks/flutterwave route is not mounted, " +
      "so a completed checkout can never activate its Subscription even if paymentCollection is enabled for a business.",
  );
}

// The admin-frontend package (admin-frontend/) is a separate-origin browser
// app in dev (e.g. http://localhost:5173) and would otherwise be blocked by
// the browser's same-origin policy from calling this API. Scoped to only the
// /admin router (never the WhatsApp webhook route, which is server-to-server
// and has no browser origin to protect) and to an explicit allowlist from
// ADMIN_FRONTEND_ORIGINS — unset means "no cross-origin browser access",
// not "allow all", since this API issues JWTs with real admin privileges.
const adminFrontendOrigins = (process.env["ADMIN_FRONTEND_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

app.use(
  "/admin",
  cors({
    origin: adminFrontendOrigins,
    credentials: false, // the admin frontend sends the JWT via an Authorization header, not cookies
  }),
  createAdminRouter(prisma, adminJwtSecret, {
    ...(outboundGateway ? { outboundGateway } : {}),
    ...(deletionResolutionOutboundGateway ? { deletionResolutionOutboundGateway } : {}),
    ...(loginRateLimiter ? { loginRateLimiter } : {}),
  }),
);

const port = Number(process.env["PORT"] ?? 3000);
app.listen(port, () => {
  console.log(`TradePal webhook server listening on port ${port}`);
});
