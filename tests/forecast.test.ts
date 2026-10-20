import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { fulfilSale, receiveStock, recordSpoilage } from "../src/domain/stock.js";
import { FORECAST_METHOD, forecastForLive, forecastReorderQty, forecastScoreSummary, runForecasts, runForecastsForBusiness, scoreForecasts, smoothMilli } from "../src/domain/forecast.js";
import { ForecastGateError, flipForecastGate, getForecastGateConfig, setForecastGateConfig } from "../src/domain/forecastGate.js";
import { forecastForLive as liveFn } from "../src/domain/forecast.js";
import { generateReorderSuggestions, listOpenSuggestions, setReorderRule } from "../src/domain/reorder.js";
import { ProtectedFlagError, setFeatureFlagForBusiness, setFeatureFlagGlobalDefault } from "../src/domain/featureFlags.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

const DAY = 86_400_000;
const D0 = new Date("2026-08-03T09:00:00Z"); // a Monday; first forecast run
const at = (days: number, hours = 12) => new Date(Date.UTC(2026, 7, 3 + days, hours));
let n = 0;

/**
 * Weekly demand alternating 6 / 14 for 12 weeks before D0 and for 5 weeks after. With a 7-day Tier 1 window the simple rule
 * predicts "the same as last week", which is wrong by 8 every week; smoothing lands near the middle.
 */
async function merchantWithHistory(opts: { windowDays?: number; stockout?: boolean } = {}) {
  const env = await makeBusiness(prisma);
  for (const f of ["reorderRules", "reorderForecastShadow", "stockV2"]) await enableFlag(prisma, env.businessId, f);
  n++;
  const product = await createProduct(env.scoped, { businessId: env.businessId, name: "Rice" });
  const variant = await createVariant(env.scoped, { businessId: env.businessId, productId: product.id, sku: `RICE-${n}`, name: "bag", baseUnit: "bag" });
  const common = { businessId: env.businessId, shopId: env.shopId, variantId: variant.id, currencyCode: "NGN" };
  await receiveStock(env.scoped, { ...common, quantity: opts.stockout ? 120 : 100_000, unitCostMinor: 5_000n, occurredAt: at(-12 * 7 - 3) });
  for (let w = -12; w < 5; w++) {
    const units = Math.abs(w) % 2 === 0 ? 6 : 14;
    await fulfilSale(env.scoped, { ...common, quantity: units, occurredAt: at(w * 7 + 3) });
  }
  await setReorderRule(env.scoped, { businessId: env.businessId, shopId: env.shopId, variantId: variant.id, mode: "DAYS_OF_COVER", targetCoverDays: 14, windowDays: opts.windowDays ?? 7 });
  return { ...env, variant, common };
}

describe("the smoothing arithmetic (pure, integer fixed-point)", () => {
  it("matches hand calculation", () => {
    expect(smoothMilli([10, 20])).toBe(13_000); // 0.3 x 20 + 0.7 x 10
    expect(smoothMilli([10, 20, 20])).toBe(15_100); // 0.3 x 20 + 0.7 x 13
    expect(smoothMilli([5])).toBe(5_000);
    expect(smoothMilli([])).toBe(0);
    expect(smoothMilli([0, 0, 0, 7])).toBe(2_100);
    expect(smoothMilli([3, 4], 10_000)).toBe(4_000); // alpha 1 follows the last point
  });
  it("reorder quantity = ceil(rate x cover) - position, never negative", () => {
    expect(forecastReorderQty(14_000, 7, 14, 10)).toBe(18); // 14/wk x 2 weeks = 28 - 10
    expect(forecastReorderQty(14_000, 7, 14, 40)).toBe(0);
    expect(forecastReorderQty(3_270, 7, 7, 0)).toBe(4); // 3.27 -> 4
    expect(forecastReorderQty(0, 7, 14, 0)).toBe(0);
  });
});

