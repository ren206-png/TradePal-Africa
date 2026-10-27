import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import type { AdminRole, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import { requireRecentReauth, type AuthenticatedAdminRequest } from "./authMiddleware.js";
import { correlationIdOf } from "./adminAudit.js";
import { INVITATION_TTL_MS, OWNERSHIP_TRANSFER_TTL_MS, DEFAULT_SESSION_POLICY, type AdminSessionPolicy } from "./adminConfig.js";
import { revokeAllAdminSessions } from "./adminSessions.js";
import { recordSecurityEvent, type SecurityEventInput } from "./securityEvents.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "./rateLimiter.js";
import { hashAdminPassword } from "./auth.js";
import { parsePaginationParams, paginate } from "./pagination.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";

/**
 * Staff access (admin-console Phase 2): invitations, roles, account status, session revocation, ownership transfer and the security
 * event list. Every change writes its audit row IN THE SAME TRANSACTION as the change, plus the role history where a role moves.
 *
 * Rules enforced here and again by the database (so a bug here cannot break them):
 *   - an invitation is bound to one email, expires, works once, and only the hash of its token is stored;
 *   - the last active owner cannot be removed, disabled or demoted (trigger `AdminUser_guard`);
 *   - nobody changes their own role or disables themselves through this API;
 *   - changing staff needs a recent password + second-factor confirmation.
 */
export class StaffError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ADMIN_ROLES = ["SUPER_ADMIN", "OPERATOR", "SUPPORT", "ANALYST", "FINANCE_ADMIN", "MODERATOR"] as const satisfies readonly AdminRole[];

/** At least 12 characters, not the email, and not trivially repetitive. (Staff also get a second factor, so this is a floor, not the whole defence.) */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 200) return "That password is too long.";
  if (password.toLowerCase().includes(email.split("@")[0]!.toLowerCase()) && email.split("@")[0]!.length >= 4) return "The password must not contain your email name.";
  if (/^(.)\1+$/.test(password) || new Set(password).size < 5) return "Use a less repetitive password.";
  return null;
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// ------------------------------------------------------------------------------------------------ invitations

export interface InvitationCreated { id: string; email: string; role: AdminRole; expiresAt: Date; /** Shown once; only its hash is stored. */ token: string }

export async function createInvitation(
  prisma: PrismaClient,
  input: { email: string; role: AdminRole; invitedById: string; correlationId?: string; now?: Date },
): Promise<InvitationCreated> {
  const email = input.email.trim().toLowerCase();
  const now = input.now ?? new Date();
  if (await prisma.adminUser.findUnique({ where: { email }, select: { id: true } })) throw new StaffError(409, "ALREADY_STAFF", "That person already has an account.");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  try {
    const row = await prisma.$transaction(async (tx) => {
      // an expired, unaccepted invitation to the same address must not block a new one
      await tx.staffInvitation.updateMany({ where: { email, acceptedAt: null, revokedAt: null, expiresAt: { lte: now } }, data: { revokedAt: now } });
      const inv = await tx.staffInvitation.create({ data: { email, role: input.role, tokenHash: hashToken(token), invitedById: input.invitedById, createdAt: now, expiresAt } });
      await tx.auditLog.create({
        data: { actorType: "ADMIN", actorId: input.invitedById, action: "admin.staff.invitation_created", entityType: "StaffInvitation", entityId: inv.id, ...(input.correlationId ? { correlationId: input.correlationId } : {}), metadata: { role: input.role, expiresAt: expiresAt.toISOString() } },
      });
      return inv;
    });
    return { id: row.id, email, role: input.role, expiresAt, token };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new StaffError(409, "INVITATION_EXISTS", "There is already a live invitation to that address. Revoke it first, or resend it.");
    throw error;
  }
}

