import type { PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { reportIncident, type AlertEmailDeps } from "../monitoring/alerts.js";
import { runForecasts, scoreForecasts, forecastForLive } from "../domain/forecast.js";
import { generateReorderSuggestions } from "../domain/reorder.js";
import { expireReservations } from "../domain/stock.js";
import { expireTradeOrders } from "../domain/trade/orders.js";
import { expireStoreOrders } from "../domain/store/orders.js";

/**
 * Periodic operations for the Phase 2-3 capabilities (OFF unless OPERATIONS_SWEEP_ENABLED=true):
 *   1. expire stock reservations whose time has passed (so held stock is never stuck);
 *   2. expire requested/quoted trade orders past their validity;
 *   3. (Phase 4) lapse unconfirmed or unpaid consumer store orders and release their held stock; retire abandoned baskets;
 *   4. refresh reorder suggestions (Tier 1; the forecast quantity only for merchants whose gate is open);
 *   5. write the day's shadow forecasts and score every forecast whose period has ended (the "nightly" scoring job).
 * Every task is idempotent, so running more often than needed is harmless, and one task failing never stops the others.
 */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly
const FIRST_DELAY_MS = 60_000;

export function operationsSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["OPERATIONS_SWEEP_ENABLED"] === "true";
}

export interface OperationsSweepResult {
  reservationsExpired: number;
  tradeOrdersExpired: number;
  storeOrdersExpired: number;
  basketsExpired: number;
  suggestionsCreated: number;
  forecastsWritten: number;
  forecastsScored: number;
  failures: string[];
}

export async function runOperationsSweep(prisma: PrismaClient, now: Date = new Date()): Promise<OperationsSweepResult> {
  const out: OperationsSweepResult = { reservationsExpired: 0, tradeOrdersExpired: 0, storeOrdersExpired: 0, basketsExpired: 0, suggestionsCreated: 0, forecastsWritten: 0, forecastsScored: 0, failures: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      out.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await step("reservations", async () => {
    const due = await prisma.stockReservation.findMany({ where: { status: "ACTIVE", expiresAt: { lte: now } }, select: { businessId: true }, distinct: ["businessId"] });
    for (const { businessId } of due) out.reservationsExpired += await expireReservations(getTenantScopedClient(prisma, businessId), now);
  });
  await step("trade orders", async () => {
    out.tradeOrdersExpired = await expireTradeOrders(prisma, now);
  });
  await step("store orders", async () => {
    out.storeOrdersExpired = await expireStoreOrders(prisma, now);
  });
  await step("baskets", async () => {
    out.basketsExpired = (await prisma.basket.updateMany({ where: { status: "OPEN", expiresAt: { lte: now } }, data: { status: "EXPIRED" } })).count;
  });
  await step("forecasts", async () => {
    const written = await runForecasts(prisma, now);
    out.forecastsWritten = Object.values(written).reduce((n, r) => n + r.written, 0);
    out.forecastsScored = (await scoreForecasts(prisma, now)).scored;
  });
  await step("suggestions", async () => {
    const businesses = await prisma.reorderRule.findMany({ where: { active: true }, select: { businessId: true }, distinct: ["businessId"] });
    for (const { businessId } of businesses) out.suggestionsCreated += (await generateReorderSuggestions(prisma, { businessId, now }, forecastForLive)).created;
  });
  return out;
}

export function startOperationsSweep(deps: { prisma: PrismaClient; alerts?: AlertEmailDeps | undefined; intervalMs?: number }): { stop(): void } {
  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await runOperationsSweep(deps.prisma);
      if (result.failures.length > 0) {
        await reportIncident(deps.alerts, { service: "worker", title: "Operations sweep step failed", detail: result.failures.join("\n").slice(0, 1500) });
      }
    } catch (error) {
      console.error("operations sweep failed (will retry next interval):", error);
    } finally {
      running = false;
    }
  }
  const first = setTimeout(() => void tick(), FIRST_DELAY_MS);
  const interval = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  first.unref();
  interval.unref();
  return { stop() { clearTimeout(first); clearInterval(interval); } };
}
