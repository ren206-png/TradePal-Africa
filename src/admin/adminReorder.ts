import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { FORECAST_METHOD, forecastScoreSummary } from "../domain/forecast.js";
import { ForecastGateError, flipForecastGate, getForecastGateConfig, setForecastGateConfig } from "../domain/forecastGate.js";
import { asyncHandler } from "./asyncHandler.js";
import { correlationIdOf } from "./adminAudit.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { paginate, parsePaginationParams } from "./pagination.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";

/**
 * Admin: reorder and forecasting panel (expansion Phase 3, section 18). Read access is `admin:view_reorder`. The two writes
 * are owner-only (SUPER_ADMIN), need step-up when it is enabled, and are audited: setting the platform thresholds, and opening
 * or closing one merchant's promotion gate. Forecasts are quantities of units, never money, and are never shown to merchants.
 */
const thresholdsBody = z.object({ minScoredWeeks: z.number().int().min(1).optional(), minImprovementBps: z.number().int().min(0).optional() }).refine((b) => b.minScoredWeeks !== undefined || b.minImprovementBps !== undefined, "Give at least one threshold.");
const gateBody = z.object({ enabled: z.boolean(), reason: z.string().trim().min(10, "Give a reason of at least 10 characters.").max(300) });

export function createAdminReorderRouter(prisma: PrismaClient, jwtSecret: string): Router {
  const router = Router();

  router.get(
    "/reorder/overview",
    requirePlatformPermission("admin:view_reorder"),
    asyncHandler(async (_req, res) => {
      const config = await getForecastGateConfig(prisma);
      const ruleBusinesses = await prisma.reorderRule.findMany({ where: { active: true }, select: { businessId: true }, distinct: ["businessId"] });
      const predBusinesses = await prisma.forecastPrediction.findMany({ select: { businessId: true }, distinct: ["businessId"] });
      const ids = Array.from(new Set([...ruleBusinesses, ...predBusinesses].map((b) => b.businessId))).slice(0, 200);
      const merchants = [];
      for (const businessId of ids) {
        const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, countryCode: true } });
        if (!business) continue;
        const scoped = getTenantScopedClient(prisma, businessId);
        const grouped = await scoped.reorderSuggestion.groupBy({ by: ["method", "status"], _count: { _all: true } });
        const count = (status: string) => grouped.filter((g) => g.status === status).reduce((n, g) => n + g._count._all, 0);
        const issued = grouped.reduce((n, g) => n + g._count._all, 0);
        const summary = await forecastScoreSummary(prisma, { businessId });
        const flags = await prisma.businessFeatureFlag.findMany({ where: { businessId, flagKey: { in: ["reorderRules", "reorderForecastShadow", "reorderForecastLive"] } } });
        const flag = (k: string) => flags.find((f) => f.flagKey === k)?.enabled ?? false;
        const thresholdsSet = config.minScoredWeeks !== null && config.minImprovementBps !== null;
        merchants.push({
          businessId, name: business.name, country: business.countryCode,
          rules: await scoped.reorderRule.count({ where: { active: true } }),
          suggestions: { issued, proposed: count("PROPOSED"), accepted: count("ACCEPTED"), dismissed: count("DISMISSED"), superseded: count("SUPERSEDED"), tier2Issued: grouped.filter((g) => g.method === "TIER2_FORECAST").reduce((n, g) => n + g._count._all, 0) },
          flags: { tier1: flag("reorderRules"), shadow: flag("reorderForecastShadow"), live: flag("reorderForecastLive") },
          forecast: summary,
          eligible: thresholdsSet && summary.scoredWeeks >= config.minScoredWeeks! && summary.improvementBps !== null && summary.improvementBps >= config.minImprovementBps!,
        });
      }
      res.json({ thresholds: { minScoredWeeks: config.minScoredWeeks, minImprovementBps: config.minImprovementBps, updatedAt: config.updatedAt }, method: FORECAST_METHOD, merchants });
    }),
  );

  router.get(
    "/businesses/:id/forecasts",
    requirePlatformPermission("admin:view_reorder"),
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } }))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const variantId = typeof req.query["variantId"] === "string" ? req.query["variantId"] : undefined;
      const rows = await prisma.forecastPrediction.findMany({
        where: { businessId, ...(variantId ? { variantId } : {}) }, orderBy: { periodStart: "desc" }, take: pagination.take + 1, skip: pagination.skip,
        include: { score: true, variant: { select: { sku: true, baseUnit: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      const variants = await prisma.forecastPrediction.findMany({ where: { businessId }, select: { variantId: true, variant: { select: { sku: true } } }, distinct: ["variantId"] });
      const perVariant = [];
      for (const v of variants) perVariant.push({ variantId: v.variantId, sku: v.variant.sku, summary: await forecastScoreSummary(prisma, { businessId, variantId: v.variantId }) });
      const gateEvents = await prisma.forecastGateEvent.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 20 });
      res.json({
        businessSummary: await forecastScoreSummary(prisma, { businessId }),
        perVariant,
        predictions: items.map((p) => ({
          id: p.id, sku: p.variant.sku, unit: p.variant.baseUnit, method: p.method, periodStart: p.periodStart, periodEnd: p.periodEnd,
          predictedUnits: p.predictionMilli / 1000, tier1Units: p.baselineMilli / 1000, suggestedReorderQty: p.suggestedReorderQty,
          score: p.score ? { actualUnits: p.score.actualMilli / 1000, modelApeBps: p.score.apeBps, tier1ApeBps: p.score.baselineApeBps, stockout: p.score.stockout } : null,
        })),
        gateEvents: gateEvents.map((e) => ({ id: e.id, action: e.action, adminUserId: e.adminUserId, reason: e.reason, createdAt: e.createdAt, correlationId: e.correlationId, metrics: e.metrics })),
        pagination: meta,
      });
    }),
  );

  router.get(
    "/forecast-gate-config",
    requirePlatformPermission("admin:view_reorder"),
    asyncHandler(async (_req, res) => {
      const c = await getForecastGateConfig(prisma);
      res.json({ minScoredWeeks: c.minScoredWeeks, minImprovementBps: c.minImprovementBps, updatedAt: c.updatedAt, updatedBy: c.updatedBy });
    }),
  );

  router.put(
    "/forecast-gate-config",
    requirePlatformPermission("admin:set_forecast_thresholds"),
    requireStepUp(prisma, jwtSecret, "admin:set_forecast_thresholds"),
    asyncHandler(async (req, res) => {
      const parsed = thresholdsBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
        return;
      }
      const admin = (req as AuthenticatedAdminRequest).adminUser!;
      try {
        const c = await setForecastGateConfig(prisma, {
          ...(parsed.data.minScoredWeeks !== undefined ? { minScoredWeeks: parsed.data.minScoredWeeks } : {}),
          ...(parsed.data.minImprovementBps !== undefined ? { minImprovementBps: parsed.data.minImprovementBps } : {}),
          adminUserId: admin.adminUserId, correlationId: correlationIdOf(res),
        });
        res.json({ minScoredWeeks: c.minScoredWeeks, minImprovementBps: c.minImprovementBps });
      } catch (error) {
        if (error instanceof ForecastGateError) {
          res.status(400).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    "/businesses/:id/forecast-gate",
    requirePlatformPermission("admin:flip_forecast_gate"),
    requireStepUp(prisma, jwtSecret, "admin:flip_forecast_gate"),
    asyncHandler(async (req, res) => {
      const parsed = gateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
        return;
      }
      const admin = (req as AuthenticatedAdminRequest).adminUser!;
      try {
        const outcome = await flipForecastGate(prisma, { businessId: req.params["id"] as string, enabled: parsed.data.enabled, adminUserId: admin.adminUserId, reason: parsed.data.reason, correlationId: correlationIdOf(res) });
        res.status(200).json({ enabled: outcome.enabled, eventId: outcome.event.id, metrics: outcome.metrics });
      } catch (error) {
        if (error instanceof ForecastGateError) {
          // a rejected attempt is recorded and shown with the numbers that decided it
          res.status(error.code === "NOT_FOUND" ? 404 : error.code === "INVALID" ? 400 : 409).json({ error: error.message, code: error.code, metrics: error.metrics });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
