import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, TradeOrder, TradeOrderLine, TradePartner } from "@prisma/client";
import { asTenantScoped, getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../../db/tenantScope.js";
import { enqueueOutboxEvent } from "../outbox.js";
import { toBaseQuantity } from "../catalog.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { resolvePrice } from "../pricing.js";
import { ensureDefaultShopFor } from "../shops.js";
import { releaseReservation, reserveStock, extendReservation } from "../stock.js";
import { recordAuditLog } from "../auditLog.js";
import { evaluateTradeCredit } from "./credit.js";
import { FLAG_STOCK, TradeError, isUniqueViolation, nextReference, requireTradeEnabled } from "./common.js";
import { getActiveLink, resolveSharedPrice, type ActiveLink } from "./partners.js";

/**
 * Orders (expansion Phase 3). Acceptance is its own state machine:
 *
 *   DRAFT -> REQUESTED (buyer sends) -> ACCEPTED (seller accepts, or the buyer accepts the seller's quote)
 *                     \\-> QUOTED (seller revises and HOLDS stock until validUntil) -> ACCEPTED / REJECTED / EXPIRED
 *   any pre-shipment state -> REJECTED (seller) / CANCELLED / EXPIRED
 *
 * Acceptance FREEZES the terms: the lines (quantity, pack, price) are snapshotted into `frozenTerms` and the database
 * refuses further changes to them. Goods movement, invoicing and payment are separate states handled elsewhere.
 * Stock is held (reserved) on the seller's side the moment the seller commits (accepts or quotes).
 */
export const DEFAULT_HOLD_DAYS = 14;
const DAY = 86_400_000;

type TradeOrderWithLines = TradeOrder & { lines: TradeOrderLine[] };

export interface PurchaseLineInput {
  /** The buyer's own variant: stock is received against it. */
  variantId: string;
  /** For a linked supplier: the supplier's variant from the shared catalog. */
  counterpartVariantId?: string;
  quantity: number;
  /** Pack name (carton, bag...) or the base unit; omitted = base unit. */
  unit?: string;
  /** Manual price for a supplier who is not linked (draft lines may be 0 until priced). */
  unitPriceMinor?: bigint;
  description?: string;
}

export interface SalesLineInput {
  variantId: string;
  quantity: number;
  unit?: string;
  unitPriceMinor?: bigint;
  /** Price from one of this business's own wholesale/customer lists instead of a typed price. */
  priceListId?: string;
  description?: string;
}

interface BuiltLine {
  variantId: string;
  counterpartVariantId: string | null;
  description: string;
  sku: string;
  unit: string;
  packBaseQuantity: number;
  quantity: number;
  baseQuantity: number;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
}

function assertQty(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new TradeError("INVALID", "Quantity must be a positive whole number.");
}

function toLineRows(businessId: string, built: BuiltLine[]) {
  return built.map((l, i) => ({
    businessId, lineNo: i + 1, variantId: l.variantId, counterpartVariantId: l.counterpartVariantId, description: l.description, sku: l.sku, unit: l.unit,
    packBaseQuantity: l.packBaseQuantity, quantity: l.quantity, baseQuantity: l.baseQuantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor,
  }));
}

const sumTotals = (built: BuiltLine[]): bigint => built.reduce((s, l) => s + l.lineTotalMinor, 0n);

async function loadOrder(scoped: TenantScopedClient, orderId: string): Promise<TradeOrderWithLines> {
  const order = await scoped.tradeOrder.findUnique({ where: { id: orderId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!order) throw new TradeError("NOT_FOUND", "Order not found.");
  return order;
}

function freezeTerms(order: TradeOrderWithLines, at: Date): Prisma.InputJsonValue {
  return {
    reference: order.reference, side: order.side, currencyCode: order.currencyCode, paymentTermsDays: order.paymentTermsDays, frozenAt: at.toISOString(),
    totalMinor: order.lines.reduce((s, l) => s + l.lineTotalMinor, 0n).toString(),
    lines: order.lines.map((l) => ({
      lineNo: l.lineNo, sku: l.sku, description: l.description, unit: l.unit, packBaseQuantity: l.packBaseQuantity, quantity: l.quantity,
      baseQuantity: l.baseQuantity, unitPriceMinor: l.unitPriceMinor.toString(), lineTotalMinor: l.lineTotalMinor.toString(),
    })),
  };
}

async function enqueue(tx: unknown, input: { businessId: string; orderId: string; eventType: string; dedupeKey: string; payload: Prisma.InputJsonValue }) {
  await enqueueOutboxEvent(tx as Prisma.TransactionClient, {
    businessId: input.businessId, aggregateType: "TradeOrder", aggregateId: input.orderId, eventType: input.eventType, dedupeKey: input.dedupeKey, payload: input.payload,
  });
}

// ------------------------------------------------------------------------------ building lines

async function buildPurchaseLines(
  prisma: PrismaClient,
  scoped: TenantScopedClient,
  businessId: string,
  active: ActiveLink | null,
  currencyCode: string,
  inputs: PurchaseLineInput[],
  at: Date,
): Promise<BuiltLine[]> {
  if (inputs.length === 0) throw new TradeError("INVALID", "An order needs at least one line.");
  const seen = new Set<string>();
  const built: BuiltLine[] = [];
  for (const input of inputs) {
    assertQty(input.quantity);
    const own = await scoped.productVariant.findUnique({ where: { id: input.variantId }, include: { product: true } });
    if (!own) throw new TradeError("INVALID", "One of the products is not in your catalog.");
    if (seen.has(input.variantId)) throw new TradeError("INVALID", "List each product once.");
    seen.add(input.variantId);

    if (active) {
      if (!input.counterpartVariantId) throw new TradeError("INVALID", `Choose the supplier's item for ${own.sku} from their shared catalog.`);
      const price = await resolveSharedPrice(prisma, {
        buyerBusinessId: businessId, linkId: active.link.id, sellerVariantId: input.counterpartVariantId, quantity: input.quantity, unit: input.unit ?? null, at, currencyCode,
      });
      const seller = getTenantScopedClient(prisma, active.counterpartBusinessId);
      const theirs = await seller.productVariant.findUniqueOrThrow({ where: { id: input.counterpartVariantId }, include: { product: true } });
      if (theirs.baseUnit !== own.baseUnit) {
        throw new TradeError("INVALID", `The supplier counts ${theirs.sku} in ${theirs.baseUnit} but you count ${own.sku} in ${own.baseUnit}. Fix the unit before ordering.`);
      }
      built.push({
        variantId: own.id, counterpartVariantId: theirs.id, description: `${theirs.product.name}${theirs.name && theirs.name !== theirs.product.name ? ` ${theirs.name}` : ""}`,
        sku: theirs.sku, unit: price.unit, packBaseQuantity: price.baseQuantity / price.quantity, quantity: input.quantity, baseQuantity: price.baseQuantity,
        unitPriceMinor: price.unitPriceMinor, lineTotalMinor: price.lineTotalMinor,
      });
    } else {
      const { baseQuantity, pack } = await toBaseQuantity(scoped, own.id, input.unit, input.quantity);
      const price = input.unitPriceMinor ?? 0n;
      if (price < 0n) throw new TradeError("INVALID", "A price cannot be negative.");
      built.push({
        variantId: own.id, counterpartVariantId: null, description: input.description ?? `${own.product.name}${own.name !== own.product.name ? ` ${own.name}` : ""}`, sku: own.sku,
        unit: pack?.normalizedName ?? own.baseUnit, packBaseQuantity: pack?.baseQuantity ?? 1, quantity: input.quantity, baseQuantity,
        unitPriceMinor: price, lineTotalMinor: price * BigInt(input.quantity),
      });
    }
  }
  void currencyCode;
  return built;
}

async function buildSalesLines(scoped: TenantScopedClient, inputs: SalesLineInput[], currencyCode: string, at: Date): Promise<BuiltLine[]> {
  if (inputs.length === 0) throw new TradeError("INVALID", "An order needs at least one line.");
  const seen = new Set<string>();
  const built: BuiltLine[] = [];
  for (const input of inputs) {
    assertQty(input.quantity);
    const own = await scoped.productVariant.findUnique({ where: { id: input.variantId }, include: { product: true } });
    if (!own) throw new TradeError("INVALID", "One of the products is not in your catalog.");
    if (seen.has(input.variantId)) throw new TradeError("INVALID", "List each product once.");
    seen.add(input.variantId);
    const { baseQuantity, pack } = await toBaseQuantity(scoped, own.id, input.unit, input.quantity);
    let unitPrice = input.unitPriceMinor ?? 0n;
    let unitName = pack?.normalizedName ?? own.baseUnit;
    if (input.priceListId) {
      const r = await resolvePrice(scoped, { priceListId: input.priceListId, variantId: own.id, quantity: input.quantity, ...(input.unit ? { unit: input.unit } : {}), at, currencyCode });
      unitPrice = r.unitPriceMinor;
      unitName = r.unit;
    }
    if (unitPrice < 0n) throw new TradeError("INVALID", "A price cannot be negative.");
    built.push({
      variantId: own.id, counterpartVariantId: null, description: input.description ?? `${own.product.name}${own.name !== own.product.name ? ` ${own.name}` : ""}`, sku: own.sku,
      unit: unitName, packBaseQuantity: pack?.baseQuantity ?? 1, quantity: input.quantity, baseQuantity, unitPriceMinor: unitPrice, lineTotalMinor: unitPrice * BigInt(input.quantity),
    });
  }
  return built;
}

async function createOrderRow(
  scoped: TenantScopedClient,
  data: { businessId: string; side: "BUY" | "SELL"; partner: TradePartner; currencyCode: string; built: BuiltLine[]; note?: string; validUntil?: Date; createdBy?: string },
): Promise<TradeOrderWithLines> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const reference = await nextReference(scoped, data.side, "order");
    try {
      return await scoped.tradeOrder.create({
        data: {
          businessId: data.businessId, side: data.side, partnerId: data.partner.id, reference, currencyCode: data.currencyCode, totalMinor: sumTotals(data.built),
          paymentTermsDays: data.partner.paymentTermsDays, validUntil: data.validUntil ?? null, note: data.note ?? null, createdBy: data.createdBy ?? null,
          lines: { create: toLineRows(data.businessId, data.built) },
        },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new TradeError("DUPLICATE", "Could not allocate an order number; try again.");
}

// ----------------------------------------------------------------------------------- buyer side

export async function createPurchaseOrder(
  prisma: PrismaClient,
  input: { businessId: string; partnerId: string; currencyCode: string; lines: PurchaseLineInput[]; note?: string; validUntil?: Date; createdBy?: string; now?: Date },
): Promise<TradeOrderWithLines> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const partner = await scoped.tradePartner.findUnique({ where: { id: input.partnerId } });
  if (!partner) throw new TradeError("NOT_FOUND", "Partner not found.");
  if (partner.role === "CUSTOMER") throw new TradeError("INVALID", `${partner.name} is a customer, not a supplier.`);
  const active = partner.linkStatus === "LINKED" ? await getActiveLink(prisma, input.businessId, partner.id) : null;
  const built = await buildPurchaseLines(prisma, scoped, input.businessId, active, input.currencyCode, input.lines, input.now ?? new Date());
  return createOrderRow(scoped, { businessId: input.businessId, side: "BUY", partner, currencyCode: input.currencyCode, built, ...(input.note ? { note: input.note } : {}), ...(input.validUntil ? { validUntil: input.validUntil } : {}), ...(input.createdBy ? { createdBy: input.createdBy } : {}) });
}

/** Replaces the lines of a DRAFT purchase order (drafts carry no financial effect, so their lines may be rebuilt). */
export async function setDraftPurchaseLines(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; lines: PurchaseLineInput[]; now?: Date },
): Promise<TradeOrderWithLines> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "BUY" || order.acceptance !== "DRAFT") throw new TradeError("WRONG_STATE", "Only a draft purchase order can be edited.");
  const partner = await scoped.tradePartner.findUniqueOrThrow({ where: { id: order.partnerId } });
  const active = partner.linkStatus === "LINKED" ? await getActiveLink(prisma, input.businessId, partner.id) : null;
  const built = await buildPurchaseLines(prisma, scoped, input.businessId, active, order.currencyCode, input.lines, input.now ?? new Date());
  return withScopedTransaction(scoped, async (tx) => {
    await tx.tradeOrderLine.deleteMany({ where: { orderId: order.id } });
    await tx.tradeOrderLine.createMany({ data: toLineRows(input.businessId, built).map((r) => ({ ...r, orderId: order.id })) });
    await tx.tradeOrder.update({ where: { id: order.id }, data: { totalMinor: sumTotals(built) } });
    return loadOrder(tx, order.id);
  });
}

/**
 * Sends a draft purchase order to a LINKED supplier. Prices are re-resolved from the supplier's shared lists at this
 * moment (an expired or below-minimum price refuses the submit); the supplier's own row is created by the outbox handler.
 */
export async function submitPurchaseOrder(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; validUntil?: Date; now?: Date },
): Promise<TradeOrderWithLines> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "BUY" || order.acceptance !== "DRAFT") throw new TradeError("WRONG_STATE", "Only a draft purchase order can be sent.");
  const partner = await scoped.tradePartner.findUniqueOrThrow({ where: { id: order.partnerId } });
  if (partner.linkStatus !== "LINKED") throw new TradeError("NOT_LINKED", "This supplier is not linked. Record their confirmation with confirmUnlinkedPurchase instead.");
  const active = await getActiveLink(prisma, input.businessId, partner.id);

  const repriced: { id: string; unit: string; packBase: number; baseQuantity: number; price: bigint; total: bigint }[] = [];
  for (const l of order.lines) {
    if (!l.counterpartVariantId) throw new TradeError("INVALID", `Line ${l.lineNo} has no supplier item.`);
    const r = await resolveSharedPrice(prisma, {
      buyerBusinessId: input.businessId, linkId: active.link.id, sellerVariantId: l.counterpartVariantId, quantity: l.quantity, unit: l.unit, at: now, currencyCode: order.currencyCode,
    });
    repriced.push({ id: l.id, unit: r.unit, packBase: r.baseQuantity / r.quantity, baseQuantity: r.baseQuantity, price: r.unitPriceMinor, total: r.lineTotalMinor });
  }
  const validUntil = input.validUntil ?? order.validUntil ?? null;
  if (validUntil && validUntil <= now) throw new TradeError("EXPIRED", "The validity date is already past.");

  return withScopedTransaction(scoped, async (tx) => {
    for (const r of repriced) {
      await tx.tradeOrderLine.update({ where: { id: r.id }, data: { unit: r.unit, packBaseQuantity: r.packBase, baseQuantity: r.baseQuantity, unitPriceMinor: r.price, lineTotalMinor: r.total } });
    }
    const total = repriced.reduce((s, r) => s + r.total, 0n);
    const claimed = await tx.tradeOrder.updateMany({ where: { id: order.id, acceptance: "DRAFT" }, data: { acceptance: "REQUESTED", totalMinor: total, validUntil } });
    if (claimed.count !== 1) throw new TradeError("WRONG_STATE", "The order was just changed by someone else.");
    await enqueue(tx, { businessId: input.businessId, orderId: order.id, eventType: "trade.order.requested", dedupeKey: `trade.order.requested:${order.id}`, payload: { buyerBusinessId: input.businessId, buyerOrderId: order.id } });
    return loadOrder(tx, order.id);
  });
}