export async function revokeInvitation(prisma: PrismaClient, id: string, byId: string, correlationId?: string, now: Date = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const r = await tx.staffInvitation.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
    if (r.count !== 1) throw new StaffError(404, "NOT_FOUND", "That invitation is not open.");
    await tx.auditLog.create({ data: { actorType: "ADMIN", actorId: byId, action: "admin.staff.invitation_revoked", entityType: "StaffInvitation", entityId: id, ...(correlationId ? { correlationId } : {}) } });
  });
}

export async function resendInvitation(prisma: PrismaClient, id: string, byId: string, correlationId?: string, now: Date = new Date()): Promise<InvitationCreated> {
  const old = await prisma.staffInvitation.findUnique({ where: { id } });
  if (!old || old.acceptedAt || old.revokedAt) throw new StaffError(404, "NOT_FOUND", "That invitation is not open.");
  await revokeInvitation(prisma, id, byId, correlationId, now);
  return createInvitation(prisma, { email: old.email, role: old.role, invitedById: byId, ...(correlationId ? { correlationId } : {}), now });
}

export interface InvitationAcceptance { adminUserId: string; email: string; role: AdminRole }

/**
 * Redeems an invitation: creates the account (second factor required from the first sign-in), records the role history, and burns the
 * token. Any failure (unknown, expired, used, revoked) answers the same way, so a token cannot be probed.
 */
export async function acceptInvitation(
  prisma: PrismaClient,
  input: { token: string; name: string; password: string; now?: Date; correlationId?: string },
): Promise<InvitationAcceptance> {
  const now = input.now ?? new Date();
  const inv = await prisma.staffInvitation.findUnique({ where: { tokenHash: hashToken(input.token) } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt.getTime() <= now.getTime()) throw new StaffError(400, "INVITATION_INVALID", "This invitation is not valid. Ask for a new one.");
  const problem = passwordProblem(input.password, inv.email);
  if (problem) throw new StaffError(400, "WEAK_PASSWORD", problem);
  const passwordHash = await hashAdminPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      // claim the token first (naming the account it will create): of two simultaneous redemptions only one gets count = 1
      const adminId = randomUUID();
      const claimed = await tx.staffInvitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now, acceptedById: adminId } });
      if (claimed.count !== 1) throw new StaffError(400, "INVITATION_INVALID", "This invitation is not valid. Ask for a new one.");
      const admin = await tx.adminUser.create({ data: { id: adminId, email: inv.email, name: input.name.trim(), role: inv.role, passwordHash, mfaRequiredAt: now, createdById: inv.invitedById } });
      await tx.staffRoleChange.create({ data: { adminUserId: admin.id, fromRole: null, toRole: inv.role, changedById: inv.invitedById, reason: "accepted invitation" } });
      await tx.auditLog.create({ data: { actorType: "ADMIN", actorId: admin.id, action: "admin.staff.invitation_accepted", entityType: "AdminUser", entityId: admin.id, ...(input.correlationId ? { correlationId: input.correlationId } : {}), metadata: { role: inv.role, invitedBy: inv.invitedById } } });
      return { adminUserId: admin.id, email: admin.email, role: admin.role };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new StaffError(409, "ALREADY_STAFF", "That person already has an account.");
    throw error;
  }
}

// ------------------------------------------------------------------------------------------- roles and status

function mapDbError(error: unknown): never {
  const msg = error instanceof Error ? error.message : "";
  if (/last active platform owner/.test(msg)) throw new StaffError(409, "LAST_OWNER", "That would leave the platform without an active owner. Promote another owner first.");
  throw error;
}

