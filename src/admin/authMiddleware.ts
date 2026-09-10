import type { AdminRole, PrismaClient } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "./asyncHandler.js";
import { verifyAdminJwt, type AdminJwtPayload } from "./auth.js";
import { isAdminTokenRevoked } from "./tokenRevocation.js";

export interface AuthenticatedAdminRequest extends Request {
  adminUser?: AdminJwtPayload;
}

/**
 * Populates `req.adminUser` from a `Bearer <jwt>` Authorization header, or
 * responds 401 if it's missing/invalid/expired/revoked. Every `/admin/*`
 * route except `/admin/login` should sit behind this. Requires `prisma` (in
 * addition to the JWT secret) to check the revocation list populated by
 * `POST /admin/logout` — a signature-valid, unexpired token can still be
 * rejected here if it was explicitly logged out.
 *
 * Wrapped in `asyncHandler` (see its own doc comment, asyncHandler.ts): the
 * `isAdminTokenRevoked` call below is an unguarded `await`, and this
 * middleware sits in front of nearly every admin route via
 * `router.use(requireAdminAuth(...))` — a transient error here (e.g. a
 * dropped DB connection) must reach the centralized error handler and fail
 * only the one request, not crash the whole process.
 */
export function requireAdminAuth(prisma: PrismaClient, jwtSecret: string) {
  return asyncHandler(async (req: AuthenticatedAdminRequest, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

    if (!token) {
      res.status(401).json({ error: "Missing or malformed Authorization header." });
      return;
    }

    const payload = verifyAdminJwt(token, jwtSecret);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token." });
      return;
    }

    if (await isAdminTokenRevoked(prisma, payload.jti)) {
      res.status(401).json({ error: "This session has been logged out." });
      return;
    }

    req.adminUser = payload;
    next();
  });
}

/**
 * RBAC gate: must run after `requireAdminAuth`. Non-negotiable per the
 * Phase 2 mandate ("RBAC before any write") — every write-capable route
 * lists exactly which roles may call it, rather than defaulting open.
 */
export function requireAdminRole(...allowedRoles: AdminRole[]) {
  return (req: AuthenticatedAdminRequest, res: Response, next: NextFunction): void => {
    const role = req.adminUser?.role;
    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({ error: "You do not have permission to perform this action." });
      return;
    }
    next();
  };
}