/** For a supplier who is NOT on TradePal: the buyer records that the supplier confirmed (by phone, WhatsApp...), freezing the terms. */
export async function confirmUnlinkedPurchase(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; evidenceNote: string; actor?: string; now?: Date },
): Promise<TradeOrderWithLines> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "BUY" || !["DRAFT", "REQUESTED"].includes(order.acceptance)) throw new TradeError("WRONG_STATE", "This order cannot be confirmed in its current state.");
  const partner = await scoped.tradePartner.findUniqueOrThrow({ where: { id: order.partnerId } });
  if (partner.linkStatus === "LINKED") throw new TradeError("INVALID", "This supplier is linked on TradePal: send the order to them instead.");
  if (!input.evidenceNote.trim()) throw new TradeError("INVALID", "Say how the supplier confirmed (for example: confirmed by phone on 20 Oct).");
  if (order.lines.some((l) => l.unitPriceMinor <= 0n)) throw new TradeError("UNPRICED", "Every line needs the agreed price before the order can be confirmed.");
  return withScopedTransaction(scoped, async (tx) => {
    const fresh = await loadOrder(tx, order.id);
    await tx.tradeOrder.update({
      where: { id: order.id },
      data: { acceptance: "ACCEPTED", acceptedAt: now, frozenTerms: { ...(freezeTerms(fresh, now) as object), evidence: input.evidenceNote.trim() } as Prisma.InputJsonValue },
    });
    await recordAuditLog(tx, { businessId: input.businessId, actorType: "MERCHANT", ...(input.actor ? { actorId: input.actor } : {}), action: "trade.order.confirmed_unlinked", entityType: "TradeOrder", entityId: order.id, metadata: { evidence: input.evidenceNote.trim() } });
    return loadOrder(tx, order.id);
  });
}

