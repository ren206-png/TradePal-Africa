import type { AdminSession, PrismaClient } from "@prisma/client";
import { callerHashes } from "./securityEvents.js";
import type { AdminSessionPolicy } from "./adminConfig.js";

/**
 * Server-side admin sessions (admin-console Phase 2). The access token's `jti` is the session id; the token proves WHO, this row decides
 * whether the sign-in is still alive: not revoked, inside its absolute lifetime, not idle too long, and (when a second factor applies)
 * past the second factor within the allowed time. The admin audience is fixed in the database (`AdminSession_values_check`), so a
 * consumer or merchant session can never be one of these.
 */
export type SessionVerdict =
  | { ok: true; session: AdminSession }
  | { ok: false; reason: "NONE" | "REVOKED" | "EXPIRED" | "IDLE" | "MFA_TIMEOUT" };

/** `lastSeenAt` is rewritten at most once a minute so a busy console does not turn every request into a database write. */
const TOUCH_INTERVAL_MS = 60_000;

export async function createAdminSession(
  prisma: PrismaClient,
  input: { adminUserId: string; policy: AdminSessionPolicy; mfaVerified: boolean; req: Parameters<typeof callerHashes>[0]; jwtSecret: string; now?: Date },
): Promise<AdminSession> {
  const now = input.now ?? new Date();
  const { ipHash, userAgentHash } = callerHashes(input.req, input.jwtSecret);
  return prisma.adminSession.create({
    data: {
      adminUserId: input.adminUserId,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + input.policy.absoluteMs),
      // A sign-in with nothing more to prove counts as a fresh confirmation; otherwise the second factor sets both.
      mfaVerifiedAt: input.mfaVerified ? now : null,
      reauthAt: input.mfaVerified ? now : null,
      ipHash,
      userAgentHash,
    },
  });
}

export async function loadSession(prisma: PrismaClient, id: string, policy: AdminSessionPolicy, mfaApplies: boolean, now: Date = new Date()): Promise<SessionVerdict> {
  const session = await prisma.adminSession.findUnique({ where: { id } });
  if (!session) return { ok: false, reason: "NONE" };
  if (session.revokedAt) return { ok: false, reason: "REVOKED" };
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) return { ok: false, reason: "EXPIRED" };
  if (now.getTime() - session.lastSeenAt.getTime() > policy.idleMs) return { ok: false, reason: "IDLE" };
  if (mfaApplies && !session.mfaVerifiedAt && now.getTime() - session.createdAt.getTime() > policy.preMfaMs) return { ok: false, reason: "MFA_TIMEOUT" };
  if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    await prisma.adminSession.updateMany({ where: { id, revokedAt: null }, data: { lastSeenAt: now } });
  }
  return { ok: true, session };
}

export async function revokeAdminSession(prisma: PrismaClient, id: string, reason: string, now: Date = new Date()): Promise<boolean> {
  const r = await prisma.adminSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
  return r.count > 0;
}

/** Ends every live session of one admin (optionally keeping one, e.g. the caller's own). Returns how many were ended. */
export async function revokeAllAdminSessions(prisma: PrismaClient, adminUserId: string, reason: string, exceptId?: string, now: Date = new Date()): Promise<number> {
  const r = await prisma.adminSession.updateMany({
    where: { adminUserId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { revokedAt: now, revokedReason: reason },
  });
  return r.count;
}

export async function markSessionMfaVerified(prisma: PrismaClient, id: string, now: Date = new Date()): Promise<void> {
  await prisma.adminSession.update({ where: { id }, data: { mfaVerifiedAt: now, reauthAt: now } });
}

export async function markSessionReauth(prisma: PrismaClient, id: string, now: Date = new Date()): Promise<void> {
  await prisma.adminSession.update({ where: { id }, data: { reauthAt: now } });
}

/** Whether the last fresh confirmation is recent enough for a sensitive action. */
export function reauthIsFresh(session: Pick<AdminSession, "reauthAt">, policy: AdminSessionPolicy, now: Date = new Date()): boolean {
  return session.reauthAt !== null && now.getTime() - session.reauthAt.getTime() <= policy.reauthMs;
}
