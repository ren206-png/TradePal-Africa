import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getInboxStats } from "../domain/callbackInbox.js";
import { getOutboxStats } from "../domain/outbox.js";
import { platformPermissionsFor } from "../auth/permissions.js";
import { evaluateHeartbeats, heartbeatEnabled, requiredHeartbeatServices } from "../monitoring/heartbeat.js";
import { asyncHandler } from "./asyncHandler.js";
import { createAdminTransactionsRouter } from "./adminTransactions.js";
import { createAdminReorderRouter } from "./adminReorder.js";
import { createAdminSupportRouter } from "./adminSupport.js";
import { createAdminPaymentsRouter } from "./adminPayments.js";
import { createAdminModerationRouter } from "./adminModeration.js";
import { createAdminSubscriptionsRouter } from "./adminSubscriptions.js";
import { correlationIdOf } from "./adminAudit.js";
import { verifyAdminPassword } from "./auth.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import {
  FLAG_STEP_UP,
  FLAG_SUPPORT_ACCESS,
  SUPPORT_ACCESS_MAX_MINUTES,
  issueStepUpToken,
  openSupportAccess,
  recordPlatformAudit,
  requirePlatformPermission,
  STEP_UP_TTL_SECONDS,
} from "./platformGuards.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "./rateLimiter.js";

const stepUpBodySchema = z.object({ password: z.string().min(1) });
const supportAccessBodySchema = z.object({
  reason: z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500),
  minutes: z.number().int().min(1).max(SUPPORT_ACCESS_MAX_MINUTES).optional(),
});

const STUCK_WEBHOOK_AFTER_MS = 5 * 60_000;

export interface PlatformAdminOptions {
  stepUpRateLimiter?: LoginRateLimiter;
  /** Test seam: the clock. */
  now?: () => Date;
  /** Sends a WhatsApp reminder to a business owner about their own subscription; omitted when messaging is not configured. */
  sendRenewalReminder?: (toPhoneNumber: string, body: string) => Promise<void>;
}

/**
 * Admin console core routes (expansion Phase 1), mounted behind requireAdminAuth. Metadata and counts only: no route
 * here returns a merchant's transactions or money (those stay behind requireSupportAccess).
 */
