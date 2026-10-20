import { Prisma } from "@prisma/client";
import type { ActorType, InventoryItem, Provenance, StockBalance, StockMovement, StockMovementKind, StockReservation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { asTenantScoped, withScopedTransaction, type TenantScopedClient } from "../db/tenantScope.js";
import { postStockWriteDown, postStockWriteUp, postJournal, type SystemAccountKey } from "./accounting.js";
import { isFeatureEnabled } from "./featureFlags.js";
import { ensureDefaultShopFor } from "./shops.js";
import { divRoundHalfUp } from "./rounding.js";

/**
 * Movement-based stock (expansion Phase 2): one system for manual, WhatsApp, B2B and B2C stock changes.
 *
 * - The truth is the append-only `StockMovement` log. `StockBalance` is a running total per (shop, variant) that every
 *   change updates in the SAME transaction, under a row lock (SELECT ... FOR UPDATE), so two concurrent orders
 *   cannot both take the last unit. `reconcileStock` proves the balance equals the movement sums.
 * - on hand / reserved / available / damaged (quarantine) / in transit are separate numbers; available = on hand - reserved.
 * - Costing: moving weighted average over COSTED units only. Units that arrived without a cost are tracked
 *   (`uncostedQty`), consumed first on the way out, and any outflow that touches them (or goes below zero) is flagged
 *   `costIncomplete`, so profit built on it is labelled incomplete rather than overstated.
 *   Returns restock at the cost the units left at. Backdated entries keep their `occurredAt` but are costed at posting
 *   time (history is not restated); see docs/expansion/accounting-postings.md.
 */
export class StockError extends Error {
  readonly code: "INSUFFICIENT_STOCK" | "INVALID" | "NOT_FOUND" | "RESERVATION_CLOSED" | "COUNT_CLOSED" | "REASON_REQUIRED" | "TRANSFER_STATE" | "OVER_RECEIPT";
  readonly available: number | undefined;
  constructor(code: StockError["code"], message: string, available?: number) {
    super(message);
    this.code = code;
    this.available = available;
  }
}

interface Actor {
  type: ActorType;
  id?: string;
}

export interface PostMovementInput {
  businessId: string;
  shopId: string;
  variantId: string;
  kind: StockMovementKind;
  onHandDelta?: number;
  damagedDelta?: number;
  inTransitDelta?: number;
  /** Units of an existing reservation released by this movement (fulfilment consumes its own reservation). */
  reservedRelease?: number;
  unitCostMinor?: bigint | null;
  currencyCode?: string;
  occurredAt?: Date;
  provenance?: Provenance;
  sourceType?: string;
  sourceId?: string;
  actor?: Actor;
  note?: string;
  idempotencyKey?: string;
  /** 'REQUIRE_AVAILABLE' refuses an on-hand decrease that would dip into reserved or below zero. */
  availability?: "REQUIRE_AVAILABLE" | "ALLOW_NEGATIVE";
  reversalOfMovementId?: string;
}

export interface PostedMovement {
  movement: StockMovement;
  balance: StockBalance;
  replayed: boolean;
}

interface BalanceRow {
  id: string;
  onHand: number;
  reserved: number;
  damaged: number;
  inTransit: number;
  avgCostMinor: bigint | null;
  uncostedQty: number;
  costCurrency: string | null;
}

async function lockBalance(tx: TenantScopedClient, businessId: string, shopId: string, variantId: string): Promise<BalanceRow> {
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO "StockBalance" ("id","businessId","shopId","variantId","updatedAt") VALUES (${randomUUID()}, ${businessId}, ${shopId}, ${variantId}, now()) ON CONFLICT ("shopId","variantId") DO NOTHING`,
  );
  const rows = await tx.$queryRaw<BalanceRow[]>(
    Prisma.sql`SELECT "id","onHand","reserved","damaged","inTransit","avgCostMinor","uncostedQty","costCurrency" FROM "StockBalance" WHERE "shopId" = ${shopId} AND "variantId" = ${variantId} AND "businessId" = ${businessId} FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) throw new StockError("NOT_FOUND", "Stock balance not found.");
  return row;
}

async function assertShopAndVariant(tx: TenantScopedClient, shopId: string, variantId: string) {
  const shop = await tx.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new StockError("NOT_FOUND", "Shop not found.");
  const variant = await tx.productVariant.findUnique({ where: { id: variantId } });
  if (!variant) throw new StockError("NOT_FOUND", "Variant not found.");
  return variant;
}

