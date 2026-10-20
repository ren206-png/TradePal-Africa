import type { PrismaClient, ReorderMode, ReorderRule, ReorderSuggestion, SuggestionMethod } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { getTenantScopedClient, type TenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "./featureFlags.js";
import { ensureDefaultShopFor } from "./shops.js";
import { getStockLevel } from "./stock.js";
import { TradeError } from "./trade/common.js";
import { createPurchaseOrder } from "./trade/orders.js";
import { getSharedCatalog, resolveSharedPrice } from "./trade/partners.js";

/**
 * Reorder suggestions, Tier 1 (expansion Phase 3, flag `reorderRules`). Deterministic and explainable: no model, no
 * forecasting, every number used is stored with the suggestion and written out in words.
 *
 * A suggestion is ONLY a proposal, a draft purchase order with its reasoning attached. This module has no path to send an
 * order, pay anything or message a supplier: accepting a suggestion creates a DRAFT purchase order and stops there. The
 * merchant decides whether to send it.
 *
 * Position (what you effectively have) = on hand - reserved + incoming, where incoming is the not-yet-received part of your
 * open purchase orders (sent, quoted or agreed). Short-delivered units never arrive, so they are not counted as incoming.
 *
 *   FIXED          suggest `reorderQuantity` when position <= `reorderPoint`.
 *   DAYS_OF_COVER  daily rate = units sold in the last `windowDays` / windowDays. Needed = ceil(sold x targetCoverDays / windowDays).
 *                  Suggest (needed - position) when position < needed. No sales in the window = no evidence = no suggestion.
 *
 * "Sold" is net recorded sales: fulfilled sales minus sellable returns and reversed sales. Known limit: a reversal of an
 * earlier-system (legacy) sale is not linked back to that sale, so it can slightly overstate sales for such items.
 */
const DAY = 86_400_000;

export interface ReorderSnapshot {
  onHand: number;
  reserved: number;
  incoming: number;
  position: number;
  soldInWindow: number | null;
}

export interface Tier1Result {
  method: SuggestionMethod;
  suggestedBaseQty: number;
  inputs: Record<string, number | string>;
  arithmetic: string;
}

/** n/d with two decimals using integers only. */
function perDay(sold: number, windowDays: number): string {
  const hundredths = Math.round((sold * 100) / windowDays);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** The pure rule. `null` = nothing to suggest (stock is fine, or there is no demand evidence). */
export function computeTier1(
  rule: Pick<ReorderRule, "mode" | "reorderPoint" | "reorderQuantity" | "targetCoverDays" | "windowDays">,
  s: ReorderSnapshot,
  unit: string,
): Tier1Result | null {
  const have = `${s.position} ${unit} (on hand ${s.onHand} - reserved ${s.reserved} + on order ${s.incoming})`;
  if (rule.mode === "FIXED") {
    const point = rule.reorderPoint!;
    const qty = rule.reorderQuantity!;
    if (s.position > point) return null;
    return {
      method: "TIER1_FIXED",
      suggestedBaseQty: qty,
      inputs: { onHand: s.onHand, reserved: s.reserved, incoming: s.incoming, position: s.position, reorderPoint: point, reorderQuantity: qty },
      arithmetic: `You have ${have}. Your reorder point is ${point}, and ${s.position} is at or below it. Your usual reorder quantity is ${qty} ${unit}.`,
    };
  }
  const days = rule.targetCoverDays!;
  const window = rule.windowDays!;
  const sold = s.soldInWindow ?? 0;
  if (sold <= 0) return null;
  const needed = Math.ceil((sold * days) / window);
  if (s.position >= needed) return null;
  const qty = needed - s.position;
  return {
    method: "TIER1_COVER",
    suggestedBaseQty: qty,
    inputs: { onHand: s.onHand, reserved: s.reserved, incoming: s.incoming, position: s.position, soldInWindow: sold, windowDays: window, targetCoverDays: days, needed },
    arithmetic:
      `You sold ${sold} ${unit} in the last ${window} days (${perDay(sold, window)} a day). To cover ${days} days you need ${needed} (${sold} x ${days} / ${window}, rounded up). ` +
      `You have ${have}. Order ${needed} - ${s.position} = ${qty} ${unit}.`,
  };
}

// ----------------------------------------------------------------------------------------- rules

export interface SetRuleInput {
  businessId: string;
  shopId: string;
  variantId: string;
  mode: ReorderMode;
  reorderPoint?: number;
  reorderQuantity?: number;
  targetCoverDays?: number;
  windowDays?: number;
  preferredPartnerId?: string | null;
}

function posInt(n: number | undefined, what: string, min = 1): number {
  if (n === undefined || !Number.isInteger(n) || n < min) throw new TradeError("INVALID", `${what} must be a whole number of at least ${min}.`);
  return n;
}

/** Creates or replaces the rule for a variant in a shop. Thresholds are the merchant's own; nothing is defaulted. */
export async function setReorderRule(scoped: TenantScopedClient, input: SetRuleInput): Promise<ReorderRule> {
  if (!(await scoped.productVariant.findUnique({ where: { id: input.variantId } }))) throw new TradeError("NOT_FOUND", "Product not found.");
  const data =
    input.mode === "FIXED"
      ? { mode: "FIXED" as const, reorderPoint: posInt(input.reorderPoint, "The reorder point", 0), reorderQuantity: posInt(input.reorderQuantity, "The reorder quantity"), targetCoverDays: null, windowDays: null }
      : { mode: "DAYS_OF_COVER" as const, reorderPoint: null, reorderQuantity: null, targetCoverDays: posInt(input.targetCoverDays, "Days of cover"), windowDays: posInt(input.windowDays, "The sales window (days)") };
  const existing = await scoped.reorderRule.findFirst({ where: { shopId: input.shopId, variantId: input.variantId } });
  const common = { ...data, preferredPartnerId: input.preferredPartnerId ?? null, active: true };
  if (existing) return scoped.reorderRule.update({ where: { id: existing.id }, data: common });
  return scoped.reorderRule.create({ data: { businessId: input.businessId, shopId: input.shopId, variantId: input.variantId, ...common } });
}

export async function deactivateReorderRule(scoped: TenantScopedClient, ruleId: string): Promise<void> {
  const r = await scoped.reorderRule.updateMany({ where: { id: ruleId }, data: { active: false } });
  if (r.count !== 1) throw new TradeError("NOT_FOUND", "Rule not found.");
}

// ------------------------------------------------------------------------------------- inputs

/** Units of this variant on open purchase orders that have not yet arrived (and will not, if they were short). */
export async function incomingUnits(scoped: TenantScopedClient, variantId: string): Promise<number> {
  const orders = await scoped.tradeOrder.findMany({ where: { side: "BUY", acceptance: { in: ["REQUESTED", "QUOTED", "ACCEPTED"] } }, include: { lines: { where: { variantId } } } });
  const lineIds = orders.flatMap((o) => o.lines.map((l) => l.id));
  if (lineIds.length === 0) return 0;
  const shipped = await scoped.shipmentLine.findMany({ where: { orderLineId: { in: lineIds } } });
  let incoming = 0;
  for (const o of orders) {
    for (const l of o.lines) {
      const short = shipped.filter((s) => s.orderLineId === l.id).reduce((n, s) => n + s.shortBase, 0);
      incoming += Math.max(0, l.baseQuantity - l.receivedBase - short);
    }
  }
  return incoming;
}

/** Net sales events in [start, end): fulfilled sales count as +units, sellable returns and reversed sales as -units. */
export async function salesEvents(scoped: TenantScopedClient, shopId: string, variantId: string, start: Date, end: Date): Promise<{ at: Date; units: number }[]> {
  const rows = await scoped.stockMovement.findMany({
    where: { shopId, variantId, occurredAt: { gte: start, lt: end }, kind: { in: ["SALE_FULFILLMENT", "RETURN_RESTOCK", "REVERSAL", "LEGACY_MIRROR"] } },
    include: { reversalOf: { select: { kind: true } } },
    orderBy: { occurredAt: "asc" },
  });
  const legacyIds = rows.filter((r) => r.kind === "LEGACY_MIRROR" && r.sourceId).map((r) => r.sourceId as string);
  const legacy = legacyIds.length ? await scoped.inventoryMovement.findMany({ where: { id: { in: legacyIds } }, select: { id: true, source: true } }) : [];
  const out: { at: Date; units: number }[] = [];
  for (const r of rows) {
    if (r.kind === "SALE_FULFILLMENT" || r.kind === "RETURN_RESTOCK") out.push({ at: r.occurredAt, units: -r.onHandDelta });
    else if (r.kind === "REVERSAL" && r.reversalOf?.kind === "SALE_FULFILLMENT") out.push({ at: r.occurredAt, units: -r.onHandDelta });
    else if (r.kind === "LEGACY_MIRROR" && legacy.find((l) => l.id === r.sourceId)?.source === "SALE") out.push({ at: r.occurredAt, units: -r.onHandDelta });
  }
  return out;
}

/** Net units sold from a shop's stock in [start, end). */
export async function netUnitsSoldBetween(scoped: TenantScopedClient, shopId: string, variantId: string, start: Date, end: Date): Promise<number> {
  const events = await salesEvents(scoped, shopId, variantId, start, end);
  return Math.max(0, events.reduce((n, e) => n + e.units, 0));
}

/** Net units sold from a shop's stock in [now - windowDays, now]. */
export async function netUnitsSold(scoped: TenantScopedClient, shopId: string, variantId: string, windowDays: number, now: Date): Promise<number> {
  return netUnitsSoldBetween(scoped, shopId, variantId, new Date(now.getTime() - windowDays * DAY), new Date(now.getTime() + 1));
}

export async function snapshotFor(scoped: TenantScopedClient, shopId: string, variantId: string, windowDays: number | null, now: Date): Promise<ReorderSnapshot> {
  const lvl = await getStockLevel(scoped, shopId, variantId);
  const incoming = await incomingUnits(scoped, variantId);
  return {
    onHand: lvl.onHand, reserved: lvl.reserved, incoming, position: lvl.onHand - lvl.reserved + incoming,
    soldInWindow: windowDays ? await netUnitsSold(scoped, shopId, variantId, windowDays, now) : null,
  };
}

// ------------------------------------------------------------------------------- suggestions

export interface GenerateResult {
  created: number;
  superseded: number;
  unchanged: number;
}

/**
 * Re-evaluates every active rule. One open suggestion per (shop, variant, method): if the numbers changed, the old one is
 * SUPERSEDED and a new one proposed; if the condition cleared, the old one is superseded and nothing new is made. Idempotent.
 * When the per-merchant forecast gate is open (flag `reorderForecastLive`) the forecast-based quantity replaces Tier 1 for
 * variants that have a forecast; otherwise this is Tier 1 only.
 */
export async function generateReorderSuggestions(
  prisma: PrismaClient,
  input: { businessId: string; now?: Date },
  forecastQty?: (scoped: TenantScopedClient, rule: ReorderRule, now: Date) => Promise<{ suggestedBaseQty: number; inputs: Record<string, number | string>; arithmetic: string } | null>,
): Promise<GenerateResult> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const result: GenerateResult = { created: 0, superseded: 0, unchanged: 0 };
  if (!(await isFeatureEnabled(scoped, input.businessId, "reorderRules"))) return result;
  const live = (await isFeatureEnabled(scoped, input.businessId, "reorderForecastLive")) && forecastQty !== undefined;

  const rules = await scoped.reorderRule.findMany({ where: { active: true } });
  for (const rule of rules) {
    const variant = await scoped.productVariant.findUnique({ where: { id: rule.variantId } });
    if (!variant) continue;
    const snap = await snapshotFor(scoped, rule.shopId, rule.variantId, rule.windowDays, now);
    let wanted: (Tier1Result & { method: SuggestionMethod }) | null = computeTier1(rule, snap, variant.baseUnit);
    if (wanted && live) {
      const f = await forecastQty!(scoped, rule, now);
      if (f && f.suggestedBaseQty > 0) {
        wanted = {
          method: "TIER2_FORECAST", suggestedBaseQty: f.suggestedBaseQty, inputs: { ...f.inputs, tier1SuggestedBaseQty: wanted.suggestedBaseQty },
          arithmetic: `${f.arithmetic} (Your usual rule would have suggested ${wanted.suggestedBaseQty} ${variant.baseUnit}.)`,
        };
      }
    }
    const open = await scoped.reorderSuggestion.findMany({ where: { shopId: rule.shopId, variantId: rule.variantId, status: "PROPOSED" } });
    const same = wanted ? open.find((o) => o.method === wanted!.method && o.suggestedBaseQty === wanted!.suggestedBaseQty && o.arithmetic === wanted!.arithmetic) : undefined;
    for (const o of open) {
      if (o === same) continue;
      await scoped.reorderSuggestion.update({ where: { id: o.id }, data: { status: "SUPERSEDED", decidedAt: now } });
      result.superseded++;
    }
    if (!wanted) continue;
    if (same) {
      result.unchanged++;
      continue;
    }
    await scoped.reorderSuggestion.create({
      data: {
        businessId: input.businessId, shopId: rule.shopId, variantId: rule.variantId, ruleId: rule.id, method: wanted.method, suggestedBaseQty: wanted.suggestedBaseQty,
        inputs: wanted.inputs as Prisma.InputJsonValue, arithmetic: wanted.arithmetic,
      },
    });
    result.created++;
  }
  return result;
}

export async function listOpenSuggestions(scoped: TenantScopedClient): Promise<(ReorderSuggestion & { sku: string; unit: string })[]> {
  const rows = await scoped.reorderSuggestion.findMany({ where: { status: "PROPOSED" }, orderBy: { createdAt: "asc" }, include: { variant: { select: { sku: true, baseUnit: true } } } });
  return rows.map(({ variant, ...r }) => ({ ...r, sku: variant.sku, unit: variant.baseUnit }));
}

/**
 * Accepting turns the suggestion into a DRAFT purchase order (priced from the supplier's shared list when linked, in the
 * largest whole pack that covers the quantity; unpriced otherwise) and nothing more. It is never sent, paid or messaged.
 */
export async function acceptSuggestion(
  prisma: PrismaClient,
  input: { businessId: string; suggestionId: string; partnerId?: string; counterpartVariantId?: string; /** The supplier's own item code, for a linked supplier, when it cannot be worked out from earlier orders. */ supplierSku?: string; actor?: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const s = await scoped.reorderSuggestion.findUnique({ where: { id: input.suggestionId } });
  if (!s) throw new TradeError("NOT_FOUND", "Suggestion not found.");
  if (s.status !== "PROPOSED") throw new TradeError("WRONG_STATE", `This suggestion is already ${s.status.toLowerCase()}.`);
  const rule = s.ruleId ? await scoped.reorderRule.findUnique({ where: { id: s.ruleId } }) : null;
  const partnerId = input.partnerId ?? rule?.preferredPartnerId;
  if (!partnerId) throw new TradeError("INVALID", "Choose which supplier this order is for.");
  const partner = await scoped.tradePartner.findUnique({ where: { id: partnerId } });
  if (!partner) throw new TradeError("NOT_FOUND", "Supplier not found.");
  const variant = await scoped.productVariant.findUniqueOrThrow({ where: { id: s.variantId }, include: { packs: true } });
  const currency = (await prisma.business.findUniqueOrThrow({ where: { id: input.businessId } })).currencyCode;

  // largest whole pack that does not exceed the quantity, rounding the quantity UP to whole packs
  const pack = [...variant.packs].sort((a, b) => b.baseQuantity - a.baseQuantity).find((p) => p.baseQuantity <= s.suggestedBaseQty);
  const tries = pack ? [{ unit: pack.name, quantity: Math.ceil(s.suggestedBaseQty / pack.baseQuantity) }, { unit: undefined, quantity: s.suggestedBaseQty }] : [{ unit: undefined, quantity: s.suggestedBaseQty }];

  let counterpartVariantId = input.counterpartVariantId;
  if (partner.linkStatus === "LINKED" && !counterpartVariantId) {
    // reuse what an earlier order with this supplier already established for this product
    const earlier = await scoped.tradeOrderLine.findFirst({ where: { variantId: s.variantId, counterpartVariantId: { not: null }, order: { partnerId: partner.id, side: "BUY" } }, orderBy: { createdAt: "desc" } });
    counterpartVariantId = earlier?.counterpartVariantId ?? undefined;
    if (!counterpartVariantId && input.supplierSku && partner.linkId) {
      const catalog = await getSharedCatalog(prisma, { buyerBusinessId: input.businessId, linkId: partner.linkId, at: now });
      counterpartVariantId = catalog.find((c) => c.sku.toLowerCase() === input.supplierSku!.toLowerCase())?.sellerVariantId;
      if (!counterpartVariantId) throw new TradeError("NOT_FOUND", `${partner.name} does not list an item with code ${input.supplierSku}.`);
    }
    if (!counterpartVariantId) throw new TradeError("INVALID", `Say which of ${partner.name}'s items this is: add "sku <their code>".`);
  }

  let line: { unit: string | undefined; quantity: number; counterpartVariantId?: string; unitPriceMinor?: bigint } = tries[tries.length - 1]!;
  if (partner.linkStatus === "LINKED" && counterpartVariantId) {
    const active = partner.linkId ? await prisma.businessLink.findUnique({ where: { id: partner.linkId } }) : null;
    for (const t of tries) {
      try {
        if (active) await resolveSharedPrice(prisma, { buyerBusinessId: input.businessId, linkId: active.id, sellerVariantId: counterpartVariantId, quantity: t.quantity, unit: t.unit ?? null, at: now, currencyCode: currency });
        line = { ...t, counterpartVariantId };
        break;
      } catch {
        /* try the next unit */
      }
    }
    if (!line.counterpartVariantId) line = { ...tries[tries.length - 1]!, counterpartVariantId };
  }
  const order = await createPurchaseOrder(prisma, {
    businessId: input.businessId, partnerId: partner.id, currencyCode: currency, now,
    note: `Reorder suggestion: ${s.arithmetic}`.slice(0, 500), ...(input.actor ? { createdBy: input.actor } : {}),
    lines: [{ variantId: s.variantId, quantity: line.quantity, ...(line.unit ? { unit: line.unit } : {}), ...(line.counterpartVariantId ? { counterpartVariantId: line.counterpartVariantId } : {}) }],
  });
  await scoped.reorderSuggestion.update({ where: { id: s.id }, data: { status: "ACCEPTED", draftOrderId: order.id, decidedAt: now, decidedBy: input.actor ?? null } });
  return order;
}

export async function dismissSuggestion(scoped: TenantScopedClient, input: { suggestionId: string; actor?: string; now?: Date }): Promise<void> {
  const r = await scoped.reorderSuggestion.updateMany({
    where: { id: input.suggestionId, status: "PROPOSED" }, data: { status: "DISMISSED", decidedAt: input.now ?? new Date(), decidedBy: input.actor ?? null },
  });
  if (r.count !== 1) throw new TradeError("WRONG_STATE", "That suggestion is not open.");
}

export async function defaultShopId(scoped: TenantScopedClient, businessId: string): Promise<string> {
  return (await ensureDefaultShopFor(scoped, businessId)).id;
}