export function createPlatformAdminRouter(prisma: PrismaClient, jwtSecret: string, options: PlatformAdminOptions = {}): Router {
  const router = Router();
  const stepUpLimiter = options.stepUpRateLimiter ?? new InMemoryLoginRateLimiter();
  const clock = options.now ?? (() => new Date());

  router.use(createAdminTransactionsRouter(prisma, jwtSecret));
  router.use(createAdminReorderRouter(prisma, jwtSecret));
  router.use(createAdminSupportRouter(prisma, jwtSecret));
  router.use(createAdminPaymentsRouter(prisma, jwtSecret));
  router.use(createAdminModerationRouter(prisma, jwtSecret));
  router.use(createAdminSubscriptionsRouter(prisma, jwtSecret, { ...(options.sendRenewalReminder ? { sendReminder: options.sendRenewalReminder } : {}), ...(options.now ? { now: options.now } : {}) }));

  router.get("/me/permissions", (req, res) => {
    const admin = (req as AuthenticatedAdminRequest).adminUser;
    if (!admin) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }
    res.json({ role: admin.role, permissions: platformPermissionsFor(admin.role) });
  });

  // Fresh password confirmation -> short-lived step-up token (header x-admin-step-up on sensitive calls).
  router.post(
    "/step-up",
    asyncHandler(async (req, res) => {
      const admin = (req as AuthenticatedAdminRequest).adminUser;
      if (!admin) {
        res.status(401).json({ error: "Not authenticated." });
        return;
      }
      const parsed = stepUpBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body." });
        return;
      }
      const key = `step-up:${admin.adminUserId}`;
      const limit = await stepUpLimiter.consume(key);
      if (!limit.allowed) {
        res.status(429).set("Retry-After", String(limit.retryAfterSeconds)).json({ error: "Too many attempts. Try again later." });
        return;
      }
      // Re-read the account: a deleted admin or a changed password must not keep working on an old session.
      const row = await prisma.adminUser.findUnique({ where: { id: admin.adminUserId } });
      const ok = row ? await verifyAdminPassword(parsed.data.password, row.passwordHash) : false;
      if (!row || !ok) {
        await recordPlatformAudit(prisma, { adminUserId: admin.adminUserId, action: "admin.step_up.failed", entityType: "AdminUser", entityId: admin.adminUserId, correlationId: correlationIdOf(res) });
        res.status(401).json({ error: "Incorrect password." });
        return;
      }
      await stepUpLimiter.reset(key);
      await recordPlatformAudit(prisma, { adminUserId: admin.adminUserId, action: "admin.step_up.confirmed", entityType: "AdminUser", entityId: admin.adminUserId, correlationId: correlationIdOf(res) });
      res.json({ stepUpToken: issueStepUpToken(admin.adminUserId, admin.jti, jwtSecret), expiresInSeconds: STEP_UP_TTL_SECONDS });
    }),
  );

  router.post(
    "/businesses/:id/support-access",
    requirePlatformPermission("admin:view_merchant_financials"),
    asyncHandler(async (req, res) => {
      const admin = (req as AuthenticatedAdminRequest).adminUser!;
      const parsed = supportAccessBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
        return;
      }
      const businessId = req.params["id"] as string;
      if (!(await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } }))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const access = await openSupportAccess(prisma, {
        adminUserId: admin.adminUserId,
        businessId,
        reason: parsed.data.reason,
        now: clock(),
        correlationId: correlationIdOf(res),
        ...(parsed.data.minutes !== undefined ? { minutes: parsed.data.minutes } : {}),
      });
      res.status(201).json({ supportAccess: { id: access.id, businessId, openedAt: access.openedAt, expiresAt: access.expiresAt } });
    }),
  );

  router.get(
    "/businesses/:id/support-access",
    requirePlatformPermission("admin:view_audit_log"),
    asyncHandler(async (req, res) => {
      const rows = await prisma.supportAccess.findMany({
        where: { businessId: req.params["id"] as string },
        orderBy: { openedAt: "desc" },
        take: 50,
        include: { adminUser: { select: { email: true } } },
      });
      res.json({
        supportAccesses: rows.map((r) => ({ id: r.id, adminEmail: r.adminUser.email, reason: r.reason, openedAt: r.openedAt, expiresAt: r.expiresAt })),
      });
    }),
  );

  router.get(
    "/overview",
    requirePlatformPermission("admin:view_overview"),
    asyncHandler(async (_req, res) => {
      const now = clock();
      const day = new Date(now.getTime() - 24 * 3600_000);
      const week = new Date(now.getTime() - 7 * 24 * 3600_000);
      // Sequential on purpose: a low-traffic admin page, and it keeps load on the shared pool predictable.
      const businesses = await prisma.business.count();
      const suspended = await prisma.business.count({ where: { status: "SUSPENDED" } });
      const merchants = await prisma.merchant.count({ where: { removedAt: null } });
      const newBusinesses7d = await prisma.business.count({ where: { createdAt: { gte: week } } });
      const transactions24h = await prisma.transaction.count({ where: { createdAt: { gte: day } } });
      const transactions7d = await prisma.transaction.count({ where: { createdAt: { gte: week } } });
      const subs = await prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } });
      const deletions = await prisma.deletionRequest.count({ where: { status: "PENDING" } });
      const unmatchedAlerts = await prisma.mobileMoneyAlert.count({ where: { matchStatus: "UNMATCHED" } });
      const openSupportCases = await prisma.supportCase.count({ where: { status: { not: "CLOSED" } } });
      const openPaymentExceptions = await prisma.paymentException.count({ where: { status: "OPEN" } });
      const openProviderExceptions = await prisma.providerException.count({ where: { status: "OPEN" } });
      const unresolvedPaymentAttempts = await prisma.paymentAttempt.count({ where: { status: { in: ["PENDING", "UNKNOWN"] } } });
      const openReports = await prisma.marketplaceReport.count({ where: { status: "OPEN" } });
      const openAppeals = await prisma.appeal.count({ where: { status: "OPEN" } });
      const pendingRefundRequests = await prisma.storeRefundRequest.count({ where: { status: { in: ["REQUESTED", "APPROVED", "GOODS_RECEIVED"] } } });
      const outbox = await getOutboxStats(prisma, now);
      const inbox = await getInboxStats(prisma, now);
      res.json({
        businesses: { total: businesses, suspended, active: businesses - suspended, newLast7Days: newBusinesses7d },
        merchants: { active: merchants },
        activity: { transactionsLast24h: transactions24h, transactionsLast7d: transactions7d },
        subscriptions: Object.fromEntries(subs.map((s) => [s.status, s._count._all])),
        queues: { pendingDeletionRequests: deletions, unmatchedMobileMoneyAlerts: unmatchedAlerts, openSupportCases, openPaymentExceptions, pendingRefundRequests, openProviderExceptions, unresolvedPaymentAttempts, openReports, openAppeals, outbox, inbox },
        generatedAt: now,
      });
    }),
  );

  router.get(
    "/system-health",
    requirePlatformPermission("admin:view_system_health"),
    asyncHandler(async (_req, res) => {
      const now = clock();
      const stuckBefore = new Date(now.getTime() - STUCK_WEBHOOK_AFTER_MS);
      const heartbeats = await evaluateHeartbeats(prisma, requiredHeartbeatServices(), now);
      const stuckWebhooks = await prisma.webhookEvent.count({ where: { status: "PENDING", receivedAt: { lt: stuckBefore } } });
      const outbox = await getOutboxStats(prisma, now);
      const inbox = await getInboxStats(prisma, now);
      const lastAi = await prisma.aiUsageLedger.findFirst({ where: { phase: "COMMIT" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, provider: true } });
      const flags = await prisma.featureFlag.findMany({ where: { key: { in: [FLAG_STEP_UP, FLAG_SUPPORT_ACCESS] } } });
      // Only whether things are configured, never their values.
      const env = process.env;
      res.json({
        heartbeats: { enabled: heartbeatEnabled(), services: heartbeats },
        webhooks: { stuckPendingOver5Min: stuckWebhooks },
        outbox,
        inbox,
        ai: { lastSuccessfulCallAt: lastAi?.createdAt ?? null, lastSuccessfulProvider: lastAi?.provider ?? null },
        configured: {
          alertEmail: Boolean(env["ALERT_EMAIL_API_KEY"] && env["ALERT_EMAIL_TO"]),
          deepseek: Boolean(env["DEEPSEEK_API_KEY"]),
          outboxSweep: env["OUTBOX_SWEEP_ENABLED"] === "true",
        },
        adminControls: Object.fromEntries(flags.map((f) => [f.key, f.enabledByDefault])),
        generatedAt: now,
      });
    }),
  );

  router.get(
    "/admins",
    requirePlatformPermission("admin:manage_admins"),
    asyncHandler(async (_req, res) => {
      const rows = await prisma.adminUser.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, email: true, name: true, role: true, createdAt: true } });
      res.json({ admins: rows });
    }),
  );

  return router;
}
