import type { Prisma, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import { correlationIdOf } from "./adminAudit.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { csvNumber, csvRow, csvText } from "./csv.js";
import { paginate, parsePaginationParams } from "./pagination.js";
import { recordPlatformAudit, requirePlatformPermission, requireStepUp } from "./platformGuards.js";
import { DAY_MS, BillingError, getBillingConfig, SWITCH_PROVIDER } from "../domain/subscriptions/common.js";
import { reconcileBilling, refundSubscriptionCharge, applyBillingDeposit } from "../domain/subscriptions/collection.js";
import { KNOWN_FEATURES, createPlanVersion, publishPlanVersion, retirePlanVersion, setPlanPrice } from "../domain/subscriptions/plans.js";


/**
 * Admin: subscriptions panel (expansion Phase 6, section 18). Reads need `admin:view_subscriptions`; every write needs
 * `admin:manage_subscriptions` (owner), step-up when enabled, a reason, and is audited. Deliberately narrow:
 *  - plans are versioned: drafts are edited, a published version is frozen by the database, a new version is the only way to change one;
 *  - a manual entitlement adjustment never edits history: it sets the period and writes an EntitlementEvent naming the admin and reason;
 *  - refunds are for SUBSCRIPTION charges only and go through pawaPay (never merchant money);
 *  - switches stop NEW charges per provider and country; reconciling and servicing existing charges is never affected by them;
 *  - there is no delete anywhere and no "mark paid": an invoice becomes paid only through the provider-evidence path.
 */
const reason = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500);
const EXPORT_CAP = 10_000;
const money = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

export interface AdminSubscriptionsOptions {
  /** Sends a WhatsApp reminder to a business owner about their own subscription (omitted when messaging is not configured). */
  sendReminder?: (toPhoneNumber: string, body: string) => Promise<void>;
  now?: () => Date;
}

type Derived = "ACTIVE" | "GRACE" | "EXPIRED" | "PENDING" | "CANCELLED";
function derive(sub: { status: string; currentPeriodEnd: Date; planVersion?: { graceDays: number } | null }, now: Date): Derived {
  if (sub.status === "PENDING") return "PENDING";
  if (sub.status === "CANCELED") return "CANCELLED";
  const graceEnd = new Date(sub.currentPeriodEnd.getTime() + (sub.planVersion?.graceDays ?? 3) * DAY_MS);
  return now < sub.currentPeriodEnd ? "ACTIVE" : now < graceEnd ? "GRACE" : "EXPIRED";
}