/** The buyer accepts the supplier's quote. The supplier's side finalises it (and keeps the stock held). */
export async function acceptQuote(prisma: PrismaClient, input: { businessId: string; orderId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "BUY" || order.acceptance !== "QUOTED") throw new TradeError("WRONG_STATE", "There is no quote to accept on this order.");
  if (order.validUntil && order.validUntil <= now) throw new TradeError("EXPIRED", "This quote has expired.");
  await withScopedTransaction(scoped, async (tx) => {
    await enqueue(tx, { businessId: input.businessId, orderId: order.id, eventType: "trade.quote.accepted", dedupeKey: `trade.quote.accepted:${order.id}`, payload: { buyerBusinessId: input.businessId, buyerOrderId: order.id } });
  });
}

// ---------------------------------------------------------------------------------- seller side

export async function createSalesOrder(
  prisma: PrismaClient,
  input: { businessId: string; partnerId: string; currencyCode: string; lines: SalesLineInput[]; note?: string; validUntil?: Date; createdBy?: string; now?: Date },
): Promise<TradeOrderWithLines> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const partner = await scoped.tradePartner.findUnique({ where: { id: input.partnerId } });
  if (!partner) throw new TradeError("NOT_FOUND", "Partner not found.");
  if (partner.role === "SUPPLIER") throw new TradeError("INVALID", `${partner.name} is a supplier, not a customer.`);
  if (partner.linkStatus === "LINKED") throw new TradeError("INVALID", "This customer orders through TradePal: ask them to send a purchase order, then accept or quote it.");
  const built = await buildSalesLines(scoped, input.lines, input.currencyCode, input.now ?? new Date());
  return createOrderRow(scoped, { businessId: input.businessId, side: "SELL", partner, currencyCode: input.currencyCode, built, ...(input.note ? { note: input.note } : {}), ...(input.validUntil ? { validUntil: input.validUntil } : {}), ...(input.createdBy ? { createdBy: input.createdBy } : {}) });
}

