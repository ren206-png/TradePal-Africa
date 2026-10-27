import { rejectNulBytes } from "../http/rejectNul.js";
import type { Plan, Prisma, PrismaClient } from "@prisma/client";
import { Router, type Response } from "express";
import { z } from "zod";
import { getEffectivePlan, type EffectivePlan } from "../domain/billing.js";
import {
  FeatureFlagNotFoundError,
  ProtectedFlagError,
  listFeatureFlags,
  listFeatureFlagStatesForBusiness,
  removeFeatureFlagOverrideForBusiness,
  setFeatureFlagForBusiness,
  setFeatureFlagGlobalDefault,
} from "../domain/featureFlags.js";
import {
  completeDeletionRequest,
  DeletionRequestAlreadyResolvedError,
  DeletionRequestNotFoundError,
  rejectDeletionRequest,
  type DeletionResolutionOutboundGateway,
} from "../domain/deletion.js";
import {
  changeMerchantPhoneNumber,
  MerchantNotFoundError,
  PhoneNumberAlreadyRegisteredError,
} from "../domain/merchantIdentity.js";
import {
  assignSubscription,
  BusinessNotFoundError,
  cancelActiveSubscription,
  CurrencyNotFoundError,
  InvalidSubscriptionPeriodError,
  listPlans,
  NoActiveSubscriptionError,
  PlanNotFoundError,
  PlanValidationError,
  upsertPlan,
} from "../domain/planAdmin.js";
import { backfillInventoryLinksForBusiness } from "../domain/inventory.js";
import {
  BusinessAlreadySuspendedError,
  BusinessNotSuspendedError,
  reinstateBusiness,
  suspendBusiness,
} from "../domain/businessModeration.js";
import { expireLapsedSubscriptions, type SubscriptionExpiryOutboundGateway } from "../domain/subscriptionExpiry.js";
import { expireStalePaymentRequests } from "../domain/paymentRequestExpiry.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { findAdminUserByEmail } from "./adminUsers.js";
import { asyncHandler } from "./asyncHandler.js";
import { issueAdminJwt, verifyAdminPassword } from "./auth.js";
import { requireAdminAuth, requireAdminRole, requireMfaComplete, type AuthenticatedAdminRequest } from "./authMiddleware.js";
import { createStaffRouter, invitationAcceptHandler } from "./staffAdmin.js";
import { moduleGate, moduleReport, type ModuleSwitch } from "./moduleGate.js";
import { blockDirectRefunds, createRefundRouter, type RefundExecutors } from "./refundRequests.js";
import { buildAuthContext, createLoginHandler, createSessionRouter, denialRecorder, type AdminAuthRouteOptions } from "./adminAuthRoutes.js";
import { parsePaginationParams, paginate } from "./pagination.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "./rateLimiter.js";
import { revokeAdminToken } from "./tokenRevocation.js";
import { createPlatformAdminRouter, type PlatformAdminOptions } from "./platformAdmin.js";
import { recordPlatformAudit, requireFinancialViewer, requireLegacyAccess, requireStepUp, requireSupportAccess } from "./platformGuards.js";
import { auditAdminWrites, correlationIdOf, correlationMiddleware } from "./adminAudit.js";
import type { PlatformPermission } from "../auth/permissions.js";

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePhoneNumberBodySchema = z.object({
  businessId: z.string().min(1),
  newPhoneNumber: z.string().min(1),
  reason: z.string().min(1),
});

const completeDeletionRequestBodySchema = z.object({
  businessId: z.string().min(1),
  resolutionNote: z.string().optional(),
});

const rejectDeletionRequestBodySchema = z.object({
  businessId: z.string().min(1),
  resolutionNote: z.string().min(1),
});

