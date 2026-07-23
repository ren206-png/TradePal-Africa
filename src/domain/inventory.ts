import { Prisma } from "@prisma/client";
import type { InventoryItem, MovementSource } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";

/**
 * Phase 14: stock/inventory tracking. `InventoryItem`/`InventoryMovement`
 * (plus the `MovementSource` enum) have existed in the Prisma schema and in
 * `tenantScope.ts`'s `TENANT_SCOPED_MODELS` since an earlier phase's
 * migration, but nothing in `src/` ever read or wrote them — this module is
 * the first actual application-layer use.
 *
 * Deliberately minimal, mirroring `estimatedStockQty`'s own doc comment in
 * the schema ("an estimate; a sale is never blocked by this reaching zero"):
 * this is a lightweight running-count feature for a merchant who wants a
 * rough sense of what's left, not a full stock-take/reconciliation system.
 * Phase 15: a SALE/PURCHASE logged via natural language with itemized
 * `items` now DOES move stock too, but only when the business has the
 * `stockTracking` FeatureFlag on — see `applyParsedIntent.ts`'s
 * `applySale`/`applyPurchase` for the caller. This intentionally still does
 * NOT happen for a business that never opted in, for the exact reason
 * originally disclosed here: resolving free-text item names to
 * InventoryItem rows on every sale/purchase line would otherwise silently
 * create a lot of low-signal InventoryItem rows for businesses that never
 * intended to track stock.
 */

export class InvalidStockThresholdError extends Error {}

/**
 * `InventoryItem.name` is not `@unique` in the schema (unlike
 * `Merchant.phoneNumber`), so "the bread item" for a business is whatever
 * row this lookup finds first — case-insensitive, exact-match only (no
 * fuzzy/partial matching), mirroring `findOrCreateSupplierByName`'s own
 * `{ equals, mode: "insensitive" }` convention in applyParsedIntent.ts. Two
 * merchants typing "Bread" and "bread" resolve to the same row; "Bread"
 * and "bread loaf" do not — a known, disclosed limitation, not a bug.
 *
 * Exported (as of Phase 15) so `applyParsedIntent.ts` can resolve an
 * `InventoryItem` row for each SALE/PURCHASE line item *before* creating the
 * `Transaction`, since `TransactionItem.inventoryItemId` must be set as part
 * of that same nested `create` call — see `applyStockMovement` below for the
 * quantity-adjustment half, which runs *after* the transaction exists so it
 * can stamp `InventoryMovement.transactionId`.
 *
 * Phase 17: closes a same-item-name collision race. Two concurrent calls for
 * a business's brand-new item (e.g. two WhatsApp messages both saying "sold
 * 2 Bread" within milliseconds of each other) would previously both miss the
 * `findFirst` (since neither row exists yet) and both proceed to `create`,
 * producing two `InventoryItem` rows for what should be one item — silently
 * splitting that item's stock count across two rows forever after.
 * `InventoryItem` now has a `@@unique([businessId, normalizedName])`
 * constraint (see schema.prisma), so the loser of the race gets a Prisma
 * P2002 unique-violation on `create` instead of succeeding; that failure is
 * caught here and treated as "someone else just created it — go read what
 * they made," mirroring the standard upsert-via-catch pattern for
 * constraints Prisma's own `upsert` can't express against a computed column.
 */