export async function changeRole(
  prisma: PrismaClient,
  input: { targetId: string; role: AdminRole; reason: string; byId: string; correlationId?: string },
): Promise<{ role: AdminRole; roleVersion: number }> {
  if (input.targetId === input.byId) throw new StaffError(409, "SELF_CHANGE", "You cannot change your own role. Ask another owner.");
  try {
    return await prisma.$transaction(async (tx) => {
      const target = await tx.adminUser.findUnique({ where: { id: input.targetId } });
      if (!target) throw new StaffError(404, "NOT_FOUND", "No such staff member.");
      if (target.disabledAt) throw new StaffError(409, "DISABLED", "Enable the account before changing its role.");
      if (target.role === input.role) throw new StaffError(409, "NO_CHANGE", "That is already their role.");
      const updated = await tx.adminUser.update({ where: { id: target.id }, data: { role: input.role } }); // database bumps roleVersion and guards the last owner
      await tx.staffRoleChange.create({ data: { adminUserId: target.id, fromRole: target.role, toRole: input.role, changedById: input.byId, reason: input.reason } });
      await tx.auditLog.create({ data: { actorType: "ADMIN", actorId: input.byId, action: "admin.staff.role_changed", entityType: "AdminUser", entityId: target.id, reason: input.reason, ...(input.correlationId ? { correlationId: input.correlationId } : {}), metadata: { from: target.role, to: input.role } } });
      return { role: updated.role, roleVersion: updated.roleVersion };
    });
  } catch (error) {
    return mapDbError(error);
  }
}

export async function setStaffDisabled(
  prisma: PrismaClient,
  input: { targetId: string; disabled: boolean; reason: string; byId: string; correlationId?: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  if (input.disabled && input.targetId === input.byId) throw new StaffError(409, "SELF_CHANGE", "You cannot disable your own account.");
  try {
    await prisma.$transaction(async (tx) => {
      const target = await tx.adminUser.findUnique({ where: { id: input.targetId } });
      if (!target) throw new StaffError(404, "NOT_FOUND", "No such staff member.");
      if (input.disabled === (target.disabledAt !== null)) throw new StaffError(409, "NO_CHANGE", input.disabled ? "Already disabled." : "Already active.");
      await tx.adminUser.update({ where: { id: target.id }, data: { disabledAt: input.disabled ? now : null } });
      if (input.disabled) await tx.adminSession.updateMany({ where: { adminUserId: target.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "account disabled" } });
      await tx.auditLog.create({ data: { actorType: "ADMIN", actorId: input.byId, action: input.disabled ? "admin.staff.disabled" : "admin.staff.enabled", entityType: "AdminUser", entityId: target.id, reason: input.reason, ...(input.correlationId ? { correlationId: input.correlationId } : {}) } });
    });
  } catch (error) {
    return mapDbError(error);
  }
}

export async function revokeStaffSessions(prisma: PrismaClient, targetId: string, byId: string, reason: string, correlationId?: string): Promise<number> {
  const target = await prisma.adminUser.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!target) throw new StaffError(404, "NOT_FOUND", "No such staff member.");
  const n = await revokeAllAdminSessions(prisma, targetId, `revoked by an owner: ${reason}`.slice(0, 200));
  await prisma.auditLog.create({ data: { actorType: "ADMIN", actorId: byId, action: "admin.staff.sessions_revoked", entityType: "AdminUser", entityId: targetId, reason, ...(correlationId ? { correlationId } : {}), metadata: { revoked: n } } });
  return n;
}

// ------------------------------------------------------------------------------------------- ownership transfer

export async function initiateOwnershipTransfer(prisma: PrismaClient, input: { fromId: string; toId: string; correlationId?: string; now?: Date }): Promise<{ id: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const [from, to] = await Promise.all([prisma.adminUser.findUnique({ where: { id: input.fromId } }), prisma.adminUser.findUnique({ where: { id: input.toId } })]);
  if (!from || from.role !== "SUPER_ADMIN" || from.disabledAt) throw new StaffError(403, "NOT_OWNER", "Only an active owner can hand over ownership.");
  if (!to || to.disabledAt) throw new StaffError(404, "NOT_FOUND", "That person is not an active staff member.");
  if (to.id === from.id) throw new StaffError(409, "SELF_CHANGE", "Choose someone else.");
  const expiresAt = new Date(now.getTime() + OWNERSHIP_TRANSFER_TTL_MS);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.ownershipTransfer.updateMany({ where: { fromAdminId: from.id, status: "INITIATED", expiresAt: { lte: now } }, data: { status: "EXPIRED", decidedAt: now } });
      const t = await tx.ownershipTransfer.create({ data: { fromAdminId: from.id, toAdminId: to.id, initiatedAt: now, expiresAt } });
      await tx.auditLog.create({ data: { actorType: "ADMIN", actorId: from.id, action: "admin.staff.ownership_transfer_started", entityType: "OwnershipTransfer", entityId: t.id, ...(input.correlationId ? { correlationId: input.correlationId } : {}), metadata: { to: to.id, expiresAt: expiresAt.toISOString() } } });
      return { id: t.id, expiresAt };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new StaffError(409, "TRANSFER_OPEN", "You already have an open ownership transfer. Cancel it first.");
    throw error;
  }
}