// priceMinor travels as a decimal-digit string, not a JSON number: it's a BigInt column
// (Non-Negotiable: money is never a float), and a JS number can't safely represent every
// bigint value — same reasoning as the amountMinor serialization on mobile-money-alerts.
// Phase 14: staffCapCount is `.optional()` (unlike entryCapPerMonth, required) so an
// admin-frontend build that predates this field can keep saving plans without it —
// the route handler below falls back to the plan's existing stored value when the
// field is omitted, rather than defaulting to null and silently clobbering any
// manually-set cap on every save from an unaware frontend.
const upsertPlanBodySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  priceMinor: z.string().regex(/^\d+$/, "priceMinor must be a non-negative integer string (minor units)."),
  currencyCode: z.string().min(1),
  entryCapPerMonth: z.number().int().nonnegative().nullable(),
  voiceEnabled: z.boolean(),
  staffCapCount: z.number().int().nonnegative().nullable().optional(),
});

const assignSubscriptionBodySchema = z.object({
  planCode: z.string().min(1),
  currentPeriodStart: z.string().datetime(),
  currentPeriodEnd: z.string().datetime(),
  reason: z.string().optional(),
});

const cancelSubscriptionBodySchema = z.object({
  reason: z.string().optional(),
});

const suspendBusinessBodySchema = z.object({
  reason: z.string().min(1),
});

const reinstateBusinessBodySchema = z.object({
  reason: z.string().optional(),
});

const setGlobalFeatureFlagDefaultBodySchema = z.object({
  enabledByDefault: z.boolean(),
});

const setBusinessFeatureFlagBodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
});

const removeBusinessFeatureFlagOverrideBodySchema = z.object({
  reason: z.string().optional(),
});

