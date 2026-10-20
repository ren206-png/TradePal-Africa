import type { Prisma, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { paginate, parsePaginationParams } from "./pagination.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";
import { replayDeadCallback, getInboxStats } from "../domain/callbackInbox.js";
import { PaymentsError } from "../domain/merchantPayments/common.js";
import { registerConnection } from "../domain/merchantPayments/intents.js";
import { closeAttemptAfterCheck, refreshAttempt } from "../domain/merchantPayments/outcomes.js";
import { retryFailedRefund } from "../domain/merchantPayments/refunds.js";
import { getAdapterRegistry } from "../payments/registry.js";
import { CapabilityError } from "../payments/adapter.js";
import { PaymentPurposeForbiddenError } from "../domain/paymentPurpose.js";

/**
 * Admin: merchant payments and exceptions (expansion Phase 5, section 18). Reads need `admin:view_payments`. Writes are audited,
 * need step-up when enabled, and are deliberately narrow:
 *  - an attempt can be refreshed (an authenticated status check) or closed ONLY after the provider confirms it did not collect;
 *  - a provider exception is resolved with a documented outcome and note (the console never moves money itself);
 *  - a failed refund can be retried through the same provider; a dead callback can be replayed;
 *  - connecting a merchant to a provider records an arrangement and a destination, and never accepts a secret.
 * There is no delete and no "mark paid" anywhere: money becomes applied only through the provider-evidence path.
 */
const reason = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500);
const resolveBody = z.object({ outcome: z.enum(["NO_ACTION_NEEDED", "CORRECTED_BY_PROVIDER", "SETTLED_OFFLINE", "REFUNDED_OFFLINE", "CONTACTED_PARTIES", "ESCALATED_TO_PROVIDER"]), note: reason });
const closeBody = z.object({ as: z.enum(["FAILED", "CANCELLED"]), reason });
const connBody = z.object({
  provider: z.string().trim().min(2).max(30), arrangementRef: z.string().trim().min(1).max(100), destinationKey: z.string().trim().min(1).max(100), destinationLabel: z.string().trim().min(1).max(100),
  credentialRef: z.string().trim().max(60).optional(), reason,
});

