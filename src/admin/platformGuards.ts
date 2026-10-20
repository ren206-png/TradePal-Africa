import { Prisma, type PrismaClient } from "@prisma/client";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { asyncHandler } from "./asyncHandler.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { canPlatform, PLATFORM_STEP_UP_PERMISSIONS, type PlatformPermission } from "../auth/permissions.js";

/**
 * Platform-admin guards (expansion Phase 1, admin console core):
 *   - permission checks from the platform matrix (src/auth/permissions.ts);
 *   - step-up auth: a fresh password confirmation, bound to the admin and to the access token it was issued for;
 *   - support access: a recorded, time-boxed reason before an admin opens one merchant's financial data.
 *
 * Step-up and support-access are enforced only while their feature flags (`adminStepUp`,
 * `adminSupportAccessRequired`, default OFF, global default) are on, so rolling this out cannot lock the existing
 * admins out of anything. Permission checks and audit rows are always on.
 */

export const STEP_UP_HEADER = "x-admin-step-up";
export const STEP_UP_TTL_SECONDS = 5 * 60;
export const SUPPORT_ACCESS_DEFAULT_MINUTES = 30;
export const SUPPORT_ACCESS_MAX_MINUTES = 120;

export const FLAG_STEP_UP = "adminStepUp";
export const FLAG_SUPPORT_ACCESS = "adminSupportAccessRequired";

async function globalFlagEnabled(prisma: PrismaClient, key: string): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  return flag?.enabledByDefault ?? false;
}

// ----------------------------------------------------------------------------------- permission gate

export function requirePlatformPermission(permission: PlatformPermission): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = (req as AuthenticatedAdminRequest).adminUser?.role;
    if (!role || !canPlatform(role, permission)) {
      res.status(403).json({ error: "You do not have permission to perform this action.", code: "FORBIDDEN" });
      return;
    }
    next();
  };
}

// ------------------------------------------------------------------------------------------- step-up

/**
 * A step-up token is signed with a key derived from the admin JWT secret, so it can never be accepted as an access
 * token (and an access token can never be accepted as step-up). It carries the admin id and the access token's jti,
 * so it dies with the session on logout and cannot be moved to another admin's session.
 */
function stepUpKey(jwtSecret: string): string {
  return `${jwtSecret}::step-up`;
}

export function issueStepUpToken(adminUserId: string, sessionJti: string, jwtSecret: string): string {
  return jwt.sign({ adminUserId, sid: sessionJti, typ: "step-up" }, stepUpKey(jwtSecret), { expiresIn: STEP_UP_TTL_SECONDS });
}

export function verifyStepUpToken(token: string, adminUserId: string, sessionJti: string, jwtSecret: string): boolean {
  try {
    const decoded = jwt.verify(token, stepUpKey(jwtSecret));
    if (typeof decoded !== "object" || decoded === null) return false;
    const claims = decoded as Record<string, unknown>;
    return claims["typ"] === "step-up" && claims["adminUserId"] === adminUserId && claims["sid"] === sessionJti;
  } catch {
    return false;
  }
}

/** Requires a valid step-up token when the flag is on and `permission` is in the step-up set. */
export function requireStepUp(prisma: PrismaClient, jwtSecret: string, permission: PlatformPermission): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!PLATFORM_STEP_UP_PERMISSIONS.has(permission) || !(await globalFlagEnabled(prisma, FLAG_STEP_UP))) {
      next();
      return;
    }
    const admin = (req as AuthenticatedAdminRequest).adminUser;
    const token = req.header(STEP_UP_HEADER);
    if (!admin || !token || !verifyStepUpToken(token, admin.adminUserId, admin.jti, jwtSecret)) {
      res.status(403).json({ error: "Please confirm your password to continue.", code: "STEP_UP_REQUIRED" });
      return;
    }
    next();
  });
}

// -------------------------------------------------------------------------------------- support access

export interface OpenSupportAccessInput {
  adminUserId: string;
  businessId: string;
  reason: string;
  minutes?: number;
  now?: Date;
}

/** Records the reason and opens a time-boxed window. Also writes the audit row in the same transaction. */
export async function openSupportAccess(prisma: PrismaClient, input: OpenSupportAccessInput) {
  const now = input.now ?? new Date();
  const minutes = Math.min(Math.max(input.minutes ?? SUPPORT_ACCESS_DEFAULT_MINUTES, 1), SUPPORT_ACCESS_MAX_MINUTES);
  const expiresAt = new Date(now.getTime() + minutes * 60_000);
  return prisma.$transaction(async (tx) => {
    const access = await tx.supportAccess.create({
      data: { adminUserId: input.adminUserId, businessId: input.businessId, reason: input.reason, openedAt: now, expiresAt },
    });
    await tx.auditLog.create({
      data: {
        businessId: input.businessId,
        actorType: "ADMIN",
        actorId: input.adminUserId,
        action: "admin.support_access.opened",
        entityType: "SupportAccess",
        entityId: access.id,
        metadata: { reason: input.reason, expiresAt: expiresAt.toISOString() },
      },
    });
    return access;
  });
}

export async function hasActiveSupportAccess(prisma: PrismaClient, adminUserId: string, businessId: string, now: Date = new Date()) {
  const row = await prisma.supportAccess.findFirst({
    where: { adminUserId, businessId, expiresAt: { gt: now } },
    orderBy: { expiresAt: "desc" },
  });
  return row !== null;
}

/**
 * Gate for routes that expose one merchant's financial data (`:id` is the business id). A no-op while
 * `adminSupportAccessRequired` is off, so today's behaviour is unchanged. When on it requires (1) the
 * `admin:view_merchant_financials` permission (a read-only ANALYST cannot read a merchant's books) and (2) an
 * unexpired support-access record for that exact business, and it writes a per-read audit row
 * ("admin.merchant_financials.viewed") so every read of someone's books is traceable.
 */
export function requireSupportAccess(prisma: PrismaClient, entity: string): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!(await globalFlagEnabled(prisma, FLAG_SUPPORT_ACCESS))) {
      next();
      return;
    }
    const admin = (req as AuthenticatedAdminRequest).adminUser;
    if (!admin || !canPlatform(admin.role, "admin:view_merchant_financials")) {
      res.status(403).json({ error: "You do not have permission to perform this action.", code: "FORBIDDEN" });
      return;
    }
    const businessId = req.params["id"] as string;
    if (!(await hasActiveSupportAccess(prisma, admin.adminUserId, businessId))) {
      res.status(403).json({
        error: "Open a support-access session with a reason before viewing this merchant's financial data.",
        code: "SUPPORT_ACCESS_REQUIRED",
      });
      return;
    }
    await prisma.auditLog.create({
      data: {
        businessId,
        actorType: "ADMIN",
        actorId: admin.adminUserId,
        action: "admin.merchant_financials.viewed",
        entityType: entity,
        metadata: { path: req.path } satisfies Prisma.InputJsonValue,
      },
    });
    next();
  });
}

/** Platform-level audit row (no business). Used for admin-only actions such as step-up confirmation. */
export async function recordPlatformAudit(
  prisma: PrismaClient,
  input: { adminUserId: string; action: string; entityType: string; entityId?: string; businessId?: string; metadata?: Prisma.InputJsonValue },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      businessId: input.businessId ?? null,
      actorType: "ADMIN",
      actorId: input.adminUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
}
