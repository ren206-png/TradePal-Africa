import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import { requireRecentReauth, type AuthenticatedAdminRequest } from "./authMiddleware.js";
import { correlationIdOf } from "./adminAudit.js";
import { DEFAULT_SESSION_POLICY, refundExecutionEnabled, type AdminSessionPolicy } from "./adminConfig.js";
import { revalidateActor } from "./actorRevalidation.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";
import { parsePaginationParams, paginate } from "./pagination.js";
import { refundHeldBillingPayment, refundSubscriptionCharge } from "../domain/subscriptions/collection.js";
import type { PlatformPermission } from "../auth/permissions.js";

/**
 * Refunds under the two-person rule (admin-console Phase 3), for TradePal SUBSCRIPTION charges only (merchant sales refunds are the
 * merchant's own and never go through here).
 *
 *   1. someone with `admin:request_refund` opens a request: the action and every parameter are FROZEN and hashed;
 *   2. a DIFFERENT person with `admin:approve_refund` approves exactly that hash (a changed request needs a new one; the database refuses
 *      self-approval and any edit of the frozen fields);
 *   3. a person with `admin:execute_refund` runs it, and only while ADMIN_REFUND_EXECUTION_ENABLED=true. Otherwise it stays approved and
 *      NOTHING is sent to the payment provider.
 *
 * Execution re-checks the actor's account, role and permission at that moment, re-derives the hash from the stored payload, and calls the
 * same domain function the older direct route uses, so every money rule there (bounded by what was paid, one refund in flight per payment,
 * reserve before the call) still applies. "Accepted by the provider" is not "completed": the refund's own status follows pawaPay.
 */
export type RefundAction = "SUBSCRIPTION_CHARGE_REFUND" | "HELD_PAYMENT_REFUND";

export class RefundRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface RefundPayload {
  action: RefundAction;
  targetType: "Invoice" | "BillingAttempt";
  targetId: string;
  /** Integer minor units as a string; null means "everything still refundable". */
  amountMinor: string | null;
  currency: string;
  revokeEntitlement: boolean;
  businessId: string;
}