/** Core: runs inside a transaction the caller opened. */
async function postMovementTx(tx: TenantScopedClient, input: PostMovementInput): Promise<PostedMovement> {
  const onHandDelta = input.onHandDelta ?? 0;
  const damagedDelta = input.damagedDelta ?? 0;
  const inTransitDelta = input.inTransitDelta ?? 0;
  const reservedRelease = input.reservedRelease ?? 0;
  for (const n of [onHandDelta, damagedDelta, inTransitDelta, reservedRelease]) {
    if (!Number.isInteger(n)) throw new StockError("INVALID", "Stock quantities must be whole numbers.");
  }
  if (onHandDelta === 0 && damagedDelta === 0 && inTransitDelta === 0) throw new StockError("INVALID", "A stock movement must change something.");

  if (input.idempotencyKey) {
    const existing = await tx.stockMovement.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      const balance = await tx.stockBalance.findFirstOrThrow({ where: { shopId: existing.shopId, variantId: existing.variantId } });
      return { movement: existing, balance, replayed: true };
    }
  }

  await assertShopAndVariant(tx, input.shopId, input.variantId);
  const b = await lockBalance(tx, input.businessId, input.shopId, input.variantId);

  const newReserved = b.reserved - reservedRelease;
  const newOnHand = b.onHand + onHandDelta;
  const newDamaged = b.damaged + damagedDelta;
  const newInTransit = b.inTransit + inTransitDelta;
  if (newReserved < 0 || newDamaged < 0 || newInTransit < 0) throw new StockError("INVALID", "That would make a stock bucket negative.");
  if (onHandDelta < 0 && (input.availability ?? "REQUIRE_AVAILABLE") === "REQUIRE_AVAILABLE" && newOnHand - newReserved < 0) {
    throw new StockError("INSUFFICIENT_STOCK", `Only ${Math.max(0, b.onHand - b.reserved)} available.`, Math.max(0, b.onHand - b.reserved));
  }

  // ---- costing (only the on-hand bucket carries cost)
  let avg = b.avgCostMinor;
  let uncosted = b.uncostedQty;
  let costMinor: bigint | null = null;
  let movementUnitCost: bigint | null = input.unitCostMinor ?? null;
  let costIncomplete = false;

  if (onHandDelta > 0) {
    const q = onHandDelta;
    const costedBefore = Math.max(0, b.onHand - b.uncostedQty);
    if (input.unitCostMinor !== undefined && input.unitCostMinor !== null) {
      if (input.unitCostMinor < 0n) throw new StockError("INVALID", "A unit cost cannot be negative.");
      avg = avg === null || costedBefore === 0
        ? input.unitCostMinor
        : divRoundHalfUp(avg * BigInt(costedBefore) + input.unitCostMinor * BigInt(q), BigInt(costedBefore + q));
    } else {
      uncosted += q; // arrived without a cost: tracked, never guessed
    }
  } else if (onHandDelta < 0) {
    const q = -onHandDelta;
    const uncostedConsumed = Math.min(q, Math.max(0, b.uncostedQty));
    const costedOnHand = Math.max(0, b.onHand - b.uncostedQty);
    const costedPortion = Math.min(q - uncostedConsumed, costedOnHand);
    const beyond = q - uncostedConsumed - costedPortion; // units that were never on hand (sold below zero)
    uncosted = b.uncostedQty - uncostedConsumed;
    costIncomplete = uncostedConsumed > 0 || beyond > 0;
    if (avg !== null && costedPortion > 0) {
      costMinor = avg * BigInt(costedPortion);
      movementUnitCost = avg;
    } else {
      costMinor = null;
      movementUnitCost = null;
    }
    if (input.unitCostMinor !== undefined && input.unitCostMinor !== null) movementUnitCost = input.unitCostMinor;
  } else if (damagedDelta < 0 && avg !== null) {
    // Writing quarantined stock off: it leaves at the current average cost.
    costMinor = avg * BigInt(-damagedDelta);
    movementUnitCost = avg;
  }

  const movement = await tx.stockMovement.create({
    data: {
      businessId: input.businessId,
      shopId: input.shopId,
      variantId: input.variantId,
      kind: input.kind,
      onHandDelta,
      damagedDelta,
      inTransitDelta,
      unitCostMinor: movementUnitCost,
      costCurrency: input.currencyCode ?? null,
      costIncomplete,
      costMinor,
      occurredAt: input.occurredAt ?? new Date(),
      provenance: input.provenance ?? "MERCHANT_ENTERED",
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      actorType: input.actor?.type ?? "SYSTEM",
      actorId: input.actor?.id ?? null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      reversalOfMovementId: input.reversalOfMovementId ?? null,
    },
  });

  const balance = await tx.stockBalance.update({
    where: { id: b.id },
    data: {
      onHand: newOnHand,
      reserved: newReserved,
      damaged: newDamaged,
      inTransit: newInTransit,
      avgCostMinor: avg,
      uncostedQty: uncosted,
      ...(input.currencyCode ? { costCurrency: input.currencyCode } : {}),
    },
  });

  await journalMovementIfEnabled(tx, movement, input.currencyCode ?? b.costCurrency ?? undefined);
  return { movement, balance, replayed: false };
}

/**
 * Money effect of a stock movement, posted in the same transaction when `accountingJournals` is on.
 * Sale cost of goods, losses, owner withdrawals, count differences and restocks all move value between Inventory
 * and an expense/equity account at the movement's cost. Receipts and transfers do not post here: a purchase is
 * journaled by the purchase (Dr Inventory, Cr cash/payables), and a transfer keeps the value inside Inventory.
 */