export async function findOrCreateInventoryItem(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  itemName: string,
): Promise<InventoryItem> {
  const name = itemName.trim();
  const normalizedName = name.toLowerCase();
  const existing = await scopedPrisma.inventoryItem.findFirst({
    where: { businessId, normalizedName },
  });
  if (existing) return existing;

  try {
    return await scopedPrisma.inventoryItem.create({ data: { businessId, name, normalizedName } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await scopedPrisma.inventoryItem.findFirst({ where: { businessId, normalizedName } });
      if (winner) return winner;
    }
    throw error;
  }
}

export interface StockAdjustmentResult {
  item: InventoryItem;
  quantityDelta: number;
}

/**
 * Applies a signed quantity change to an item's `estimatedStockQty` and
 * records the `InventoryMovement` row that explains it — the movement row
 * is this feature's own append-style record of what happened (mirroring how
 * `Transaction` itself is the record for ledger entries, per
 * `src/domain/ledger.ts`), so no separate `AuditLog` row is written for a
 * routine adjustment; only genuinely admin/system-actor events (staff
 * roster changes, subscription lifecycle, etc.) go through `recordAuditLog`
 * — see PHASE_0_FINDINGS.md's Phase 14 section for the explicit rationale.
 *
 * `source` defaults to `"ADJUSTMENT"`: the only caller today is the
 * STOCK_ADJUSTMENT AI intent (a merchant directly declaring "sold 2 bread
 * from stock" etc.), which isn't tied to an actual logged SALE/PURCHASE
 * transaction (see this module's own doc comment on that gap) — so
 * `"SALE"`/`"PURCHASE"` sources are reserved for a future caller that links
 * this to `recordTransaction`, and `"SHRINKAGE_UNKNOWN"` is reserved for a
 * future explicit "stock write-off" command, neither of which exists yet.
 */
export async function recordStockAdjustment(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  itemName: string,
  quantityDelta: number,
  source: MovementSource = "ADJUSTMENT",
  transactionId?: string,
): Promise<StockAdjustmentResult> {
  const item = await findOrCreateInventoryItem(scopedPrisma, businessId, itemName);
  return applyStockMovement(scopedPrisma, businessId, item, quantityDelta, source, transactionId);
}

/**
 * The quantity-adjustment half of `recordStockAdjustment`, split out (Phase
 * 15) so a caller that has *already* resolved (or created) the
 * `InventoryItem` row — as `applySale`/`applyPurchase` must, to link
 * `TransactionItem.inventoryItemId` before the `Transaction` exists — can
 * apply the movement afterward without a redundant find-or-create lookup.
 */
export async function applyStockMovement(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  item: InventoryItem,
  quantityDelta: number,
  source: MovementSource,
  transactionId?: string,
): Promise<StockAdjustmentResult> {
  const updated = await scopedPrisma.inventoryItem.update({
    where: { id: item.id },
    data: { estimatedStockQty: { increment: quantityDelta } },
  });

  await scopedPrisma.inventoryMovement.create({
    data: {
      businessId,
      inventoryItemId: item.id,
      quantityDelta,
      source,
      ...(transactionId ? { transactionId } : {}),
    },
  });

  return { item: updated, quantityDelta };
}

export interface InventoryStatusEntry {
  id: string;
  name: string;
  unit: string | null;
  estimatedStockQty: number;
  lowStockThreshold: number | null;
  /** true only when a threshold is set AND the current estimate is at or below it. No threshold = never flagged. */
  isLowStock: boolean;
}

/** Powers the `/stock` command — every InventoryItem for the business, alphabetical, with a computed low-stock flag. */
export async function getInventoryStatus(
  scopedPrisma: TenantScopedClient,
  businessId: string,
): Promise<InventoryStatusEntry[]> {
  const items = await scopedPrisma.inventoryItem.findMany({
    where: { businessId },
    orderBy: { name: "asc" },
  });

  return items.map((item) => ({
    id: item.id,
    name: item.name,
    unit: item.unit,
    estimatedStockQty: item.estimatedStockQty,
    lowStockThreshold: item.lowStockThreshold,
    isLowStock: item.lowStockThreshold !== null && item.estimatedStockQty <= item.lowStockThreshold,
  }));
}

/**
 * Sets (or clears, with `null`) the low-stock alert threshold for an item —
 * powers the `/lowstock <item> <threshold>` command. Unlike
 * `recordStockAdjustment`, this never moves `estimatedStockQty` and never
 * writes an `InventoryMovement` row (there is no quantity change to
 * explain); it's a pure configuration edit on the `InventoryItem` row
 * itself, so the row's own `lowStockThreshold` column is the record — same
 * "no separate AuditLog row for routine business-data configuration"
 * rationale as `recordStockAdjustment` above.
 */
export async function setLowStockThreshold(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  itemName: string,
  threshold: number | null,
): Promise<InventoryItem> {
  if (threshold !== null && threshold < 0) {
    throw new InvalidStockThresholdError("Low-stock threshold must be zero or a positive whole number.");
  }

  const item = await findOrCreateInventoryItem(scopedPrisma, businessId, itemName);
  return scopedPrisma.inventoryItem.update({
    where: { id: item.id },
    data: { lowStockThreshold: threshold },
  });
}

/**
 * Sets the sale price for an item — powers the `/setprice <item> <amount>`
 * command (Phase 24). Same pure-configuration-edit shape as
 * `setLowStockThreshold` above: no InventoryMovement, no AuditLog, the row's
 * own `priceMinor` column is the record.
 */
export async function setInventoryItemPrice(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  itemName: string,
  priceMinor: bigint,
): Promise<InventoryItem> {
  const item = await findOrCreateInventoryItem(scopedPrisma, businessId, itemName);
  return scopedPrisma.inventoryItem.update({
    where: { id: item.id },
    data: { priceMinor },
  });
}

export interface CatalogEntry {
  id: string;
  name: string;
  priceMinor: bigint;
}

/** Powers the `/catalog` command (Phase 25) — every InventoryItem with a price set via /setprice, alphabetical. */
export async function getCatalog(scopedPrisma: TenantScopedClient, businessId: string): Promise<CatalogEntry[]> {
  const items = await scopedPrisma.inventoryItem.findMany({
    where: { businessId, priceMinor: { not: null } },
    orderBy: { name: "asc" },
  });

  return items.map((item) => ({
    id: item.id,
    name: item.name,
    priceMinor: item.priceMinor as bigint, // non-null by the where clause
  }));
}

export interface InventoryBackfillResult {
  /** How many TransactionItem rows were linked to an InventoryItem (and got a matching InventoryMovement) this run. */
  transactionItemsLinked: number;
}

/**
 * Phase 17: retroactive backfill for a business that enables `stockTracking`
 * *after* it has already logged SALE/PURCHASE transactions with itemized
 * line items. `applySale`/`applyPurchase` (applyParsedIntent.ts) only ever
 * resolve/create `InventoryItem` rows and link
 * `TransactionItem.inventoryItemId` when `stockTrackingEnabled` was true
 * *at the time the transaction was logged* — every `TransactionItem` row
 * created before that flip has `inventoryItemId: null` forever, and never
 * contributed to any `InventoryItem.estimatedStockQty`, even after the
 * business turns tracking on. This function closes that gap on demand
 * (wired to an admin-triggered route, not an automatic migration hook,
 * since a merchant might reasonably want their stock counts to start fresh
 * from the moment they opt in, not be retroactively adjusted).
 *
 * For every `TransactionItem` still missing an `inventoryItemId` whose
 * parent `Transaction` is a SALE or PURCHASE (the only two types that ever
 * move stock — EXPENSE/PAYMENT_RECEIVED/DEBT_NOTE/STOCK_ADJUSTMENT-sourced
 * transactions never carry line items in the first place), this:
 *   1. resolves (find-or-creates) the matching `InventoryItem` by name,
 *   2. links `TransactionItem.inventoryItemId` to it,
 *   3. applies the same signed `InventoryMovement` (SALE = negative,
 *      PURCHASE = positive) that would have been applied at log time,
 *      stamped with the original `transactionId` so the movement history
 *      reads exactly as if tracking had been on from the start.
 *
 * Naturally idempotent: step 2 removes each row from future runs' candidate
 * set (`inventoryItemId: null`), so calling this again after a prior run —
 * or after a fresh SALE/PURCHASE with tracking already on, which never sets
 * `inventoryItemId: null` in the first place — is always a safe no-op. Rows
 * are processed sequentially (not `Promise.all`), mirroring
 * `resolveInventoryItemsForLines`'s own rationale in applyParsedIntent.ts:
 * two backfilled lines naming the same brand-new item should resolve to one
 * created row, not race each other (the `@@unique` constraint added
 * alongside `findOrCreateInventoryItem`'s catch-and-refetch logic would
 * still make that race safe, but sequential processing avoids relying on it
 * for what is already a low-throughput, admin-triggered batch job).
 */
export async function backfillInventoryLinksForBusiness(
  scopedPrisma: TenantScopedClient,
  businessId: string,
): Promise<InventoryBackfillResult> {
  const candidates = await scopedPrisma.transactionItem.findMany({
    where: {
      businessId,
      inventoryItemId: null,
      transaction: { type: { in: ["SALE", "PURCHASE"] } },
    },
    include: { transaction: true },
    orderBy: { id: "asc" },
  });

  let transactionItemsLinked = 0;

  for (const txItem of candidates) {
    const isSale = txItem.transaction.type === "SALE";
    const source: MovementSource = isSale ? "SALE" : "PURCHASE";
    const quantityDelta = (isSale ? -1 : 1) * txItem.quantity;

    const item = await findOrCreateInventoryItem(scopedPrisma, businessId, txItem.itemName);

    await scopedPrisma.transactionItem.update({
      where: { id: txItem.id },
      data: { inventoryItemId: item.id },
    });

    await applyStockMovement(scopedPrisma, businessId, item, quantityDelta, source, txItem.transactionId);

    transactionItemsLinked += 1;
  }

  return { transactionItemsLinked };
}
