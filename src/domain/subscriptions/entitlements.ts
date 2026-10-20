import type { TenantScopedClient } from "../../db/tenantScope.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { DAY_MS, FLAG_ENTITLEMENTS } from "./common.js";

/**
 * The server-side entitlement matrix (expansion section 13). One function decides what a business may do, from stored state and the
 * clock, so nothing depends on a sweep having run:
 *
 *   FREE                 no paid subscription: the FREE plan's caps; no premium features.
 *   ACTIVE               a paid period is running: the plan version's caps and features.
 *   GRACE                the period ended less than `graceDays` ago: the SAME entitlements continue (the disclosed grace behaviour),
 *                        and renewal stays open.
 *   EXPIRED              grace is over: new PREMIUM operations are refused with a message that points to renewal; the FREE caps apply.
 *   SECURITY_SUSPENDED   the business is suspended by TradePal (a separate control with its own operator path): never reported as
 *                        an ordinary expiry, and never lifted by paying.
 *
 * What expiry never touches (section 13): existing payments, callbacks, status checks and reconciliation; the fulfilment of orders already
 * placed; authorised refunds; the business's historical data and its export; and renewal itself. Those paths never call `assertEntitled`;
 * `SERVICING_OPERATIONS` documents them and a test exercises each one on an expired business.
 *
 * Enforcement is OFF unless the business has the `subscriptionEntitlements` flag, so behaviour with the flag off is exactly what it was.
 */
export type EntitlementState = "FREE" | "ACTIVE" | "GRACE" | "EXPIRED" | "SECURITY_SUSPENDED";

export interface Entitlement {
  state: EntitlementState;
  planCode: string;
  planVersionId: string | null;
  features: ReadonlySet<string>;
  entryCapPerMonth: number | null;
  voiceEnabled: boolean;
  staffCapCount: number | null;
  subscriptionStatus: string | null;
  periodEnd: Date | null;
  graceEndsAt: Date | null;
}

/** New operations that need a premium feature. Each maps to the feature a plan version must list. */
export const PREMIUM_OPERATIONS = {
  "trade.order.create": "trade",
  "marketplace.publish": "marketplace",
  "reorder.rule": "reorder",
  "store.open": "storefront",
} as const;
export type PremiumOperation = keyof typeof PREMIUM_OPERATIONS;

/** Operations that continue whatever the subscription state. Documentation, and the list the expiry test walks. */
export const SERVICING_OPERATIONS = [
  "payments.callbacks", "payments.status_checks", "payments.reconciliation", "orders.fulfil_existing", "orders.cancel_existing", "refunds.authorised",
  "data.read", "data.export", "billing.renew", "billing.view", "store.close", "shopper.checkout",
] as const;

const FALLBACK_PLAN = "FREE";
/** Plans created before versions existed carry no feature list: a paid plan includes every premium feature, the FREE plan none. A documented assumption (decisions C7). */
const ALL_FEATURES = ["trade", "marketplace", "reorder", "storefront", "voice"];

export class EntitlementError extends Error {
  constructor(readonly code: "SUBSCRIPTION_EXPIRED" | "NOT_IN_PLAN" | "SECURITY_SUSPENDED", message: string) {
    super(message);
    this.name = "EntitlementError";
  }
}

export async function getEntitlement(scoped: TenantScopedClient, businessId: string, now: Date = new Date()): Promise<Entitlement> {
  const free = await freeEntitlement(scoped);
  const business = await scoped.business.findUnique({ where: { id: businessId }, select: { status: true } });
  const subs = await scoped.subscription.findMany({ where: { businessId, status: { in: ["ACTIVE", "PAST_DUE"] } }, orderBy: { currentPeriodEnd: "desc" }, take: 1, include: { planVersion: true, plan: true } });
  const sub = subs[0];

  let ent: Entitlement = { ...free, state: "FREE" };
  if (sub) {
    const version = sub.planVersion;
    const graceDays = version?.graceDays ?? 3;
    const graceEnds = new Date(sub.currentPeriodEnd.getTime() + graceDays * DAY_MS);
    const live = now < sub.currentPeriodEnd;
    const inGrace = !live && now < graceEnds;
    const features = new Set(version ? version.features : sub.plan.code === FALLBACK_PLAN ? [] : ALL_FEATURES);
    const paid = {
      planCode: sub.plan.code, planVersionId: version?.id ?? null, features, subscriptionStatus: sub.status, periodEnd: sub.currentPeriodEnd, graceEndsAt: graceEnds,
      entryCapPerMonth: version ? version.entryCapPerMonth : sub.plan.entryCapPerMonth, voiceEnabled: version ? version.voiceEnabled : sub.plan.voiceEnabled,
      staffCapCount: version ? version.staffCapCount : sub.plan.staffCapCount,
    };
    if (live && sub.status === "ACTIVE") ent = { ...paid, state: "ACTIVE" };
    else if ((live || inGrace) && (sub.status === "ACTIVE" || sub.status === "PAST_DUE")) ent = { ...paid, state: live ? "ACTIVE" : "GRACE" };
    else ent = { ...free, state: "EXPIRED", subscriptionStatus: sub.status, periodEnd: sub.currentPeriodEnd, graceEndsAt: graceEnds };
  }
  if (business?.status === "SUSPENDED") ent = { ...ent, state: "SECURITY_SUSPENDED" };
  return ent;
}

async function freeEntitlement(scoped: TenantScopedClient): Promise<Omit<Entitlement, "state">> {
  const plan = await scoped.plan.findUnique({ where: { code: FALLBACK_PLAN } });
  return {
    planCode: FALLBACK_PLAN, planVersionId: null, features: new Set<string>(), entryCapPerMonth: plan?.entryCapPerMonth ?? null, voiceEnabled: plan?.voiceEnabled ?? false,
    staffCapCount: plan?.staffCapCount ?? null, subscriptionStatus: null, periodEnd: null, graceEndsAt: null,
  };
}

/**
 * Refuses a NEW premium operation the business is not entitled to. A no-op while the `subscriptionEntitlements` flag is off for the
 * business. The messages are shown to merchants, so they say what is paused, what is NOT, and how to renew.
 */
export async function assertEntitled(scoped: TenantScopedClient, businessId: string, operation: PremiumOperation, now: Date = new Date()): Promise<void> {
  if (!(await isFeatureEnabled(scoped, businessId, FLAG_ENTITLEMENTS))) return;
  const ent = await getEntitlement(scoped, businessId, now);
  if (ent.state === "SECURITY_SUSPENDED") throw new EntitlementError("SECURITY_SUSPENDED", "This account is suspended by TradePal. Please contact TradePal support. Paying a subscription does not lift a suspension.");
  const needed = PREMIUM_OPERATIONS[operation];
  if (ent.state === "EXPIRED") {
    throw new EntitlementError("SUBSCRIPTION_EXPIRED", "Your subscription has ended, so new orders, publishing and rules are paused. Everything already in progress, your payments and all your records are untouched. Renew with /renew to continue.");
  }
  if (!ent.features.has(needed)) {
    throw new EntitlementError("NOT_IN_PLAN", `Your ${ent.planCode} plan does not include this. See the plans you can switch to with /plans.`);
  }
}