const auditQuery = z.object({
  businessId: z.string().max(64).optional(),
  actorId: z.string().max(120).optional(),
  actorType: z.enum(["MERCHANT", "ADMIN", "SYSTEM"]).optional(),
  action: z.string().max(120).optional(),
  actionMode: z.enum(["prefix", "exact"]).optional(),
  entityType: z.string().max(80).optional(),
  entityId: z.string().max(120).optional(),
  correlationId: z.string().max(64).optional(),
  result: z.enum(["SUCCESS", "FAILURE", "DENIED"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).passthrough();

function sendZodError(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "Invalid request body.", details: error.issues });
}

/** priceMinor is a BigInt column — see the upsertPlanBodySchema comment for why it's serialized as a string. */
function serializePlan(plan: Plan) {
  return { ...plan, priceMinor: plan.priceMinor.toString() };
}

/**
 * Read-only first, RBAC before any write (Phase 2 mandate): every route
 * below `/login` requires a valid admin JWT, and the one write route
 * (`POST /merchants/:id/phone-number`) additionally requires SUPER_ADMIN or
 * SUPPORT — ANALYST is intentionally read-only, per the AdminRole enum's
 * purpose (analytics access, not operational changes).
 */
export interface CreateAdminRouterOptions {
  loginRateLimiter?: LoginRateLimiter;
  /**
   * Optional: only present when the API server process has WhatsApp Cloud
   * API credentials configured (see server.ts). When omitted, the manual
   * expire-subscriptions trigger below still runs the status/audit sweep —
   * it just can't also send the subscription-lapse WhatsApp notification
   * (src/domain/subscriptionExpiry.ts), consistent with that notification
   * being best-effort and gated behind its own off-by-default FeatureFlag.
   */
  outboundGateway?: SubscriptionExpiryOutboundGateway;
  /**
   * Phase 18: same optionality/rationale as `outboundGateway` above, for the
   * deletion-request resolution notification instead of the subscription-
   * lapse one. `Omit<..., "prisma">` because this router already has the raw
   * `PrismaClient` it needs to merge in at each call site — see
   * `buildDeletionResolutionOutboundGatewayFromEnv`'s own doc comment
   * (config/outboundGatewayEnv.ts) for why the full type isn't used here.
   */
  deletionResolutionOutboundGateway?: Omit<DeletionResolutionOutboundGateway, "prisma">;
  /** Expansion Phase 1: step-up limiter / clock seams for the platform admin core router. */
  platform?: PlatformAdminOptions;
  /**
   * Admin-console Phase 2: session rules, second-factor enforcement and its key. Left out (tests, local tools) means the sign-in keeps
   * working as before: no enforcement, legacy tokens accepted. server.ts passes the real values from the environment.
   */
  auth?: AdminAuthRouteOptions & { requireSession?: boolean };
  /**
   * Admin-console Phase 3: which modules are on. server.ts passes the environment switches (all off by default); a router built without
   * this (tests, local tools) has every module on, as before.
   */
  modules?: ModuleSwitch;
  /** Admin-console Phase 3: refund execution seams (tests inject fakes so nothing reaches a payment provider) and the environment it reads. */
  refunds?: { executors?: RefundExecutors; env?: () => NodeJS.ProcessEnv };
  /** Admin-console Phase 2: where invitation links point, and the limiter for the public accept route. */
  staff?: { publicBaseUrl?: string; inviteRateLimiter?: LoginRateLimiter };
}

export function createAdminRouter(prisma: PrismaClient, jwtSecret: string, options: CreateAdminRouterOptions = {}): Router {
  const router = Router();
  router.use(rejectNulBytes);
  const loginRateLimiter = options.loginRateLimiter ?? new InMemoryLoginRateLimiter();

  const authCtx = buildAuthContext(prisma, jwtSecret, { ...options.auth, ...(options.loginRateLimiter ? { loginRateLimiter: options.loginRateLimiter } : {}) });
  router.use(correlationMiddleware());
  router.use(denialRecorder(authCtx));
  router.post("/login", createLoginHandler(authCtx));
  {
    const accept = invitationAcceptHandler(prisma, { jwtSecret, ...(options.staff?.inviteRateLimiter ? { limiter: options.staff.inviteRateLimiter } : {}), now: authCtx.now });
    // redeeming an invitation belongs to the Staff module: with it off the route does not exist
    router.post("/invitations/accept", (req, res, next) => (options.modules && !options.modules("STAFF") ? next("router") : accept(req, res, next)));
  }

  router.use(requireAdminAuth(prisma, jwtSecret, { policy: authCtx.policy, enforceMfa: authCtx.enforceMfa, requireSession: options.auth?.requireSession ?? false, now: authCtx.now }));
  // Sign-in state, second-factor and sign-out routes: reachable by a half-open session. Everything after the gate needs the factor done.
  router.use(createSessionRouter(authCtx));
  router.use(requireMfaComplete(prisma));
  // What is switched on and how much of each module is really built (any signed-in staff member may read it).
  router.get("/modules", (_req, res) => { res.json({ modules: moduleReport(options.modules) }); });
  router.use(moduleGate(options.modules));
  // While the Refunds module is on, the older single-person refund routes refuse; the two-person workflow replaces them.
  router.use(blockDirectRefunds(() => (options.modules ? options.modules("REFUNDS") : false)));
  router.use(auditAdminWrites(prisma, options.platform?.alertDeps));
  router.use(createRefundRouter(prisma, { jwtSecret, policy: authCtx.policy, now: authCtx.now, ...(options.refunds?.env ? { env: options.refunds.env } : {}), ...(options.refunds?.executors ? { executors: options.refunds.executors } : {}) }));
  router.use(createStaffRouter(prisma, { jwtSecret, policy: authCtx.policy, now: authCtx.now, ...(options.staff?.publicBaseUrl ? { publicBaseUrl: options.staff.publicBaseUrl } : {}) }));

  // Expansion Phase 1: admin console core (overview, system health, step-up, support access, admin list).
  router.use(createPlatformAdminRouter(prisma, jwtSecret, options.platform));

  // Step-up (flag adminStepUp, default off) is layered on top of each write route's existing role check.
  const stepUp = (permission: PlatformPermission) => requireStepUp(prisma, jwtSecret, permission);

  router.get(
    "/businesses",
    requireLegacyAccess("admin:view_orgs"),
    asyncHandler(async (req, res) => {
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.business.findMany({
        orderBy: { createdAt: "desc" },
        take: pagination.take + 1,
        skip: pagination.skip,
        include: { _count: { select: { merchants: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      res.json({ businesses: items, pagination: meta });
    }),
  );

  // Opening one business shows its people's phone numbers and its subscriptions: with the support-access control on it needs a recorded reason.
  router.get(
    "/businesses/:id",
    requireLegacyAccess("admin:view_orgs"),
    requireSupportAccess(prisma, "Business"),
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        include: {
          merchants: true,
          subscriptions: { orderBy: { createdAt: "desc" }, include: { plan: true } },
        },
      });
      if (!business) {
        res.status(404).json({ error: "Business not found." });
        return;
      }

      // getEffectivePlan (billing.ts) is the same resolver /usage and the quota
      // checks use — surfacing it here means an admin sees exactly what plan is
      // actually in force, not just the raw Subscription history (which can
      // include stale/CANCELED rows and, per planAdmin.ts's disclosed gap,
      // ACTIVE rows whose currentPeriodEnd has already lapsed).
      let currentPlan: EffectivePlan | null;
      try {
        currentPlan = await getEffectivePlan(getTenantScopedClient(prisma, businessId), businessId);
      } catch {
        currentPlan = null;
      }

      const serialized = {
        ...business,
        subscriptions: business.subscriptions.map((subscription) => ({
          ...subscription,
          plan: serializePlan(subscription.plan),
        })),
      };

      res.json({ business: serialized, currentPlan });
    }),
  );

  router.get(
    "/deletion-requests",
    requireLegacyAccess("admin:view_support_cases"),
    asyncHandler(async (req, res) => {
      const statusParam = req.query["status"];
      const status =
        typeof statusParam === "string" && ["PENDING", "COMPLETED", "REJECTED"].includes(statusParam)
          ? (statusParam as "PENDING" | "COMPLETED" | "REJECTED")
          : "PENDING";

      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.deletionRequest.findMany({
        where: { status },
        orderBy: { createdAt: "desc" },
        take: pagination.take + 1,
        skip: pagination.skip,
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      res.json({ deletionRequests: items, pagination: meta });
    }),
  );

  // Resolution routes (KQ5 gap closure): SUPER_ADMIN or SUPPORT, mirroring the
  // phone-number-change route's RBAC — this is a business-scoped-but-sensitive
  // write (it anonymizes a customer, or formally declines to), not a global
  // maintenance action, so ANALYST stays read-only-excluded same as everywhere
  // else. `businessId` travels in the body (not inferable from the request id
  // alone without a cross-tenant lookup) so a TenantScopedClient can be built,
  // exactly like every other admin write route above that touches tenant data.
  router.post(
    "/deletion-requests/:id/complete",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:resolve_support_case"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = completeDeletionRequestBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const resolved = await completeDeletionRequest(
          getTenantScopedClient(prisma, parsed.data.businessId),
          req.params["id"] as string,
          parsed.data.resolutionNote,
          req.adminUser?.adminUserId,
          options.deletionResolutionOutboundGateway ? { prisma, ...options.deletionResolutionOutboundGateway } : undefined,
        );
        res.json({ deletionRequest: resolved });
      } catch (error) {
        if (error instanceof DeletionRequestNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof DeletionRequestAlreadyResolvedError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    "/deletion-requests/:id/reject",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:resolve_support_case"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = rejectDeletionRequestBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const resolved = await rejectDeletionRequest(
          getTenantScopedClient(prisma, parsed.data.businessId),
          req.params["id"] as string,
          parsed.data.resolutionNote,
          req.adminUser?.adminUserId,
          options.deletionResolutionOutboundGateway ? { prisma, ...options.deletionResolutionOutboundGateway } : undefined,
        );
        res.json({ deletionRequest: resolved });
      } catch (error) {
        if (error instanceof DeletionRequestNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof DeletionRequestAlreadyResolvedError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.get(
    "/audit-logs",
    requireLegacyAccess("admin:view_audit_log"),
    asyncHandler(async (req, res) => {
      // Admin-console Phase 3: filter by actor, action, target, business, outcome, request id and date. Every filter is validated; unknown
      // keys other than the paging keys are ignored (they never reach the query).
      const q = auditQuery.safeParse(req.query);
      if (!q.success) return void res.status(400).json({ error: "Invalid query.", details: q.error.issues });
      const f = q.data;
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const where: Prisma.AuditLogWhereInput = {
        ...(f.businessId ? { businessId: f.businessId } : {}),
        ...(f.actorId ? { actorId: f.actorId } : {}),
        ...(f.actorType ? { actorType: f.actorType } : {}),
        ...(f.action ? { action: f.actionMode === "exact" ? f.action : { startsWith: f.action } } : {}),
        ...(f.entityType ? { entityType: f.entityType } : {}),
        ...(f.entityId ? { entityId: f.entityId } : {}),
        ...(f.correlationId ? { correlationId: f.correlationId } : {}),
        ...(f.result ? { result: f.result } : {}),
        ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } } : {}),
      };
      const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip });
      const { items, pagination: meta } = paginate(rows, pagination);
      res.json({ auditLogs: items, pagination: meta });
    }),
  );

  router.get(
    "/mobile-money-alerts",
    requireLegacyAccess("admin:view_payments"),
    requireFinancialViewer(prisma),
    asyncHandler(async (req, res) => {
      const businessId = req.query["businessId"];
      const statusParam = req.query["status"];
      const status =
        typeof statusParam === "string" && ["UNMATCHED", "SUGGESTED", "CONFIRMED"].includes(statusParam)
          ? (statusParam as "UNMATCHED" | "SUGGESTED" | "CONFIRMED")
          : undefined;

      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.mobileMoneyAlert.findMany({
        where: {
          ...(typeof businessId === "string" ? { businessId } : {}),
          ...(status ? { matchStatus: status } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: pagination.take + 1,
        skip: pagination.skip,
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      // amountMinor is a bigint (Non-Negotiable: money is never a float) — express's res.json can't
      // serialize BigInt, and none of the other admin list endpoints return a bigint column, so this
      // is the first route that needs an explicit conversion. Serialized as a string (not Number) to
      // preserve exact precision over the wire, same reasoning as everywhere else money is handled.
      const serialized = items.map((item) => ({ ...item, amountMinor: item.amountMinor.toString() }));
      res.json({ mobileMoneyAlerts: serialized, pagination: meta });
    }),
  );

  router.get(
    "/plans",
    requireLegacyAccess("admin:view_subscriptions"),
    asyncHandler(async (_req, res) => {
      const plans = await listPlans(prisma);
      res.json({ plans: plans.map(serializePlan) });
    }),
  );

  router.post(
    "/plans",
    requireAdminRole("SUPER_ADMIN"),
    stepUp("admin:manage_subscriptions"),
    asyncHandler(async (req, res) => {
      const parsed = upsertPlanBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        // staffCapCount omitted entirely (vs. explicitly null) means "don't touch
        // this field" — fetch the current row so an old frontend's save doesn't
        // silently clear a cap someone else set via a newer client/script.
        const staffCapCount =
          parsed.data.staffCapCount !== undefined
            ? parsed.data.staffCapCount
            : ((await prisma.plan.findUnique({ where: { code: parsed.data.code } }))?.staffCapCount ?? null);

        const plan = await upsertPlan(prisma, {
          code: parsed.data.code,
          name: parsed.data.name,
          priceMinor: BigInt(parsed.data.priceMinor),
          currencyCode: parsed.data.currencyCode,
          entryCapPerMonth: parsed.data.entryCapPerMonth,
          voiceEnabled: parsed.data.voiceEnabled,
          staffCapCount,
        });
        // Standard #8: these platform-level writes were previously un-audited (no business to scope to).
        await recordPlatformAudit(prisma, {
          adminUserId: (req as AuthenticatedAdminRequest).adminUser!.adminUserId,
          correlationId: correlationIdOf(res),
          action: "admin.plan.upserted",
          entityType: "Plan",
          entityId: plan.code,
          metadata: { priceMinor: plan.priceMinor.toString(), currencyCode: plan.currencyCode, entryCapPerMonth: plan.entryCapPerMonth },
        });
        res.json({ plan: serializePlan(plan) });
      } catch (error) {
        if (error instanceof PlanValidationError || error instanceof CurrencyNotFoundError) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.get(
    "/feature-flags",
    requireLegacyAccess("admin:view_orgs"),
    asyncHandler(async (_req, res) => {
      const flags = await listFeatureFlags(prisma);
      res.json({ featureFlags: flags });
    }),
  );

  // SUPER_ADMIN only: flipping a flag's global default is a bulk rollout (or
  // rollback) affecting every business that has never set its own override —
  // a materially bigger blast radius than the per-business override routes
  // below, which is why this needs a stricter role than SUPPORT.
  router.post(
    "/feature-flags/:key",
    requireAdminRole("SUPER_ADMIN"),
    stepUp("admin:manage_global_flags"),
    asyncHandler(async (req, res) => {
      const parsed = setGlobalFeatureFlagDefaultBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const flag = await setFeatureFlagGlobalDefault(prisma, req.params["key"] as string, parsed.data.enabledByDefault);
        await recordPlatformAudit(prisma, {
          adminUserId: (req as AuthenticatedAdminRequest).adminUser!.adminUserId,
          correlationId: correlationIdOf(res),
          action: "admin.feature_flag.global_default_set",
          entityType: "FeatureFlag",
          entityId: flag.key,
          metadata: { enabledByDefault: flag.enabledByDefault },
        });
        res.json({ featureFlag: flag });
      } catch (error) {
        if (error instanceof ProtectedFlagError) {
          res.status(409).json({ error: error.message, code: "PROTECTED_FLAG" });
          return;
        }
        if (error instanceof FeatureFlagNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    "/businesses/:id/subscription",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:manage_subscriptions"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = assignSubscriptionBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const subscription = await assignSubscription(prisma, {
          businessId: req.params["id"] as string,
          planCode: parsed.data.planCode,
          currentPeriodStart: new Date(parsed.data.currentPeriodStart),
          currentPeriodEnd: new Date(parsed.data.currentPeriodEnd),
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
          ...(req.adminUser ? { changedByAdminUserId: req.adminUser.adminUserId } : {}),
        });
        res.json({ subscription });
      } catch (error) {
        if (error instanceof BusinessNotFoundError || error instanceof PlanNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof InvalidSubscriptionPeriodError) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    "/businesses/:id/subscription/cancel",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:manage_subscriptions"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = cancelSubscriptionBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const subscription = await cancelActiveSubscription(prisma, req.params["id"] as string, {
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
          ...(req.adminUser ? { changedByAdminUserId: req.adminUser.adminUserId } : {}),
        });
        res.json({ subscription });
      } catch (error) {
        if (error instanceof NoActiveSubscriptionError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  // Phase 29: platform-moderation suspension — SUPER_ADMIN only, stricter than
  // the SUPER_ADMIN-or-SUPPORT bar used for subscription writes above, since
  // this is the highest-blast-radius admin action in the codebase (cuts off
  // every merchant on the business at once, everywhere, via messageDispatcher.ts).
  router.post(
    "/businesses/:id/suspend",
    requireAdminRole("SUPER_ADMIN"),
    stepUp("admin:suspend_org"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = suspendBusinessBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const business = await suspendBusiness(prisma, {
          businessId: req.params["id"] as string,
          reason: parsed.data.reason,
          ...(req.adminUser ? { suspendedByAdminUserId: req.adminUser.adminUserId } : {}),
        });
        res.json({ business });
      } catch (error) {
        if (error instanceof BusinessNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof BusinessAlreadySuspendedError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    "/businesses/:id/reinstate",
    requireAdminRole("SUPER_ADMIN"),
    stepUp("admin:suspend_org"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = reinstateBusinessBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const business = await reinstateBusiness(prisma, {
          businessId: req.params["id"] as string,
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
          ...(req.adminUser ? { reinstatedByAdminUserId: req.adminUser.adminUserId } : {}),
        });
        res.json({ business });
      } catch (error) {
        if (error instanceof BusinessNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof BusinessNotSuspendedError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  // Business-existence check lives here (not in the domain layer) — see the
  // module doc comment on featureFlags.ts's assertFlagExists for why: mirrors
  // this same inline 404 pattern already used by GET /businesses/:id above.
  async function requireBusinessExists(businessId: string, res: Response): Promise<boolean> {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      res.status(404).json({ error: "Business not found." });
      return false;
    }
    return true;
  }

  router.get(
    "/businesses/:id/feature-flags",
    requireLegacyAccess("admin:view_orgs"),
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await requireBusinessExists(businessId, res))) return;

      const states = await listFeatureFlagStatesForBusiness(getTenantScopedClient(prisma, businessId), businessId);
      res.json({ featureFlags: states });
    }),
  );

  // Phase 23 gap closure: Phase 22 (Flutterwave payment collection) added the
  // Invoice model but never gave admins any way to see one — the only place
  // an Invoice's existence was observable was the AuditLog rows it produces.
  // Invoice has no businessId column of its own (see schema.prisma's comment
  // on why it isn't tenant-scoped), so it's reached here via its Subscription
  // relation instead, using the raw PrismaClient like every other admin list
  // route above. Read-only: there is deliberately no admin write path for
  // Invoice status — PAID/FAILED is only ever set by confirmSubscriptionPayment
  // (src/domain/payments.ts) reacting to a verified Flutterwave webhook, and
  // letting an admin flip it by hand would let the dashboard silently
  // desynchronize from what Flutterwave actually recorded.
  router.get(
    "/businesses/:id/invoices",
    requireLegacyAccess("admin:view_subscriptions"),
    requireSupportAccess(prisma, "Invoice"),
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await requireBusinessExists(businessId, res))) return;

      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.invoice.findMany({
        where: { subscription: { businessId } },
        orderBy: { createdAt: "desc" },
        take: pagination.take + 1,
        skip: pagination.skip,
        include: { subscription: { select: { planCode: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      // amountMinor is a bigint (Non-Negotiable: money is never a float) — same
      // string-serialization reasoning as GET /mobile-money-alerts above.
      // Phase 6 added two more bigint columns (paidMinor, refundedMinor): serialized the same way.
      const serialized = items.map((item) => ({ ...item, amountMinor: item.amountMinor.toString(), paidMinor: item.paidMinor.toString(), refundedMinor: item.refundedMinor.toString() }));
      res.json({ invoices: serialized, pagination: meta });
    }),
  );

  // Phase 24: same admin-visibility precedent as GET /businesses/:id/invoices
  // above, for the new customer-facing /paylink feature. Unlike Invoice,
  // PaymentRequest carries its own businessId column (it's in
  // tenantScope.ts's TENANT_SCOPED_MODELS), so this filters directly rather
  // than through a relation — but still reads via the raw PrismaClient like
  // every other admin list route, since admin access is deliberately not
  // routed through TenantScopedClient (that type exists to constrain
  // merchant-facing writes to their own business, not admin reads). Read-only
  // for the same reason as Invoice: status is only ever set by
  // confirmPaymentRequestPayment reacting to a verified Flutterwave webhook.
  router.get(
    "/businesses/:id/payment-requests",
    requireLegacyAccess("admin:view_payments"),
    requireSupportAccess(prisma, "PaymentRequest"),
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await requireBusinessExists(businessId, res))) return;

      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.paymentRequest.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: pagination.take + 1,
        skip: pagination.skip,
        include: { customer: { select: { name: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      const serialized = items.map((item) => ({ ...item, amountMinor: item.amountMinor.toString() }));
      res.json({ paymentRequests: serialized, pagination: meta });
    }),
  );

  router.post(
    "/businesses/:id/feature-flags/:key",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:manage_flags"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = setBusinessFeatureFlagBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      const businessId = req.params["id"] as string;
      if (!(await requireBusinessExists(businessId, res))) return;

      try {
        const override = await setFeatureFlagForBusiness(
          getTenantScopedClient(prisma, businessId),
          businessId,
          req.params["key"] as string,
          parsed.data.enabled,
          {
            ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
            ...(req.adminUser ? { changedByAdminUserId: req.adminUser.adminUserId } : {}),
          },
        );
        res.json({ featureFlag: override });
      } catch (error) {
        if (error instanceof ProtectedFlagError) {
          res.status(409).json({ error: error.message, code: "PROTECTED_FLAG" });
          return;
        }
        if (error instanceof FeatureFlagNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    "/businesses/:id/feature-flags/:key/reset",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:manage_flags"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = removeBusinessFeatureFlagOverrideBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      const businessId = req.params["id"] as string;
      if (!(await requireBusinessExists(businessId, res))) return;

      try {
        const removed = await removeFeatureFlagOverrideForBusiness(
          getTenantScopedClient(prisma, businessId),
          businessId,
          req.params["key"] as string,
          {
            ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
            ...(req.adminUser ? { changedByAdminUserId: req.adminUser.adminUserId } : {}),
          },
        );
        res.json({ removed });
      } catch (error) {
        if (error instanceof ProtectedFlagError) {
          res.status(409).json({ error: error.message, code: "PROTECTED_FLAG" });
          return;
        }
        if (error instanceof FeatureFlagNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  // Phase 17 gap closure: a business that enables `stockTracking` after already
  // logging SALE/PURCHASE transactions has a permanent backlog of TransactionItem
  // rows with inventoryItemId: null that never contributed to any InventoryItem's
  // estimatedStockQty — see backfillInventoryLinksForBusiness's own doc comment
  // (src/domain/inventory.ts) for the full rationale. This is admin-triggered
  // (not automatic on the FeatureFlag flip) since retroactively adjusting stock
  // counts is a real decision a business might not want made for them silently.
  // Safe to call repeatedly: the underlying function is naturally idempotent.
  router.post(
    "/businesses/:id/inventory/backfill",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:resolve_support_case"),
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await requireBusinessExists(businessId, res))) return;

      const result = await backfillInventoryLinksForBusiness(getTenantScopedClient(prisma, businessId), businessId);
      await recordPlatformAudit(prisma, {
        adminUserId: (req as AuthenticatedAdminRequest).adminUser!.adminUserId,
        correlationId: correlationIdOf(res),
        action: "admin.inventory.backfill_run",
        entityType: "Business",
        entityId: businessId,
        businessId,
        metadata: { ...result },
      });
      res.json(result);
    }),
  );

  router.post(
    "/merchants/:id/phone-number",
    requireAdminRole("SUPER_ADMIN", "SUPPORT"),
    stepUp("admin:revoke_staff"),
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const parsed = changePhoneNumberBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(res, parsed.error);

      try {
        const merchant = await changeMerchantPhoneNumber(prisma, {
          merchantId: req.params["id"] as string,
          businessId: parsed.data.businessId,
          newPhoneNumber: parsed.data.newPhoneNumber,
          reason: parsed.data.reason,
          ...(req.adminUser ? { changedByAdminUserId: req.adminUser.adminUserId } : {}),
        });
        res.json({ merchant });
      } catch (error) {
        if (error instanceof MerchantNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof PhoneNumberAlreadyRegisteredError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  /**
   * Phase 6: manual trigger for the same sweep the hourly
   * subscription-expiry worker runs (src/subscriptionExpiryWorker.ts) —
   * lets an operator force a lapsed subscription to reflect PAST_DUE right
   * away instead of waiting up to an hour for the next scheduled tick, and
   * gives this codebase's one automated-cron effect a synchronous,
   * test-without-Redis-covered path. SUPER_ADMIN-only: it's a global
   * maintenance action across every business, not a single-business write.
   */
  router.post(
    "/maintenance/expire-subscriptions",
    requireAdminRole("SUPER_ADMIN"),
    stepUp("admin:pause_job_class"),
    asyncHandler(async (_req, res) => {
      const result = await expireLapsedSubscriptions(prisma, new Date(), options.outboundGateway);
      res.json(result);
    }),
  );

  /**
   * Phase 26: manual trigger for the same sweep the hourly
   * payment-request-expiry worker runs (src/paymentRequestExpiryWorker.ts) —
   * same rationale as the /maintenance/expire-subscriptions route directly
   * above: lets an operator force stale PENDING PaymentRequest rows to
   * reflect EXPIRED right away instead of waiting up to an hour, and gives
   * this sweep a synchronous, test-without-Redis-covered path.
   * SUPER_ADMIN-only for the same reason: a global maintenance action across
   * every business, not a single-business write.
   */
  router.post(
    "/maintenance/expire-payment-requests",
    requireAdminRole("SUPER_ADMIN"),
    stepUp("admin:pause_job_class"),
    asyncHandler(async (_req, res) => {
      const result = await expireStalePaymentRequests(prisma);
      res.json(result);
    }),
  );

  return router;
}