describe("shadow mode: predictions are written but a merchant never sees them (scenario 32)", () => {
  it("writes one prediction per rule per day, with its inputs, the method and the Tier 1 baseline", async () => {
    const m = await merchantWithHistory();
    const first = await runForecastsForBusiness(prisma, m.businessId, D0);
    expect(first).toEqual({ written: 1, alreadyWritten: 0, skippedShortHistory: 0 });
    expect(await runForecastsForBusiness(prisma, m.businessId, new Date(D0.getTime() + 3 * 3_600_000))).toEqual({ written: 0, alreadyWritten: 1, skippedShortHistory: 0 }); // idempotent within the day
    const p = await m.scoped.forecastPrediction.findFirstOrThrow({ where: {} });
    // the last 12 weeks before D0 were w = -12..-1: even |w| -> 6, odd -> 14
    const series = Array.from({ length: 12 }, (_, i) => (Math.abs(i - 12) % 2 === 0 ? 6 : 14));
    expect(p).toMatchObject({ method: FORECAST_METHOD, horizonDays: 7, predictionMilli: smoothMilli(series) });
    expect((p.inputs as { weeklyUnits: number[] }).weeklyUnits).toEqual(series);
    expect(p.baselineMilli).toBe(14_000); // "same as last week" (w = -1 was a 14)
    expect(p.periodEnd.getTime() - p.periodStart.getTime()).toBe(7 * DAY);
  });

  it("with the gate closed nothing forecast-derived reaches the merchant: suggestions are Tier 1 only and the live hook returns null", async () => {
    const m = await merchantWithHistory();
    await runForecastsForBusiness(prisma, m.businessId, D0);
    await recordSpoilage(m.scoped, { ...m.common, quantity: 99_830, occurredAt: D0 }); // leave almost nothing so a suggestion is due
    await generateReorderSuggestions(prisma, { businessId: m.businessId, now: D0 }, liveFn);
    const open = await listOpenSuggestions(m.scoped);
    expect(open.length).toBe(1);
    expect(open[0]!.method).toBe("TIER1_COVER");
    expect(JSON.stringify(open)).not.toMatch(/forecast|ses-v1|predictionMilli/i);
    const rule = await m.scoped.reorderRule.findFirstOrThrow({ where: {} });
    expect(await forecastForLive(m.scoped, rule, D0)).toBeNull();
  });

  it("is off unless the merchant is in shadow mode, needs history, and skips short histories", async () => {
    const m = await merchantWithHistory();
    await enableFlag(prisma, m.businessId, "reorderForecastShadow", false);
    expect(await runForecastsForBusiness(prisma, m.businessId, D0)).toEqual({ written: 0, alreadyWritten: 0, skippedShortHistory: 0 });
    await enableFlag(prisma, m.businessId, "reorderForecastShadow", true);
    // a brand-new variant with 2 weeks of history is skipped, not forecast from nothing
    const p = await createProduct(m.scoped, { businessId: m.businessId, name: "New" });
    const v = await createVariant(m.scoped, { businessId: m.businessId, productId: p.id, sku: "NEW-1", name: "x", baseUnit: "piece" });
    await receiveStock(m.scoped, { businessId: m.businessId, shopId: m.shopId, variantId: v.id, quantity: 50, occurredAt: at(-14) });
    await setReorderRule(m.scoped, { businessId: m.businessId, shopId: m.shopId, variantId: v.id, mode: "FIXED", reorderPoint: 5, reorderQuantity: 10 });
    expect(await runForecastsForBusiness(prisma, m.businessId, D0)).toEqual({ written: 1, alreadyWritten: 0, skippedShortHistory: 1 });
    expect(await runForecasts(prisma, D0)).toMatchObject({ [m.businessId]: { written: 0, alreadyWritten: 1 } });
  });
});