/** The named person accepts: they become an owner, the previous owner becomes an operator (a person can still be made owner again). One transaction. */
export async function acceptOwnershipTransfer(prisma: PrismaClient, input: { transferId: string; byId: string; correlationId?: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const t = await tx.ownershipTransfer.findUnique({ where: { id: input.transferId } });
      if (!t || t.status !== "INITIATED") throw new StaffError(404, "NOT_FOUND", "That transfer is not open.");
      if (t.toAdminId !== input.byId) throw new StaffError(403, "NOT_YOU", "Only the person named in the transfer can accept it.");
      if (t.expiresAt.getTime() <= now.getTime()) {
        await tx.ownershipTransfer.update({ where: { id: t.id }, data: { status: "EXPIRED", decidedAt: now } });
        throw new StaffError(410, "EXPIRED", "That transfer has expired. Ask for a new one.");
      }
      const [from, to] = await Promise.all([tx.adminUser.findUnique({ where: { id: t.fromAdminId } }), tx.adminUser.findUnique({ where: { id: t.toAdminId } })]);
      if (!from || !to || to.disabledAt) throw new StaffError(409, "NOT_POSSIBLE", "One of the two accounts is no longer active.");
      // promote first, then step the previous owner aside, so an owner exists at every instant (the database checks this too)
      await tx.adminUser.update({ where: { id: to.id }, data: { role: "SUPER_ADMIN" } });
      await tx.staffRoleChange.create({ data: { adminUserId: to.id, fromRole: to.role, toRole: "SUPER_ADMIN", changedById: from.id, reason: "ownership transfer accepted" } });
      if (from.role === "SUPER_ADMIN") {
        await tx.adminUser.update({ where: { id: from.id }, data: { role: "OPERATOR" } });
        await tx.staffRoleChange.create({ data: { adminUserId: from.id, fromRole: "SUPER_ADMIN", toRole: "OPERATOR", changedById: to.id, reason: "ownership transfer: handed over" } });
      }
      await tx.ownershipTransfer.update({ where: { id: t.id }, data: { status: "ACCEPTED", decidedAt: now } });
      await tx.auditLog.create({ data: { actorType: "ADMIN", actorId: to.id, action: "admin.staff.ownership_transfer_accepted", entityType: "OwnershipTransfer", entityId: t.id, ...(input.correlationId ? { correlationId: input.correlationId } : {}), metadata: { from: from.id, to: to.id } } });
    });
  } catch (error) {
    return mapDbError(error);
  }
}

export async function cancelOwnershipTransfer(prisma: PrismaClient, input: { transferId: string; byId: string; correlationId?: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const t = await tx.ownershipTransfer.findUnique({ where: { id: input.transferId } });
    if (!t || t.status !== "INITIATED") throw new StaffError(404, "NOT_FOUND", "That transfer is not open.");
    if (t.fromAdminId !== input.byId && t.toAdminId !== input.byId) throw new StaffError(403, "NOT_YOU", "Only the two people in the transfer can cancel it.");
    await tx.ownershipTransfer.update({ where: { id: t.id }, data: { status: "CANCELLED", decidedAt: now } });
    await tx.auditLog.create({ data: { actorType: "ADMIN", actorId: input.byId, action: "admin.staff.ownership_transfer_cancelled", entityType: "OwnershipTransfer", entityId: t.id, ...(input.correlationId ? { correlationId: input.correlationId } : {}) } });
  });
}

