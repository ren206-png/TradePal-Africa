import type { PrismaClient } from "@prisma/client";
import { adminBootstrapAllowed } from "./adminConfig.js";
import { resetMfaFor } from "./mfa.js";
import { revokeAllAdminSessions } from "./adminSessions.js";
import { recordSecurityEvent } from "./securityEvents.js";

/**
 * Server-side commands run with deployment credentials (never over HTTP): promote an existing staff account to platform owner, and
 * re-enrol a locked-out person's second factor. Both refuse to run unless ADMIN_BOOTSTRAP_ALLOWED=true, both need the identity typed
 * twice (`--identity` and `--confirm`), both leave an audit row and a security event with actor `system:bootstrap`, and neither
 * prints or accepts a secret. They never choose a password: the account must already exist (scripts/createAdminUser.ts or an invitation).
 */
export class BootstrapError extends Error {
  readonly code: "DISABLED" | "CONFIRM_MISMATCH" | "NOT_FOUND" | "ACCOUNT_DISABLED" | "AMBIGUOUS";
  constructor(code: BootstrapError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BOOTSTRAP_ACTOR = "system:bootstrap";

async function resolveIdentity(prisma: PrismaClient, identity: string, confirm: string, env: NodeJS.ProcessEnv) {
  if (!adminBootstrapAllowed(env)) throw new BootstrapError("DISABLED", "Refused: ADMIN_BOOTSTRAP_ALLOWED is not set to true for this run.");
  const id = identity.trim();
  if (!id || id.toLowerCase() !== confirm.trim().toLowerCase()) throw new BootstrapError("CONFIRM_MISMATCH", "Refused: --confirm must repeat --identity exactly.");
  const admin = UUID.test(id) ? await prisma.adminUser.findUnique({ where: { id } }) : await prisma.adminUser.findUnique({ where: { email: id.toLowerCase() } });
  if (!admin) throw new BootstrapError("NOT_FOUND", "No staff account matches that identity. Create it first (scripts/createAdminUser.ts) or invite it.");
  return admin;
}

export async function bootstrapOwner(
  prisma: PrismaClient,
  input: { identity: string; confirm: string; env?: NodeJS.ProcessEnv; jwtSecret?: string; now?: Date },
): Promise<{ status: "PROMOTED" | "ALREADY_OWNER"; adminUserId: string; email: string }> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const admin = await resolveIdentity(prisma, input.identity, input.confirm, env);
  if (admin.disabledAt) throw new BootstrapError("ACCOUNT_DISABLED", "That account is disabled. Enable it first; this command will not do it silently.");
  if (admin.role === "SUPER_ADMIN") return { status: "ALREADY_OWNER", adminUserId: admin.id, email: admin.email };
  await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: admin.id }, data: { role: "SUPER_ADMIN", mfaRequiredAt: admin.mfaRequiredAt ?? now } });
    await tx.staffRoleChange.create({ data: { adminUserId: admin.id, fromRole: admin.role, toRole: "SUPER_ADMIN", changedById: null, reason: "first-owner bootstrap command" } });
    await tx.auditLog.create({ data: { actorType: "SYSTEM", actorId: BOOTSTRAP_ACTOR, action: "admin.staff.owner_bootstrapped", entityType: "AdminUser", entityId: admin.id, metadata: { from: admin.role } } });
  });
  await recordSecurityEvent(prisma, input.jwtSecret ?? env["ADMIN_JWT_SECRET"] ?? "bootstrap", null, { type: "OWNER_BOOTSTRAPPED", result: "SUCCESS", adminUserId: admin.id });
  return { status: "PROMOTED", adminUserId: admin.id, email: admin.email };
}

/** Lockout recovery: removes the second factor and recovery codes, ends every session, and requires enrolment again at next sign-in. */
export async function resetAdminMfaCommand(
  prisma: PrismaClient,
  input: { identity: string; confirm: string; env?: NodeJS.ProcessEnv; jwtSecret?: string; now?: Date },
): Promise<{ adminUserId: string; email: string; sessionsEnded: number }> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const admin = await resolveIdentity(prisma, input.identity, input.confirm, env);
  await resetMfaFor(prisma, admin.id, now);
  const sessionsEnded = await revokeAllAdminSessions(prisma, admin.id, "second factor reset by the recovery command", undefined, now);
  await prisma.auditLog.create({ data: { actorType: "SYSTEM", actorId: BOOTSTRAP_ACTOR, action: "admin.staff.mfa_reset", entityType: "AdminUser", entityId: admin.id, metadata: { sessionsEnded } } });
  await recordSecurityEvent(prisma, input.jwtSecret ?? env["ADMIN_JWT_SECRET"] ?? "bootstrap", null, { type: "MFA_RESET", result: "SUCCESS", adminUserId: admin.id, metadata: { sessionsEnded } });
  return { adminUserId: admin.id, email: admin.email, sessionsEnded };
}