export function createAdminSubscriptionsRouter(prisma: PrismaClient, jwtSecret: string, options: AdminSubscriptionsOptions = {}): Router {
  const router = Router();
  const clock = options.now ?? (() => new Date());
  const adminId = (req: unknown) => (req as AuthenticatedAdminRequest).adminUser!.adminUserId;
  const view = requirePlatformPermission("admin:view_subscriptions");
  const manage = [requirePlatformPermission("admin:manage_subscriptions"), requireStepUp(prisma, jwtSecret, "admin:manage_subscriptions")];
  const resolveW = [requirePlatformPermission("admin:resolve_exception"), requireStepUp(prisma, jwtSecret, "admin:resolve_exception")];
  const fail = (res: import("express").Response, error: unknown) => {
    if (error instanceof BillingError) return void res.status(error.code === "NOT_FOUND" ? 404 : error.code === "INVALID" || error.code === "REFUND_LIMIT" ? 400 : 409).json({ error: error.message, code: error.code });
    throw error;
  };

  // ------------------------------------------------------------------------------------ reads

  router.get("/subscriptions/overview", view, asyncHandler(async (_req, res) => {
    const now = clock();
    const subs = await prisma.subscription.findMany({ where: { status: { in: ["ACTIVE", "PAST_DUE", "PENDING", "CANCELED"] } }, select: { status: true, currentPeriodEnd: true, planVersion: { select: { graceDays: true } } }, take: 5_000 });
    const states: Record<string, number> = {};
    for (const s of subs) states[derive(s, now)] = (states[derive(s, now)] ?? 0) + 1;
    const invoices = await prisma.invoice.groupBy({ by: ["status"], where: { purpose: "PLATFORM_SUBSCRIPTION", providerCode: "PAWAPAY" }, _count: { _all: true } });
    const attempts = await prisma.billingAttempt.groupBy({ by: ["status"], _count: { _all: true } });
    const exceptions = await prisma.billingException.groupBy({ by: ["type"], where: { status: "OPEN" }, _count: { _all: true } });
    const refunds = await prisma.billingRefund.groupBy({ by: ["status"], _count: { _all: true } });
    const switches = await prisma.billingSwitch.findMany({ orderBy: [{ provider: "asc" }, { countryCode: "asc" }] });
    const authFailures24h = await prisma.billingException.count({ where: { type: "CALLBACK_AUTH_FAILED", createdAt: { gte: new Date(now.getTime() - DAY_MS) } } });
    const cfg = getBillingConfig();
    res.json({
      states, invoices: Object.fromEntries(invoices.map((g) => [g.status, g._count._all])), attempts: Object.fromEntries(attempts.map((g) => [g.status, g._count._all])),
      openExceptions: Object.fromEntries(exceptions.map((g) => [g.type, g._count._all])), refunds: Object.fromEntries(refunds.map((g) => [g.status, g._count._all])),
      callbackAuthFailuresLast24h: authFailures24h,
      switches: switches.map((s) => ({ id: s.id, provider: s.provider, countryCode: s.countryCode, purpose: s.purpose, newAttemptsEnabled: s.newAttemptsEnabled, reason: s.reason, updatedAt: s.updatedAt })),
      configuration: cfg.ok ? { configured: true, environment: cfg.config.environment, requireSignedCallbacks: cfg.config.requireSignedCallbacks, productionActivated: cfg.config.productionActivated } : { configured: false, reason: cfg.reason },
      generatedAt: now,
    });
  }));

  router.get("/subscriptions", view, asyncHandler(async (req, res) => {
    const now = clock();
    const q = req.query as Record<string, unknown>;
    const pagination = parsePaginationParams(q);
    const where: Prisma.SubscriptionWhereInput = typeof q["businessId"] === "string" ? { businessId: q["businessId"] } : {};
    const rows = await prisma.subscription.findMany({ where, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip, include: { business: { select: { name: true, countryCode: true, status: true } }, planVersion: { select: { version: true, graceDays: true } } } });
    const { items, pagination: meta } = paginate(rows, pagination);
    const stateFilter = typeof q["state"] === "string" ? q["state"] : "";
    const mapped = items.map((s) => ({
      id: s.id, businessId: s.businessId, business: s.business.name, country: s.business.countryCode, securitySuspended: s.business.status === "SUSPENDED", planCode: s.planCode, planVersion: s.planVersion?.version ?? null,
      status: s.status, state: derive(s, now), currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, pendingPlanVersionId: s.pendingPlanVersionId, createdAt: s.createdAt,
    }));
    res.json({ subscriptions: stateFilter ? mapped.filter((s) => s.state === stateFilter) : mapped, pagination: meta });
  }));

  router.get("/subscriptions/exceptions", view, asyncHandler(async (req, res) => {
    const status = req.query["status"] === "RESOLVED" ? "RESOLVED" : "OPEN";
    const rows = await prisma.billingException.findMany({ where: { status }, orderBy: { createdAt: "desc" }, take: 100 });
    const names = new Map((await prisma.business.findMany({ where: { id: { in: rows.map((r) => r.businessId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    res.json({ exceptions: rows.map((e) => ({ id: e.id, type: e.type, status: e.status, business: e.businessId ? names.get(e.businessId) ?? null : null, businessId: e.businessId, attemptId: e.attemptId, invoiceId: e.invoiceId, amountMinor: money(e.amountMinor), details: e.details, resolution: e.resolution, createdAt: e.createdAt })) });
  }));

  router.get("/subscriptions/invoices", view, asyncHandler(async (req, res) => {
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    const rows = await prisma.invoice.findMany({
      where: { purpose: "PLATFORM_SUBSCRIPTION", ...(status ? { status } : {}), ...(typeof req.query["businessId"] === "string" ? { subscription: { businessId: req.query["businessId"] } } : {}) },
      orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip, include: { subscription: { select: { businessId: true, business: { select: { name: true } } } } },
    });
    const { items, pagination: meta } = paginate(rows, pagination);
    res.json({
      invoices: items.map((i) => ({ id: i.id, reference: i.reference, business: i.subscription.business.name, businessId: i.subscription.businessId, kind: i.kind, status: i.status, amountMinor: money(i.amountMinor), paidMinor: money(i.paidMinor), refundedMinor: money(i.refundedMinor), currencyCode: i.currencyCode, provider: i.providerCode, dueDate: i.dueDate, paidAt: i.paidAt, periodStart: i.periodStart, periodEnd: i.periodEnd, createdAt: i.createdAt })),
      pagination: meta,
    });
  }));

  router.get("/subscriptions/invoices.csv", view, asyncHandler(async (req, res) => {
    const admin = (req as AuthenticatedAdminRequest).adminUser!;
    const rows = await prisma.invoice.findMany({ where: { purpose: "PLATFORM_SUBSCRIPTION" }, orderBy: { createdAt: "asc" }, take: EXPORT_CAP + 1, include: { subscription: { select: { businessId: true, business: { select: { name: true } } } } } });
    const truncated = rows.length > EXPORT_CAP;
    const out = rows.slice(0, EXPORT_CAP);
    const lines = [
      csvRow(["reference", "business_id", "business", "kind", "status", "amount_minor", "paid_minor", "refunded_minor", "currency", "provider", "due", "paid_at", "period_start", "period_end"].map(csvText)),
      ...out.map((i) => csvRow([
        csvText(i.reference ?? i.id), csvText(i.subscription.businessId), csvText(i.subscription.business.name), csvText(i.kind ?? ""), csvText(i.status), csvNumber(i.amountMinor), csvNumber(i.paidMinor), csvNumber(i.refundedMinor),
        csvText(i.currencyCode), csvText(i.providerCode ?? ""), csvText(i.dueDate.toISOString()), csvText(i.paidAt?.toISOString() ?? ""), csvText(i.periodStart?.toISOString() ?? ""), csvText(i.periodEnd?.toISOString() ?? ""),
      ])),
    ];
    await recordPlatformAudit(prisma, { adminUserId: admin.adminUserId, action: "admin.subscriptions.exported", entityType: "Invoice", correlationId: correlationIdOf(res), metadata: { rows: out.length, truncated } });
    res.status(200).set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", 'attachment; filename="subscription-invoices.csv"').set("X-Export-Truncated", truncated ? "true" : "false").send(lines.join("\r\n") + "\r\n");
  }));

  router.get("/subscriptions/:id", view, asyncHandler(async (req, res) => {
    const now = clock();
    const s = await prisma.subscription.findUnique({ where: { id: req.params["id"] as string }, include: { business: { select: { name: true, countryCode: true, status: true } }, planVersion: true, invoices: { orderBy: { createdAt: "desc" }, take: 20 } } });
    if (!s) return void res.status(404).json({ error: "Subscription not found." });
    const events = await prisma.entitlementEvent.findMany({ where: { subscriptionId: s.id }, orderBy: { createdAt: "desc" }, take: 50 });
    const attempts = await prisma.billingAttempt.findMany({ where: { invoiceId: { in: s.invoices.map((i) => i.id) } }, orderBy: { createdAt: "desc" }, take: 50 });
    const refunds = await prisma.billingRefund.findMany({ where: { invoiceId: { in: s.invoices.map((i) => i.id) } }, orderBy: { createdAt: "desc" }, take: 50 });
    res.json({
      id: s.id, business: s.business.name, businessId: s.businessId, country: s.business.countryCode, securitySuspended: s.business.status === "SUSPENDED", planCode: s.planCode, planVersion: s.planVersion ? { id: s.planVersion.id, version: s.planVersion.version, graceDays: s.planVersion.graceDays, billingPeriodDays: s.planVersion.billingPeriodDays, features: s.planVersion.features } : null,
      status: s.status, state: derive(s, now), currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      invoices: s.invoices.map((i) => ({ id: i.id, reference: i.reference, status: i.status, amountMinor: money(i.amountMinor), paidMinor: money(i.paidMinor), refundedMinor: money(i.refundedMinor), currencyCode: i.currencyCode, provider: i.providerCode, createdAt: i.createdAt })),
      attempts: attempts.map((a) => ({ id: a.id, invoiceId: a.invoiceId, status: a.status, providerCode: a.providerCode, environment: a.environment, amountMinor: money(a.amountMinor), capturedMinor: money(a.capturedMinor), payerPhoneLast4: a.payerPhoneLast4, failureCode: a.failureCode, createdAt: a.createdAt })),
      refunds: refunds.map((r) => ({ id: r.id, invoiceId: r.invoiceId, amountMinor: money(r.amountMinor), status: r.status, reason: r.reason, adminUserId: r.adminUserId, createdAt: r.createdAt })),
      history: events.map((e) => ({ id: e.id, kind: e.kind, from: e.fromPlanCode, to: e.toPlanCode, periodStart: e.periodStart, periodEnd: e.periodEnd, source: e.source, adminUserId: e.adminUserId, reason: e.reason, at: e.createdAt })),
    });
  }));

  router.get("/plan-versions", view, asyncHandler(async (_req, res) => {
    const rows = await prisma.planVersion.findMany({ orderBy: [{ planCode: "asc" }, { version: "desc" }], include: { prices: true, _count: { select: { subscriptions: true } } } });
    res.json({
      knownFeatures: KNOWN_FEATURES,
      versions: rows.map((v) => ({
        id: v.id, planCode: v.planCode, version: v.version, status: v.status, billingPeriodDays: v.billingPeriodDays, graceDays: v.graceDays, features: v.features, note: v.note, publishedAt: v.publishedAt, retiredAt: v.retiredAt, subscribers: v._count.subscriptions,
        prices: v.prices.map((p) => ({ countryCode: p.countryCode, currencyCode: p.currencyCode, priceMinor: money(p.priceMinor) })),
      })),
    });
  }));

  // ------------------------------------------------------------------------------------ writes

  const versionBody = z.object({
    features: z.array(z.string()).max(20).optional(), billingPeriodDays: z.number().int().optional(), graceDays: z.number().int().optional(),
    entryCapPerMonth: z.number().int().min(0).nullable().optional(), voiceEnabled: z.boolean().optional(), staffCapCount: z.number().int().min(0).nullable().optional(), note: z.string().max(300).optional(), reason,
  });
  router.post("/plan-versions/:planCode", ...manage, asyncHandler(async (req, res) => {
    const p = versionBody.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      const { reason: _r, ...rest } = p.data;
      void _r;
      const v = await createPlanVersion(prisma, { planCode: req.params["planCode"] as string, ...rest, createdBy: adminId(req) });
      res.status(201).json({ id: v.id, version: v.version, status: v.status });
    } catch (e) { fail(res, e); }
  }));

  router.put("/plan-versions/:id/prices", ...manage, asyncHandler(async (req, res) => {
    const p = z.object({ countryCode: z.string().length(2), priceMinor: z.string().regex(/^[1-9]\d{0,15}$/), reason }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      const price = await setPlanPrice(prisma, { planVersionId: req.params["id"] as string, countryCode: p.data.countryCode, priceMinor: BigInt(p.data.priceMinor) });
      res.json({ countryCode: price.countryCode, currencyCode: price.currencyCode, priceMinor: price.priceMinor.toString() });
    } catch (e) { fail(res, e); }
  }));

  router.post("/plan-versions/:id/publish", ...manage, asyncHandler(async (req, res) => {
    if (!z.object({ reason }).safeParse(req.body).success) return void res.status(400).json({ error: "Give a reason of at least 10 characters." });
    try { res.json({ status: (await publishPlanVersion(prisma, req.params["id"] as string)).status }); } catch (e) { fail(res, e); }
  }));

  router.post("/plan-versions/:id/retire", ...manage, asyncHandler(async (req, res) => {
    if (!z.object({ reason }).safeParse(req.body).success) return void res.status(400).json({ error: "Give a reason of at least 10 characters." });
    try { await retirePlanVersion(prisma, req.params["id"] as string); res.json({ status: "RETIRED" }); } catch (e) { fail(res, e); }
  }));

  /** Manual entitlement adjustment: sets the paid-through date (and optionally the plan version), writes an event naming the admin and reason. Never edits history. */
  router.post("/subscriptions/:id/adjust", ...manage, asyncHandler(async (req, res) => {
    const p = z.object({ periodEnd: z.string().datetime(), planVersionId: z.string().min(1).max(60).optional(), reason }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    const now = clock();
    const end = new Date(p.data.periodEnd);
    if (Math.abs(end.getTime() - now.getTime()) > 366 * DAY_MS) return void res.status(400).json({ error: "The new date must be within a year of today.", code: "INVALID" });
    const sub = await prisma.subscription.findUnique({ where: { id: req.params["id"] as string } });
    if (!sub) return void res.status(404).json({ error: "Subscription not found." });
    let version = null;
    if (p.data.planVersionId) {
      version = await prisma.planVersion.findUnique({ where: { id: p.data.planVersionId } });
      if (!version || version.status === "DRAFT") return void res.status(400).json({ error: "Choose a published plan version.", code: "INVALID" });
    }
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { currentPeriodEnd: end, status: end > now ? "ACTIVE" : sub.status === "PENDING" ? "PENDING" : "PAST_DUE", ...(sub.status === "PENDING" && end > now ? { currentPeriodStart: now } : {}), ...(version ? { planCode: version.planCode, planVersionId: version.id } : {}) },
    });
    await prisma.entitlementEvent.create({ data: { businessId: sub.businessId, subscriptionId: sub.id, kind: "MANUAL_ADJUSTMENT", fromPlanCode: sub.planCode, toPlanCode: version?.planCode ?? sub.planCode, periodEnd: end, source: "ADMIN", adminUserId: adminId(req), reason: p.data.reason } });
    res.json({ id: sub.id, currentPeriodEnd: end });
  }));

  router.post("/invoices/:id/refund", ...manage, asyncHandler(async (req, res) => {
    const p = z.object({ amountMinor: z.string().regex(/^[1-9]\d{0,15}$/).optional(), reason, revokeEntitlement: z.boolean().optional() }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      const r = await refundSubscriptionCharge(prisma, { invoiceId: req.params["id"] as string, ...(p.data.amountMinor ? { amountMinor: BigInt(p.data.amountMinor) } : {}), reason: p.data.reason, adminUserId: adminId(req), ...(p.data.revokeEntitlement ? { revokeEntitlement: true } : {}) });
      res.status(202).json({ refundId: r.id, status: r.status });
    } catch (e) { fail(res, e); }
  }));

  router.put("/billing-switches", ...manage, asyncHandler(async (req, res) => {
    const p = z.object({ provider: z.literal(SWITCH_PROVIDER), countryCode: z.string().length(2), newAttemptsEnabled: z.boolean(), reason }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    if (!(await prisma.country.findUnique({ where: { code: p.data.countryCode } }))) return void res.status(404).json({ error: "Country not found." });
    const s = await prisma.billingSwitch.upsert({
      where: { provider_countryCode_purpose: { provider: p.data.provider, countryCode: p.data.countryCode, purpose: "PLATFORM_SUBSCRIPTION" } },
      update: { newAttemptsEnabled: p.data.newAttemptsEnabled, reason: p.data.reason, updatedBy: adminId(req) }, create: { provider: p.data.provider, countryCode: p.data.countryCode, newAttemptsEnabled: p.data.newAttemptsEnabled, reason: p.data.reason, updatedBy: adminId(req) },
    });
    res.json({ provider: s.provider, countryCode: s.countryCode, purpose: s.purpose, newAttemptsEnabled: s.newAttemptsEnabled });
  }));

  router.post("/subscriptions/exceptions/:id/resolve", ...resolveW, asyncHandler(async (req, res) => {
    const p = z.object({ outcome: z.enum(["NO_ACTION_NEEDED", "REFUNDED", "SETTLED_OFFLINE", "CONTACTED_MERCHANT", "ESCALATED_TO_PROVIDER"]), note: reason }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    const done = await prisma.billingException.updateMany({ where: { id: req.params["id"] as string, status: "OPEN" }, data: { status: "RESOLVED", resolution: `${p.data.outcome}: ${p.data.note}`.slice(0, 500), resolvedBy: adminId(req), resolvedAt: clock() } });
    if (done.count !== 1) {
      const exists = await prisma.billingException.findUnique({ where: { id: req.params["id"] as string }, select: { id: true } });
      return void res.status(exists ? 409 : 404).json({ error: exists ? "That exception is already resolved." : "Exception not found." });
    }
    res.json({ resolved: true });
  }));

  /** Looks at one charge at pawaPay (authenticated) and applies the answer. The only way an admin can cause money to be applied: by asking the provider. */
  router.post("/subscriptions/attempts/:id/refresh", ...resolveW, asyncHandler(async (req, res) => {
    const cfg = getBillingConfig();
    if (!cfg.ok) return void res.status(409).json({ error: "pawaPay is not configured here.", code: "NOT_CONFIGURED" });
    res.json({ outcome: await applyBillingDeposit(prisma, cfg.config, req.params["id"] as string, "ADMIN", clock()) });
  }));

  router.post("/subscriptions/reconcile", ...resolveW, asyncHandler(async (_req, res) => {
    res.json(await reconcileBilling(prisma, clock()));
  }));

  /** Sends the owner a plain reminder about their own subscription (no link: renewal is a PIN prompt started by the owner with /renew). */
  router.post("/subscriptions/:id/remind", ...manage, asyncHandler(async (req, res) => {
    if (!z.object({ reason }).safeParse(req.body).success) return void res.status(400).json({ error: "Give a reason of at least 10 characters." });
    if (!options.sendReminder) return void res.status(409).json({ error: "Messaging is not configured on this server.", code: "NOT_CONFIGURED" });
    const sub = await prisma.subscription.findUnique({ where: { id: req.params["id"] as string }, include: { business: true } });
    if (!sub) return void res.status(404).json({ error: "Subscription not found." });
    const owner = await prisma.merchant.findFirst({ where: { businessId: sub.businessId, role: "OWNER", removedAt: null } });
    if (!owner) return void res.status(409).json({ error: "This business has no active owner to message." });
    const state = derive(sub, clock());
    const body = state === "ACTIVE" ? `Your TradePal ${sub.planCode} plan is active until ${sub.currentPeriodEnd.toISOString().slice(0, 10)}. You can renew with /renew when you are ready.` : `Your TradePal ${sub.planCode} plan has ended. Renew any time with /renew to continue. Your records are safe.`;
    await options.sendReminder(owner.phoneNumber, body);
    res.json({ sent: true });
  }));

  return router;
}
