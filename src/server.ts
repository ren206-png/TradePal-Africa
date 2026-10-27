import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { Redis } from "ioredis";
import { mountAdminConsole } from "./admin/mount.js";
import { authOptionsFromEnv } from "./admin/adminAuthRoutes.js";
import { createOfflineRouter } from "./offline/routes.js";
import { installAlertDeliveryRecorder } from "./monitoring/alertRecorder.js";
import { buildAlertEmailDepsFromEnv } from "./config/monitoringEnv.js";
import { wireConsumerMessaging } from "./messaging/wire.js";
import { sendWhatsAppTextMessage } from "./whatsapp/outboundGateway.js";
import { createStorefrontRouter } from "./storefront/routes.js";
import { getAdapterRegistry } from "./payments/registry.js";
import { createMerchantPaymentWebhookRouter } from "./payments/webhookRoute.js";
import { createPawaPayBillingWebhookRouter } from "./pawapay/billingWebhook.js";
import { createCourierWebhookRouter } from "./couriers/webhook.js";
import { couriersEnabled, getCourierRegistry } from "./couriers/registry.js";
import { InMemoryLoginRateLimiter, RedisLoginRateLimiter } from "./admin/rateLimiter.js";
import {
  buildDeletionResolutionOutboundGatewayFromEnv,
  buildSubscriptionExpiryOutboundGatewayFromEnv,
} from "./config/outboundGatewayEnv.js";
import {
  buildFlutterwaveDepsFromEnv,
  buildPawaPayDepsFromEnv,
  buildPaymentRequestOutboundGatewayFromEnv,
  buildPaymentsOutboundGatewayFromEnv,
} from "./config/paymentsEnv.js";
import { prisma } from "./db/client.js";
import { createFlutterwaveWebhookPostHandler } from "./flutterwave/webhookRoute.js";
import { createPawaPayWebhookPostHandler } from "./pawapay/webhookRoute.js";
import { installCrashReporting, installGracefulShutdown } from "./monitoring/processGuards.js";
import { createRequestErrorHandler } from "./monitoring/requestErrorHandler.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { evaluateHeartbeats, heartbeatEnabled, requiredHeartbeatServices, startHeartbeat } from "./monitoring/heartbeat.js";
import { enqueueInboundMessage, replayInboundMessage } from "./queue/inboundMessageQueue.js";
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

// Optional, same as every WhatsApp/payments credential below: a deployment
// that hasn't signed up for an email-alerting provider yet still boots this
// server exactly as before this monitoring phase — reportIncident's own
// unconditional console.error is the fallback (see monitoring/alerts.ts).
const alerts = buildAlertEmailDepsFromEnv();
if (!alerts) {
  console.warn(
    "server: ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set — " +
      "crash/incident alerts will only be logged to console, not emailed.",
  );
}
// See processGuards.ts's own doc comment: an uncaughtException/
// unhandledRejection escaping this Express process is reported, then the
// process exits so Railway's restart policy brings up a clean replacement.
installCrashReporting("server", alerts);

// Optional (not requireEnv): the API server process doesn't otherwise need
// WhatsApp send credentials (src/worker.ts is what normally sends messages),
// so this deployment isn't forced to configure them just to boot. When
// present, the admin manual expire-subscriptions trigger can also send the
// subscription-lapse notification (see adminRoutes.ts, subscriptionExpiry.ts);
// when absent, that route still runs the sweep, just without notifications.
const outboundGateway = buildSubscriptionExpiryOutboundGatewayFromEnv();
wireConsumerMessaging(prisma);
installAlertDeliveryRecorder(prisma);

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

// PawaPay mobile money aggregator — C2B collection for West Africa (SL, LR, GM, GN).
// Optional, same as Flutterwave above: deployment boots without it, route simply unmounted.
// Set PAWAPAY_API_TOKEN to your sandbox (or production) token from dashboard.pawapay.io.
const pawapay = buildPawaPayDepsFromEnv();

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

// Security-header defaults (helmet) — this API serves no HTML/browser
// content itself (JSON responses only; the marketing site lives separately
// in landing/), so helmet's default CSP/HSTS/X-Frame-Options/etc. have no
// legitimate page to conflict with and are safe to apply as-is.
app.use(helmet());

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RequestWithRawBody).rawBody = Buffer.from(buf);
    },
  }),
);