/** Keys sorted at every level, so the same request always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const hashPayload = (payload: unknown): string => createHash("sha256").update(canonicalJson(payload)).digest("hex");

const REQUEST_TTL_MS = 48 * 3600_000;

export interface RefundExecutors {
  refundSubscriptionCharge: typeof refundSubscriptionCharge;
  refundHeldBillingPayment: typeof refundHeldBillingPayment;
}
const REAL_EXECUTORS: RefundExecutors = { refundSubscriptionCharge, refundHeldBillingPayment };

interface Ctx { prisma: PrismaClient; now?: Date; correlationId?: string }

function audit(tx: Prisma.TransactionClient, actorId: string, action: string, id: string, extra: { reason?: string; correlationId?: string; businessId?: string | null; metadata?: Prisma.InputJsonValue } = {}) {
  return tx.auditLog.create({
    data: {
      actorType: "ADMIN", actorId, action, entityType: "ApprovalRequest", entityId: id,
      businessId: extra.businessId ?? null, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.correlationId ? { correlationId: extra.correlationId } : {}),
      ...(extra.metadata !== undefined ? { metadata: extra.metadata } : {}),
    },
  });
}

// ------------------------------------------------------------------------------------------------------ request

export async function requestRefund(
  ctx: Ctx,
  input: { action: RefundAction; targetId: string; amountMinor?: string | undefined; revokeEntitlement?: boolean | undefined; reason: string; requestedById: string },
) {
  const { prisma } = ctx;
  const now = ctx.now ?? new Date();
  const reason = input.reason.trim();
  if (reason.length < 10) throw new RefundRequestError(400, "REASON_TOO_SHORT", "Give a reason of at least 10 characters.");
  let payload: RefundPayload;
  let remaining: bigint;
  if (input.action === "SUBSCRIPTION_CHARGE_REFUND") {
    const inv = await prisma.invoice.findUnique({ where: { id: input.targetId }, include: { subscription: true } });
    if (!inv) throw new RefundRequestError(404, "NOT_FOUND", "No such invoice.");
    if (inv.purpose !== "PLATFORM_SUBSCRIPTION") throw new RefundRequestError(409, "NOT_ALLOWED", "Only subscription charges can be refunded here.");
    if (inv.status !== "PAID" && inv.status !== "PARTIALLY_REFUNDED") throw new RefundRequestError(409, "NOT_REFUNDABLE", "Only a paid subscription invoice can be refunded.");
    remaining = inv.paidMinor - inv.refundedMinor;
    payload = { action: input.action, targetType: "Invoice", targetId: inv.id, amountMinor: input.amountMinor ?? null, currency: inv.currencyCode, revokeEntitlement: input.revokeEntitlement === true, businessId: inv.subscription.businessId };
  } else {
    const attempt = await prisma.billingAttempt.findUnique({ where: { id: input.targetId }, include: { allocation: true, invoice: true } });
    if (!attempt) throw new RefundRequestError(404, "NOT_FOUND", "No such payment.");
    if (attempt.invoice.purpose !== "PLATFORM_SUBSCRIPTION") throw new RefundRequestError(409, "NOT_ALLOWED", "Only subscription charges can be refunded here.");
    if (attempt.status !== "COMPLETED" || attempt.allocation) throw new RefundRequestError(409, "NOT_REFUNDABLE", "Only a collected payment that was never applied to an invoice can be refunded here.");
    remaining = attempt.capturedMinor - attempt.refundedMinor;
    payload = { action: input.action, targetType: "BillingAttempt", targetId: attempt.id, amountMinor: input.amountMinor ?? null, currency: attempt.currencyCode, revokeEntitlement: false, businessId: attempt.businessId };
  }
  if (input.amountMinor !== undefined) {
    if (!/^[1-9]\d{0,15}$/.test(input.amountMinor)) throw new RefundRequestError(400, "BAD_AMOUNT", "The amount must be a whole number of minor units.");
    if (BigInt(input.amountMinor) > remaining) throw new RefundRequestError(409, "REFUND_LIMIT", "That is more than remains refundable on this payment.");
  }
  if (remaining <= 0n) throw new RefundRequestError(409, "NOTHING_TO_REFUND", "Nothing remains refundable on this payment.");
  const open = await prisma.approvalRequest.findFirst({ where: { actionType: input.action, targetId: payload.targetId, status: { in: ["PENDING", "APPROVED"] } }, select: { id: true } });
  if (open) throw new RefundRequestError(409, "REQUEST_OPEN", "There is already an open refund request for this payment.");
  const payloadHash = hashPayload(payload);
  return prisma.$transaction(async (tx) => {
    const row = await tx.approvalRequest.create({
      data: {
        actionType: input.action, targetType: payload.targetType, targetId: payload.targetId, subjectBusinessId: payload.businessId, reason,
        payload: payload as unknown as Prisma.InputJsonValue, payloadHash, requestedById: input.requestedById, createdAt: now, expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      },
    });
    await audit(tx, input.requestedById, "admin.refund.requested", row.id, { reason, businessId: payload.businessId, ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}), metadata: { payloadHash, action: input.action } });
    return row;
  });
}

// ------------------------------------------------------------------------------------------ approve / reject / cancel

async function loadOpen(prisma: PrismaClient, id: string, now: Date) {
  const row = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!row || !row.actionType.endsWith("REFUND")) throw new RefundRequestError(404, "NOT_FOUND", "No such refund request.");
  if ((row.status === "PENDING" || row.status === "APPROVED") && row.expiresAt.getTime() <= now.getTime()) {
    await prisma.approvalRequest.updateMany({ where: { id, status: { in: ["PENDING", "APPROVED"] } }, data: { status: "EXPIRED" } });
    throw new RefundRequestError(410, "EXPIRED", "This request expired. Make a new one.");
  }
  return row;
}

export async function approveRefund(ctx: Ctx, input: { id: string; approverId: string; payloadHash: string }) {
  const { prisma } = ctx;
  const now = ctx.now ?? new Date();
  const row = await loadOpen(prisma, input.id, now);
  if (row.status !== "PENDING") throw new RefundRequestError(409, "NOT_PENDING", `This request is ${row.status.toLowerCase()}.`);
  if (row.requestedById === input.approverId) throw new RefundRequestError(403, "SELF_APPROVAL", "You cannot approve a request you made.");
  // the approver approves exactly what they were shown
  if (input.payloadHash !== row.payloadHash || hashPayload(row.payload) !== row.payloadHash) throw new RefundRequestError(409, "PAYLOAD_CHANGED", "The request is not what you reviewed. Open it again.");
  const requester = await prisma.adminUser.findUnique({ where: { id: row.requestedById }, select: { disabledAt: true } });
  if (!requester || requester.disabledAt) throw new RefundRequestError(409, "REQUESTER_INACTIVE", "The person who made this request is no longer active. Cancel it and make a new one.");
  return prisma.$transaction(async (tx) => {
    const r = await tx.approvalRequest.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "APPROVED", approvedById: input.approverId, decidedAt: now } });
    if (r.count !== 1) throw new RefundRequestError(409, "NOT_PENDING", "This request was just decided by someone else.");
    await audit(tx, input.approverId, "admin.refund.approved", row.id, { businessId: row.subjectBusinessId, ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}), metadata: { payloadHash: row.payloadHash } });
    return tx.approvalRequest.findUniqueOrThrow({ where: { id: row.id } });
  });
}

export async function rejectRefund(ctx: Ctx, input: { id: string; rejecterId: string; reason: string }) {
  const { prisma } = ctx;
  const now = ctx.now ?? new Date();
  const row = await loadOpen(prisma, input.id, now);
  if (row.status !== "PENDING") throw new RefundRequestError(409, "NOT_PENDING", `This request is ${row.status.toLowerCase()}.`);
  if (row.requestedById === input.rejecterId) throw new RefundRequestError(403, "SELF_APPROVAL", "Cancel your own request instead of rejecting it.");
  return prisma.$transaction(async (tx) => {
    const r = await tx.approvalRequest.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "REJECTED", rejectedById: input.rejecterId, decidedAt: now } });
    if (r.count !== 1) throw new RefundRequestError(409, "NOT_PENDING", "This request was just decided by someone else.");
    await audit(tx, input.rejecterId, "admin.refund.rejected", row.id, { reason: input.reason, businessId: row.subjectBusinessId, ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}) });
    return tx.approvalRequest.findUniqueOrThrow({ where: { id: row.id } });
  });
}

export async function cancelRefund(ctx: Ctx, input: { id: string; byId: string }) {
  const { prisma } = ctx;
  const now = ctx.now ?? new Date();
  const row = await loadOpen(prisma, input.id, now);
  if (row.requestedById !== input.byId) throw new RefundRequestError(403, "NOT_YOURS", "Only the person who made the request can cancel it.");
  return prisma.$transaction(async (tx) => {
    const r = await tx.approvalRequest.updateMany({ where: { id: row.id, status: { in: ["PENDING", "APPROVED"] } }, data: { status: "CANCELLED" } });
    if (r.count !== 1) throw new RefundRequestError(409, "NOT_OPEN", "This request is already closed.");
    await audit(tx, input.byId, "admin.refund.cancelled", row.id, { businessId: row.subjectBusinessId, ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}) });
    return tx.approvalRequest.findUniqueOrThrow({ where: { id: row.id } });
  });
}

// ------------------------------------------------------------------------------------------------------- execute

export async function executeRefund(
  ctx: Ctx & { env?: NodeJS.ProcessEnv; executors?: RefundExecutors },
  input: { id: string; executorId: string; executorRoleVersion?: number },
): Promise<{ refundId: string; status: string }> {
  const { prisma } = ctx;
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? new Date();
  if (!refundExecutionEnabled(env)) throw new RefundRequestError(409, "EXECUTION_DISABLED", "Refund execution is switched off in this environment. The request stays approved; nothing was sent to the payment provider.");
  const row = await loadOpen(prisma, input.id, now);
  if (row.status !== "APPROVED") throw new RefundRequestError(409, "NOT_APPROVED", `This request is ${row.status.toLowerCase()}, not approved.`);
  // the person running it must still be allowed to, right now
  const verdict = await revalidateActor(prisma, { adminUserId: input.executorId, permission: "admin:execute_refund" as PlatformPermission, ...(input.executorRoleVersion !== undefined ? { roleVersionAtQueue: input.executorRoleVersion } : {}) });
  if (!verdict.ok) throw new RefundRequestError(403, "ACTOR_NOT_ALLOWED", "You are no longer allowed to run this.");
  if (hashPayload(row.payload) !== row.payloadHash) throw new RefundRequestError(409, "PAYLOAD_CHANGED", "The stored request does not match its approved hash. Nothing was sent.");
  const payload = row.payload as unknown as RefundPayload;
  const executors = ctx.executors ?? REAL_EXECUTORS;
  const reason = `${row.reason} [two-person approval ${row.id}]`;
  const amount = payload.amountMinor !== null ? { amountMinor: BigInt(payload.amountMinor) } : {};
  let result: { id: string; status: string };
  if (payload.action === "SUBSCRIPTION_CHARGE_REFUND") {
    result = await executors.refundSubscriptionCharge(prisma, { invoiceId: payload.targetId, ...amount, reason, adminUserId: input.executorId, revokeEntitlement: payload.revokeEntitlement, now });
  } else {
    result = await executors.refundHeldBillingPayment(prisma, { attemptId: payload.targetId, ...amount, reason, adminUserId: input.executorId, now });
  }
  // The domain function already enforces "one refund in flight per payment", so a repeat of this call cannot send a second refund.
  await prisma.$transaction(async (tx) => {
    const r = await tx.approvalRequest.updateMany({ where: { id: row.id, status: "APPROVED" }, data: { status: "EXECUTED", executedAt: now } });
    if (r.count === 1) await audit(tx, input.executorId, "admin.refund.executed", row.id, { businessId: row.subjectBusinessId, ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}), metadata: { refundId: result.id, providerStatus: result.status } });
  });
  return { refundId: result.id, status: result.status };
}

// ----------------------------------------------------------------------------------------------------- routes

const requestBody = z.object({
  action: z.enum(["SUBSCRIPTION_CHARGE_REFUND", "HELD_PAYMENT_REFUND"]),
  targetId: z.string().min(1).max(64),
  amountMinor: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
  revokeEntitlement: z.boolean().optional(),
  reason: z.string().trim().min(10).max(300),
}).strict();
const approveBody = z.object({ payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const rejectBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

export interface RefundRouterOptions {
  jwtSecret: string;
  policy?: AdminSessionPolicy;
  now?: () => Date;
  env?: () => NodeJS.ProcessEnv;
  executors?: RefundExecutors;
}

function fail(res: Response, error: unknown): void {
  if (error instanceof RefundRequestError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  throw error;
}

const present = (r: { id: string; actionType: string; status: string; reason: string; payload: unknown; payloadHash: string; requestedById: string; approvedById: string | null; rejectedById: string | null; createdAt: Date; decidedAt: Date | null; executedAt: Date | null; expiresAt: Date; subjectBusinessId: string | null }) => ({
  id: r.id, action: r.actionType, status: r.status, reason: r.reason, payload: r.payload, payloadHash: r.payloadHash, requestedById: r.requestedById,
  approvedById: r.approvedById, rejectedById: r.rejectedById, businessId: r.subjectBusinessId, createdAt: r.createdAt, decidedAt: r.decidedAt, executedAt: r.executedAt, expiresAt: r.expiresAt,
});

export function createRefundRouter(prisma: PrismaClient, options: RefundRouterOptions): Router {
  const router = Router();
  const policy = options.policy ?? DEFAULT_SESSION_POLICY;
  const now = options.now ?? (() => new Date());
  const reauth = requireRecentReauth(policy, now);
  const guard = (permission: PlatformPermission): RequestHandler[] => [requirePlatformPermission(permission), requireStepUp(prisma, options.jwtSecret, permission), reauth];
  const me = (req: Request) => (req as AuthenticatedAdminRequest).adminUser!;
  const ctxOf = (req: Request, res: Response): Ctx => ({ prisma, now: now(), correlationId: correlationIdOf(res) });

  router.get("/refund-requests", requirePlatformPermission("admin:view_payments"), asyncHandler(async (req, res) => {
    const status = z.enum(["PENDING", "APPROVED", "REJECTED", "EXECUTED", "EXPIRED", "CANCELLED"]).optional().safeParse(req.query["status"]);
    if (!status.success) return void res.status(400).json({ error: "Invalid query." });
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    const rows = await prisma.approvalRequest.findMany({ where: { actionType: { endsWith: "REFUND" }, ...(status.data ? { status: status.data } : {}) }, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip });
    const { items, pagination: meta } = paginate(rows, pagination);
    res.json({ requests: items.map(present), pagination: meta, executionEnabled: refundExecutionEnabled((options.env ?? (() => process.env))()) });
  }));

  router.get("/refund-requests/:id", requirePlatformPermission("admin:view_payments"), asyncHandler(async (req, res) => {
    const row = await prisma.approvalRequest.findUnique({ where: { id: req.params["id"] as string } });
    if (!row || !row.actionType.endsWith("REFUND")) return void res.status(404).json({ error: "No such refund request." });
    res.json(present(row));
  }));

  router.post("/refund-requests", ...guard("admin:request_refund"), asyncHandler(async (req, res) => {
    const p = requestBody.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      const row = await requestRefund(ctxOf(req, res), { ...p.data, requestedById: me(req).adminUserId });
      res.status(201).json(present(row));
    } catch (e) { fail(res, e); }
  }));

  router.post("/refund-requests/:id/approve", ...guard("admin:approve_refund"), asyncHandler(async (req, res) => {
    const p = approveBody.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Send the payloadHash you reviewed.", details: p.error.issues });
    try { res.json(present(await approveRefund(ctxOf(req, res), { id: req.params["id"] as string, approverId: me(req).adminUserId, payloadHash: p.data.payloadHash }))); } catch (e) { fail(res, e); }
  }));

  router.post("/refund-requests/:id/reject", ...guard("admin:approve_refund"), asyncHandler(async (req, res) => {
    const p = rejectBody.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Give a reason.", details: p.error.issues });
    try { res.json(present(await rejectRefund(ctxOf(req, res), { id: req.params["id"] as string, rejecterId: me(req).adminUserId, reason: p.data.reason }))); } catch (e) { fail(res, e); }
  }));

  router.post("/refund-requests/:id/cancel", ...guard("admin:request_refund"), asyncHandler(async (req, res) => {
    try { res.json(present(await cancelRefund(ctxOf(req, res), { id: req.params["id"] as string, byId: me(req).adminUserId }))); } catch (e) { fail(res, e); }
  }));

  router.post("/refund-requests/:id/execute", ...guard("admin:execute_refund"), asyncHandler(async (req, res) => {
    try {
      const out = await executeRefund({ ...ctxOf(req, res), env: (options.env ?? (() => process.env))(), ...(options.executors ? { executors: options.executors } : {}) }, { id: req.params["id"] as string, executorId: me(req).adminUserId });
      res.status(202).json(out);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && "message" in e && !(e instanceof RefundRequestError)) {
        // a money-rule refusal from the billing code (limit, in progress, not configured): a clear answer, not a crash
        const code = String((e as { code: unknown }).code);
        return void res.status(409).json({ error: String((e as { message: unknown }).message), code });
      }
      fail(res, e);
    }
  }));

  return router;
}

/** While the Refunds module is on, the older single-person refund routes refuse and point at the approval workflow. */
export function blockDirectRefunds(isRefundsModuleOn: () => boolean): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "POST" && /^\/(invoices\/[^/]+\/refund|subscriptions\/attempts\/[^/]+\/refund)$/.test(req.path) && isRefundsModuleOn()) {
      res.status(409).json({ error: "Refunds now need a request and a second person's approval. Use /admin/refund-requests.", code: "USE_REFUND_REQUESTS" });
      return;
    }
    next();
  };
}