describe("the scoring job", () => {
  it("scores each ended period against actual sales AND against the Tier 1 baseline, once", async () => {
    const m = await merchantWithHistory();
    await runForecastsForBusiness(prisma, m.businessId, D0);
    expect(await scoreForecasts(prisma, new Date(D0.getTime() + 3 * DAY))).toEqual({ scored: 0, stockouts: 0 }); // the period has not ended
    expect((await m.scoped.forecastScore.count({ where: {} }))).toBe(0);
    const run = await scoreForecasts(prisma, new Date(D0.getTime() + 8 * DAY)); // the job is global: it also scores other merchants' due predictions
    expect(run.scored).toBeGreaterThanOrEqual(1);
    expect(await m.scoped.forecastScore.count({ where: {} })).toBe(1);
    expect(await scoreForecasts(prisma, new Date(D0.getTime() + 9 * DAY))).toEqual({ scored: 0, stockouts: 0 }); // idempotent
    const p = await m.scoped.forecastPrediction.findFirstOrThrow({ where: {}, include: { score: true } });
    // the week of D0..D0+7 is w = 0 (even -> 6 units): the 3rd day of that week had the sale
    expect(p.score).toMatchObject({ actualMilli: 6_000, stockout: false });
    expect(p.score!.absErrorMilli).toBe(Math.abs(p.predictionMilli - 6_000));
    expect(p.score!.baselineAbsErrorMilli).toBe(8_000); // "same as last week" said 14, reality was 6
    expect(p.score!.apeBps).toBe(Math.round((p.score!.absErrorMilli * 10_000) / 6_000));
    expect(p.score!.baselineApeBps).toBe(13_333); // 8 / 6
    expect(p.score!.apeBps!).toBeLessThan(p.score!.baselineApeBps!); // smoothing beat the naive rule here
    await expect(testDb.db.query(`UPDATE "ForecastScore" SET "stockout" = true WHERE id = '${p.score!.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "ForecastPrediction" WHERE id = '${p.id}'`)).rejects.toThrow(/append-only/);
  });

  it("flags a period in which stock ran out and keeps it out of the headline metric; zero demand has no percentage error", async () => {
    const m = await merchantWithHistory({ stockout: true }); // only 120 in stock; ~170 units sell over the history
    await runForecastsForBusiness(prisma, m.businessId, D0);
    await scoreForecasts(prisma, new Date(D0.getTime() + 8 * DAY));
    const summary = await forecastScoreSummary(prisma, { businessId: m.businessId });
    expect(summary).toMatchObject({ scoredPredictions: 1, excludedStockouts: 1, countedPredictions: 0, scoredWeeks: 0, modelMapeBps: null, improvementBps: null });

    // a period with no sales at all: scored, but no APE (undefined), and it does not count
    const z = await makeBusiness(prisma);
    await enableFlag(prisma, z.businessId, "reorderForecastShadow");
    const p = await createProduct(z.scoped, { businessId: z.businessId, name: "Slow" });
    const v = await createVariant(z.scoped, { businessId: z.businessId, productId: p.id, sku: "SLOW-1", name: "x", baseUnit: "piece" });
    await receiveStock(z.scoped, { businessId: z.businessId, shopId: z.shopId, variantId: v.id, quantity: 500, occurredAt: at(-80) });
    await setReorderRule(z.scoped, { businessId: z.businessId, shopId: z.shopId, variantId: v.id, mode: "FIXED", reorderPoint: 5, reorderQuantity: 10 });
    await runForecastsForBusiness(prisma, z.businessId, D0);
    await scoreForecasts(prisma, new Date(D0.getTime() + 8 * DAY));
    const s = await z.scoped.forecastScore.findFirstOrThrow({ where: {} });
    expect(s).toMatchObject({ actualMilli: 0, apeBps: null, baselineApeBps: null, stockout: false });
    expect((await forecastScoreSummary(prisma, { businessId: z.businessId })).countedPredictions).toBe(0);
  });

  it("scoredWeeks counts distinct weeks, not overlapping daily runs, and one business's scores never count for another", async () => {
    const m = await merchantWithHistory();
    const other = await merchantWithHistory();
    for (const day of [0, 1, 2, 7, 14]) await runForecastsForBusiness(prisma, m.businessId, new Date(D0.getTime() + day * DAY));
    await runForecastsForBusiness(prisma, other.businessId, D0);
    await scoreForecasts(prisma, new Date(D0.getTime() + 30 * DAY));
    const s = await forecastScoreSummary(prisma, { businessId: m.businessId });
    expect(s.scoredPredictions).toBe(5);
    expect(s.scoredWeeks).toBe(3); // days 0/1/2 fall in one week, 7 in the next, 14 in the one after
    expect((await forecastScoreSummary(prisma, { businessId: other.businessId })).scoredPredictions).toBe(1);
  });
});