async function journalMovementIfEnabled(tx: TenantScopedClient, m: StockMovement, currency: string | undefined): Promise<void> {
  if (!currency) return;
  if (!(await isFeatureEnabled(tx, m.businessId, "accountingJournals"))) return;
  const common = {
    businessId: m.businessId,
    currencyCode: currency,
    occurredAt: m.occurredAt,
    idempotencyKey: `stock:${m.id}`,
    source: { type: "STOCK_MOVEMENT", id: m.id },
    provenance: m.provenance,
    actor: { type: m.actorType, ...(m.actorId ? { id: m.actorId } : {}) },
  } as const;
  const cost = m.costMinor ?? 0n;
  switch (m.kind) {
    case "SALE_FULFILLMENT": {
      if (cost > 0n) {
        await postJournal(tx, { ...common, kind: "COGS", lines: [{ account: "COGS", debitMinor: cost }, { account: "INVENTORY", creditMinor: cost }] });
      }
      break;
    }
    case "SPOILAGE":
    case "COUNT_ADJUSTMENT":
    case "MANUAL_ADJUSTMENT": {
      if (m.onHandDelta < 0 || m.damagedDelta < 0) {
        if (cost > 0n) await postStockWriteDown(tx, { ...common, costMinor: cost, into: "INVENTORY_SHRINKAGE" });
      } else if (m.onHandDelta > 0 && m.unitCostMinor && m.unitCostMinor > 0n) {
        await postStockWriteUp(tx, { ...common, costMinor: m.unitCostMinor * BigInt(m.onHandDelta) });
      }
      break;
    }
    case "OWNER_WITHDRAWAL": {
      if (cost > 0n) await postStockWriteDown(tx, { ...common, costMinor: cost, into: "OWNER_WITHDRAWALS" });
      break;
    }
    case "RETURN_RESTOCK": {
      const value = m.unitCostMinor ? m.unitCostMinor * BigInt(m.onHandDelta) : 0n;
      if (value > 0n) await postJournal(tx, { ...common, kind: "RESTOCK", lines: [{ account: "INVENTORY", debitMinor: value }, { account: "COGS", creditMinor: value }] });
      break;
    }
    case "OPENING_BALANCE": {
      const value = m.unitCostMinor && m.onHandDelta > 0 ? m.unitCostMinor * BigInt(m.onHandDelta) : 0n;
      if (value > 0n) {
        await postJournal(tx, { ...common, kind: "OPENING_BALANCE", provenance: "MIGRATED_OPENING", lines: [{ account: "INVENTORY" satisfies SystemAccountKey, debitMinor: value }, { account: "OPENING_BALANCE_EQUITY", creditMinor: value }] });
      }
      break;
    }
    default:
      break;
  }
}

export async function postStockMovement(scoped: TenantScopedClient, input: PostMovementInput): Promise<PostedMovement> {
  return withScopedTransaction(scoped, (tx) => postMovementTx(tx, input));
}

// -------------------------------------------------------------------------------------- reading

export interface StockLevel {
  variantId: string;
  shopId: string;
  onHand: number;
  reserved: number;
  available: number;
  damaged: number;
  inTransit: number;
  /** Private: cost never appears in any storefront or public view. */
  avgCostMinor: bigint | null;
  uncostedQty: number;
}

export async function getStockLevel(scoped: TenantScopedClient, shopId: string, variantId: string): Promise<StockLevel> {
  const b = await scoped.stockBalance.findFirst({ where: { shopId, variantId } });
  return {
    variantId,
    shopId,
    onHand: b?.onHand ?? 0,
    reserved: b?.reserved ?? 0,
    available: (b?.onHand ?? 0) - (b?.reserved ?? 0),
    damaged: b?.damaged ?? 0,
    inTransit: b?.inTransit ?? 0,
    avgCostMinor: b?.avgCostMinor ?? null,
    uncostedQty: b?.uncostedQty ?? 0,
  };
}

export async function getStockPolicy(scoped: TenantScopedClient) {
  const row = await scoped.stockPolicy.findFirst({ where: {} });
  return { negativeStock: row?.negativeStock ?? "ALLOW", allowBackorder: row?.allowBackorder ?? false } as const;
}

export async function setStockPolicy(
  scoped: TenantScopedClient,
  businessId: string,
  policy: { negativeStock?: "ALLOW" | "BLOCK"; allowBackorder?: boolean },
) {
  const existing = await scoped.stockPolicy.findFirst({ where: {} });
  if (existing) return scoped.stockPolicy.update({ where: { id: existing.id }, data: { ...policy } });
  return scoped.stockPolicy.create({ data: { businessId, ...policy } });
}

// --------------------------------------------------------------------------- everyday movements

interface Common {
  businessId: string;
  shopId: string;
  variantId: string;
  quantity: number; // base units, > 0
  occurredAt?: Date;
  actor?: Actor;
  note?: string;
  idempotencyKey?: string;
  sourceType?: string;
  sourceId?: string;
  provenance?: Provenance;
}

function positiveQty(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new StockError("INVALID", "Quantity must be a positive whole number.");
}

/** A confirmed goods receipt. (A purchase ORDER never increases stock; only this does.) */
export async function receiveStock(scoped: TenantScopedClient, input: Common & { unitCostMinor?: bigint; currencyCode?: string }) {
  positiveQty(input.quantity);
  return postStockMovement(scoped, { ...input, kind: "RECEIPT", onHandDelta: input.quantity });
}

export async function recordOpeningBalance(scoped: TenantScopedClient, input: Common & { unitCostMinor?: bigint; currencyCode?: string }) {
  positiveQty(input.quantity);
  return postStockMovement(scoped, { ...input, kind: "OPENING_BALANCE", onHandDelta: input.quantity, provenance: "MIGRATED_OPENING" });
}

/**
 * Takes stock out for a sale/fulfilment without a reservation. Refused when it would dip into reserved stock or go
 * below zero if the business policy is BLOCK (or `requireAvailable` is set), unless `approvedBy` names an approver.
 */
export async function fulfilSale(
  scoped: TenantScopedClient,
  input: Common & { requireAvailable?: boolean; approvedBy?: string; currencyCode?: string },
) {
  positiveQty(input.quantity);
  const policy = await getStockPolicy(scoped);
  const strict = (input.requireAvailable ?? policy.negativeStock === "BLOCK") && !input.approvedBy;
  return postStockMovement(scoped, {
    ...input,
    kind: "SALE_FULFILLMENT",
    onHandDelta: -input.quantity,
    availability: strict ? "REQUIRE_AVAILABLE" : "ALLOW_NEGATIVE",
    ...(input.approvedBy ? { note: `${input.note ? input.note + " " : ""}[negative stock approved by ${input.approvedBy}]` } : {}),
  });
}

