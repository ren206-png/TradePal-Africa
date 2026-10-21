import { createHash } from "node:crypto";
import type { MembershipRole, PrismaClient, ProductStatus } from "@prisma/client";
import { canMerchant } from "../auth/permissions.js";
import { getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../db/tenantScope.js";
import { recordAuditLog } from "./auditLog.js";
import { CatalogError, createProduct, createVariant, normalizeKey } from "./catalog.js";
import { InvalidAmountError, formatMoney, parseAmountToMinorUnits } from "./money.js";
import { PriceError, addPriceRule, createPriceList } from "./pricing.js";
import { StoreError } from "./store/common.js";
import { listVariantScoped, resolveOptionPrice, retailListOf, unlistVariantScoped } from "./store/storefront.js";
import { csvRow, csvText } from "../admin/csv.js";

/**
 * Bulk catalog editing (the seller's web screen and CSV import). One screen, one rule: nothing is written until the person has seen
 * exactly what will change, and a batch is all-or-nothing, so a half-applied price list can never exist.
 *
 *  - A row is identified by SKU. An existing SKU is edited, an unknown SKU with a product name and unit is created (as a draft).
 *  - A field left out is left alone. `null` clears an optional field (category, description, barcode, low-stock alert, price).
 *  - Each exported row carries a `rev` (a short fingerprint of the row as it was). If the row has changed since (another phone, a
 *    WhatsApp command), the edit is refused as a CONFLICT rather than overwriting someone else's change.
 *  - Prices are the RETAIL price of one base unit. Pack prices, price breaks, cost and stock quantities are NOT edited here: cost and
 *    stock go through goods receipts and counts, which keep the books right.
 *  - An old price is retired, never overwritten, so the price history stays.
 *  - Applying is idempotent per `batchId` (a phone that retries after a dropped connection cannot apply the same batch twice) and writes
 *    one audit entry.
 */
export const MAX_BULK_ROWS = 200;
export const MAX_BULK_EXPORT = 1000;

export type BulkStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
const STATUSES: readonly BulkStatus[] = ["DRAFT", "PUBLISHED", "ARCHIVED"];

export interface BulkRow {
  sku: string;
  /** Fingerprint of the row when it was exported; when present, the edit is refused if the row has changed since. */
  rev?: string;
  productName?: string;
  variantName?: string;
  baseUnit?: string;
  category?: string | null;
  description?: string | null;
  barcode?: string | null;
  lowStockThreshold?: number | null;
  status?: BulkStatus;
  /** Retail price of one base unit in major units, e.g. "1500" or "1500.50". null removes the retail price. */
  retailPrice?: string | null;
  listed?: boolean;
}

export interface ExportedRow {
  sku: string;
  rev: string;
  productName: string;
  variantName: string;
  baseUnit: string;
  category: string | null;
  description: string | null;
  barcode: string | null;
  lowStockThreshold: number | null;
  status: BulkStatus;
  retailPrice: string | null;
  listed: boolean;
  photos: number;
  productId: string;
}

export interface BulkContext {
  businessId: string;
  currencyCode: string;
  minorUnitExp: number;
  role: MembershipRole;
  actorId?: string;
  now?: Date;
}

export type RowAction = "CREATE" | "UPDATE" | "NOOP" | "ERROR";
export interface PlannedRow {
  index: number;
  sku: string;
  action: RowAction;
  changes: string[];
  errors: string[];
  warnings: string[];
}
export interface BulkPlan {
  rows: PlannedRow[];
  counts: { create: number; update: number; noop: number; error: number };
  canApply: boolean;
}

export class BulkError extends Error {
  readonly code: "INVALID" | "TOO_MANY" | "NOT_ALLOWED";
  readonly plan: BulkPlan | undefined;
  constructor(code: BulkError["code"], message: string, plan?: BulkPlan) {
    super(message);
    this.code = code;
    this.plan = plan;
  }
}

const fingerprint = (r: Omit<ExportedRow, "rev" | "photos" | "productId">): string =>
  createHash("sha256").update(JSON.stringify([r.sku, r.productName, r.variantName, r.baseUnit, r.category, r.description, r.barcode, r.lowStockThreshold, r.status, r.retailPrice, r.listed])).digest("hex").slice(0, 12);

// ------------------------------------------------------------------------------------------------------------------ export

async function currentRetailPriceMinor(scoped: TenantScopedClient, listId: string | null, variantId: string, baseUnit: string, at: Date): Promise<bigint | null> {
  if (!listId) return null;
  const p = await resolveOptionPrice(scoped, listId, variantId, baseUnit, at);
  // only a plain base-unit price at quantity 1 counts as "the" price here; a price that exists only from a larger quantity is a price break
  return p && p.breakMinQuantity <= 1 && p.unit === baseUnit ? p.unitPriceMinor : null;
}

type VariantWithProduct = Awaited<ReturnType<typeof loadVariants>>[number];
const loadVariants = (scoped: TenantScopedClient, args: { skip?: number; take?: number; where?: { id?: string } }) =>
  scoped.productVariant.findMany({ ...(args.where ? { where: args.where } : {}), orderBy: { sku: "asc" }, ...(args.skip ? { skip: args.skip } : {}), ...(args.take ? { take: args.take } : {}), include: { product: true } });

async function buildRows(scoped: TenantScopedClient, ctx: Pick<BulkContext, "minorUnitExp" | "now">, variants: VariantWithProduct[]): Promise<ExportedRow[]> {
  const at = ctx.now ?? new Date();
  const list = await retailListOf(scoped);
  const listings = await scoped.listing.findMany({ where: { channel: "STOREFRONT", variantId: { in: variants.map((v) => v.id) } } });
  const photoCounts = await scoped.productImage.groupBy({ by: ["productId"], where: { removedAt: null, productId: { in: [...new Set(variants.map((v) => v.productId))] } }, _count: { _all: true } });
  const photos = new Map(photoCounts.map((p) => [p.productId, p._count._all]));
  const rows: ExportedRow[] = [];
  for (const v of variants) {
    const price = await currentRetailPriceMinor(scoped, list?.id ?? null, v.id, v.baseUnit, at);
    const base = {
      sku: v.sku, productName: v.product.name, variantName: v.name, baseUnit: v.baseUnit, category: v.product.category, description: v.product.description,
      barcode: v.barcode, lowStockThreshold: v.lowStockThreshold, status: v.status as BulkStatus,
      retailPrice: price === null ? null : formatMoney(price, ctx.minorUnitExp), listed: listings.some((l) => l.variantId === v.id && l.status === "ACTIVE"),
    };
    rows.push({ ...base, rev: fingerprint(base), photos: photos.get(v.productId) ?? 0, productId: v.productId });
  }
  return rows;
}

export async function exportCatalog(scoped: TenantScopedClient, ctx: Pick<BulkContext, "minorUnitExp" | "now">, opts: { skip?: number; take?: number } = {}): Promise<{ rows: ExportedRow[]; total: number; truncated: boolean }> {
  const take = Math.min(opts.take ?? MAX_BULK_EXPORT, MAX_BULK_EXPORT);
  const total = await scoped.productVariant.count({ where: {} });
  const variants = await loadVariants(scoped, { skip: opts.skip ?? 0, take });
  return { rows: await buildRows(scoped, ctx, variants), total, truncated: total > (opts.skip ?? 0) + variants.length };
}

export const CSV_HEADER = ["sku", "product", "variant", "unit", "category", "description", "barcode", "low_stock_alert", "status", "price", "listed", "rev"] as const;

/** Formula-safe CSV of the catalog (the same rules as every report export). */
export function catalogToCsv(rows: ExportedRow[]): string {
  const lines = [csvRow(CSV_HEADER.map((h) => csvText(h)))];
  for (const r of rows) {
    lines.push(csvRow([r.sku, r.productName, r.variantName, r.baseUnit, r.category ?? "", r.description ?? "", r.barcode ?? "", r.lowStockThreshold === null ? "" : String(r.lowStockThreshold), r.status, r.retailPrice ?? "", r.listed ? "yes" : "no", r.rev].map(csvText)));
  }
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------------------------------------------------------ CSV in

/** A small RFC 4180 reader: quoted cells, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

const CLEAR = /^(clear|\(clear\))$/i;
const YES = /^(yes|y|true|1|listed)$/i;
const NO = /^(no|n|false|0|unlisted)$/i;

/**
 * Reads a CSV the seller edited. The header names the columns (any order, unknown columns ignored). In a cell: empty = leave alone,
 * the word CLEAR = remove the value (category, description, barcode, low-stock alert, price). A leading apostrophe added by the
 * export to neutralise a spreadsheet formula is removed again.
 */
export function rowsFromCsv(text: string): { rows: BulkRow[]; errors: string[] } {
  const grid = parseCsv(text);
  if (grid.length === 0) return { rows: [], errors: ["The file is empty."] };
  const header = grid[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  if (!header.includes("sku")) return { rows: [], errors: ["The first row must name the columns, and one of them must be sku."] };
  const idx = (name: string): number => header.indexOf(name);
  const errors: string[] = [];
  const rows: BulkRow[] = [];
  const unquote = (v: string): string => (v.startsWith("'") && /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
  const get = (cells: string[], name: string): string | undefined => {
    const i = idx(name);
    if (i === -1) return undefined;
    const v = unquote((cells[i] ?? "").trim());
    return v === "" ? undefined : v;
  };
  for (let n = 1; n < grid.length; n++) {
    const cells = grid[n]!;
    const sku = get(cells, "sku");
    if (!sku) { errors.push(`Line ${n + 1}: no sku.`); continue; }
    const row: BulkRow = { sku };
    const rev = get(cells, "rev");
    if (rev) row.rev = rev;
    const s = (name: string): string | null | undefined => { const v = get(cells, name); return v === undefined ? undefined : CLEAR.test(v) ? null : v; };
    const product = get(cells, "product") ?? get(cells, "product_name");
    if (product) row.productName = product;
    const variant = get(cells, "variant") ?? get(cells, "variant_name");
    if (variant) row.variantName = variant;
    const unit = get(cells, "unit") ?? get(cells, "base_unit");
    if (unit) row.baseUnit = unit;
    const cat = s("category"); if (cat !== undefined) row.category = cat;
    const desc = s("description"); if (desc !== undefined) row.description = desc;
    const bar = s("barcode"); if (bar !== undefined) row.barcode = bar;
    const low = s("low_stock_alert") ?? s("low_stock");
    if (low !== undefined) {
      if (low === null) row.lowStockThreshold = null;
      else if (/^\d{1,7}$/.test(low)) row.lowStockThreshold = Number(low);
      else errors.push(`Line ${n + 1} (${sku}): low_stock_alert must be a whole number.`);
    }
    const status = get(cells, "status");
    if (status) {
      const up = status.toUpperCase();
      if ((STATUSES as readonly string[]).includes(up)) row.status = up as BulkStatus;
      else errors.push(`Line ${n + 1} (${sku}): status must be DRAFT, PUBLISHED or ARCHIVED.`);
    }
    const price = s("price") ?? s("retail_price");
    if (price !== undefined) row.retailPrice = price;
    const listed = get(cells, "listed");
    if (listed) {
      if (YES.test(listed)) row.listed = true;
      else if (NO.test(listed)) row.listed = false;
      else errors.push(`Line ${n + 1} (${sku}): listed must be yes or no.`);
    }
    rows.push(row);
  }
  return { rows, errors };
}

// ------------------------------------------------------------------------------------------------------------------ plan

const SKU = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/;
const TEXT = (v: string, max: number): boolean => v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);

type Op = {
  index: number;
  sku: string;
  kind: "CREATE" | "UPDATE";
  variantId?: string;
  productId?: string;
  product?: { name?: string; category?: string | null; description?: string | null };
  variant?: { name?: string; barcode?: string | null; lowStockThreshold?: number | null; status?: ProductStatus };
  create?: { productName: string; variantName: string; baseUnit: string };
  priceMinor?: bigint | null; // undefined = no change
  listed?: boolean;
};

interface Planned { plan: BulkPlan; ops: Op[] }

async function planRows(scoped: TenantScopedClient, ctx: BulkContext, rows: BulkRow[]): Promise<Planned> {
  const at = ctx.now ?? new Date();
  const planned: PlannedRow[] = [];
  const ops: Op[] = [];
  const can = (p: Parameters<typeof canMerchant>[1]) => canMerchant(ctx.role, p);
  const list = await retailListOf(scoped);
  const skus = [...new Set(rows.map((r) => String(r.sku ?? "").trim()).filter(Boolean))];
  const variants = await scoped.productVariant.findMany({ where: { sku: { in: skus } }, include: { product: true } });
  const bySku = new Map(variants.map((v) => [v.sku, v]));
  const listings = await scoped.listing.findMany({ where: { channel: "STOREFRONT", variantId: { in: variants.map((v) => v.id) } } });
  const seenSkus = new Set<string>();
  const seenBarcodes = new Map<string, string>(); // barcode -> sku in this batch
  const productFieldClaims = new Map<string, { sku: string; name?: string; category?: string | null; description?: string | null }>();
  const newProductByName = new Map<string, string>(); // normalised name -> first new sku (rows creating variants of one new product share it)

  for (let index = 0; index < rows.length; index++) {
    const r = rows[index]!;
    const sku = String(r.sku ?? "").trim();
    const pr: PlannedRow = { index, sku, action: "NOOP", changes: [], errors: [], warnings: [] };
    planned.push(pr);
    const fail = (m: string) => { pr.errors.push(m); };

    if (!SKU.test(sku)) { fail("The SKU must be 1-64 letters, numbers, dots, dashes or slashes."); continue; }
    if (seenSkus.has(sku)) { fail("This SKU appears twice in the batch."); continue; }
    seenSkus.add(sku);

    // field checks that do not depend on the database
    if (r.productName !== undefined && (!r.productName.trim() || !TEXT(r.productName, 120))) fail("The product name must be 1-120 characters.");
    if (r.variantName !== undefined && !TEXT(r.variantName, 120)) fail("The variant name must be at most 120 characters.");
    if (r.category != null && !TEXT(r.category, 60)) fail("The category must be at most 60 characters.");
    if (r.description != null && !TEXT(r.description, 1000)) fail("The description must be at most 1000 characters.");
    if (r.barcode != null && !/^[A-Za-z0-9\-]{4,64}$/.test(r.barcode)) fail("The barcode must be 4-64 letters, numbers or dashes.");
    if (r.lowStockThreshold != null && (!Number.isInteger(r.lowStockThreshold) || r.lowStockThreshold < 0 || r.lowStockThreshold > 1_000_000)) fail("The low-stock alert must be a whole number from 0 to 1,000,000.");
    if (r.status !== undefined && !STATUSES.includes(r.status)) fail("The status must be DRAFT, PUBLISHED or ARCHIVED.");
    let priceMinor: bigint | null | undefined;
    if (r.retailPrice !== undefined) {
      if (r.retailPrice === null) priceMinor = null;
      else {
        try {
          priceMinor = parseAmountToMinorUnits(String(r.retailPrice), ctx.minorUnitExp);
          if (priceMinor <= 0n) fail("A price must be more than zero.");
          else if (priceMinor > 10n ** 13n) fail("That price is too large.");
        } catch (e) {
          fail(e instanceof InvalidAmountError ? e.message : "That price is not a valid amount.");
        }
      }
    }
    if (r.barcode) {
      const other = seenBarcodes.get(r.barcode);
      if (other && other !== sku) fail(`The barcode ${r.barcode} is also used by ${other} in this batch.`);
      else seenBarcodes.set(r.barcode, sku);
    }
    if (pr.errors.length) continue;

    const v = bySku.get(sku);
    if (v) {
      // ---- existing variant
      if (r.rev !== undefined) {
        const current = await exportOne(scoped, ctx, v.id);
        if (current && current.rev !== r.rev) { fail("This product was changed after you opened it. Reload and try again."); continue; }
      }
      if (r.baseUnit !== undefined && normalizeKey(r.baseUnit) !== v.baseUnit) { fail(`The unit cannot be changed (it is ${v.baseUnit}). Stock counts depend on it.`); continue; }
      const op: Op = { index, sku, kind: "UPDATE", variantId: v.id, productId: v.productId };
      const product: NonNullable<Op["product"]> = {};
      const variant: NonNullable<Op["variant"]> = {};
      if (r.productName !== undefined && r.productName.trim() !== v.product.name) { product.name = r.productName.trim(); pr.changes.push(`product name: ${v.product.name} -> ${r.productName.trim()}`); }
      if (r.category !== undefined && (r.category?.trim() || null) !== v.product.category) { product.category = r.category?.trim() || null; pr.changes.push(`category: ${v.product.category ?? "none"} -> ${product.category ?? "none"}`); }
      if (r.description !== undefined && (r.description?.trim() || null) !== v.product.description) { product.description = r.description?.trim() || null; pr.changes.push("description changed"); }
      if (r.variantName !== undefined && r.variantName.trim() !== v.name) { variant.name = r.variantName.trim() || v.product.name; pr.changes.push(`variant name: ${v.name} -> ${variant.name}`); }
      if (r.barcode !== undefined && (r.barcode?.trim() || null) !== v.barcode) {
        const code = r.barcode?.trim() || null;
        if (code && (await scoped.productVariant.findFirst({ where: { barcode: code, NOT: { id: v.id } } }))) { fail(`The barcode ${code} is already used by another product.`); continue; }
        variant.barcode = code; pr.changes.push(`barcode: ${v.barcode ?? "none"} -> ${code ?? "none"}`);
      }
      if (r.lowStockThreshold !== undefined && (r.lowStockThreshold ?? null) !== v.lowStockThreshold) { variant.lowStockThreshold = r.lowStockThreshold ?? null; pr.changes.push(`low-stock alert: ${v.lowStockThreshold ?? "none"} -> ${r.lowStockThreshold ?? "none"}`); }
      if (r.status !== undefined && r.status !== v.status) {
        if (!can("inventory:adjust")) { fail("You are not allowed to change a product's status."); continue; }
        variant.status = r.status; pr.changes.push(`status: ${v.status} -> ${r.status}`);
      }
      const nowPrice = await currentRetailPriceMinor(scoped, list?.id ?? null, v.id, v.baseUnit, at);
      if (priceMinor !== undefined && priceMinor !== nowPrice) {
        op.priceMinor = priceMinor;
        pr.changes.push(`price: ${nowPrice === null ? "none" : formatMoney(nowPrice, ctx.minorUnitExp)} -> ${priceMinor === null ? "none" : formatMoney(priceMinor, ctx.minorUnitExp)} ${ctx.currencyCode}`);
      }
      const isListed = listings.some((l) => l.variantId === v.id && l.status === "ACTIVE");
      if (r.listed !== undefined && r.listed !== isListed) {
        if (!can("store:manage")) { fail("You are not allowed to list or unlist products on the shop."); continue; }
        op.listed = r.listed; pr.changes.push(r.listed ? "list on the shop" : "take off the shop");
      }
      const finalPrice = priceMinor !== undefined ? priceMinor : nowPrice;
      const finalListed = r.listed !== undefined ? r.listed : isListed;
      if (finalListed && finalPrice === null) { fail("A product needs a price before it can be on the shop."); continue; }
      if (Object.keys(product).length) {
        op.product = product;
        const siblings = await scoped.productVariant.count({ where: { productId: v.productId, NOT: { id: v.id } } });
        if (siblings > 0) pr.warnings.push(`The product name, category and description are shared with ${siblings} other variant(s) of this product.`);
        const claim = productFieldClaims.get(v.productId);
        if (claim && JSON.stringify([claim.name, claim.category, claim.description]) !== JSON.stringify([product.name, product.category, product.description])) { fail(`Another row in this batch changes the same product (${claim.sku}) differently.`); continue; }
        productFieldClaims.set(v.productId, { sku, ...product });
      }
      if (Object.keys(variant).length) op.variant = variant;
      if (pr.changes.length) {
        if (!can("prices:manage")) { fail("You are not allowed to change products or prices."); continue; }
        pr.action = "UPDATE";
        ops.push(op);
      }
    } else {
      // ---- new variant
      if (!can("inventory:adjust") || !can("prices:manage")) { fail("You are not allowed to add products."); continue; }
      if (!r.productName?.trim()) { fail("A new product needs a product name."); continue; }
      if (!r.baseUnit?.trim() || !/^[A-Za-z][A-Za-z0-9 ._-]{0,29}$/.test(r.baseUnit.trim())) { fail("A new product needs a unit (piece, bottle, kg...)."); continue; }
      if (r.barcode && (await scoped.productVariant.findFirst({ where: { barcode: r.barcode } }))) { fail(`The barcode ${r.barcode} is already used by another product.`); continue; }
      if (r.rev) pr.warnings.push("This SKU did not exist, so it will be created.");
      const op: Op = { index, sku, kind: "CREATE", create: { productName: r.productName.trim(), variantName: (r.variantName ?? r.productName).trim(), baseUnit: normalizeKey(r.baseUnit) } };
      pr.changes.push(`create ${r.productName.trim()} (${normalizeKey(r.baseUnit)})`);
      const productKey = normalizeKey(r.productName);
      const first = newProductByName.get(productKey);
      if (first) pr.warnings.push(`Shares its product with ${first}.`);
      else newProductByName.set(productKey, sku);
      op.product = { name: r.productName.trim(), ...(r.category !== undefined ? { category: r.category?.trim() || null } : {}), ...(r.description !== undefined ? { description: r.description?.trim() || null } : {}) };
      op.variant = { ...(r.barcode ? { barcode: r.barcode.trim() } : {}), ...(r.lowStockThreshold != null ? { lowStockThreshold: r.lowStockThreshold } : {}), ...(r.status ? { status: r.status } : {}) };
      if (priceMinor !== undefined && priceMinor !== null) { op.priceMinor = priceMinor; pr.changes.push(`price ${formatMoney(priceMinor, ctx.minorUnitExp)} ${ctx.currencyCode}`); }
      if (r.listed === true) {
        if (!can("store:manage")) { fail("You are not allowed to list products on the shop."); continue; }
        if (priceMinor == null) { fail("A product needs a price before it can be on the shop."); continue; }
        op.listed = true; pr.changes.push("list on the shop");
      }
      pr.action = "CREATE";
      ops.push(op);
    }
  }
  const counts = { create: 0, update: 0, noop: 0, error: 0 };
  for (const p of planned) {
    if (p.errors.length) { p.action = "ERROR"; counts.error++; }
    else if (p.action === "CREATE") counts.create++;
    else if (p.action === "UPDATE") counts.update++;
    else counts.noop++;
  }
  return { plan: { rows: planned, counts, canApply: counts.error === 0 && counts.create + counts.update > 0 }, ops: ops.filter((o) => !planned[o.index]!.errors.length) };
}

async function exportOne(scoped: TenantScopedClient, ctx: BulkContext, variantId: string): Promise<ExportedRow | null> {
  const [v] = await loadVariants(scoped, { where: { id: variantId } });
  return v ? (await buildRows(scoped, ctx, [v]))[0] ?? null : null;
}

/** What WOULD change, row by row, without writing anything. */
export async function previewBulkChanges(prisma: PrismaClient, ctx: BulkContext, rows: BulkRow[]): Promise<BulkPlan> {
  if (!Array.isArray(rows) || rows.length === 0) throw new BulkError("INVALID", "There is nothing to change.");
  if (rows.length > MAX_BULK_ROWS) throw new BulkError("TOO_MANY", `At most ${MAX_BULK_ROWS} rows at a time.`);
  return (await planRows(getTenantScopedClient(prisma, ctx.businessId), ctx, rows)).plan;
}

// ------------------------------------------------------------------------------------------------------------------ apply

export interface BulkResult { replayed: boolean; created: number; updated: number; unchanged: number; plan: BulkPlan }

async function ensureRetailList(scoped: TenantScopedClient, ctx: BulkContext) {
  return (await retailListOf(scoped)) ?? (await createPriceList(scoped, { businessId: ctx.businessId, name: "Retail", kind: "RETAIL", currencyCode: ctx.currencyCode }));
}

/** Applies the whole batch or nothing. A row that cannot be applied stops the batch before anything is written. */
export async function applyBulkChanges(prisma: PrismaClient, ctx: BulkContext, input: { batchId: string; rows: BulkRow[] }): Promise<BulkResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.batchId)) throw new BulkError("INVALID", "Each batch needs its own id (8-64 letters, numbers or dashes).");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new BulkError("INVALID", "There is nothing to change.");
  if (input.rows.length > MAX_BULK_ROWS) throw new BulkError("TOO_MANY", `At most ${MAX_BULK_ROWS} rows at a time.`);
  const scoped = getTenantScopedClient(prisma, ctx.businessId);
  const previous = await scoped.auditLog.findFirst({ where: { action: "catalog.bulk_edit", metadata: { path: ["batchId"], equals: input.batchId } } });
  if (previous) {
    const m = previous.metadata as { created?: number; updated?: number; unchanged?: number };
    return { replayed: true, created: m.created ?? 0, updated: m.updated ?? 0, unchanged: m.unchanged ?? 0, plan: { rows: [], counts: { create: m.created ?? 0, update: m.updated ?? 0, noop: m.unchanged ?? 0, error: 0 }, canApply: false } };
  }

  return withScopedTransaction(scoped, async (tx) => {
    const { plan, ops } = await planRows(tx, ctx, input.rows);
    if (plan.counts.error > 0) throw new BulkError("INVALID", `${plan.counts.error} row(s) have a problem. Nothing was changed.`, plan);
    if (ops.length === 0) return { replayed: false, created: 0, updated: 0, unchanged: plan.counts.noop, plan };
    const at = ctx.now ?? new Date();
    const newProducts = new Map<string, string>(); // normalised new product name -> product id (variants of one new product share it)
    let list = await retailListOf(tx);
    for (const op of ops) {
      let variantId = op.variantId;
      let productId = op.productId;
      try {
        if (op.kind === "CREATE") {
          const key = normalizeKey(op.create!.productName);
          productId = newProducts.get(key);
          if (!productId) {
            const p = await createProduct(tx, { businessId: ctx.businessId, name: op.create!.productName, ...(op.product?.description ? { description: op.product.description } : {}), ...(op.product?.category ? { category: op.product.category } : {}) });
            productId = p.id;
            newProducts.set(key, p.id);
          }
          const nv = await createVariant(tx, { businessId: ctx.businessId, productId, sku: op.sku, name: op.create!.variantName, baseUnit: op.create!.baseUnit, ...(op.variant?.barcode ? { barcode: op.variant.barcode } : {}), ...(op.variant?.lowStockThreshold != null ? { lowStockThreshold: op.variant.lowStockThreshold } : {}) });
          variantId = nv.id;
          if (op.variant?.status && op.variant.status !== "DRAFT") await tx.productVariant.update({ where: { id: variantId }, data: { status: op.variant.status } });
        } else {
          if (op.product && Object.keys(op.product).length) await tx.product.update({ where: { id: productId! }, data: op.product });
          if (op.variant && Object.keys(op.variant).length) await tx.productVariant.update({ where: { id: variantId! }, data: op.variant });
        }
        if (op.priceMinor !== undefined) {
          const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId! } });
          list = list ?? (await ensureRetailList(tx, ctx));
          const open = await tx.priceRule.findMany({ where: { priceListId: list.id, variantId: variantId!, packConversionId: null, minQuantity: 1, status: "ACTIVE" } });
          for (const rule of open) await tx.priceRule.update({ where: { id: rule.id }, data: { status: "RETIRED" } });
          if (op.priceMinor !== null) await addPriceRule(tx, { businessId: ctx.businessId, priceListId: list.id, variantId: variantId!, unitPriceMinor: op.priceMinor, validFrom: new Date(at.getTime() - 1000) });
          void variant;
        }
        if (op.listed === true) await listVariantScoped(tx, ctx.businessId, variantId!);
        else if (op.listed === false) await unlistVariantScoped(tx, variantId!);
      } catch (error) {
        const reason = error instanceof CatalogError || error instanceof PriceError || error instanceof StoreError ? error.message : null;
        if (reason) {
          plan.rows[op.index]!.errors.push(reason);
          plan.rows[op.index]!.action = "ERROR";
          plan.counts.error++;
          throw new BulkError("INVALID", `${op.sku}: ${reason} Nothing was changed.`, plan);
        }
        throw error;
      }
    }
    await recordAuditLog(tx, {
      businessId: ctx.businessId, actorType: "MERCHANT", ...(ctx.actorId ? { actorId: ctx.actorId } : {}), action: "catalog.bulk_edit", entityType: "Catalog",
      metadata: { batchId: input.batchId, created: plan.counts.create, updated: plan.counts.update, unchanged: plan.counts.noop, skus: plan.rows.filter((r) => r.action === "CREATE" || r.action === "UPDATE").map((r) => r.sku).slice(0, 100) },
    });
    return { replayed: false, created: plan.counts.create, updated: plan.counts.update, unchanged: plan.counts.noop, plan };
  });
}
