import type { Plan, PrismaClient, Subscription } from "@prisma/client";
import { recordAuditLog } from "./auditLog.js";
import { PlanNotFoundError } from "./billing.js";
import { getTenantScopedClient } from "../db/tenantScope.js";

export { PlanNotFoundError };
export class BusinessNotFoundError extends Error {}
export class CurrencyNotFoundError extends Error {}
export class PlanValidationError extends Error {}
export class InvalidSubscriptionPeriodError extends Error {}
export class NoActiveSubscriptionError extends Error {}

/**
 * Admin-only console for managing billing `Plan`s and assigning/canceling a
 * business's `Subscription` — the piece Phase 4's billing quota enforcement
 * deliberately left out ("no admin tooling to manage Subscription/Plan rows
 * ... still requires direct database access"). This closes that gap without
 * touching actual payment collection, which remains explicitly out of scope
 * (needs a human decision on a payment gateway) — every operation here is an
 * admin *assigning* a plan a business is already deemed entitled to, not a
 * charge of any kind.
 */

export interface UpsertPlanInput {
  code: string;
  name: string;
  priceMinor: bigint;
  currencyCode: string;
  entryCapPerMonth: number | null;
  voiceEnabled: boolean;
  /** Phase 14: caps how many active STAFF Merchant rows /addstaff can create for a business on this plan. null = uncapped. */
  staffCapCount: number | null;
}

export async function listPlans(prisma: PrismaClient): Promise<Plan[]> {
  return prisma.plan.findMany({ orderBy: { code: "asc" } });
}

/**
 * `Plan` is reference/master data, not tenant-scoped (see the comment on
 * TENANT_SCOPED_MODELS in tenantScope.ts), so this takes the raw
 * `PrismaClient`. There is deliberately no `AuditLog` row for this action:
 * `AuditLog.businessId` is `NOT NULL` and a `Plan` doesn't belong to any one
 * business — pricing/plan-definition changes are global, not tenant events.
 * If a paper trail for "who changed a plan's price" is ever needed, it
 * belongs in a separate, plan-scoped audit table, not this one.
 */
export async function upsertPlan(prisma: PrismaClient, input: UpsertPlanInput): Promise<Plan> {
  if (!input.code.trim()) throw new PlanValidationError("Plan code is required.");
  if (!input.name.trim()) throw new PlanValidationError("Plan name is required.");
  if (input.priceMinor < 0n) throw new PlanValidationError("priceMinor cannot be negative.");
  if (input.entryCapPerMonth !== null && input.entryCapPerMonth < 0) {
    throw new PlanValidationError("entryCapPerMonth cannot be negative.");
  }
  if (input.staffCapCount !== null && input.staffCapCount < 0) {
    throw new PlanValidationError("staffCapCount cannot be negative.");
  }

  const currency = await prisma.currency.findUnique({ where: { code: input.currencyCode } });
  if (!currency) {
    throw new CurrencyNotFoundError(`Currency '${input.currencyCode}' does not exist.`);
  }

  return prisma.plan.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      name: input.name,
      priceMinor: input.priceMinor,
      currencyCode: input.currencyCode,
      entryCapPerMonth: input.entryCapPerMonth,
      voiceEnabled: input.voiceEnabled,
      staffCapCount: input.staffCapCount,
    },
    update: {
      name: input.name,
      priceMinor: input.priceMinor,
      currencyCode: input.currencyCode,
      entryCapPerMonth: input.entryCapPerMonth,
      voiceEnabled: input.voiceEnabled,
      staffCapCount: input.staffCapCount,
    },
  });
}

export interface AssignSubscriptionInput {
  businessId: string;
  planCode: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  reason?: string;
  /** The AdminUser.id of the operator performing this change, for AuditLog.actorId. */
  changedByAdminUserId?: string;
}

/**
 * Assigns a business to a plan by creating a new ACTIVE Subscription row.
 * Deliberately does not touch any prior Subscription rows for the business
 * (no update-in-place, no auto-cancel of the previous one): getEffectivePlan
 * (billing.ts) already picks the most-recently-created ACTIVE row for a
 * business, so a fresh row here takes effect immediately and the old row is
 * simply left behind as history. An operator who wants the old plan gone
 * too should call cancelActiveSubscription for it explicitly.
 *
 * `currentPeriodEnd` is no longer purely informational (see subscriptionExpiry.ts
 * and billing.ts's getEffectivePlan, which now both stop treating a lapsed
 * ACTIVE row as entitled): once the period end passes, getEffectivePlan
 * immediately falls through to the next still-valid row (or FREE), and the
 * periodic sweep eventually flips this row's stored status to PAST_DUE. An
 * admin can still explicitly cancel a subscription early via
 * cancelActiveSubscription regardless of its period end.
 */
export async function assignSubscription(prisma: PrismaClient, input: AssignSubscriptionInput): Promise<Subscription> {
  if (input.currentPeriodEnd.getTime() <= input.currentPeriodStart.getTime()) {
    throw new InvalidSubscriptionPeriodError("currentPeriodEnd must be after currentPeriodStart.");
  }

  const business = await prisma.business.findUnique({ where: { id: input.businessId } });
  if (!business) throw new BusinessNotFoundError(`Business '${input.businessId}' not found.`);

  const plan = await prisma.plan.findUnique({ where: { code: input.planCode } });
  if (!plan) throw new PlanNotFoundError(`Plan '${input.planCode}' does not exist.`);

  const scoped = getTenantScopedClient(prisma, input.businessId);
  const subscription = await scoped.subscription.create({
    data: {
      businessId: input.businessId,
      planCode: input.planCode,
      status: "ACTIVE",
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
    },
  });

  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "ADMIN",
    ...(input.changedByAdminUserId ? { actorId: input.changedByAdminUserId } : {}),
    action: "SUBSCRIPTION_ASSIGNED",
    entityType: "Subscription",
    entityId: subscription.id,
    metadata: { planCode: input.planCode, reason: input.reason ?? null },
  });

  return subscription;
}

export interface CancelActiveSubscriptionOptions {
  reason?: string;
  changedByAdminUserId?: string;
}

/** Cancels the business's current ACTIVE subscription (falling the business back to whatever
 * getEffectivePlan resolves to next — ordinarily the FREE plan). Throws NoActiveSubscriptionError
 * rather than silently no-op'ing if there isn't one, so a caller can distinguish "already canceled" /
 * "never subscribed" from "cancel actually happened" instead of getting the same 200 either way. */
export async function cancelActiveSubscription(
  prisma: PrismaClient,
  businessId: string,
  options: CancelActiveSubscriptionOptions = {},
): Promise<Subscription> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const active = await scoped.subscription.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  if (!active) {
    throw new NoActiveSubscriptionError(`Business '${businessId}' has no active subscription to cancel.`);
  }

  const updated = await scoped.subscription.update({
    where: { id: active.id },
    data: { status: "CANCELED" },
  });

  await recordAuditLog(scoped, {
    businessId,
    actorType: "ADMIN",
    ...(options.changedByAdminUserId ? { actorId: options.changedByAdminUserId } : {}),
    action: "SUBSCRIPTION_CANCELED",
    entityType: "Subscription",
    entityId: updated.id,
    metadata: { reason: options.reason ?? null },
  });

  return updated;
}
