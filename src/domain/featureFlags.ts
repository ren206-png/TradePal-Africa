import type { ActorType, FeatureFlag, PrismaClient } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { recordAuditLog } from "./auditLog.js";

export class FeatureFlagNotFoundError extends Error {}

/**
 * Non-Negotiable Standard #7: every FeatureFlag defaults to `enabledByDefault:
 * false`, and a business only sees a feature once a BusinessFeatureFlag row
 * explicitly turns it on (or, for a flag the business has never overridden,
 * once the global flag's own default is flipped to true). A per-business
 * override always wins over the global default in both directions — a
 * business can be opted in early or opted out even after global rollout.
 */
export async function isFeatureEnabled(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  flagKey: string,
): Promise<boolean> {
  const override = await scopedPrisma.businessFeatureFlag.findUnique({
    where: { businessId_flagKey: { businessId, flagKey } },
  });
  if (override) return override.enabled;

  const flag = await scopedPrisma.featureFlag.findUnique({ where: { key: flagKey } });
  return flag?.enabledByDefault ?? false;
}

/**
 * Deliberately checks only that the flag exists, not the business — a
 * business-existence check belongs at the admin-route layer here (mirroring
 * `GET /admin/businesses/:id`'s own inline 404), not in this module: the
 * obvious alternative (importing `BusinessNotFoundError` from planAdmin.ts)
 * would create a circular import, since planAdmin.ts imports from billing.ts,
 * and billing.ts already imports `isFeatureEnabled` from this same file.
 */
async function assertFlagExists(scopedPrisma: TenantScopedClient, flagKey: string): Promise<void> {
  const flag = await scopedPrisma.featureFlag.findUnique({ where: { key: flagKey } });
  if (!flag) throw new FeatureFlagNotFoundError(`Feature flag '${flagKey}' does not exist.`);
}

export interface SetFeatureFlagForBusinessOptions {
  reason?: string;
  changedByAdminUserId?: string;
  actorType?: ActorType;
}

/**
 * Sets (creating or overwriting) a business-level override, regardless of
 * the flag's global default — this is the per-business half of Phase 10's
 * feature-flag admin tooling (the other half, `setFeatureFlagGlobalDefault`,
 * is the actual bulk-rollout mechanism). Checks the flag actually exists
 * first (rather than relying on the BusinessFeatureFlag foreign key to
 * reject a bad write with a raw database error), since this is now called
 * from an admin route with a URL-supplied flag key, not only from trusted
 * internal test setup — callers are expected to have already checked the
 * business itself exists (see the module doc comment on `assertFlagExists`).
 * Records one AuditLog row per call (Standard #8) — this was previously
 * un-audited since every prior caller was test setup, not a real admin
 * action.
 */
export async function setFeatureFlagForBusiness(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  flagKey: string,
  enabled: boolean,
  options: SetFeatureFlagForBusinessOptions = {},
) {
  await assertFlagExists(scopedPrisma, flagKey);

  const override = await scopedPrisma.businessFeatureFlag.upsert({
    where: { businessId_flagKey: { businessId, flagKey } },
    update: { enabled },
    create: { businessId, flagKey, enabled },
  });

  await recordAuditLog(scopedPrisma, {
    businessId,
    actorType: options.actorType ?? "ADMIN",
    ...(options.changedByAdminUserId ? { actorId: options.changedByAdminUserId } : {}),
    action: "BUSINESS_FEATURE_FLAG_SET",
    entityType: "BusinessFeatureFlag",
    entityId: flagKey,
    metadata: { enabled, reason: options.reason ?? null },
  });

  return override;
}

export interface RemoveFeatureFlagOverrideOptions {
  reason?: string;
  changedByAdminUserId?: string;
  actorType?: ActorType;
}

/**
 * Reverts a business back to whatever the flag's global default currently
 * is, by deleting its override row outright rather than setting `enabled`
 * to match today's default — a plain delete stays correct even if the
 * global default changes again later, whereas copying today's default in
 * would silently freeze the business's behavior at that snapshot. Returns
 * `false` (and records nothing) if the business had no override to remove —
 * idempotent, since there's no actual state change to audit in that case.
 */
