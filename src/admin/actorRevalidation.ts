import type { PrismaClient } from "@prisma/client";
import { canPlatform, type PlatformPermission } from "../auth/permissions.js";

/**
 * Re-checks the actor of a QUEUED admin action at the moment it runs (not when it was queued). An action a person queued and then lost the
 * right to do, or was removed before it ran, must not execute: the person's account must still be active, their CURRENT role must still hold
 * the permission, and (when the caller recorded it at queue time) their role must not have changed since. The role always comes from the
 * database, never from the queued payload.
 */
export type ActorVerdict = { ok: true; role: string; roleVersion: number } | { ok: false; reason: "NOT_FOUND" | "DISABLED" | "PERMISSION_LOST" | "ROLE_CHANGED" };

export async function revalidateActor(
  prisma: PrismaClient,
  input: { adminUserId: string; permission: PlatformPermission; roleVersionAtQueue?: number },
): Promise<ActorVerdict> {
  const a = await prisma.adminUser.findUnique({ where: { id: input.adminUserId }, select: { role: true, roleVersion: true, disabledAt: true } });
  if (!a) return { ok: false, reason: "NOT_FOUND" };
  if (a.disabledAt) return { ok: false, reason: "DISABLED" };
  if (input.roleVersionAtQueue !== undefined && a.roleVersion !== input.roleVersionAtQueue) return { ok: false, reason: "ROLE_CHANGED" };
  if (!canPlatform(a.role, input.permission)) return { ok: false, reason: "PERMISSION_LOST" };
  return { ok: true, role: a.role, roleVersion: a.roleVersion };
}
