import type { Business, PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { recordAuditLog } from "./auditLog.js";
import { BusinessNotFoundError } from "./planAdmin.js";

export { BusinessNotFoundError };
export class BusinessAlreadySuspendedError extends Error {}
export class BusinessNotSuspendedError extends Error {}

/**
 * Phase 29: platform-moderation suspension — a full `Business` cut off for
 * violating platform rules. Distinct from the two superficially similar
 * mechanisms already in this codebase:
 *  - `Merchant.removedAt` (`/removestaff`) only ever soft-deactivates a
 *    single STAFF merchant, never an OWNER or the whole business.
 *  - `DeletionRequest` is customer-initiated GDPR data deletion, not
 *    owner-initiated (or here, admin-initiated) moderation.
 *
 * This is the highest-blast-radius admin action in the codebase — it blocks
 * every merchant on the business at once, everywhere they'd otherwise be
 * checked (the live WhatsApp path, via `isBusinessSuspended` in
 * `messageDispatcher.ts`). SUPER_ADMIN-only at the route layer
 * (`adminRoutes.ts`), stricter than the SUPER_ADMIN-or-SUPPORT bar used for
 * subscription/phone-number/feature-flag writes.
 */
export interface SuspendBusinessInput {
  businessId: string;
  /** Mandatory, mirroring changeMerchantPhoneNumber's convention for a similarly consequential,
   * human-judgment-driven action — the paper trail is the point. */
  reason: string;
  /** The AdminUser.id of the operator performing this change, for AuditLog.actorId. */
  suspendedByAdminUserId?: string;
}

export async function suspendBusiness(prisma: PrismaClient, input: SuspendBusinessInput): Promise<Business> {
  if (!input.reason.trim()) {
    throw new Error("suspendBusiness requires a non-empty reason.");
  }

  const business = await prisma.business.findUnique({ where: { id: input.businessId } });
  if (!business) throw new BusinessNotFoundError(`Business '${input.businessId}' not found.`);
  if (business.status === "SUSPENDED") {
    throw new BusinessAlreadySuspendedError(`Business '${input.businessId}' is already suspended.`);
  }

  // Business itself is reference/tenant-root data, not a TENANT_SCOPED_MODELS entry (see
  // tenantScope.ts) — the update goes through the raw client, mirroring assignSubscription /
  // cancelActiveSubscription in planAdmin.ts. The AuditLog write still goes through a
  // tenant-scoped client, since AuditLog itself is a tenant-scoped model.
  const updated = await prisma.business.update({
    where: { id: input.businessId },
    data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: input.reason },
  });

  const scoped = getTenantScopedClient(prisma, input.businessId);
  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "ADMIN",
    ...(input.suspendedByAdminUserId ? { actorId: input.suspendedByAdminUserId } : {}),
    action: "BUSINESS_SUSPENDED",
    entityType: "Business",
    entityId: input.businessId,
    metadata: { reason: input.reason },
  });

  return updated;
}

export interface ReinstateBusinessInput {
  businessId: string;
  reason?: string;
  /** The AdminUser.id of the operator performing this change, for AuditLog.actorId. */
  reinstatedByAdminUserId?: string;
}

/** The counterpart to suspendBusiness — clears status back to ACTIVE and wipes
 * suspendedAt/suspensionReason (rather than leaving a stale reason behind). */
export async function reinstateBusiness(prisma: PrismaClient, input: ReinstateBusinessInput): Promise<Business> {
  const business = await prisma.business.findUnique({ where: { id: input.businessId } });
  if (!business) throw new BusinessNotFoundError(`Business '${input.businessId}' not found.`);
  if (business.status !== "SUSPENDED") {
    throw new BusinessNotSuspendedError(`Business '${input.businessId}' is not currently suspended.`);
  }

  const updated = await prisma.business.update({
    where: { id: input.businessId },
    data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null },
  });

  const scoped = getTenantScopedClient(prisma, input.businessId);
  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "ADMIN",
    ...(input.reinstatedByAdminUserId ? { actorId: input.reinstatedByAdminUserId } : {}),
    action: "BUSINESS_REINSTATED",
    entityType: "Business",
    entityId: input.businessId,
    metadata: { reason: input.reason ?? null },
  });

  return updated;
}

/**
 * Powers the messageDispatcher.ts suspension gate — a single indexed
 * (primary-key) lookup rather than fetching the full Business row, since the
 * live message path already runs this check on every inbound message from a
 * merchant whose onboarding is otherwise clear.
 */
export async function isBusinessSuspended(prisma: PrismaClient, businessId: string): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { status: true } });
  return business?.status === "SUSPENDED";
}