// ---------------------------------------------------------------------------------------------------- queries

/** Staff list for the console: never a password hash, secret, code or token hash. */
export async function listStaff(prisma: PrismaClient) {
  const rows = await prisma.adminUser.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true, email: true, name: true, role: true, roleVersion: true, createdAt: true, disabledAt: true, mfaRequiredAt: true, lastSignInAt: true,
      mfaFactors: { where: { disabledAt: null, confirmedAt: { not: null } }, select: { id: true } },
      sessions: { where: { revokedAt: null, absoluteExpiresAt: { gt: new Date() } }, select: { id: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id, email: r.email, name: r.name, role: r.role, roleVersion: r.roleVersion, createdAt: r.createdAt,
    status: r.disabledAt ? "DISABLED" : "ACTIVE", lastSignInAt: r.lastSignInAt,
    mfa: r.mfaFactors.length > 0 ? "ENROLLED" : r.mfaRequiredAt ? "REQUIRED" : "NOT_ENROLLED",
    liveSessions: r.sessions.length,
  }));
}

// ------------------------------------------------------------------------------------------------------ routes

const inviteBody = z.object({ email: z.string().email().max(254), role: z.enum(ADMIN_ROLES) }).strict();
const roleBody = z.object({ role: z.enum(ADMIN_ROLES), reason: z.string().trim().min(3).max(300) }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const transferBody = z.object({ toAdminId: z.string().uuid() }).strict();
const acceptBody = z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) }).strict();
const eventsQuery = z.object({
  adminUserId: z.string().uuid().optional(), type: z.string().regex(/^[A-Z_]{3,60}$/).optional(), result: z.enum(["SUCCESS", "FAILURE", "DENIED"]).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(), correlationId: z.string().max(64).optional(),
  // the paging keys (take, skip) are read separately by parsePaginationParams; every other unknown key is rejected
  take: z.string().optional(), skip: z.string().optional(),
}).strict();

export interface StaffRouterOptions {
  policy?: AdminSessionPolicy;
  now?: () => Date;
  /** Where the invitation link points (the admin console's address). Never emailed by this code: the owner receives the link once. */
  publicBaseUrl?: string;
  inviteRateLimiter?: LoginRateLimiter;
  jwtSecret: string;
}

