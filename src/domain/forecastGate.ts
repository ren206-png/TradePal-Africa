import type { ForecastGateConfig, ForecastGateEvent, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { forecastScoreSummary, type ForecastScoreSummary } from "./forecast.js";

/**
 * The per-merchant forecast promotion gate (expansion Phase 3, scenario 32).
 *
 * Forecasting replaces the Tier 1 quantity for a merchant ONLY when that merchant's own scored data meets two thresholds the
 * owner has configured: a minimum number of scored weeks, and a minimum improvement over Tier 1. There are NO defaults: until
 * the owner sets them, nothing can be promoted. Opening the gate is an owner action (SUPER_ADMIN, step-up) with a reason; every
 * attempt, including rejected ones, is recorded with the metrics at the time, and a database trigger refuses any other way of
 * setting the flag, so neither application code nor a manual UPDATE can bypass the thresholds.
 * Closing the gate is always allowed.
 */
export type GateErrorCode = "THRESHOLDS_NOT_SET" | "BELOW_THRESHOLD" | "NOT_FOUND" | "INVALID";

export class ForecastGateError extends Error {
  readonly code: GateErrorCode;
  readonly metrics: ForecastScoreSummary | null;
  constructor(code: GateErrorCode, message: string, metrics: ForecastScoreSummary | null = null) {
    super(message);
    this.code = code;
    this.metrics = metrics;
  }
}

export const GATE_FLAG = "reorderForecastLive";

export async function getForecastGateConfig(prisma: PrismaClient): Promise<ForecastGateConfig> {
  return prisma.forecastGateConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

/** The owner sets the platform-wide thresholds. Audited. Either value may be left unchanged by omitting it. */
export async function setForecastGateConfig(
  prisma: PrismaClient,
  input: { minScoredWeeks?: number; minImprovementBps?: number; adminUserId: string; correlationId?: string },
): Promise<ForecastGateConfig> {
  if (input.minScoredWeeks !== undefined && (!Number.isInteger(input.minScoredWeeks) || input.minScoredWeeks < 1)) throw new ForecastGateError("INVALID", "Minimum scored weeks must be a whole number of at least 1.");
  if (input.minImprovementBps !== undefined && (!Number.isInteger(input.minImprovementBps) || input.minImprovementBps < 0)) throw new ForecastGateError("INVALID", "Minimum improvement must be a whole number of basis points, zero or more.");
  const before = await getForecastGateConfig(prisma);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.forecastGateConfig.update({
      where: { id: 1 },
      data: { ...(input.minScoredWeeks !== undefined ? { minScoredWeeks: input.minScoredWeeks } : {}), ...(input.minImprovementBps !== undefined ? { minImprovementBps: input.minImprovementBps } : {}), updatedBy: input.adminUserId, updatedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        businessId: null, actorType: "ADMIN", actorId: input.adminUserId, action: "admin.forecast_gate.config_set", entityType: "ForecastGateConfig", entityId: "1",
        metadata: { before: { minScoredWeeks: before.minScoredWeeks, minImprovementBps: before.minImprovementBps }, after: { minScoredWeeks: updated.minScoredWeeks, minImprovementBps: updated.minImprovementBps }, ...(input.correlationId ? { correlationId: input.correlationId } : {}) },
      },
    });
    return updated;
  });
}

export interface GateOutcome {
  event: ForecastGateEvent;
  metrics: ForecastScoreSummary;
  enabled: boolean;
}

async function recordEvent(prisma: PrismaClient, input: { businessId: string; action: "ENABLED" | "DISABLED" | "REJECTED"; adminUserId: string; reason: string; metrics: object; correlationId?: string }) {
  return prisma.forecastGateEvent.create({
    data: { businessId: input.businessId, action: input.action, adminUserId: input.adminUserId, reason: input.reason, metrics: input.metrics as Prisma.InputJsonValue, correlationId: input.correlationId ?? null },
  });
}

export async function flipForecastGate(
  prisma: PrismaClient,
  input: { businessId: string; enabled: boolean; adminUserId: string; reason: string; correlationId?: string },
): Promise<GateOutcome> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new ForecastGateError("INVALID", "Give a reason of at least 10 characters.");
  if (!(await prisma.business.findUnique({ where: { id: input.businessId }, select: { id: true } }))) throw new ForecastGateError("NOT_FOUND", "Business not found.");
  const metrics = await forecastScoreSummary(prisma, { businessId: input.businessId });
  const config = await getForecastGateConfig(prisma);

  if (input.enabled) {
    const reject = async (code: GateErrorCode, message: string): Promise<never> => {
      await recordEvent(prisma, { businessId: input.businessId, action: "REJECTED", adminUserId: input.adminUserId, reason, metrics: { code, message, metrics, thresholds: { minScoredWeeks: config.minScoredWeeks, minImprovementBps: config.minImprovementBps } }, ...(input.correlationId ? { correlationId: input.correlationId } : {}) });
      await prisma.auditLog.create({ data: { businessId: input.businessId, actorType: "ADMIN", actorId: input.adminUserId, action: "admin.forecast_gate.rejected", entityType: "BusinessFeatureFlag", entityId: GATE_FLAG, metadata: { code, reason, ...(input.correlationId ? { correlationId: input.correlationId } : {}) } } });
      throw new ForecastGateError(code, message, metrics);
    };
    if (config.minScoredWeeks === null || config.minImprovementBps === null) {
      return reject("THRESHOLDS_NOT_SET", "The promotion thresholds have not been set yet, so no merchant can be promoted.");
    }
    if (metrics.scoredWeeks < config.minScoredWeeks) {
      return reject("BELOW_THRESHOLD", `Only ${metrics.scoredWeeks} scored week(s); the threshold is ${config.minScoredWeeks}.`);
    }
    if (metrics.improvementBps === null || metrics.improvementBps < config.minImprovementBps) {
      return reject("BELOW_THRESHOLD", `The forecast improves on the simple rule by ${metrics.improvementBps ?? "an unmeasurable amount of"} bps; the threshold is ${config.minImprovementBps} bps.`);
    }
  }

  const event = await prisma.$transaction(async (tx) => {
    // The database trigger only lets this flag turn ON while this transaction-local marker is set, i.e. only from here.
    await tx.$queryRaw`SELECT set_config('app.forecast_gate_open', ${input.enabled ? "on" : "off"}, true)`;
    await tx.businessFeatureFlag.upsert({
      where: { businessId_flagKey: { businessId: input.businessId, flagKey: GATE_FLAG } },
      update: { enabled: input.enabled },
      create: { businessId: input.businessId, flagKey: GATE_FLAG, enabled: input.enabled },
    });
    const e = await tx.forecastGateEvent.create({
      data: {
        businessId: input.businessId, action: input.enabled ? "ENABLED" : "DISABLED", adminUserId: input.adminUserId, reason,
        metrics: { metrics, thresholds: { minScoredWeeks: config.minScoredWeeks, minImprovementBps: config.minImprovementBps } } as unknown as Prisma.InputJsonValue, correlationId: input.correlationId ?? null,
      },
    });
    await tx.auditLog.create({
      data: {
        businessId: input.businessId, actorType: "ADMIN", actorId: input.adminUserId, action: input.enabled ? "admin.forecast_gate.enabled" : "admin.forecast_gate.disabled", entityType: "BusinessFeatureFlag", entityId: GATE_FLAG,
        metadata: { reason, scoredWeeks: metrics.scoredWeeks, improvementBps: metrics.improvementBps, ...(input.correlationId ? { correlationId: input.correlationId } : {}) },
      },
    });
    return e;
  });
  return { event, metrics, enabled: input.enabled };
}
