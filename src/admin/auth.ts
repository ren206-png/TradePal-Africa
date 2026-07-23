import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { AdminRole } from "@prisma/client";

const BCRYPT_COST_FACTOR = 12;

export async function hashAdminPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export async function verifyAdminPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export interface AdminJwtIssuePayload {
  adminUserId: string;
  email: string;
  role: AdminRole;
}

/**
 * `jti`/`exp` are always present on a verified token (reserved JWT claims we
 * set/require ourselves) — they back the logout/revocation flow below, since
 * a stateless JWT can't otherwise be invalidated before it naturally expires.
 */
export interface AdminJwtPayload extends AdminJwtIssuePayload {
  jti: string;
  exp: number; // unix seconds
}

/**
 * Short-lived (12h) access token — the admin dashboard is expected to be an
 * internal, low-traffic surface (see AdminUser docstring: "Internal TradePal
 * staff"), so there is no refresh-token flow yet; a support/analyst simply
 * logs in again once a token expires. `jwt.sign`'s payload spread requires
 * an index-signature-compatible object, hence the `Record<string, unknown>`
 * cast rather than passing `AdminJwtIssuePayload` directly. Every token gets
 * a fresh `jti` (via the `jwtid` option) so a single token — not the whole
 * account — can be revoked on logout; see src/admin/tokenRevocation.ts.
 */
export function issueAdminJwt(payload: AdminJwtIssuePayload, secret: string): string {
  return jwt.sign(payload as unknown as Record<string, unknown>, secret, {
    expiresIn: "12h",
    jwtid: randomUUID(),
  });
}

/** Returns null (rather than throwing) for any invalid/expired/malformed token — callers treat
 * a null result as "not authenticated" uniformly, without needing to know which failure mode. */
export function verifyAdminJwt(token: string, secret: string): AdminJwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded !== "object" || decoded === null) return null;
    const { adminUserId, email, role, jti, exp } = decoded as Record<string, unknown>;
    if (
      typeof adminUserId !== "string" ||
      typeof email !== "string" ||
      typeof role !== "string" ||
      typeof jti !== "string" ||
      typeof exp !== "number"
    ) {
      return null;
    }
    return { adminUserId, email, role: role as AdminRole, jti, exp };
  } catch {
    return null;
  }
}