export async function recordSpoilage(scoped: TenantScopedClient, input: Common & { currencyCode?: string }) {
  positiveQty(input.quantity);
  return postStockMovement(scoped, { ...input, kind: "SPOILAGE", onHandDelta: -input.quantity });
}

/** An explicit owner withdrawal of stock for personal use. Equity movement, not a loss and not a sale. */
export async function recordOwnerWithdrawal(scoped: TenantScopedClient, input: Common & { currencyCode?: string }) {
  positiveQty(input.quantity);
  return postStockMovement(scoped, { ...input, kind: "OWNER_WITHDRAWAL", onHandDelta: -input.quantity });
}

/** Moves units from sellable stock into quarantine (damaged). */
export async function quarantineStock(scoped: TenantScopedClient, input: Common) {
  positiveQty(input.quantity);
  return postStockMovement(scoped, { ...input, kind: "DAMAGE_QUARANTINE", onHandDelta: -input.quantity, damagedDelta: input.quantity });
}

/** Writes quarantined units off (they leave the books at average cost). */
export async function writeOffQuarantined(scoped: TenantScopedClient, input: Common & { currencyCode?: string }) {
  positiveQty(input.quantity);
  return postStockMovement(scoped, { ...input, kind: "SPOILAGE", damagedDelta: -input.quantity });
}

/**
 * A sellable return that has been RECEIVED and ACCEPTED: stock goes back in at the cost it left at (pass that cost;
 * omit only when it is genuinely unknown, which marks the units uncosted).
 */
export async function restockReturn(scoped: TenantScopedClient, input: Common & { unitCostMinor?: bigint; currencyCode?: string }) {
  positiveQty(input.quantity);
  return postStockMovement(scoped, { ...input, kind: "RETURN_RESTOCK", onHandDelta: input.quantity });
}

/** Undoes a movement exactly (on-hand/damaged/in-transit swapped). Idempotent: one reversal per movement. */
export async function reverseStockMovement(scoped: TenantScopedClient, movementId: string, actor?: Actor, note?: string) {
  const original = await scoped.stockMovement.findUnique({ where: { id: movementId } });
  if (!original) throw new StockError("NOT_FOUND", "Movement not found.");
  if (original.reversalOfMovementId) throw new StockError("INVALID", "A reversal cannot be reversed.");
  const existing = await scoped.stockMovement.findFirst({ where: { reversalOfMovementId: original.id } });
  if (existing) {
    const balance = await scoped.stockBalance.findFirstOrThrow({ where: { shopId: existing.shopId, variantId: existing.variantId } });
    return { movement: existing, balance, replayed: true } satisfies PostedMovement;
  }
  return postStockMovement(scoped, {
    businessId: original.businessId,
    shopId: original.shopId,
    variantId: original.variantId,
    kind: "REVERSAL",
    onHandDelta: -original.onHandDelta,
    damagedDelta: -original.damagedDelta,
    inTransitDelta: -original.inTransitDelta,
    ...(original.unitCostMinor !== null ? { unitCostMinor: original.unitCostMinor } : {}),
    ...(original.costCurrency ? { currencyCode: original.costCurrency } : {}),
    sourceType: "STOCK_MOVEMENT",
    sourceId: original.id,
    reversalOfMovementId: original.id,
    availability: "ALLOW_NEGATIVE",
    provenance: "SYSTEM_DERIVED",
    ...(actor ? { actor } : {}),
    ...(note ? { note } : {}),
  });
}

// ------------------------------------------------------------------------------------- reservations

export interface ReserveInput {
  businessId: string;
  shopId: string;
  variantId: string;
  quantity: number;
  reference: string;
  idempotencyKey: string;
  expiresAt: Date;
  now?: Date;
}

/**
 * Holds stock for an order or basket. Atomic: the balance row is locked, so of two concurrent reservations for the
 * last units exactly one succeeds. Refused when available < quantity unless the business allows backorders.
 * Idempotent per idempotencyKey (a retried request returns the original reservation).
 */
