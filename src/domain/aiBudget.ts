import type { TenantScopedClient } from "../db/tenantScope.js";
import { getEffectivePlan } from "./billing.js";
import { getOpenBudgetMicroUsdForBusiness } from "./aiUsageLedger.js";

/**
 * DeepSeek Integration Phase 3 (INTEGRATION_DESIGN.md §1, "Phase 3.6"): the
 * graduated `record → warn → alert → restrict-premium → block-optional-AI`
 * threshold evaluator, consuming `Plan.aiDeepseekMonthlyBudgetMicroUsd` the
 * same way `src/domain/billing.ts`'s `assertWithinQuota` consumes
 * `Plan.entryCapPerMonth` — but graduated rather than binary, per
 * PHASE_0_FINDINGS.md's own note that the existing quota mechanism is a
 * hard binary block, not a staged system.
 *
 * Nothing in this file is wired to a live call path yet (same inertness as
 * aiUsageLedger.ts — see that file's doc comment). `enforcementEnabled` is
 * an explicit boolean parameter here, not read from `process.env` inside
 * this module, because INTEGRATION_DESIGN.md §4 documents
 * `AI_BUDGET_ENFORCEMENT_ENABLED` as a plain env var read at the eventual
 * call site (mirroring `AI_PROVIDER_DEEPSEEK_ENABLED`'s own
 * conditional-construction pattern in `src/worker.ts`), not a value this
 * domain module should read for itself — keeping this module a pure
 * function of its inputs, consistent with `billing.ts`'s own style, and
 * testable without touching `process.env`.
 */

export type AiBudgetLevel = "RECORD" | "WARN" | "ALERT" | "RESTRICT_PREMIUM" | "BLOCK_OPTIONAL_AI";

export interface AiBudgetThresholds {
  /** Fraction of the monthly budget consumed (0..1+) at which each stage begins. Must be ascending. */
  warnAtFraction: number;
  alertAtFraction: number;
  restrictPremiumAtFraction: number;
  blockOptionalAiAtFraction: number;
}

/**
 * UNSPECIFIED BY THE GOVERNING BRIEF, flagged rather than silently invented
 * as if sourced: INTEGRATION_DESIGN.md §1 names these five graduated stages
 * but gives no numeric thresholds for any of them (UNKNOWN — searched:
 * INTEGRATION_DESIGN.md, PHASE_0_FINDINGS.md, for a percentage tied to any
 * of these stage names). The values below are a reasonable, evenly-spaced
 * placeholder scale so this evaluator has something concrete to run and be
 * observed against in Phase 3's record-only mode. They are
 * operator-overridable via the `thresholds` parameter and must be replaced
 * with real, business-approved numbers before
 * `AI_BUDGET_ENFORCEMENT_ENABLED` is ever flipped true against live
 * merchant traffic — the same "confirm before real traffic" posture already
 * used for `modelRegistry.ts`'s placeholder pricing.
 */
export const DEFAULT_AI_BUDGET_THRESHOLDS: AiBudgetThresholds = {
  warnAtFraction: 0.5,
  alertAtFraction: 0.75,
  restrictPremiumAtFraction: 0.9,
  blockOptionalAiAtFraction: 1.0,
};

export interface AiBudgetEvaluation {
  level: AiBudgetLevel;
  /** null = this business's effective plan has no DeepSeek budget cap set (`Plan.aiDeepseekMonthlyBudgetMicroUsd` is null — uncapped, mirroring `entryCapPerMonth`'s convention). Always RECORD when null. */
  budgetMicroUsd: bigint | null;
  usedMicroUsd: bigint;
  /** null exactly when budgetMicroUsd is null — a fraction is meaningless against an uncapped budget. */
  fractionUsed: number | null;
  /** Echoes the caller-supplied enforcement flag, so a caller/test can see what mode an evaluation was computed under without threading a second value around. */
  enforcementEnabled: boolean;
}

/** Reuses billing.ts's existing plan-resolution (Subscription lookup, FREE fallback) rather than duplicating it, then reads the one extra column billing.ts's own EffectivePlan doesn't expose. */
async function getAiBudgetMicroUsdForBusiness(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  now: Date,
): Promise<bigint | null> {
  const plan = await getEffectivePlan(scopedPrisma, businessId, now);
  const fullPlan = await scopedPrisma.plan.findUnique({ where: { code: plan.code } });
  return fullPlan?.aiDeepseekMonthlyBudgetMicroUsd ?? null;
}

/**
 * Computes where a business currently sits against its DeepSeek budget.
 * Purely observational — does not itself throw or block anything, even at
 * the highest level; see `isAiCallPermitted`/`isPremiumModelRestricted`
 * below for how a caller would actually act on the result once enforcement
 * is enabled.
 */
export async function evaluateAiBudget(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  timezone: string,
  enforcementEnabled: boolean,
  now: Date = new Date(),
  thresholds: AiBudgetThresholds = DEFAULT_AI_BUDGET_THRESHOLDS,
): Promise<AiBudgetEvaluation> {
  const [budgetMicroUsd, usedMicroUsd] = await Promise.all([
    getAiBudgetMicroUsdForBusiness(scopedPrisma, businessId, now),
    getOpenBudgetMicroUsdForBusiness(scopedPrisma, businessId, timezone, now),
  ]);

  if (budgetMicroUsd === null) {
    return { level: "RECORD", budgetMicroUsd: null, usedMicroUsd, fractionUsed: null, enforcementEnabled };
  }

  const fractionUsed =
    budgetMicroUsd === 0n
      ? usedMicroUsd > 0n
        ? Number.POSITIVE_INFINITY
        : 0
      : Number(usedMicroUsd) / Number(budgetMicroUsd);

  let level: AiBudgetLevel = "RECORD";
  if (fractionUsed >= thresholds.blockOptionalAiAtFraction) level = "BLOCK_OPTIONAL_AI";
  else if (fractionUsed >= thresholds.restrictPremiumAtFraction) level = "RESTRICT_PREMIUM";
  else if (fractionUsed >= thresholds.alertAtFraction) level = "ALERT";
  else if (fractionUsed >= thresholds.warnAtFraction) level = "WARN";

  return { level, budgetMicroUsd, usedMicroUsd, fractionUsed, enforcementEnabled };
}

/**
 * Whether a call tagged as "optional" should be allowed to proceed under
 * this evaluation. In record-only mode (`enforcementEnabled: false`, the
 * default per `AI_BUDGET_ENFORCEMENT_ENABLED`) this always returns true —
 * nothing is ever actually blocked, only observed.
 */
export function isAiCallPermitted(evaluation: AiBudgetEvaluation, isOptionalFeature: boolean): boolean {
  if (!evaluation.enforcementEnabled) return true;
  if (evaluation.level === "BLOCK_OPTIONAL_AI") return !isOptionalFeature;
  return true;
}

/**
 * Whether a "premium" (costlier) model choice should be downgraded to a
 * cheaper one under this evaluation. Same record-only-mode short-circuit as
 * `isAiCallPermitted`.
 */
export function isPremiumModelRestricted(evaluation: AiBudgetEvaluation): boolean {
  if (!evaluation.enforcementEnabled) return false;
  return evaluation.level === "RESTRICT_PREMIUM" || evaluation.level === "BLOCK_OPTIONAL_AI";
}
