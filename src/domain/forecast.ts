import type { ForecastPrediction, PrismaClient, ReorderRule } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { getTenantScopedClient, type TenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "./featureFlags.js";
import { netUnitsSoldBetween, salesEvents, snapshotFor } from "./reorder.js";
import { divRoundHalfUp } from "./rounding.js";

/**
 * Tier 2 demand forecasting (expansion Phase 3). It runs in SHADOW mode: predictions are written, scored against what
 * really sold and against the Tier 1 baseline, and shown to the platform owner in the admin console. A merchant sees
 * nothing from this module unless that merchant's own promotion gate (flag `reorderForecastLive`) has been opened by the
 * owner, and the gate only opens above configured thresholds (see forecastGate.ts).
 *
 * METHOD `ses-v1`: simple exponential smoothing on WEEKLY net units sold.
 *   - the series is the last 12 weeks, oldest first, ending at the start of the run day (UTC);
 *   - level_0 = week_0; level_i = alpha x week_i + (1 - alpha) x level_{i-1}, with alpha = 0.30;
 *   - the prediction for the next 7 days is the final level.
 *   All arithmetic is integer fixed-point (units x 1000, alpha in basis points, half-away-from-zero rounding): no floats,
 *   fully reproducible. alpha and the 12-week window are STARTING values, not tuned: the scoring job exists to find out how
 *   well they do on each merchant's own data. A variant needs at least 4 weeks of stock history to be forecast at all.
 *
 * Known limits (also recorded in docs/expansion/decisions.md): pilot merchants have few weeks of history; demand is often
 * intermittent (many zero weeks); there is no seasonality, promotion or price modelling; sales while out of stock are
 * censored, so periods that stocked out are flagged and excluded from the headline accuracy metric.
 *
 * Merchant-facing wording never says "AI": a forecast-based suggestion explains itself as "based on your recent weekly sales".
 */
export const FORECAST_METHOD = "ses-v1";
export const FORECAST_PARAMS = { horizonDays: 7, historyWeeks: 12, minHistoryWeeks: 4, alphaBps: 3_000, baselineWindowDays: 28 } as const;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Pure: fixed-point exponential smoothing. `series` is units per week, oldest first. Returns the final level x1000. */
export function smoothMilli(series: readonly number[], alphaBps: number = FORECAST_PARAMS.alphaBps): number {
  if (series.length === 0) return 0;
  let level = BigInt(series[0]!) * 1000n;
  for (let i = 1; i < series.length; i++) {
    level = (BigInt(alphaBps) * BigInt(series[i]!) * 1000n + BigInt(10_000 - alphaBps) * level + 5_000n) / 10_000n;
  }
  return Number(level);
}

/** Pure: units needed to cover `coverDays` at the forecast rate, minus what you effectively have. */
export function forecastReorderQty(predictionMilli: number, horizonDays: number, coverDays: number, position: number): number {
  const needed = Math.ceil((predictionMilli * coverDays) / (horizonDays * 1000));
  return Math.max(0, needed - position);
}

export interface ForecastRunResult {
  written: number;
  alreadyWritten: number;
  skippedShortHistory: number;
}

async function weeklySeries(scoped: TenantScopedClient, shopId: string, variantId: string, dayStart: Date): Promise<number[]> {
  const oldest = new Date(dayStart.getTime() - FORECAST_PARAMS.historyWeeks * WEEK);
  const events = await salesEvents(scoped, shopId, variantId, oldest, dayStart);
  const series = new Array<number>(FORECAST_PARAMS.historyWeeks).fill(0);
  for (const e of events) {
    const idx = Math.min(FORECAST_PARAMS.historyWeeks - 1, Math.floor((e.at.getTime() - oldest.getTime()) / WEEK));
    series[idx]! += e.units;
  }
  return series.map((n) => Math.max(0, n));
}

/** Writes one prediction per active rule's variant for one business (flag `reorderForecastShadow`). Idempotent per day. */
export async function runForecastsForBusiness(prisma: PrismaClient, businessId: string, now: Date = new Date()): Promise<ForecastRunResult> {
  const result: ForecastRunResult = { written: 0, alreadyWritten: 0, skippedShortHistory: 0 };
  const scoped = getTenantScopedClient(prisma, businessId);
  if (!(await isFeatureEnabled(scoped, businessId, "reorderForecastShadow"))) return result;
  const dayStart = startOfUtcDay(now);
  const horizonEnd = new Date(dayStart.getTime() + FORECAST_PARAMS.horizonDays * DAY);

  for (const rule of await scoped.reorderRule.findMany({ where: { active: true } })) {
    const first = await scoped.stockMovement.findFirst({ where: { shopId: rule.shopId, variantId: rule.variantId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } });
    if (!first || first.occurredAt > new Date(dayStart.getTime() - FORECAST_PARAMS.minHistoryWeeks * WEEK)) {
      result.skippedShortHistory++;
      continue;
    }
    if (await scoped.forecastPrediction.findFirst({ where: { shopId: rule.shopId, variantId: rule.variantId, method: FORECAST_METHOD, periodStart: dayStart } })) {
      result.alreadyWritten++;
      continue;
    }
    const series = await weeklySeries(scoped, rule.shopId, rule.variantId, dayStart);
    const predictionMilli = smoothMilli(series);
    const baselineWindow = rule.windowDays ?? FORECAST_PARAMS.baselineWindowDays;
    const soldInBaseline = await netUnitsSoldBetween(scoped, rule.shopId, rule.variantId, new Date(dayStart.getTime() - baselineWindow * DAY), dayStart);
    const baselineMilli = Number(divRoundHalfUp(BigInt(soldInBaseline) * 1000n * BigInt(FORECAST_PARAMS.horizonDays), BigInt(baselineWindow)));
    const snap = await snapshotFor(scoped, rule.shopId, rule.variantId, null, now);
    const coverDays = rule.targetCoverDays ?? FORECAST_PARAMS.horizonDays;
    const suggestedReorderQty = forecastReorderQty(predictionMilli, FORECAST_PARAMS.horizonDays, coverDays, snap.position);
    try {
      await scoped.forecastPrediction.create({
        data: {
          businessId, shopId: rule.shopId, variantId: rule.variantId, method: FORECAST_METHOD, horizonDays: FORECAST_PARAMS.horizonDays, periodStart: dayStart, periodEnd: horizonEnd,
          predictionMilli, baselineMilli, suggestedReorderQty, runAt: now,
          inputs: { weeklyUnits: series, alphaBps: FORECAST_PARAMS.alphaBps, historyWeeks: FORECAST_PARAMS.historyWeeks, baselineWindowDays: baselineWindow, soldInBaseline, position: snap.position, coverDays } as Prisma.InputJsonValue,
        },
      });
      result.written++;
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") result.alreadyWritten++;
      else throw error;
    }
  }
  return result;
}

/** All businesses that have active reorder rules. */
export async function runForecasts(prisma: PrismaClient, now: Date = new Date()): Promise<Record<string, ForecastRunResult>> {
  const ids = await prisma.reorderRule.findMany({ where: { active: true }, select: { businessId: true }, distinct: ["businessId"] });
  const out: Record<string, ForecastRunResult> = {};
  for (const { businessId } of ids) out[businessId] = await runForecastsForBusiness(prisma, businessId, now);
  return out;
}

// ------------------------------------------------------------------------------------ scoring

export interface ScoreRunResult {
  scored: number;
  stockouts: number;
}

/**
 * Scores every prediction whose period has ended: actual net units sold in the period vs the forecast and vs the Tier 1
 * baseline for the same period. A period in which on-hand stock reached zero (or started at zero) is flagged `stockout`:
 * demand was censored, so it is kept but excluded from the headline accuracy numbers. Idempotent (one score per prediction).
 */
export async function scoreForecasts(prisma: PrismaClient, now: Date = new Date()): Promise<ScoreRunResult> {
  const out: ScoreRunResult = { scored: 0, stockouts: 0 };
  const due = await prisma.forecastPrediction.findMany({ where: { periodEnd: { lte: now }, score: { is: null } }, orderBy: { periodEnd: "asc" }, take: 2_000 });
  for (const p of due) {
    const scoped = getTenantScopedClient(prisma, p.businessId);
    const actual = await netUnitsSoldBetween(scoped, p.shopId, p.variantId, p.periodStart, p.periodEnd);
    const before = await scoped.stockMovement.aggregate({ where: { shopId: p.shopId, variantId: p.variantId, occurredAt: { lt: p.periodStart } }, _sum: { onHandDelta: true } });
    const inside = await scoped.stockMovement.findMany({ where: { shopId: p.shopId, variantId: p.variantId, occurredAt: { gte: p.periodStart, lt: p.periodEnd } }, orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }], select: { onHandDelta: true } });
    let running = before._sum.onHandDelta ?? 0;
    let stockout = running <= 0;
    for (const m of inside) {
      running += m.onHandDelta;
      if (running <= 0) stockout = true;
    }
    const actualMilli = actual * 1000;
    const absError = Math.abs(p.predictionMilli - actualMilli);
    const baseError = Math.abs(p.baselineMilli - actualMilli);
    const ape = (e: number) => (actualMilli > 0 ? Number(divRoundHalfUp(BigInt(e) * 10_000n, BigInt(actualMilli))) : null);
    try {
      await scoped.forecastScore.create({
        data: { businessId: p.businessId, predictionId: p.id, actualMilli, absErrorMilli: absError, apeBps: ape(absError), baselineAbsErrorMilli: baseError, baselineApeBps: ape(baseError), stockout },
      });
      out.scored++;
      if (stockout) out.stockouts++;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002")) throw error;
    }
  }
  return out;
}