async function holdLines(tx: TenantScopedClient, order: TradeOrderWithLines, expiresAt: Date, tag: string): Promise<void> {
  const shop = await ensureDefaultShopFor(tx, order.businessId);
  let needsStock = false;
  for (const l of order.lines) {
    const variant = l.variantId ? await tx.productVariant.findUnique({ where: { id: l.variantId } }) : null;
    if (!variant?.trackStock) continue;
    needsStock = true;
    const r = await reserveStock(tx, {
      businessId: order.businessId, shopId: shop.id, variantId: variant.id, quantity: l.baseQuantity, reference: `order:${order.id}`,
      idempotencyKey: `trade:${order.id}:${l.lineNo}:${tag}`, expiresAt,
    });
    await tx.tradeOrderLine.update({ where: { id: l.id }, data: { reservationId: r.reservation.id } });
  }
  if (needsStock && !(await isFeatureEnabled(tx, order.businessId, FLAG_STOCK))) throw new TradeError("REQUIRES_STOCK", "Holding stock for an order needs stock v2 turned on.");
}

async function releaseLines(tx: TenantScopedClient, order: TradeOrderWithLines, now: Date): Promise<void> {
  for (const l of order.lines) if (l.reservationId) await releaseReservation(tx, l.reservationId, now);
}