export function createAdminPaymentsRouter(prisma: PrismaClient, jwtSecret: string): Router {
  const router = Router();
  const adminId = (req: unknown) => (req as AuthenticatedAdminRequest).adminUser!.adminUserId;
  const view = requirePlatformPermission("admin:view_payments");
  const writes = [requirePlatformPermission("admin:resolve_exception"), requireStepUp(prisma, jwtSecret, "admin:resolve_exception")];
  const money = (v: bigint | null) => (v === null ? null : v.toString());

  router.get("/payments/overview", view, asyncHandler(async (_req, res) => {
    const now = new Date();
    const intents = await prisma.paymentIntent.groupBy({ by: ["status"], _count: { _all: true } });
    const attempts = await prisma.paymentAttempt.groupBy({ by: ["status"], _count: { _all: true } });
    const providerEx = await prisma.providerException.groupBy({ by: ["type"], where: { status: "OPEN" }, _count: { _all: true } });
    const storeEx = await prisma.paymentException.groupBy({ by: ["type"], where: { status: "OPEN" }, _count: { _all: true } });
    const refunds = await prisma.providerRefund.groupBy({ by: ["status"], _count: { _all: true } });
    const unsettled = await prisma.paymentAttempt.groupBy({ by: ["currencyCode"], where: { status: "SUCCEEDED", settledAt: null }, _sum: { capturedMinor: true } });
    const connections = await prisma.providerConnection.findMany({ select: { id: true, provider: true, status: true, consecutiveFailures: true, openUntil: true, lastFailureAt: true, lastSuccessAt: true, business: { select: { name: true } } }, take: 100 });
    res.json({
      intents: Object.fromEntries(intents.map((g) => [g.status, g._count._all])),
      attempts: Object.fromEntries(attempts.map((g) => [g.status, g._count._all])),
      openProviderExceptions: Object.fromEntries(providerEx.map((g) => [g.type, g._count._all])),
      openStorePaymentExceptions: Object.fromEntries(storeEx.map((g) => [g.type, g._count._all])),
      refunds: Object.fromEntries(refunds.map((g) => [g.status, g._count._all])),
      collectedNotSettled: unsettled.map((g) => ({ currencyCode: g.currencyCode, amountMinor: money(g._sum.capturedMinor ?? 0n) })),
      callbacks: await getInboxStats(prisma, now),
      providers: getAdapterRegistry(prisma).ids(),
      connections: connections.map((c) => ({ id: c.id, business: c.business.name, provider: c.provider, status: c.status, consecutiveFailures: c.consecutiveFailures, circuitOpen: c.openUntil !== null && c.openUntil > now, lastFailureAt: c.lastFailureAt, lastSuccessAt: c.lastSuccessAt })),
      generatedAt: now,
    });
  }));

  router.get("/payments/attempts", view, asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const statuses = ["CREATED", "PENDING", "SUCCEEDED", "FAILED", "EXPIRED", "UNKNOWN", "CANCELLED"] as const;
    const status = statuses.find((x) => x === q["status"]);
    const where: Prisma.PaymentAttemptWhereInput = { ...(status ? { status } : q["status"] === "unresolved" ? { status: { in: ["CREATED", "PENDING", "UNKNOWN"] } } : {}), ...(typeof q["businessId"] === "string" ? { businessId: q["businessId"] } : {}) };
    const pagination = parsePaginationParams(q);
    const rows = await prisma.paymentAttempt.findMany({ where, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip, include: { business: { select: { name: true } }, intent: { select: { reference: true, subjectType: true, status: true } } } });
    const { items, pagination: meta } = paginate(rows, pagination);
    res.json({
      attempts: items.map((a) => ({
        id: a.id, business: a.business.name, businessId: a.businessId, provider: a.provider, reference: a.intent.reference, subjectType: a.intent.subjectType, intentStatus: a.intent.status, status: a.status,
        amountMinor: money(a.amountMinor), capturedMinor: money(a.capturedMinor), refundedMinor: money(a.refundedMinor), currencyCode: a.currencyCode, pollCount: a.pollCount, nextPollAt: a.nextPollAt, settledAt: a.settledAt, createdAt: a.createdAt,
      })),
      pagination: meta,
    });
  }));

  router.get("/payments/attempts/:id", view, asyncHandler(async (req, res) => {
    const a = await prisma.paymentAttempt.findUnique({ where: { id: req.params["id"] as string }, include: { business: { select: { name: true } }, intent: true, events: { orderBy: { createdAt: "asc" } }, allocation: true, refunds: true } });
    if (!a) return void res.status(404).json({ error: "Attempt not found." });
    res.json({
      id: a.id, business: a.business.name, provider: a.provider, externalRef: a.externalRef, status: a.status, failureReason: a.failureReason, amountMinor: money(a.amountMinor), capturedMinor: money(a.capturedMinor), refundedMinor: money(a.refundedMinor), feeMinor: money(a.feeMinor), currencyCode: a.currencyCode,
      intent: { id: a.intent.id, reference: a.intent.reference, subjectType: a.intent.subjectType, status: a.intent.status, amountMinor: money(a.intent.amountMinor), paidMinor: money(a.intent.paidMinor), refundedMinor: money(a.intent.refundedMinor) },
      allocation: a.allocation ? { state: a.allocation.state, amountMinor: money(a.allocation.amountMinor), subjectType: a.allocation.subjectType } : null,
      history: a.events.map((e) => ({ at: e.createdAt, from: e.fromStatus, to: e.toStatus, source: e.source, detail: e.detail })),
      refunds: a.refunds.map((r) => ({ id: r.id, amountMinor: money(r.amountMinor), status: r.status, reason: r.reason, failureReason: r.failureReason, createdAt: r.createdAt })),
    });
  }));

  router.get("/payments/exceptions", view, asyncHandler(async (req, res) => {
    const resolved = req.query["status"] === "RESOLVED";
    const status = resolved ? "RESOLVED" : "OPEN";
    const provider = await prisma.providerException.findMany({ where: { status }, orderBy: { createdAt: "desc" }, take: 100 });
    const store = await prisma.paymentException.findMany({ where: { status }, orderBy: { createdAt: "desc" }, take: 100, include: { business: { select: { name: true } }, order: { select: { reference: true, status: true } } } });
    const names = new Map((await prisma.business.findMany({ where: { id: { in: provider.map((p) => p.businessId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    const rows = [
      ...provider.map((e) => ({ id: e.id, source: "PROVIDER" as const, type: e.type, status: e.status, business: e.businessId ? names.get(e.businessId) ?? null : null, businessId: e.businessId, reference: null as string | null, amountMinor: money(e.amountMinor), currencyCode: e.currencyCode, details: e.details, resolution: e.resolution, createdAt: e.createdAt })),
      ...store.map((e) => ({ id: e.id, source: "STORE_ORDER" as const, type: e.type, status: e.status, business: e.business.name, businessId: e.businessId, reference: e.order.reference, amountMinor: money(e.amountMinor), currencyCode: null as string | null, details: e.details, resolution: e.resolution, createdAt: e.createdAt })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json({ exceptions: rows });
  }));

  router.get("/payments/refunds", view, asyncHandler(async (req, res) => {
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    const rows = await prisma.providerRefund.findMany({ orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip, include: { business: { select: { name: true } }, intent: { select: { reference: true } } } });
    const { items, pagination: meta } = paginate(rows, pagination);
    res.json({ refunds: items.map((r) => ({ id: r.id, business: r.business.name, reference: r.intent.reference, amountMinor: money(r.amountMinor), status: r.status, reason: r.reason, failureReason: r.failureReason, createdAt: r.createdAt })), pagination: meta });
  }));

  router.get("/payments/settlements", view, asyncHandler(async (req, res) => {
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    const rows = await prisma.providerSettlement.findMany({ orderBy: { settledAt: "desc" }, take: pagination.take + 1, skip: pagination.skip, include: { business: { select: { name: true } }, lines: { select: { id: true } } } });
    const { items, pagination: meta } = paginate(rows, pagination);
    res.json({ settlements: items.map((s) => ({ id: s.id, business: s.business.name, provider: s.provider, reference: s.reference, grossMinor: money(s.grossMinor), feeMinor: money(s.feeMinor), netMinor: money(s.netMinor), currencyCode: s.currencyCode, settledAt: s.settledAt, evidence: s.evidence, payments: s.lines.length })), pagination: meta });
  }));

  router.get("/payments/callbacks", view, asyncHandler(async (_req, res) => {
    const dead = await prisma.callbackInbox.findMany({ where: { status: "DEAD" }, orderBy: { receivedAt: "desc" }, take: 50, select: { id: true, provider: true, externalId: true, attempts: true, lastError: true, receivedAt: true } });
    res.json({ stats: await getInboxStats(prisma, new Date()), dead });
  }));

  // ---- writes
  router.post("/payments/attempts/:id/refresh", ...writes, asyncHandler(async (req, res) => {
    try {
      const r = await refreshAttempt(prisma, getAdapterRegistry(prisma), req.params["id"] as string, "ADMIN", new Date(), adminId(req));
      res.json({ outcome: r.outcome.result, providerStatus: r.snapshot?.status ?? null });
    } catch (error) {
      if (error instanceof PaymentsError) return void res.status(error.code === "NOT_FOUND" ? 404 : 409).json({ error: error.message, code: error.code });
      throw error;
    }
  }));

  router.post("/payments/attempts/:id/close", ...writes, asyncHandler(async (req, res) => {
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    try {
      const r = await closeAttemptAfterCheck(prisma, getAdapterRegistry(prisma), { attemptId: req.params["id"] as string, as: parsed.data.as, adminUserId: adminId(req), reason: parsed.data.reason });
      if (!r.closed) return void res.status(409).json({ error: `The provider says this payment was collected (${r.providerSays}); it has been applied instead of closed.`, providerSays: r.providerSays });
      res.json({ closed: true, providerSays: r.providerSays });
    } catch (error) {
      if (error instanceof PaymentsError) return void res.status(error.code === "NOT_FOUND" ? 404 : 409).json({ error: error.message, code: error.code });
      throw error;
    }
  }));

  router.post("/payments/exceptions/:id/resolve", ...writes, asyncHandler(async (req, res) => {
    const parsed = resolveBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const done = await prisma.providerException.updateMany({ where: { id: req.params["id"] as string, status: "OPEN" }, data: { status: "RESOLVED", resolution: `${parsed.data.outcome}: ${parsed.data.note}`.slice(0, 500), resolvedBy: adminId(req), resolvedAt: new Date() } });
    if (done.count !== 1) {
      const exists = await prisma.providerException.findUnique({ where: { id: req.params["id"] as string }, select: { id: true } });
      return void res.status(exists ? 409 : 404).json({ error: exists ? "That exception is already resolved." : "Exception not found." });
    }
    res.json({ resolved: true });
  }));

  router.post("/payments/refunds/:id/retry", ...writes, asyncHandler(async (req, res) => {
    try {
      const r = await retryFailedRefund(prisma, getAdapterRegistry(prisma), { refundId: req.params["id"] as string, actor: `admin:${adminId(req)}` });
      res.json({ refundId: r.refund.id, status: r.refund.status });
    } catch (error) {
      if (error instanceof PaymentsError) return void res.status(error.code === "NOT_FOUND" ? 404 : 409).json({ error: error.message, code: error.code });
      if (error instanceof CapabilityError) return void res.status(409).json({ error: error.message, code: error.code });
      throw error;
    }
  }));

  router.post("/payments/callbacks/:id/replay", requirePlatformPermission("admin:replay_dead_letter"), requireStepUp(prisma, jwtSecret, "admin:replay_dead_letter"), asyncHandler(async (req, res) => {
    try {
      const r = await replayDeadCallback(prisma, req.params["id"] as string);
      res.json({ id: r.id, status: r.status });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Could not replay." });
    }
  }));

  // ---- connections
  router.get("/businesses/:id/payment-connections", view, asyncHandler(async (req, res) => {
    const rows = await prisma.providerConnection.findMany({ where: { businessId: req.params["id"] as string }, orderBy: { createdAt: "asc" } });
    res.json({ connections: rows.map((c) => ({ id: c.id, provider: c.provider, status: c.status, arrangementRef: c.arrangementRef, destinationLabel: c.destinationLabel, credentialRef: c.credentialRef, consecutiveFailures: c.consecutiveFailures, circuitOpen: c.openUntil !== null && c.openUntil > new Date(), createdAt: c.createdAt })) });
  }));

  router.post("/businesses/:id/payment-connections", requirePlatformPermission("admin:manage_payment_connections"), requireStepUp(prisma, jwtSecret, "admin:manage_payment_connections"), asyncHandler(async (req, res) => {
    const parsed = connBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    if (!(await prisma.business.findUnique({ where: { id: req.params["id"] as string }, select: { id: true } }))) return void res.status(404).json({ error: "Business not found." });
    try {
      const { reason: _r, ...rest } = parsed.data;
      void _r;
      const { credentialRef, ...fields } = rest;
      const c = await registerConnection(prisma, { businessId: req.params["id"] as string, ...fields, ...(credentialRef ? { credentialRef } : {}), createdBy: adminId(req) });
      res.status(201).json({ id: c.id, provider: c.provider });
    } catch (error) {
      if (error instanceof PaymentPurposeForbiddenError) return void res.status(409).json({ error: "That provider is not permitted for merchant sales.", code: "PURPOSE_FORBIDDEN" });
      if (error instanceof PaymentsError) return void res.status(error.code === "DUPLICATE" ? 409 : 400).json({ error: error.message, code: error.code });
      throw error;
    }
  }));

  router.post("/payment-connections/:id/disable", requirePlatformPermission("admin:manage_payment_connections"), requireStepUp(prisma, jwtSecret, "admin:manage_payment_connections"), asyncHandler(async (req, res) => {
    const parsed = z.object({ reason }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const r = await prisma.providerConnection.updateMany({ where: { id: req.params["id"] as string, status: "ACTIVE" }, data: { status: "DISABLED" } });
    if (r.count !== 1) return void res.status(404).json({ error: "No active connection with that id." });
    res.json({ disabled: true });
  }));

  return router;
}