export interface ForecastScoreSummary {
  scoredPredictions: number;
  /** Scores used for the headline numbers: not a stock-out period, and there was real demand to measure against. */
  countedPredictions: number;
  excludedStockouts: number;
  /** Distinct 7-day calendar buckets (from the Unix epoch) that contain at least one counted prediction. Overlapping daily runs do not inflate it. */
  scoredWeeks: number;
  modelMapeBps: number | null;
  baselineMapeBps: number | null;
  /** Zero-safe companion: sum of absolute errors over sum of actuals. */
  modelWapeBps: number | null;
  baselineWapeBps: number | null;
  /** How much lower the model's MAPE is than Tier 1's, as a share of Tier 1's MAPE, in basis points. Negative = the model is worse. */
  improvementBps: number | null;
}

export async function forecastScoreSummary(prisma: PrismaClient, input: { businessId: string; variantId?: string }): Promise<ForecastScoreSummary> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const rows = await scoped.forecastScore.findMany({
    where: { prediction: { method: FORECAST_METHOD, ...(input.variantId ? { variantId: input.variantId } : {}) } },
    include: { prediction: { select: { periodStart: true } } },
  });
  const counted = rows.filter((r) => !r.stockout && r.actualMilli > 0);
  const weeks = new Set(counted.map((r) => Math.floor(r.prediction.periodStart.getTime() / WEEK)));
  const mean = (xs: (number | null)[]): number | null => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const sumActual = counted.reduce((n, r) => n + r.actualMilli, 0);
  const wape = (err: number) => (sumActual > 0 ? Math.round((err * 10_000) / sumActual) : null);
  const modelMape = mean(counted.map((r) => r.apeBps));
  const baseMape = mean(counted.map((r) => r.baselineApeBps));
  return {
    scoredPredictions: rows.length,
    countedPredictions: counted.length,
    excludedStockouts: rows.filter((r) => r.stockout).length,
    scoredWeeks: weeks.size,
    modelMapeBps: modelMape,
    baselineMapeBps: baseMape,
    modelWapeBps: wape(counted.reduce((n, r) => n + r.absErrorMilli, 0)),
    baselineWapeBps: wape(counted.reduce((n, r) => n + r.baselineAbsErrorMilli, 0)),
    improvementBps: modelMape !== null && baseMape !== null && baseMape > 0 ? Math.round(((baseMape - modelMape) * 10_000) / baseMape) : null,
  };
}

