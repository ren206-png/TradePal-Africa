import type { PrismaClient } from "@prisma/client";

/**
 * Stateless JWTs can't be invalidated by themselves — this table is the
 * revocation mechanism (closes the Phase 2 "no logout/no revocation" gap).
 * `RevokedAdminToken` is deliberately not tenant-scoped (mirrors `AdminUser`).
 *
 * Every call opportunistically deletes rows whose underlying token would
 * have expired naturally anyway, so the table stays roughly bounded to
 * "tokens revoked but not yet naturally expired" rather than growing
 * forever. A dedicated cleanup cron would be more precise but is unscoped
 * for this phase — this lazy sweep is a deliberate, disclosed simplification.
 */
export async function revokeAdminToken(prisma: PrismaClient, jti: string, expiresAtUnixSeconds: number): Promise<void> {
  const expiresAt = new Date(expiresAtUnixSeconds * 1000);

  await prisma.revokedAdminToken.upsert({
    where: { jti },
    create: { jti, expiresAt },
    update: { expiresAt },
  });

  await prisma.revokedAdminToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

export async function isAdminTokenRevoked(prisma: PrismaClient, jti: string): Promise<boolean> {
  const revoked = await prisma.revokedAdminToken.findUnique({ where: { jti } });
  return revoked !== null;
}