// Minimal liveness/health-check route. This API has no browser-facing
// homepage (the marketing site lives separately, see landing/) — this just
// gives GET / and infra health-checkers (e.g. Railway) a 200 instead of a
// 404, since the only other routes mounted below are webhook/admin routes.
app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "tradepal-africa-api" });
});

// Expansion Phase 1: dead-man's-switch endpoint for an external monitor (independent of Railway). 404 unless
// HEARTBEAT_ENABLED=true. Reports only ok/stale: no service names, ages or counts.
if (heartbeatEnabled()) startHeartbeat(prisma, "api");

app.get("/heartbeat", async (_req, res) => {
  if (!heartbeatEnabled()) {
    res.status(404).end();
    return;
  }
  try {
    const statuses = await evaluateHeartbeats(prisma, requiredHeartbeatServices());
    const stale = statuses.filter((s) => requiredHeartbeatServices().includes(s.service) && s.stale);
    res.status(stale.length === 0 ? 200 : 503).json({ status: stale.length === 0 ? "ok" : "stale" });
  } catch {
    res.status(503).json({ status: "unknown" });
  }
});

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

if (pawapay) {
  app.post(
    "/webhooks/pawapay",
    createPawaPayWebhookPostHandler({
      prisma,
      pawapay,
      ...(paymentRequestOutboundGateway ? { outboundGateway: paymentRequestOutboundGateway } : {}),
    }),
  );
} else {
  console.warn(
    "PAWAPAY_API_TOKEN not set — the /webhooks/pawapay route is not mounted. " +
      "Set PAWAPAY_API_TOKEN to your sandbox or production token from dashboard.pawapay.io.",
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

// Admin-console Phase 2: mounted only while ADMIN_CONSOLE_ENABLED=true (see src/admin/mount.ts). Off means every /admin path is an ordinary 404.
// Sessions are required here (a bare token with no live server-side session is refused) and the second factor is enforced unless ADMIN_MFA_ENFORCE=false.
mountAdminConsole(app, {
  prisma,
  jwtSecret: adminJwtSecret,
  allowedOrigins: adminFrontendOrigins,
  routerOptions: {
    ...(outboundGateway ? { outboundGateway } : {}),
    // Phase 6: the admin "send reminder" action uses the same WhatsApp credentials as the other subscription notices, to the business's own owner.
    platform: {
      ...(outboundGateway ? { sendRenewalReminder: (toPhoneNumber: string, body: string) => sendWhatsAppTextMessage({ prisma, ...outboundGateway }, { toPhoneNumber, body }) } : {}),
      // Phase 7: the admin messaging panel can run an alert channel check and replay a stuck inbound message.
      alertDeps: buildAlertEmailDepsFromEnv(),
      replayInbound: replayInboundMessage,
    },
    ...(deletionResolutionOutboundGateway ? { deletionResolutionOutboundGateway } : {}),
    ...(loginRateLimiter ? { loginRateLimiter } : {}),
    auth: {
      ...authOptionsFromEnv(),
      requireSession: true,
      // 30 sign-in attempts per caller address per 15 minutes, whether or not Redis shares the count across instances.
      loginIpRateLimiter: rateLimitRedisClient ? new RedisLoginRateLimiter(rateLimitRedisClient, 30, 15 * 60_000) : new InMemoryLoginRateLimiter(30, 15 * 60_000),
      ...(rateLimitRedisClient
        ? {
            mfaRateLimiter: new RedisLoginRateLimiter(rateLimitRedisClient, 5, 10 * 60_000),
            reauthRateLimiter: new RedisLoginRateLimiter(rateLimitRedisClient, 5, 10 * 60_000),
          }
        : {}),
    },
    staff: {
      ...(process.env["ADMIN_FRONTEND_PUBLIC_URL"] ? { publicBaseUrl: process.env["ADMIN_FRONTEND_PUBLIC_URL"] } : {}),
      ...(rateLimitRedisClient ? { inviteRateLimiter: new RedisLoginRateLimiter(rateLimitRedisClient, 10, 60 * 60_000) } : {}),
    },
  },
});

// Merchant-payment provider callbacks (expansion Phase 5). Always mounted, but only providers in the adapter registry answer: in production
// the registry is empty until a real adapter is added, so this is a 404 for everything.
app.use(createMerchantPaymentWebhookRouter(prisma, () => getAdapterRegistry(prisma)));

// pawaPay callbacks about TradePal SUBSCRIPTION billing (expansion Phase 6): signed (RFC 9421) and processed asynchronously. Mounted
// regardless of the billing flags, because finishing a charge that already exists must never depend on new charges being allowed.
app.use(createPawaPayBillingWebhookRouter(prisma));

// Courier status callbacks (delivery tracking). Off unless COURIERS_ENABLED=true; even then only couriers in the registry answer, and in
// production the registry is empty until a real adapter is added by a reviewed change, so every path is a 404.
if (couriersEnabled()) app.use(createCourierWebhookRouter(prisma, () => getCourierRegistry()));

// Public storefront (expansion Phase 4): server-rendered pages for shoppers. Off unless STOREFRONT_ENABLED=true; even then a shop
// only appears once its owner switches the per-business `storefront` flag on and opens the shop. Behind a proxy set TRUST_PROXY so
// the per-client rate limits see the shopper's address, not the proxy's. Online "test" payments additionally need the simulator
// secret and are refused whenever NODE_ENV=production.
if (process.env["STOREFRONT_ENABLED"] === "true") {
  if (process.env["TRUST_PROXY"]) app.set("trust proxy", Number(process.env["TRUST_PROXY"]) || process.env["TRUST_PROXY"]);
  const paymentRegistry = getAdapterRegistry(prisma);
  app.use(
    createStorefrontRouter(prisma, {
      payments: { registry: paymentRegistry },
      // Marketplace discovery is a separate switch from having storefronts, and each seller is separately flagged.
      marketplace: process.env["MARKETPLACE_ENABLED"] === "true",
      // Shared across instances when Redis is configured (RATE_LIMIT_BACKEND), otherwise per process and reset on restart.
      ...(rateLimitRedisClient
        ? { limiters: { read: new RedisLoginRateLimiter(rateLimitRedisClient, 300, 60_000), write: new RedisLoginRateLimiter(rateLimitRedisClient, 120, 10 * 60_000), order: new RedisLoginRateLimiter(rateLimitRedisClient, 10, 60 * 60_000) } }
        : {}),
    }),
  );
}

// Offline drafts page and API (expansion Phase 7). Off unless OFFLINE_DRAFTS_ENABLED=true; every request is also checked against the
// per-business `offlineDrafts` flag. Behind a proxy set TRUST_PROXY so rate limits see the phone's address.
if (process.env["OFFLINE_DRAFTS_ENABLED"] === "true" || process.env["REPORTS_WEB_ENABLED"] === "true" || process.env["CATALOG_WEB_ENABLED"] === "true") {
  if (process.env["TRUST_PROXY"]) app.set("trust proxy", Number(process.env["TRUST_PROXY"]) || process.env["TRUST_PROXY"]);
  app.use(createOfflineRouter(prisma));
}

// Centralized error handler — MUST be registered last (after every route,
// including the /admin mount above), per Express's own rule that a 4-arg
// `(err, req, res, next)` middleware is only ever reached via `next(err)`.
// Closes the gap admin/asyncHandler.ts's own doc comment describes: Express 4
// doesn't catch a rejected Promise from an async handler on its own, so
// without both this middleware AND every handler being wrapped in
// asyncHandler, an error thrown by any admin route would previously become an
// unhandled rejection and — via installCrashReporting's own listener — take
// down the entire process instead of just failing the one request. This is
// the request-scoped counterpart to that process-scoped safety net: it
// reports the incident the same way, but responds with a plain 500 and lets
// the process keep serving every other in-flight and future request.
// Client errors (e.g. malformed JSON) get their 4xx and are NOT reported as incidents.
app.use(createRequestErrorHandler(alerts, "server"));

const port = Number(process.env["PORT"] ?? 3000);
const server = app.listen(port, () => {
  console.log(`TradePal webhook server listening on port ${port}`);
});

// See processGuards.ts's own doc comment: SIGTERM (sent by Railway on every
// redeploy) previously had no listener here, so Node's default behavior —
// terminate immediately — could cut off an in-flight webhook request rather
// than letting server.close() stop accepting new connections while letting
// existing ones finish.
installGracefulShutdown("server", [
  {
    name: "http-server",
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  },
  { name: "prisma", close: () => prisma.$disconnect() },
]);