// --------------------------------------------------------------------- live use (gate open only)

/**
 * What the forecast says for a rule, for use ONLY when that merchant's gate is open. Returns null otherwise, so a merchant
 * whose gate is closed can never receive a forecast-derived number from here.
 */
export async function forecastForLive(
  scoped: TenantScopedClient,
  rule: ReorderRule,
  now: Date,
): Promise<{ suggestedBaseQty: number; inputs: Record<string, number | string>; arithmetic: string } | null> {
  if (!(await isFeatureEnabled(scoped, rule.businessId, "reorderForecastLive"))) return null;
  const p: ForecastPrediction | null = await scoped.forecastPrediction.findFirst({
    where: { shopId: rule.shopId, variantId: rule.variantId, method: FORECAST_METHOD, runAt: { gte: new Date(now.getTime() - 2 * DAY) } },
    orderBy: { runAt: "desc" },
  });
  if (!p) return null;
  const inputs = p.inputs as { weeklyUnits?: number[]; coverDays?: number };
  const coverDays = inputs.coverDays ?? FORECAST_PARAMS.horizonDays;
  // the position is read NOW (stock may have moved since the forecast ran); the stored prediction supplies only the demand rate
  const snap = await snapshotFor(scoped, rule.shopId, rule.variantId, null, now);
  const qty = forecastReorderQty(p.predictionMilli, p.horizonDays, coverDays, snap.position);
  if (qty <= 0) return null;
  const recent = (inputs.weeklyUnits ?? []).slice(-6).join(", ");
  const perWeek = Math.round(p.predictionMilli / 100) / 10;
  return {
    suggestedBaseQty: qty,
    inputs: { forecastWeeklyMilli: p.predictionMilli, coverDays, position: snap.position, forecastId: p.id },
    arithmetic: `Based on your recent weekly sales (last weeks, oldest to newest: ${recent}) about ${perWeek} a week is expected. To cover ${coverDays} days you need ${qty + snap.position}; you have ${snap.position}. Order ${qty}.`,
  };
}