export async function reserveStock(scoped: TenantScopedClient, input: ReserveInput): Promise<{ reservation: StockReservation; replayed: boolean }> {
  positiveQty(input.quantity);
  const now = input.now ?? new Date();
  if (input.expiresAt <= now) throw new StockError("INVALID", "A reservation must expire in the future.");
  return withScopedTransaction(scoped, async (tx) => {
    const existing = await tx.stockReservation.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { reservation: existing, replayed: true };
    await assertShopAndVariant(tx, input.shopId, input.variantId);
    const b = await lockBalance(tx, input.businessId, input.shopId, input.variantId);
    const policy = await getStockPolicy(tx);
    const available = b.onHand - b.reserved;
    if (input.quantity > available && !policy.allowBackorder) {
      throw new StockError("INSUFFICIENT_STOCK", `Only ${Math.max(0, available)} available.`, Math.max(0, available));
    }
    const reservation = await tx.stockReservation.create({
      data: {
        businessId: input.businessId,
        shopId: input.shopId,
        variantId: input.variantId,
        quantity: input.quantity,
        expiresAt: input.expiresAt,
        reference: input.reference,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await tx.stockBalance.update({ where: { id: b.id }, data: { reserved: b.reserved + input.quantity } });
    return { reservation, replayed: false };
  });
}

async function closeReservation(tx: TenantScopedClient, reservationId: string, to: "RELEASED" | "EXPIRED" | "CONSUMED", now: Date): Promise<StockReservation | null> {
  const r = await tx.stockReservation.findUnique({ where: { id: reservationId } });
  if (!r) throw new StockError("NOT_FOUND", "Reservation not found.");
  if (r.status !== "ACTIVE") return null;
  // Lock first so a concurrent fulfil/release of the same reservation is serialized.
  const b = await lockBalance(tx, r.businessId, r.shopId, r.variantId);
  const claimed = await tx.stockReservation.updateMany({ where: { id: r.id, status: "ACTIVE" }, data: { status: to, settledAt: now } });
  if (claimed.count !== 1) return null;
  if (to !== "CONSUMED") await tx.stockBalance.update({ where: { id: b.id }, data: { reserved: b.reserved - r.quantity } });
  return r;
}

/** Releases an active reservation (order cancelled). Safe to call twice. */
export async function releaseReservation(scoped: TenantScopedClient, reservationId: string, now: Date = new Date()): Promise<boolean> {
  return withScopedTransaction(scoped, async (tx) => (await closeReservation(tx, reservationId, "RELEASED", now)) !== null);
}

/** Pushes an ACTIVE reservation's expiry later (never earlier). Returns false if it is no longer active. */
export async function extendReservation(scoped: TenantScopedClient, reservationId: string, newExpiresAt: Date): Promise<boolean> {
  const r = await scoped.stockReservation.updateMany({ where: { id: reservationId, status: "ACTIVE", expiresAt: { lt: newExpiresAt } }, data: { expiresAt: newExpiresAt } });
  if (r.count === 1) return true;
  const row = await scoped.stockReservation.findUnique({ where: { id: reservationId } });
  return row?.status === "ACTIVE";
}

/** Expires every active reservation past its time. Returns how many were released. */
export async function expireReservations(scoped: TenantScopedClient, now: Date = new Date()): Promise<number> {
  const due = await scoped.stockReservation.findMany({ where: { status: "ACTIVE", expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: 500 });
  let released = 0;
  for (const r of due) {
    if (await withScopedTransaction(scoped, async (tx) => (await closeReservation(tx, r.id, "EXPIRED", now)) !== null)) released++;
  }
  return released;
}

/**
 * Fulfils a reservation: the held units leave on-hand and the hold is consumed, in one transaction. Fulfilling fewer
 * than reserved releases the remainder (partial fulfilment). A reservation that already expired or was released
 * cannot be fulfilled: re-reserve instead.
 */
export async function fulfilReservation(
  scoped: TenantScopedClient,
  reservationId: string,
  options: {
    quantity?: number;
    /** Ship part of the hold and keep the rest reserved for the next shipment (B2B partial deliveries). */
    keepRemainder?: boolean;
    actor?: Actor;
    note?: string;
    now?: Date;
    currencyCode?: string;
    sourceType?: string;
    sourceId?: string;
  } = {},
): Promise<PostedMovement> {
  const now = options.now ?? new Date();
  return withScopedTransaction(scoped, async (tx) => {
    const r = await tx.stockReservation.findUnique({ where: { id: reservationId } });
    if (!r) throw new StockError("NOT_FOUND", "Reservation not found.");
    const quantity = options.quantity ?? r.quantity;
    positiveQty(quantity);
    if (quantity > r.quantity) throw new StockError("INVALID", "Cannot fulfil more than was reserved.");
    if (r.status !== "ACTIVE") throw new StockError("RESERVATION_CLOSED", `Reservation is ${r.status.toLowerCase()}.`);
    if (r.expiresAt <= now) throw new StockError("RESERVATION_CLOSED", "Reservation has expired.");
    const keep = Boolean(options.keepRemainder) && quantity < r.quantity;
    // Claim: a full fulfilment closes the hold; a partial one shrinks it (guarded on the quantity we read).
    const claimed = keep
      ? await tx.stockReservation.updateMany({ where: { id: r.id, status: "ACTIVE", quantity: r.quantity }, data: { quantity: r.quantity - quantity } })
      : await tx.stockReservation.updateMany({ where: { id: r.id, status: "ACTIVE" }, data: { status: "CONSUMED", settledAt: now } });
    if (claimed.count !== 1) throw new StockError("RESERVATION_CLOSED", "Reservation was just changed by someone else.");
    return postMovementTx(tx, {
      businessId: r.businessId,
      shopId: r.shopId,
      variantId: r.variantId,
      kind: "SALE_FULFILLMENT",
      onHandDelta: -quantity,
      // keep: release only what shipped; otherwise the whole hold ends and any unfulfilled remainder goes back to available
      reservedRelease: keep ? quantity : r.quantity,
      availability: "ALLOW_NEGATIVE",
      sourceType: options.sourceType ?? "RESERVATION",
      sourceId: options.sourceId ?? r.id,
      idempotencyKey: `fulfil:${r.id}:${r.quantity}`,
      ...(options.currencyCode ? { currencyCode: options.currencyCode } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.note ? { note: options.note } : {}),
    });
  });
}

// ------------------------------------------------------------------------------------- stock counts

export async function openStockCount(scoped: TenantScopedClient, input: { businessId: string; shopId: string; openedBy?: string; note?: string }) {
  return scoped.stockCount.create({ data: { businessId: input.businessId, shopId: input.shopId, openedBy: input.openedBy ?? null, note: input.note ?? null } });
}

/** Records what was physically counted for a variant; `expectedQty` is snapshotted from on-hand at this moment. */
export async function recordCountLine(
  scoped: TenantScopedClient,
  input: { businessId: string; countId: string; variantId: string; countedQty: number; reason?: string },
) {
  if (!Number.isInteger(input.countedQty) || input.countedQty < 0) throw new StockError("INVALID", "A counted quantity must be zero or more.");
  const count = await scoped.stockCount.findUnique({ where: { id: input.countId } });
  if (!count) throw new StockError("NOT_FOUND", "Count not found.");
  if (count.status !== "OPEN") throw new StockError("COUNT_CLOSED", "This count is already closed.");
  const level = await getStockLevel(scoped, count.shopId, input.variantId);
  const expectedQty = level.onHand;
  const data = { expectedQty, countedQty: input.countedQty, discrepancy: input.countedQty - expectedQty, reason: input.reason ?? null };
  const existing = await scoped.stockCountLine.findFirst({ where: { countId: input.countId, variantId: input.variantId } });
  if (existing) return scoped.stockCountLine.update({ where: { id: existing.id }, data });
  return scoped.stockCountLine.create({ data: { businessId: input.businessId, countId: input.countId, variantId: input.variantId, ...data } });
}

/**
 * Explains a difference without recounting: the expected/counted snapshot stays exactly as recorded.
 * (Recording the same variant again is a RECOUNT and re-snapshots expected from current on-hand.)
 */
export async function setCountLineReason(scoped: TenantScopedClient, countId: string, variantId: string, reason: string) {
  const count = await scoped.stockCount.findUnique({ where: { id: countId } });
  if (!count) throw new StockError("NOT_FOUND", "Count not found.");
  if (count.status !== "OPEN") throw new StockError("COUNT_CLOSED", "This count is already closed.");
  const line = await scoped.stockCountLine.findFirst({ where: { countId, variantId } });
  if (!line) throw new StockError("NOT_FOUND", "That variant has not been counted yet.");
  if (!reason.trim()) throw new StockError("REASON_REQUIRED", "A reason cannot be empty.");
  return scoped.stockCountLine.update({ where: { id: line.id }, data: { reason: reason.trim() } });
}

/**
 * Approves a count: every non-zero discrepancy needs a reason, then becomes a COUNT_ADJUSTMENT movement of
 * (counted - expected as of the count), so sales made after the count are not undone. One approval, once.
 */
export async function approveStockCount(
  scoped: TenantScopedClient,
  countId: string,
  approver: { id: string },
  currencyCode?: string,
): Promise<{ adjustments: number }> {
  const count = await scoped.stockCount.findUnique({ where: { id: countId }, include: { lines: true } });
  if (!count) throw new StockError("NOT_FOUND", "Count not found.");
  if (count.status !== "OPEN") throw new StockError("COUNT_CLOSED", "This count is already closed.");
  const nonZero = count.lines.filter((l) => l.discrepancy !== 0);
  const missing = nonZero.filter((l) => !l.reason?.trim());
  if (missing.length > 0) throw new StockError("REASON_REQUIRED", `${missing.length} line(s) with a difference need a reason before approval.`);

  let adjustments = 0;
  for (const line of nonZero) {
    const result = await postStockMovement(scoped, {
      businessId: count.businessId,
      shopId: count.shopId,
      variantId: line.variantId,
      kind: "COUNT_ADJUSTMENT",
      onHandDelta: line.discrepancy,
      availability: "ALLOW_NEGATIVE",
      sourceType: "STOCK_COUNT",
      sourceId: count.id,
      idempotencyKey: `count:${count.id}:${line.variantId}`,
      ...(line.reason ? { note: line.reason } : {}),
      actor: { type: "MERCHANT", id: approver.id },
      ...(currencyCode ? { currencyCode } : {}),
    });
    if (!result.replayed) adjustments++;
  }
  const closed = await scoped.stockCount.updateMany({ where: { id: count.id, status: "OPEN" }, data: { status: "APPROVED", approvedBy: approver.id, approvedAt: new Date() } });
  if (closed.count !== 1) throw new StockError("COUNT_CLOSED", "This count was just closed by someone else.");
  return { adjustments };
}

export async function cancelStockCount(scoped: TenantScopedClient, countId: string) {
  const r = await scoped.stockCount.updateMany({ where: { id: countId, status: "OPEN" }, data: { status: "CANCELLED" } });
  if (r.count !== 1) throw new StockError("COUNT_CLOSED", "Only an open count can be cancelled.");
}

// --------------------------------------------------------------------------------------- transfers

export async function createTransfer(
  scoped: TenantScopedClient,
  input: { businessId: string; fromShopId: string; toShopId: string; lines: { variantId: string; quantity: number }[]; note?: string },
) {
  if (input.fromShopId === input.toShopId) throw new StockError("INVALID", "A transfer needs two different shops.");
  if (input.lines.length === 0) throw new StockError("INVALID", "A transfer needs at least one line.");
  for (const l of input.lines) positiveQty(l.quantity);
  if (new Set(input.lines.map((l) => l.variantId)).size !== input.lines.length) throw new StockError("INVALID", "List each variant once.");
  if (!(await scoped.shop.findUnique({ where: { id: input.fromShopId } })) || !(await scoped.shop.findUnique({ where: { id: input.toShopId } }))) {
    throw new StockError("NOT_FOUND", "Shop not found.");
  }
  return scoped.stockTransfer.create({
    data: {
      businessId: input.businessId,
      fromShopId: input.fromShopId,
      toShopId: input.toShopId,
      note: input.note ?? null,
      lines: { create: input.lines.map((l) => ({ businessId: input.businessId, variantId: l.variantId, quantitySent: l.quantity })) },
    },
    include: { lines: true },
  });
}

/** Dispatch: source on-hand falls (cost carried), destination shows the units as IN TRANSIT. Destination on-hand does not change yet. */
export async function dispatchTransfer(scoped: TenantScopedClient, transferId: string, actor?: Actor) {
  return withScopedTransaction(scoped, async (tx) => {
    const t = await tx.stockTransfer.findUnique({ where: { id: transferId }, include: { lines: true } });
    if (!t) throw new StockError("NOT_FOUND", "Transfer not found.");
    if (t.status !== "DRAFT") throw new StockError("TRANSFER_STATE", `Transfer is ${t.status.toLowerCase()}.`);
    const claimed = await tx.stockTransfer.updateMany({ where: { id: t.id, status: "DRAFT" }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
    if (claimed.count !== 1) throw new StockError("TRANSFER_STATE", "Transfer was just dispatched by someone else.");
    for (const line of t.lines) {
      const out = await postMovementTx(tx, {
        businessId: t.businessId, shopId: t.fromShopId, variantId: line.variantId, kind: "TRANSFER_DISPATCH",
        onHandDelta: -line.quantitySent, sourceType: "STOCK_TRANSFER", sourceId: t.id, idempotencyKey: `transfer-out:${t.id}:${line.variantId}`,
        availability: "REQUIRE_AVAILABLE", ...(actor ? { actor } : {}),
      });
      await tx.stockTransferLine.update({ where: { id: line.id }, data: { unitCostMinor: out.movement.unitCostMinor } });
      await postMovementTx(tx, {
        businessId: t.businessId, shopId: t.toShopId, variantId: line.variantId, kind: "TRANSFER_DISPATCH",
        inTransitDelta: line.quantitySent, sourceType: "STOCK_TRANSFER", sourceId: t.id, idempotencyKey: `transfer-in-transit:${t.id}:${line.variantId}`,
        ...(actor ? { actor } : {}),
      });
    }
    return tx.stockTransfer.findUniqueOrThrow({ where: { id: t.id }, include: { lines: true } });
  });
}

/**
 * Receipt at the destination: in-transit clears and ONLY the received quantity becomes on-hand. A short receipt is
 * recorded (quantityReceived < quantitySent) and the shortfall is written off as a loss in transit at the carried cost.
 */
export async function receiveTransfer(
  scoped: TenantScopedClient,
  transferId: string,
  received: { variantId: string; quantity: number }[],
  options: { actor?: Actor; currencyCode?: string } = {},
) {
  return withScopedTransaction(scoped, async (tx) => {
    const t = await tx.stockTransfer.findUnique({ where: { id: transferId }, include: { lines: true } });
    if (!t) throw new StockError("NOT_FOUND", "Transfer not found.");
    if (t.status !== "DISPATCHED") throw new StockError("TRANSFER_STATE", `Transfer is ${t.status.toLowerCase()}.`);
    const byVariant = new Map(received.map((r) => [r.variantId, r.quantity]));
    for (const line of t.lines) {
      const q = byVariant.get(line.variantId);
      if (q === undefined) throw new StockError("INVALID", "Give a received quantity for every line (zero if nothing arrived).");
      if (!Number.isInteger(q) || q < 0) throw new StockError("INVALID", "Received quantity must be zero or more.");
      if (q > line.quantitySent) throw new StockError("OVER_RECEIPT", "Cannot receive more than was sent.");
    }
    const claimed = await tx.stockTransfer.updateMany({ where: { id: t.id, status: "DISPATCHED" }, data: { status: "RECEIVED", receivedAt: new Date() } });
    if (claimed.count !== 1) throw new StockError("TRANSFER_STATE", "Transfer was just received by someone else.");
    for (const line of t.lines) {
      const q = byVariant.get(line.variantId)!;
      await postMovementTx(tx, {
        businessId: t.businessId, shopId: t.toShopId, variantId: line.variantId, kind: "TRANSFER_RECEIPT",
        inTransitDelta: -line.quantitySent, onHandDelta: q,
        ...(line.unitCostMinor !== null ? { unitCostMinor: line.unitCostMinor } : {}),
        sourceType: "STOCK_TRANSFER", sourceId: t.id, idempotencyKey: `transfer-receipt:${t.id}:${line.variantId}`,
        ...(options.actor ? { actor: options.actor } : {}),
      });
      await tx.stockTransferLine.update({ where: { id: line.id }, data: { quantityReceived: q } });
      const shortfall = line.quantitySent - q;
      if (shortfall > 0 && line.unitCostMinor && line.unitCostMinor > 0n && options.currencyCode && (await isFeatureEnabled(tx, t.businessId, "accountingJournals"))) {
        await postStockWriteDown(tx, {
          businessId: t.businessId, currencyCode: options.currencyCode, costMinor: line.unitCostMinor * BigInt(shortfall), into: "INVENTORY_SHRINKAGE",
          idempotencyKey: `transfer-shortfall:${t.id}:${line.variantId}`, source: { type: "STOCK_TRANSFER", id: t.id }, memo: "Short receipt on transfer",
        });
      }
    }
    return tx.stockTransfer.findUniqueOrThrow({ where: { id: t.id }, include: { lines: true } });
  });
}

export async function cancelTransfer(scoped: TenantScopedClient, transferId: string) {
  const r = await scoped.stockTransfer.updateMany({ where: { id: transferId, status: "DRAFT" }, data: { status: "CANCELLED" } });
  if (r.count !== 1) throw new StockError("TRANSFER_STATE", "Only a draft transfer can be cancelled (a dispatched one must be received).");
}

// ---------------------------------------------------------------------------------- reconciliation

export interface StockMismatch {
  shopId: string;
  variantId: string;
  field: "onHand" | "damaged" | "inTransit" | "reserved";
  balance: number;
  expected: number;
}

/** Proves the running balances equal the movement log and the active reservations. Empty = consistent. */
export async function reconcileStock(scoped: TenantScopedClient): Promise<StockMismatch[]> {
  const balances = await scoped.stockBalance.findMany({ where: {} });
  const sums = await scoped.stockMovement.groupBy({ by: ["shopId", "variantId"], _sum: { onHandDelta: true, damagedDelta: true, inTransitDelta: true } });
  const holds = await scoped.stockReservation.groupBy({ by: ["shopId", "variantId"], where: { status: "ACTIVE" }, _sum: { quantity: true } });
  const out: StockMismatch[] = [];
  for (const b of balances) {
    const s = sums.find((x) => x.shopId === b.shopId && x.variantId === b.variantId);
    const h = holds.find((x) => x.shopId === b.shopId && x.variantId === b.variantId);
    const checks: [StockMismatch["field"], number, number][] = [
      ["onHand", b.onHand, s?._sum.onHandDelta ?? 0],
      ["damaged", b.damaged, s?._sum.damagedDelta ?? 0],
      ["inTransit", b.inTransit, s?._sum.inTransitDelta ?? 0],
      ["reserved", b.reserved, h?._sum.quantity ?? 0],
    ];
    for (const [field, balance, expected] of checks) if (balance !== expected) out.push({ shopId: b.shopId, variantId: b.variantId, field, balance, expected });
  }
  return out;
}

export interface LegacyStockDrift {
  inventoryItemId: string;
  variantId: string;
  sku: string;
  legacyEstimate: number;
  v2OnHand: number;
}

/**
 * Items that adopted a catalog variant should keep the legacy estimate and the new on-hand equal while the mirror is
 * on (they start equal at adoption, then every legacy movement is mirrored). A difference means a mirror write failed,
 * the flag was off for a while, or someone changed one side directly. Reporting only: nothing is auto-corrected.
 */
export async function findLegacyStockDrift(scoped: TenantScopedClient, shopId: string): Promise<LegacyStockDrift[]> {
  const variants = await scoped.productVariant.findMany({ where: { inventoryItemId: { not: null } }, include: { inventoryItem: true } });
  const drift: LegacyStockDrift[] = [];
  for (const v of variants) {
    if (!v.inventoryItem) continue;
    const level = await getStockLevel(scoped, shopId, v.id);
    if (level.onHand !== v.inventoryItem.estimatedStockQty) {
      drift.push({ inventoryItemId: v.inventoryItem.id, variantId: v.id, sku: v.sku, legacyEstimate: v.inventoryItem.estimatedStockQty, v2OnHand: level.onHand });
    }
  }
  return drift;
}

// ------------------------------------------------------------------------------- legacy bridge

/**
 * Adoption helper: posts the OPENING_BALANCE for a legacy item that just became a variant (see adoptLegacyInventory).
 * No cost is invented, so the units are uncosted until a costed receipt or count says otherwise.
 */
export async function postAdoptionOpening(
  scoped: TenantScopedClient,
  input: { businessId: string; shopId: string; variantId: string; item: InventoryItem },
): Promise<boolean> {
  if (input.item.estimatedStockQty === 0) return false;
  await postStockMovement(scoped, {
    businessId: input.businessId, shopId: input.shopId, variantId: input.variantId, kind: "OPENING_BALANCE",
    onHandDelta: input.item.estimatedStockQty, provenance: "MIGRATED_OPENING", availability: "ALLOW_NEGATIVE",
    sourceType: "INVENTORY_ITEM", sourceId: input.item.id, idempotencyKey: `adopt:${input.item.id}`,
    note: "Opening stock adopted from the earlier inventory estimate",
  });
  return true;
}

/**
 * Mirrors one legacy InventoryMovement into the new log for a variant that adopted its item. Called by the legacy
 * path when `stockV2` is on; failures are logged and never break the merchant's message (reconcile later).
 */
export async function mirrorLegacyMovement(
  scoped: TenantScopedClient,
  input: { businessId: string; inventoryItemId: string; legacyMovementId: string; quantityDelta: number; transactionId?: string; currencyCode?: string },
): Promise<void> {
  try {
    if (!(await isFeatureEnabled(scoped, input.businessId, "stockV2"))) return;
    const variant = await scoped.productVariant.findFirst({ where: { inventoryItemId: input.inventoryItemId } });
    if (!variant || !variant.trackStock || input.quantityDelta === 0) return;
    const shop = await ensureDefaultShopFor(scoped, input.businessId);
    await postStockMovement(scoped, {
      businessId: input.businessId, shopId: shop.id, variantId: variant.id, kind: "LEGACY_MIRROR",
      onHandDelta: input.quantityDelta, availability: "ALLOW_NEGATIVE", sourceType: "INVENTORY_MOVEMENT", sourceId: input.legacyMovementId,
      idempotencyKey: `legacy:${input.legacyMovementId}`, provenance: "MERCHANT_ENTERED",
      ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}),
    });
  } catch (error) {
    console.error("stock mirror failed (reconcile with reconcileStock):", error instanceof Error ? error.message : error);
  }
}

export { asTenantScoped };