/**
 * The seller accepts. Stock is reserved for every tracked line in the same transaction, so a line that cannot be
 * supplied refuses the whole acceptance (nothing is half-held). Credit rules are checked first; a block can be
 * overridden only with a named person and a reason, which is audited.
 */
export async function acceptSalesOrder(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; actor?: string; holdDays?: number; creditOverride?: { by: string; reason: string }; now?: Date },
): Promise<TradeOrderWithLines> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "SELL") throw new TradeError("WRONG_STATE", "Only a sales order can be accepted by the seller.");
  if (!["REQUESTED", "DRAFT"].includes(order.acceptance)) throw new TradeError("WRONG_STATE", `This order is ${order.acceptance.toLowerCase()}; it cannot be accepted now.`);
  if (order.validUntil && order.validUntil <= now) throw new TradeError("EXPIRED", "This order's validity has passed.");
  if (order.lines.some((l) => l.unitPriceMinor <= 0n)) throw new TradeError("UNPRICED", "Every line needs a price before the order can be accepted.");

  const credit = await evaluateTradeCredit(scoped, { partnerId: order.partnerId, additionalMinor: order.totalMinor, now });
  if (!credit.allowed) {
    if (!input.creditOverride?.reason.trim() || !input.creditOverride.by) throw new TradeError("CREDIT_BLOCKED", credit.reasons.map((r) => r.message).join(" "), credit);
  }
  const holdUntil = new Date(now.getTime() + (input.holdDays ?? DEFAULT_HOLD_DAYS) * DAY);

  return withScopedTransaction(scoped, async (tx) => {
    const claimed = await tx.tradeOrder.updateMany({ where: { id: order.id, acceptance: order.acceptance }, data: { holdUntil } });
    if (claimed.count !== 1) throw new TradeError("WRONG_STATE", "The order was just changed by someone else.");
    await holdLines(tx, order, holdUntil, "accept");
    const fresh = await loadOrder(tx, order.id);
    await tx.tradeOrder.update({ where: { id: order.id }, data: { acceptance: "ACCEPTED", acceptedAt: now, frozenTerms: freezeTerms(fresh, now) } });
    if (!credit.allowed && input.creditOverride) {
      await recordAuditLog(tx, {
        businessId: input.businessId, actorType: "MERCHANT", actorId: input.creditOverride.by, action: "trade.credit.override", entityType: "TradeOrder", entityId: order.id,
        metadata: { reason: input.creditOverride.reason, reasons: credit.reasons.map((r) => r.code) },
      });
    }
    if (order.counterpartOrderId) {
      await enqueue(tx, { businessId: input.businessId, orderId: order.id, eventType: "trade.order.accepted", dedupeKey: `trade.order.accepted:${order.id}`, payload: { sellerBusinessId: input.businessId, sellerOrderId: order.id } });
    }
    return loadOrder(tx, order.id);
  });
}