function send(res: Response, error: unknown): void {
  if (error instanceof StaffError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  throw error;
}

/** Authenticated staff-management routes. Mounted after the sign-in gate, so a half-open session never reaches them. */
export function createStaffRouter(prisma: PrismaClient, options: StaffRouterOptions): Router {
  const router = Router();
  const policy = options.policy ?? DEFAULT_SESSION_POLICY;
  const now = options.now ?? (() => new Date());
  const reauth = requireRecentReauth(policy, now);
  const manage = [requirePlatformPermission("admin:manage_admins"), requireStepUp(prisma, options.jwtSecret, "admin:manage_admins"), reauth] as const;
  const view = requirePlatformPermission("admin:view_staff");
  const idOf = (req: Request) => req.params["id"] as string;
  const me = (req: Request) => (req as AuthenticatedAdminRequest).adminUser!;

  router.get("/staff", view, asyncHandler(async (_req, res) => { res.json({ staff: await listStaff(prisma) }); }));

  router.get("/staff/invitations", view, asyncHandler(async (_req, res) => {
    const rows = await prisma.staffInvitation.findMany({ orderBy: { createdAt: "desc" }, take: 200, select: { id: true, email: true, role: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true, invitedById: true } });
    res.json({ invitations: rows.map((r) => ({ ...r, status: r.acceptedAt ? "ACCEPTED" : r.revokedAt ? "REVOKED" : r.expiresAt.getTime() <= now().getTime() ? "EXPIRED" : "OPEN" })) });
  }));

  router.post("/staff/invitations", ...manage, asyncHandler(async (req, res) => {
    const parsed = inviteBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    try {
      const inv = await createInvitation(prisma, { email: parsed.data.email, role: parsed.data.role, invitedById: me(req).adminUserId, correlationId: correlationIdOf(res), now: now() });
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "INVITATION_CREATED", result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res), metadata: { invitationId: inv.id, role: inv.role } });
      // The link is returned ONCE, to the owner who made it. It is not emailed by this code, and the token is never stored or shown again.
      const base = (options.publicBaseUrl ?? "").replace(/\/$/, "");
      res.status(201).json({ id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, link: `${base}/accept-invite#token=${inv.token}`, notice: "Copy this link now and send it to the person yourself. It is shown only once and works once." });
    } catch (error) { send(res, error); }
  }));

  router.post("/staff/invitations/:id/revoke", ...manage, asyncHandler(async (req, res) => {
    try {
      await revokeInvitation(prisma, idOf(req), me(req).adminUserId, correlationIdOf(res), now());
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "INVITATION_REVOKED", result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res) });
      res.json({ revoked: true });
    } catch (error) { send(res, error); }
  }));

  router.post("/staff/invitations/:id/resend", ...manage, asyncHandler(async (req, res) => {
    try {
      const inv = await resendInvitation(prisma, idOf(req), me(req).adminUserId, correlationIdOf(res), now());
      const base = (options.publicBaseUrl ?? "").replace(/\/$/, "");
      res.status(201).json({ id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, link: `${base}/accept-invite#token=${inv.token}`, notice: "The earlier link no longer works. Copy this one now; it is shown only once." });
    } catch (error) { send(res, error); }
  }));

  router.put("/staff/:id/role", ...manage, asyncHandler(async (req, res) => {
    const parsed = roleBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    try {
      const out = await changeRole(prisma, { targetId: idOf(req), role: parsed.data.role, reason: parsed.data.reason, byId: me(req).adminUserId, correlationId: correlationIdOf(res) });
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "STAFF_ROLE_CHANGED", result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res), metadata: { target: idOf(req), to: out.role } });
      res.json(out);
    } catch (error) { send(res, error); }
  }));

  for (const [path, disabled, type] of [["disable", true, "STAFF_DISABLED"], ["enable", false, "STAFF_ENABLED"]] as const) {
    router.post(`/staff/:id/${path}`, ...manage, asyncHandler(async (req, res) => {
      const parsed = reasonBody.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
      try {
        await setStaffDisabled(prisma, { targetId: idOf(req), disabled, reason: parsed.data.reason, byId: me(req).adminUserId, correlationId: correlationIdOf(res), now: now() });
        await recordSecurityEvent(prisma, options.jwtSecret, req, { type: type as SecurityEventInput["type"], result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res), metadata: { target: idOf(req) } });
        res.json({ status: disabled ? "DISABLED" : "ACTIVE" });
      } catch (error) { send(res, error); }
    }));
  }

  router.post("/staff/:id/revoke-sessions", ...manage, asyncHandler(async (req, res) => {
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    try {
      const revoked = await revokeStaffSessions(prisma, idOf(req), me(req).adminUserId, parsed.data.reason, correlationIdOf(res));
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "SESSION_REVOKED", result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res), metadata: { target: idOf(req), revoked } });
      res.json({ revoked });
    } catch (error) { send(res, error); }
  }));

  // Ownership transfer: the owner starts it, the named person accepts it. Both need a recent confirmation (password + second factor).
  router.post("/staff/ownership-transfers", requirePlatformPermission("admin:transfer_ownership"), requireStepUp(prisma, options.jwtSecret, "admin:transfer_ownership"), reauth, asyncHandler(async (req, res) => {
    const parsed = transferBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    try {
      const t = await initiateOwnershipTransfer(prisma, { fromId: me(req).adminUserId, toId: parsed.data.toAdminId, correlationId: correlationIdOf(res), now: now() });
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "OWNERSHIP_TRANSFER_STARTED", result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res), metadata: { transferId: t.id } });
      res.status(201).json(t);
    } catch (error) { send(res, error); }
  }));

  router.post("/staff/ownership-transfers/:id/accept", reauth, asyncHandler(async (req, res) => {
    try {
      await acceptOwnershipTransfer(prisma, { transferId: idOf(req), byId: me(req).adminUserId, correlationId: correlationIdOf(res), now: now() });
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "OWNERSHIP_TRANSFER_ACCEPTED", result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res), metadata: { transferId: idOf(req) } });
      res.json({ accepted: true, role: "SUPER_ADMIN" });
    } catch (error) { send(res, error); }
  }));

  router.post("/staff/ownership-transfers/:id/cancel", asyncHandler(async (req, res) => {
    try {
      await cancelOwnershipTransfer(prisma, { transferId: idOf(req), byId: me(req).adminUserId, correlationId: correlationIdOf(res), now: now() });
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "OWNERSHIP_TRANSFER_CANCELLED", result: "SUCCESS", adminUserId: me(req).adminUserId, correlationId: correlationIdOf(res), metadata: { transferId: idOf(req) } });
      res.json({ cancelled: true });
    } catch (error) { send(res, error); }
  }));

  router.get("/staff/ownership-transfers", view, asyncHandler(async (_req, res) => {
    res.json({ transfers: await prisma.ownershipTransfer.findMany({ orderBy: { initiatedAt: "desc" }, take: 50 }) });
  }));

  router.get("/security-events", requirePlatformPermission("admin:view_security_events"), asyncHandler(async (req, res) => {
    const q = eventsQuery.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: "Invalid query.", details: q.error.issues });
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    const where: Prisma.SecurityEventWhereInput = {
      ...(q.data.adminUserId ? { adminUserId: q.data.adminUserId } : {}), ...(q.data.type ? { eventType: q.data.type } : {}), ...(q.data.result ? { result: q.data.result } : {}),
      ...(q.data.correlationId ? { correlationId: q.data.correlationId } : {}),
      ...(q.data.from || q.data.to ? { createdAt: { ...(q.data.from ? { gte: new Date(q.data.from) } : {}), ...(q.data.to ? { lte: new Date(q.data.to) } : {}) } } : {}),
    };
    const rows = await prisma.securityEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip });
    const { items, pagination: meta } = paginate(rows, pagination);
    res.json({ events: items, pagination: meta });
  }));

  return router;
}

