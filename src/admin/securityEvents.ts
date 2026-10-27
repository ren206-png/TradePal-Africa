import type { Prisma, PrismaClient } from "@prisma/client";
import type { Request } from "express";
import { keyedHash } from "./adminConfig.js";

/**
 * Sign-in, second-factor, session and denied-access events (admin-console Phase 2). Rows are append-only (database trigger) and
 * never hold a token, a password, a code or a secret, or a raw address: only keyed hashes of the caller's address, user agent and the
 * email that was tried. A write failure is logged and swallowed: a security record must never be the reason a request fails.
 */
export type SecurityEventType =
  | "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGIN_RATE_LIMITED"
  | "MFA_ENROL_STARTED" | "MFA_ENROLLED" | "MFA_CHALLENGE_PASSED" | "MFA_FAILED" | "MFA_RATE_LIMITED"
  | "RECOVERY_CODE_USED" | "RECOVERY_CODE_FAILED" | "RECOVERY_CODES_REGENERATED" | "MFA_RESET"
  | "REAUTH_SUCCESS" | "REAUTH_FAILED"
  | "WHATSAPP_CODE_SENT" | "WHATSAPP_CODE_FAILED" | "WHATSAPP_ENROLL_STARTED" | "WHATSAPP_ENROLLED" | "WHATSAPP_REMOVED"
  | "LOGOUT" | "SESSION_REVOKED" | "SESSION_EXPIRED"
  | "ACCESS_DENIED"
  | "INVITATION_CREATED" | "INVITATION_REVOKED" | "INVITATION_ACCEPTED" | "INVITATION_REJECTED"
  | "STAFF_ROLE_CHANGED" | "STAFF_DISABLED" | "STAFF_ENABLED"
  | "OWNERSHIP_TRANSFER_STARTED" | "OWNERSHIP_TRANSFER_ACCEPTED" | "OWNERSHIP_TRANSFER_CANCELLED"
  | "OWNER_BOOTSTRAPPED";

export interface SecurityEventInput {
  type: SecurityEventType;
  result: "SUCCESS" | "FAILURE" | "DENIED";
  adminUserId?: string | null;
  /** The email that was tried (hashed before storing). */
  subject?: string;
  correlationId?: string | undefined;
  metadata?: Prisma.InputJsonValue;
}

export interface CallerHashes {
  ipHash: string | null;
  userAgentHash: string | null;
}

export function callerHashes(req: Pick<Request, "ip" | "headers">, jwtSecret: string): CallerHashes {
  const ip = req.ip ?? "";
  const ua = typeof req.headers?.["user-agent"] === "string" ? (req.headers["user-agent"] as string) : "";
  return { ipHash: ip ? keyedHash(jwtSecret, "ip", ip) : null, userAgentHash: ua ? keyedHash(jwtSecret, "ua", ua.slice(0, 300)) : null };
}

export async function recordSecurityEvent(
  prisma: PrismaClient,
  jwtSecret: string,
  req: Pick<Request, "ip" | "headers"> | null,
  input: SecurityEventInput,
): Promise<void> {
  try {
    const hashes = req ? callerHashes(req, jwtSecret) : { ipHash: null, userAgentHash: null };
    await prisma.securityEvent.create({
      data: {
        adminUserId: input.adminUserId ?? null,
        subjectHash: input.subject ? keyedHash(jwtSecret, "subject", input.subject) : null,
        eventType: input.type,
        result: input.result,
        ipHash: hashes.ipHash,
        userAgentHash: hashes.userAgentHash,
        correlationId: input.correlationId ?? null,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  } catch (error) {
    console.error("SECURITY EVENT WRITE FAILED:", input.type, error instanceof Error ? error.message : error);
  }
}