/**
 * The seller counters: changes quantities and/or prices on the existing lines and HOLDS the stock until validUntil.
 * The buyer then accepts, rejects or lets it expire. (A line cannot be added or removed; reject and re-request instead.)
 */
export async function quoteSalesOrder(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; changes: { lineNo: number; quantity?: number; unitPriceMinor?: bigint }[]; validUntil: Date; note?: string; now?: Date },
): Promise<TradeOrderWithLines> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  await requireTradeEnabled(scoped, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "SELL" || !["REQUESTED", "QUOTED"].includes(order.acceptance)) throw new TradeError("WRONG_STATE", "Only a requested order can be quoted.");
  if (!order.counterpartOrderId) throw new TradeError("INVALID", "A quote goes to a linked buyer. For other customers, edit the order and accept it.");
  if (input.validUntil <= now) throw new TradeError("EXPIRED", "A quote must be valid into the future.");

  const byNo = new Map(input.changes.map((c) => [c.lineNo, c]));
  for (const c of input.changes) if (!order.lines.some((l) => l.lineNo === c.lineNo)) throw new TradeError("INVALID", `There is no line ${c.lineNo}.`);

  return withScopedTransaction(scoped, async (tx) => {
    await releaseLines(tx, order, now);
    let total = 0n;
    for (const l of order.lines) {
      const c = byNo.get(l.lineNo);
      const quantity = c?.quantity ?? l.quantity;
      assertQty(quantity);
      const price = c?.unitPriceMinor ?? l.unitPriceMinor;
      if (price <= 0n) throw new TradeError("UNPRICED", `Line ${l.lineNo} needs a price.`);
      const lineTotal = price * BigInt(quantity);
      total += lineTotal;
      await tx.tradeOrderLine.update({
        where: { id: l.id }, data: { quantity, baseQuantity: quantity * l.packBaseQuantity, unitPriceMinor: price, lineTotalMinor: lineTotal, reservationId: null },
      });
    }
    await tx.tradeOrder.update({ where: { id: order.id }, data: { acceptance: "QUOTED", totalMinor: total, validUntil: input.validUntil, ...(input.note ? { note: input.note } : {}) } });
    const fresh = await loadOrder(tx, order.id);
    await holdLines(tx, fresh, input.validUntil, randomUUID());
    await enqueue(tx, { businessId: input.businessId, orderId: order.id, eventType: "trade.order.quoted", dedupeKey: `trade.order.quoted:${order.id}:${randomUUID()}`, payload: { sellerBusinessId: input.businessId, sellerOrderId: order.id } });
    return loadOrder(tx, order.id);
  });
}