export async function removeFeatureFlagOverrideForBusiness(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  flagKey: string,
  options: RemoveFeatureFlagOverrideOptions = {},
): Promise<boolean> {
  await assertFlagExists(scopedPrisma, flagKey);

  const { count } = await scopedPrisma.businessFeatureFlag.deleteMany({ where: { businessId, flagKey } });
  if (count === 0) return false;

  await recordAuditLog(scopedPrisma, {
    businessId,
    actorType: options.actorType ?? "ADMIN",
    ...(options.changedByAdminUserId ? { actorId: options.changedByAdminUserId } : {}),
    action: "BUSINESS_FEATURE_FLAG_OVERRIDE_REMOVED",
    entityType: "BusinessFeatureFlag",
    entityId: flagKey,
    metadata: { reason: options.reason ?? null },
  });
  return true;
}

/** Every FeatureFlag row that exists, for the admin feature-flags list page. */
export async function listFeatureFlags(prisma: PrismaClient): Promise<FeatureFlag[]> {
  return prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
}

/**
 * Flips a FeatureFlag's global default — the actual bulk-rollout (or
 * bulk-rollback) mechanism: per `isFeatureEnabled`'s own logic, any business
 * that has never set its own BusinessFeatureFlag override immediately picks
 * up the new default, while a business with an explicit override (opted in
 * early, or opted out) keeps its own choice regardless. `FeatureFlag` is
 * global reference data, not tenant-scoped (like `Plan` — see
 * `upsertPlan`'s doc comment in planAdmin.ts), so this deliberately takes a
 * raw `PrismaClient` and records no AuditLog row: a global default change
 * doesn't belong to any single business, and `AuditLog` rows in this
 * codebase are always attributed to one.
 */
export async function setFeatureFlagGlobalDefault(
  prisma: PrismaClient,
  flagKey: string,
  enabledByDefault: boolean,
): Promise<FeatureFlag> {
  const existing = await prisma.featureFlag.findUnique({ where: { key: flagKey } });
  if (!existing) throw new FeatureFlagNotFoundError(`Feature flag '${flagKey}' does not exist.`);

  return prisma.featureFlag.update({ where: { key: flagKey }, data: { enabledByDefault } });
}

export interface FeatureFlagState {
  key: string;
  description: string;
  enabledByDefault: boolean;
  /** `null` means this business has never overridden the flag — it simply follows `enabledByDefault`. */
  override: boolean | null;
  /** What `isFeatureEnabled` would actually return for this business right now. */
  effective: boolean;
}

/**
 * Merged, per-business view used by the admin business-detail page: every
 * FeatureFlag that exists, alongside this business's own override (if any)
 * and the actually-effective boolean `isFeatureEnabled` would compute — so
 * an operator sees both "what everyone gets by default" and "what this
 * specific business gets" without one round trip per flag. Does not itself
 * check the business exists (see the module doc comment on
 * `assertFlagExists` for why that check lives at the admin-route layer
 * instead) — a nonexistent businessId simply returns every flag with
 * `override: null`, since `businessFeatureFlag.findMany` for a business with
 * no rows returns an empty list rather than erroring.
 */
export async function listFeatureFlagStatesForBusiness(
  scopedPrisma: TenantScopedClient,
  businessId: string,
): Promise<FeatureFlagState[]> {
  const [flags, overrides] = await Promise.all([
    scopedPrisma.featureFlag.findMany({ orderBy: { key: "asc" } }),
    scopedPrisma.businessFeatureFlag.findMany({ where: { businessId } }),
  ]);

  const overrideByKey = new Map(overrides.map((override) => [override.flagKey, override.enabled]));

  return flags.map((flag) => {
    const override = overrideByKey.has(flag.key) ? (overrideByKey.get(flag.key) as boolean) : null;
    return {
      key: flag.key,
      description: flag.description,
      enabledByDefault: flag.enabledByDefault,
      override,
      effective: override ?? flag.enabledByDefault,
    };
  });
}
