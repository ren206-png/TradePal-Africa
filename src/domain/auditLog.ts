import { Prisma, type ActorType } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";

export interface RecordAuditLogInput {
  businessId: string;
  actorType: ActorType;
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Non-Negotiable Standard #8: one AuditLog row per state-changing action.
 * This is intentionally a thin, un-opinionated recorder — callers decide
 * what counts as an auditable action and what `action`/`entityType` strings
 * to use; this function only owns the actual write. Takes a
 * TenantScopedClient (rather than raw PrismaClient) so every audit row is
 * mechanically pinned to the acting business, same as every other
 * tenant-scoped write in this codebase.
 */
export async function recordAuditLog(scopedPrisma: TenantScopedClient, input: RecordAuditLogInput) {
  return scopedPrisma.auditLog.create({
    data: {
      businessId: input.businessId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
}