/** Seller-side finalisation of a quote the buyer accepted (called by the outbox handler). Idempotent. */
export async function finaliseQuoteAcceptance(prisma: PrismaClient, input: { sellerBusinessId: string; sellerOrderId: string; now?: Date; holdDays?: number }): Promise<"ACCEPTED" | "ALREADY" | "NOT_QUOTED"> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.sellerBusinessId);
  const order = await loadOrder(scoped, input.sellerOrderId);
  if (order.acceptance === "ACCEPTED") return "ALREADY";
  if (order.acceptance !== "QUOTED" || (order.validUntil && order.validUntil <= now)) return "NOT_QUOTED";
  const holdUntil = new Date(now.getTime() + (input.holdDays ?? DEFAULT_HOLD_DAYS) * DAY);
  await withScopedTransaction(scoped, async (tx) => {
    for (const l of order.lines) if (l.reservationId) await extendReservation(tx, l.reservationId, holdUntil);
    const claimed = await tx.tradeOrder.updateMany({ where: { id: order.id, acceptance: "QUOTED" }, data: { acceptance: "ACCEPTED", acceptedAt: now, holdUntil } });
    if (claimed.count !== 1) return;
    const fresh = await loadOrder(tx, order.id);
    await tx.tradeOrder.update({ where: { id: order.id }, data: { frozenTerms: freezeTerms(fresh, now) } });
    await enqueue(tx, { businessId: input.sellerBusinessId, orderId: order.id, eventType: "trade.order.accepted", dedupeKey: `trade.order.accepted:${order.id}`, payload: { sellerBusinessId: input.sellerBusinessId, sellerOrderId: order.id } });
  });
  return "ACCEPTED";
}

type ClosedStatus = "REJECTED" | "CANCELLED" | "EXPIRED";

async function closeOrderRow(tx: TenantScopedClient, order: TradeOrderWithLines, status: ClosedStatus, reason: string | undefined, now: Date): Promise<void> {
  await releaseLines(tx, order, now);
  await tx.tradeOrder.update({ where: { id: order.id }, data: { acceptance: status, closedAt: now, ...(reason ? { note: `${order.note ? order.note + " | " : ""}${status.toLowerCase()}: ${reason}`.slice(0, 500) } : {}) } });
}

/**
 * Closes an order before anything has shipped. The buyer withdrawing = CANCELLED; the seller declining a request or quote
 * = REJECTED; the seller cancelling an accepted order = CANCELLED. Stock held for it is released. The other side is told.
 */