describe("the promotion gate (scenario 32)", () => {
  async function scoredMerchant() {
    const m = await merchantWithHistory();
    for (const day of [0, 7, 14, 21]) await runForecastsForBusiness(prisma, m.businessId, new Date(D0.getTime() + day * DAY));
    await scoreForecasts(prisma, new Date(D0.getTime() + 40 * DAY));
    return m;
  }
  const flag = async (businessId: string) => (await prisma.businessFeatureFlag.findFirst({ where: { businessId, flagKey: "reorderForecastLive" } }))?.enabled ?? false;

  it("refuses while the owner has not set the thresholds (there are no defaults), and records the attempt", async () => {
    const m = await scoredMerchant();
    const config = await getForecastGateConfig(prisma);
    expect(config).toMatchObject({ minScoredWeeks: null, minImprovementBps: null });
    const err = await flipForecastGate(prisma, { businessId: m.businessId, enabled: true, adminUserId: "owner-1", reason: "Trying to promote this merchant" }).catch((e) => e);
    expect(err).toBeInstanceOf(ForecastGateError);
    expect(err.code).toBe("THRESHOLDS_NOT_SET");
    expect(await flag(m.businessId)).toBe(false);
    const ev = await m.scoped.forecastGateEvent.findFirstOrThrow({ where: {} });
    expect(ev).toMatchObject({ action: "REJECTED", adminUserId: "owner-1" });
    expect(await m.scoped.auditLog.count({ where: { action: "admin.forecast_gate.rejected" } })).toBe(1);
  });

  it("refuses below the thresholds (too few weeks, or not enough improvement) and opens above them, with an audit trail", async () => {
    const m = await scoredMerchant();
    const summary = await forecastScoreSummary(prisma, { businessId: m.businessId });
    expect(summary.scoredWeeks).toBe(4);
    expect(summary.improvementBps!).toBeGreaterThan(2_000); // smoothing clearly beats "same as last week" on this alternating demand

    await setForecastGateConfig(prisma, { minScoredWeeks: 8, minImprovementBps: 2_000, adminUserId: "owner-1" });
    const few = await flipForecastGate(prisma, { businessId: m.businessId, enabled: true, adminUserId: "owner-1", reason: "Promote after one month" }).catch((e) => e);
    expect(few).toMatchObject({ code: "BELOW_THRESHOLD" });
    expect(few.message).toContain("4 scored week");
    expect(await flag(m.businessId)).toBe(false);

    await setForecastGateConfig(prisma, { minScoredWeeks: 3, minImprovementBps: 9_900, adminUserId: "owner-1" });
    expect(await flipForecastGate(prisma, { businessId: m.businessId, enabled: true, adminUserId: "owner-1", reason: "Demand 99 percent better?" }).catch((e) => e)).toMatchObject({ code: "BELOW_THRESHOLD" });
    expect(await flag(m.businessId)).toBe(false);

    await setForecastGateConfig(prisma, { minScoredWeeks: 3, minImprovementBps: 2_000, adminUserId: "owner-1", correlationId: "corr-gate-1234" });
    const ok = await flipForecastGate(prisma, { businessId: m.businessId, enabled: true, adminUserId: "owner-1", reason: "Four scored weeks, large improvement", correlationId: "corr-gate-1234" });
    expect(ok.enabled).toBe(true);
    expect(ok.event).toMatchObject({ action: "ENABLED", correlationId: "corr-gate-1234" });
    expect(await flag(m.businessId)).toBe(true);
    const events = await m.scoped.forecastGateEvent.findMany({ where: {}, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual(["REJECTED", "REJECTED", "ENABLED"]);
    const audit = await m.scoped.auditLog.findFirstOrThrow({ where: { action: "admin.forecast_gate.enabled" } });
    expect(audit).toMatchObject({ actorType: "ADMIN", actorId: "owner-1" });
    expect(audit.metadata).toMatchObject({ scoredWeeks: 4, correlationId: "corr-gate-1234" });
    const cfgAudit = await prisma.auditLog.findMany({ where: { action: "admin.forecast_gate.config_set" } });
    expect(cfgAudit.length).toBeGreaterThanOrEqual(3);

    // closing is always allowed, even if the data would no longer qualify
    const off = await flipForecastGate(prisma, { businessId: m.businessId, enabled: false, adminUserId: "owner-1", reason: "Pausing forecasts for this shop" });
    expect(off.event.action).toBe("DISABLED");
    expect(await flag(m.businessId)).toBe(false);
  });

  it("once open, the forecast quantity replaces Tier 1 for that merchant and explains itself without calling it AI", async () => {
    const m = await scoredMerchant();
    await setForecastGateConfig(prisma, { minScoredWeeks: 3, minImprovementBps: 2_000, adminUserId: "owner-1" });
    await flipForecastGate(prisma, { businessId: m.businessId, enabled: true, adminUserId: "owner-1", reason: "Qualified on its own data" });
    const runDay = new Date(D0.getTime() + 33 * DAY); // the last sale (6 units) was on day 31
    await runForecastsForBusiness(prisma, m.businessId, runDay);
    await recordSpoilage(m.scoped, { ...m.common, quantity: 99_830, occurredAt: runDay });
    await generateReorderSuggestions(prisma, { businessId: m.businessId, now: runDay }, liveFn);
    const [s] = await listOpenSuggestions(m.scoped);
    expect(s!.method).toBe("TIER2_FORECAST");
    expect(s!.arithmetic).toContain("Based on your recent weekly sales");
    expect(s!.arithmetic).toContain("Your usual rule would have suggested");
    expect(s!.arithmetic).not.toMatch(/\bAI\b|artificial|machine/i);
    expect(s!.inputs).toHaveProperty("tier1SuggestedBaseQty");
    // closing the gate returns that merchant to Tier 1 on the next run
    await flipForecastGate(prisma, { businessId: m.businessId, enabled: false, adminUserId: "owner-1", reason: "Back to the simple rule" });
    await generateReorderSuggestions(prisma, { businessId: m.businessId, now: runDay }, liveFn);
    expect((await listOpenSuggestions(m.scoped))[0]!.method).toBe("TIER1_COVER");
  });

  it("no other route can open the gate: the generic flag tools, the global default and direct SQL are all refused", async () => {
    const m = await scoredMerchant();
    await expect(setFeatureFlagForBusiness(m.scoped, m.businessId, "reorderForecastLive", true)).rejects.toBeInstanceOf(ProtectedFlagError);
    await expect(setFeatureFlagGlobalDefault(prisma, "reorderForecastLive", true)).rejects.toBeInstanceOf(ProtectedFlagError);
    // turning it OFF through the generic tool is fine
    await setFeatureFlagForBusiness(m.scoped, m.businessId, "reorderForecastLive", false);
    // and if application code were bypassed, the database refuses
    await expect(testDb.db.query(`INSERT INTO "BusinessFeatureFlag" (id,"businessId","flagKey",enabled) VALUES ('f-x','${m.businessId}','reorderForecastLive',true)`)).rejects.toThrow(/promotion gate/);
    await expect(testDb.db.query(`UPDATE "BusinessFeatureFlag" SET enabled = true WHERE "businessId" = '${m.businessId}' AND "flagKey" = 'reorderForecastLive'`)).rejects.toThrow(/promotion gate/);
    await expect(testDb.db.query(`UPDATE "FeatureFlag" SET "enabledByDefault" = true WHERE key = 'reorderForecastLive'`)).rejects.toThrow(/never be on by default/);
    expect(await flag(m.businessId)).toBe(false);
  });

  it("validates the request: reason length, unknown business, threshold values", async () => {
    const m = await scoredMerchant();
    await expect(flipForecastGate(prisma, { businessId: m.businessId, enabled: true, adminUserId: "o", reason: "short" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(flipForecastGate(prisma, { businessId: "nope", enabled: true, adminUserId: "o", reason: "a long enough reason" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setForecastGateConfig(prisma, { minScoredWeeks: 0, adminUserId: "o" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(setForecastGateConfig(prisma, { minImprovementBps: -1, adminUserId: "o" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(testDb.db.query(`UPDATE "ForecastGateConfig" SET id = 2`)).rejects.toThrow(/check constraint|singleton/);
  });
});
