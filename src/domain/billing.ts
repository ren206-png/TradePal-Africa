import type { TenantScopedClient } from "../db/tenantScope.js";
import { getMonthBoundsInTimezone } from "./dailySummary.js";
import { isFeatureEnabled } from "./featureFlags.js";

/**
 * Phase 4: quota enforcement only — never payment collection. Charging a
 * merchant or picking a payment gateway needs human input first (which
 * gateways operate in NG/KE/SL/GH, settlement currency, PCI scope, etc.);
 * this module only answers "has this business used up its monthly plan
 * entry cap", gated behind a FeatureFlag like every other new/risky
 * behavior (Non-Negotiable Standard #7 — off by default).
 */
export const BILLING_QUOTA_FEATURE_FLAG_KEY = "billingQuotaEnforcement";

const FALLBACK_PLAN_CODE = "FREE";

export class PlanNotFoundError extends Error {}

export class QuotaExceededError extends Error {
  constructor(
    public readonly planCode: string,
    public readonly capPerMonth: number,
    public readonly usedThisMonth: number,
  ) {
    super(
      `Monthly entry limit reached: ${usedThisMonth}/${capPerMonth} entries used on the ${planCode} plan this month.`,
    );
  }
}

export interface EffectivePlan {
  code: string;
  entryCapPerMonth: number | null; // null = uncapped
  voiceEnabled: boolean;
  /** Phase 14: caps how many STAFF-role Merchant rows /addstaff can create for this business. null = uncapped. */
  staffCapCount: number | null;
}

/**
 * Every business currently gets a Subscription row implicitly defaulted to
 * FREE — onboarding never creates a Subscription (src/onboarding/onboardingFlow.ts),
 * and treating "no Subscription row" as "unlimited" would defeat the point of
 * adding a cap at all, since literally every existing business would be
 * exempt forever. A business with an explicit ACTIVE Subscription uses that
 * plan's cap instead. Most-recently-created ACTIVE subscription wins if
 * more than one somehow exists (defensive; the schema doesn't prevent it).
 *
 * `currentPeriodEnd` is checked here directly (`gt: now`), not just left to
 * the periodic sweep in subscriptionExpiry.ts: that sweep is a background
 * job on its own schedule (see src/subscriptionExpiryWorker.ts), so there is
 * necessarily a window between a period lapsing and the sweep actually
 * flipping the row to PAST_DUE. Without this check, every call site that
 * asks "what plan is this business actually entitled to right now" — quota
 * enforcement, /usage, the admin business-detail view — would keep treating
 * a lapsed-but-not-yet-swept row as fully entitled for up to that whole
 * window. Checking the date here closes the gap immediately and
 * unconditionally, independent of whether the sweep has run yet; the sweep
 * then keeps the *stored* Subscription.status honest for anything that reads
 * it directly (e.g. the admin subscriptions list) rather than through this
 * function.
 */
export async function getEffectivePlan(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  now: Date = new Date(),
): Promise<EffectivePlan> {
  const subscription = await scopedPrisma.subscription.findFirst({
    where: { businessId, status: "ACTIVE", currentPeriodEnd: { gt: now } },
    orderBy: { createdAt: "desc" },
  });

  const planCode = subscription?.planCode ?? FALLBACK_PLAN_CODE;
  const plan = await scopedPrisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) {
    throw new PlanNotFoundError(`Plan '${planCode}' referenced by business '${businessId}' does not exist.`);
  }

  return {
    code: plan.code,
    entryCapPerMonth: plan.entryCapPerMonth,
    voiceEnabled: plan.voiceEnabled,
    staffCapCount: plan.staffCapCount,
  };
}

export interface QuotaStatus {
  plan: EffectivePlan;
  usedThisMonth: number;
  remaining: number | null; // null = uncapped
}

/**
 * Counts ledger entries posted this calendar month (in the business's own
 * timezone, KQ7) — every Transaction row that isn't itself a reversal.
 * Reversal rows (created by /undo via reverseTransaction, which bypasses
 * recordTransaction entirely) don't count against the cap: undoing a
 * mistaken entry shouldn't cost the merchant their remaining monthly quota.
 */
export async function getQuotaStatus(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<QuotaStatus> {
  const plan = await getEffectivePlan(scopedPrisma, businessId, now);
  const { start, end } = getMonthBoundsInTimezone(now, timezone);

  const usedThisMonth = await scopedPrisma.transaction.count({
    where: { reversalOfTransactionId: null, createdAt: { gte: start, lt: end } },
  });

  const remaining = plan.entryCapPerMonth === null ? null : Math.max(plan.entryCapPerMonth - usedThisMonth, 0);
  return { plan, usedThisMonth, remaining };
}

/**
 * Throws QuotaExceededError if the business has already used its full
 * monthly entry cap. Called *before* recording a new entry so the entry
 * that would push the business over the cap is the one refused, rather
 * than being let through and only flagged after the fact.
 */
export async function assertWithinQuota(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<QuotaStatus> {
  const status = await getQuotaStatus(scopedPrisma, businessId, timezone, now);
  if (status.plan.entryCapPerMonth !== null && status.usedThisMonth >= status.plan.entryCapPerMonth) {
    throw new QuotaExceededError(status.plan.code, status.plan.entryCapPerMonth, status.usedThisMonth);
  }
  return status;
}

/**
 * Centralizes the FeatureFlag gate so call sites (commandRouter,
 * messageDispatcher) don't each have to duplicate the isFeatureEnabled
 * check. When the flag is off for a business, quota is never enforced and
 * this resolves to null rather than throwing.
 */
export async function assertWithinQuotaIfEnabled(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<QuotaStatus | null> {
  const enabled = await isFeatureEnabled(scopedPrisma, businessId, BILLING_QUOTA_FEATURE_FLAG_KEY);
  if (!enabled) return null;
  return assertWithinQuota(scopedPrisma, businessId, timezone, now);
}