export async function cancelOrder(prisma: PrismaClient, input: { businessId: string; orderId: string; reason?: string; actor?: string; now?: Date }): Promise<TradeOrderWithLines> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (!["DRAFT", "REQUESTED", "QUOTED", "ACCEPTED"].includes(order.acceptance)) throw new TradeError("WRONG_STATE", `This order is already ${order.acceptance.toLowerCase()}.`);
  if (order.lines.some((l) => l.shippedBase > 0)) throw new TradeError("WRONG_STATE", "Goods have already shipped on this order; it cannot be cancelled.");
  const status: ClosedStatus = order.side === "SELL" && ["REQUESTED", "QUOTED"].includes(order.acceptance) ? "REJECTED" : "CANCELLED";
  return withScopedTransaction(scoped, async (tx) => {
    const claimed = await tx.tradeOrder.updateMany({ where: { id: order.id, acceptance: order.acceptance }, data: { closedAt: now } });
    if (claimed.count !== 1) throw new TradeError("WRONG_STATE", "The order was just changed by someone else.");
    await closeOrderRow(tx, order, status, input.reason, now);
    if (order.counterpartOrderId) {
      await enqueue(tx, {
        businessId: input.businessId, orderId: order.id, eventType: "trade.order.closed", dedupeKey: `trade.order.closed:${order.id}`,
        payload: { fromBusinessId: input.businessId, orderId: order.id, status, reason: input.reason ?? null },
      });
    }
    return loadOrder(tx, order.id);
  });
}

/** Expires requested/quoted orders past their validity, on every business's own rows, and releases held stock. */
export async function expireTradeOrders(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const due = await prisma.tradeOrder.findMany({ where: { acceptance: { in: ["REQUESTED", "QUOTED"] }, validUntil: { lte: now } }, select: { id: true, businessId: true } });
  let expired = 0;
  for (const d of due) {
    const scoped = getTenantScopedClient(prisma, d.businessId);
    await withScopedTransaction(scoped, async (tx) => {
      const order = await loadOrder(tx, d.id);
      if (!["REQUESTED", "QUOTED"].includes(order.acceptance)) return;
      await closeOrderRow(tx, order, "EXPIRED", undefined, now);
      expired++;
    });
  }
  return expired;
}

/** The reservations behind a seller's accepted order are renewed (or re-made) for what has not shipped yet. */
export async function renewOrderHold(prisma: PrismaClient, input: { businessId: string; orderId: string; holdDays?: number; now?: Date }): Promise<TradeOrderWithLines> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const order = await loadOrder(scoped, input.orderId);
  if (order.side !== "SELL" || order.acceptance !== "ACCEPTED") throw new TradeError("WRONG_STATE", "Only an accepted sales order has a hold to renew.");
  const holdUntil = new Date(now.getTime() + (input.holdDays ?? DEFAULT_HOLD_DAYS) * DAY);
  return withScopedTransaction(scoped, async (tx) => {
    const shop = await ensureDefaultShopFor(tx, order.businessId);
    for (const l of order.lines) {
      const remaining = l.baseQuantity - l.shippedBase;
      if (remaining <= 0 || !l.variantId) continue;
      const variant = await tx.productVariant.findUnique({ where: { id: l.variantId } });
      if (!variant?.trackStock) continue;
      if (l.reservationId && (await extendReservation(tx, l.reservationId, holdUntil))) continue;
      const r = await reserveStock(tx, {
        businessId: order.businessId, shopId: shop.id, variantId: variant.id, quantity: remaining, reference: `order:${order.id}`, idempotencyKey: `trade:${order.id}:${l.lineNo}:renew:${randomUUID()}`, expiresAt: holdUntil,
      });
      await tx.tradeOrderLine.update({ where: { id: l.id }, data: { reservationId: r.reservation.id } });
    }
    await tx.tradeOrder.update({ where: { id: order.id }, data: { holdUntil } });
    return loadOrder(tx, order.id);
  });
}

export { loadOrder, freezeTerms, closeOrderRow, enqueue as enqueueTradeEvent, asTenantScoped };
export type { TradeOrderWithLines };
