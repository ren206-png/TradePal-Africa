import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { recordPlatformAudit } from "./platformGuards.js";

/**
 * Every admin request gets a correlation id (the caller's `x-correlation-id` if it is a sane token, else a new
 * UUID), echoed back in the response header and written into every audit row the request produces.
 */
const SANE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function correlationMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.header("x-correlation-id");
    const id = supplied && SANE_ID.test(supplied) ? supplied : randomUUID();
    res.locals["correlationId"] = id;
    res.setHeader("x-correlation-id", id);
    next();
  };
}

export function correlationIdOf(res: Response): string {
  return String(res.locals["correlationId"] ?? "");
}

const ENTITY_BY_SEGMENT: Record<string, string> = {
  businesses: "Business",
  merchants: "Merchant",
  "deletion-requests": "DeletionRequest",
  plans: "Plan",
  "feature-flags": "FeatureFlag",
  maintenance: "Maintenance",
  "support-cases": "SupportCase",
};

// Routes with their own, richer audit trail or that are not data writes.
const SKIP = new Set(["/logout", "/step-up"]);

/**
 * Guarantee (expansion scenario 28): every successful admin WRITE leaves an audit row with the acting admin, the
 * target, the correlation id and the stated reason, even when the handler's domain code records nothing itself.
 * It wraps `res.json` so the row is written BEFORE the success response leaves the server; if the insert fails the
 * request still answers (the change already happened) and the failure is logged loudly.
 */
export function auditAdminWrites(prisma: PrismaClient): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const original = res.json.bind(res);
    res.json = ((body?: unknown) => {
      const admin = (req as AuthenticatedAdminRequest).adminUser;
      const routePath: string = req.route?.path ?? req.path;
      if (res.statusCode >= 400 || !admin || SKIP.has(routePath)) return original(body);
      const segment = routePath.split("/").filter(Boolean)[0] ?? "";
      const entityId = typeof req.params["id"] === "string" ? req.params["id"] : undefined;
      const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === "string" ? String((req.body as { reason: string }).reason).slice(0, 300) : undefined;
      recordPlatformAudit(prisma, {
        adminUserId: admin.adminUserId,
        action: `admin.write ${req.method} ${routePath}`,
        entityType: ENTITY_BY_SEGMENT[segment] ?? "Admin",
        ...(entityId ? { entityId } : {}),
        ...(segment === "businesses" && entityId ? { businessId: entityId } : {}),
        metadata: { correlationId: correlationIdOf(res), status: res.statusCode, ...(reason ? { reason } : {}) },
        correlationId: correlationIdOf(res),
      })
        .catch((error) => console.error("ADMIN AUDIT WRITE FAILED (action succeeded, row missing):", error instanceof Error ? error.message : error))
        .finally(() => original(body));
      return res;
    }) as typeof res.json;
    next();
  };
}