// ------------------------------------------------------------------------------------- public: accept invitation

export interface InvitationAcceptRouterOptions {
  jwtSecret: string;
  limiter?: LoginRateLimiter;
  now?: () => Date;
}

/** Unauthenticated: redeems an invitation. Rate-limited per caller; every failure looks the same. */
export function invitationAcceptHandler(prisma: PrismaClient, options: InvitationAcceptRouterOptions): RequestHandler {
  const limiter = options.limiter ?? new InMemoryLoginRateLimiter(10, 60 * 60_000);
  return asyncHandler(async (req, res) => {
    const ip = req.ip ?? "unknown";
    const limit = await limiter.consume(`invite:${createHash("sha256").update(ip).digest("hex").slice(0, 16)}`);
    if (!limit.allowed) return void res.status(429).set("Retry-After", String(limit.retryAfterSeconds)).json({ error: "Too many attempts. Try again later." });
    const parsed = acceptBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
    try {
      const out = await acceptInvitation(prisma, { token: parsed.data.token, name: parsed.data.name, password: parsed.data.password, ...(options.now ? { now: options.now() } : {}), correlationId: correlationIdOf(res) });
      await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "INVITATION_ACCEPTED", result: "SUCCESS", adminUserId: out.adminUserId, correlationId: correlationIdOf(res) });
      res.status(201).json({ created: true, email: out.email, message: "Your account is ready. Sign in, then set up your authenticator app." });
    } catch (error) {
      if (error instanceof StaffError) {
        await recordSecurityEvent(prisma, options.jwtSecret, req, { type: "INVITATION_REJECTED", result: "FAILURE", correlationId: correlationIdOf(res), metadata: { code: error.code } });
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  });
}

