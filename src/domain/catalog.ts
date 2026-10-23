import type { InventoryItem, PackConversion, Product, ProductStatus, ProductVariant } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";

/**
 * Catalog (expansion Phase 2): products, variants, merchant aliases and DECLARED pack sizes.
 * A carton, bag, box, kilogram and piece are never interchangeable without a declared conversion: an unknown pack
 * name is an error, never a guess. Quantities are integers in the variant's base unit.
 */
export class CatalogError extends Error {
  readonly code: "DUPLICATE_SKU" | "DUPLICATE_BARCODE" | "DUPLICATE_ALIAS" | "DUPLICATE_PACK" | "INVALID" | "NOT_FOUND" | "UNIT_NOT_DECLARED";
  constructor(code: CatalogError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface CreateProductInput {
  businessId: string;
  name: string;
  description?: string;
  category?: string;
  imageUrls?: string[];
}

export async function createProduct(scoped: TenantScopedClient, input: CreateProductInput): Promise<Product> {
  const name = input.name.trim();
  if (!name) throw new CatalogError("INVALID", "A product needs a name.");
  return scoped.product.create({
    data: {
      businessId: input.businessId,
      name,
      description: input.description ?? null,
      category: input.category ?? null,
      imageUrls: input.imageUrls ?? [],
    },
  });
}

export interface CreateVariantInput {
  businessId: string;
  productId: string;
  sku: string;
  name: string;
  baseUnit: string;
  barcode?: string;
  trackStock?: boolean;
  lowStockThreshold?: number;
}

export async function createVariant(scoped: TenantScopedClient, input: CreateVariantInput): Promise<ProductVariant> {
  const sku = input.sku.trim();
  const baseUnit = normalizeKey(input.baseUnit);
  if (!sku) throw new CatalogError("INVALID", "A variant needs a SKU.");
  if (!baseUnit) throw new CatalogError("INVALID", "A variant needs a base unit (piece, bottle, gram...).");
  if (input.lowStockThreshold !== undefined && (!Number.isInteger(input.lowStockThreshold) || input.lowStockThreshold < 0)) {
    throw new CatalogError("INVALID", "The low-stock threshold must be a whole number, zero or more.");
  }
  const product = await scoped.product.findUnique({ where: { id: input.productId } });
  if (!product) throw new CatalogError("NOT_FOUND", "Product not found.");
  if (await scoped.productVariant.findFirst({ where: { sku } })) throw new CatalogError("DUPLICATE_SKU", `SKU '${sku}' is already in use.`);
  const barcode = input.barcode?.trim() || null;
  if (barcode && (await scoped.productVariant.findFirst({ where: { barcode } }))) {
    throw new CatalogError("DUPLICATE_BARCODE", `Barcode '${barcode}' is already in use.`);
  }
  return scoped.productVariant.create({
    data: {
      businessId: input.businessId,
      productId: input.productId,
      sku,
      name: input.name.trim() || product.name,
      baseUnit,
      barcode,
      trackStock: input.trackStock ?? true,
      lowStockThreshold: input.lowStockThreshold ?? null,
    },
  });
}

export async function setVariantStatus(scoped: TenantScopedClient, variantId: string, status: ProductStatus): Promise<ProductVariant> {
  const variant = await scoped.productVariant.findUnique({ where: { id: variantId } });
  if (!variant) throw new CatalogError("NOT_FOUND", "Variant not found.");
  return scoped.productVariant.update({ where: { id: variantId }, data: { status } });
}

export async function addAlias(scoped: TenantScopedClient, businessId: string, variantId: string, alias: string) {
  const normalizedAlias = normalizeKey(alias);
  if (!normalizedAlias) throw new CatalogError("INVALID", "An alias cannot be empty.");
  if (!(await scoped.productVariant.findUnique({ where: { id: variantId } }))) throw new CatalogError("NOT_FOUND", "Variant not found.");
  const existing = await scoped.variantAlias.findFirst({ where: { normalizedAlias } });
  if (existing) {
    if (existing.variantId === variantId) return existing; // idempotent
    throw new CatalogError("DUPLICATE_ALIAS", `'${alias}' already names a different product.`);
  }
  return scoped.variantAlias.create({ data: { businessId, variantId, alias: alias.trim(), normalizedAlias } });
}

/** Declares "1 <name> = <baseQuantity> base units". baseQuantity must be a whole number >= 2. */
export async function addPackConversion(
  scoped: TenantScopedClient,
  businessId: string,
  variantId: string,
  name: string,
  baseQuantity: number,
): Promise<PackConversion> {
  const normalizedName = normalizeKey(name);
  if (!normalizedName) throw new CatalogError("INVALID", "A pack needs a name (carton, bag, box...).");
  if (!Number.isInteger(baseQuantity) || baseQuantity < 2) {
    throw new CatalogError("INVALID", "A pack must hold a whole number of base units, at least 2.");
  }
  const variant = await scoped.productVariant.findUnique({ where: { id: variantId } });
  if (!variant) throw new CatalogError("NOT_FOUND", "Variant not found.");
  if (normalizedName === variant.baseUnit) throw new CatalogError("INVALID", `'${name}' is already the base unit.`);
  if (await scoped.packConversion.findFirst({ where: { variantId, normalizedName } })) {
    throw new CatalogError("DUPLICATE_PACK", `A '${name}' pack is already declared for this variant.`);
  }
  return scoped.packConversion.create({ data: { businessId, variantId, name: name.trim(), normalizedName, baseQuantity } });
}

/**
 * Converts `quantity` of `unit` into base units using ONLY declared conversions. The base unit converts to
 * itself; an undeclared unit throws UNIT_NOT_DECLARED instead of being guessed.
 */
export async function toBaseQuantity(
  scoped: TenantScopedClient,
  variantId: string,
  unit: string | null | undefined,
  quantity: number,
): Promise<{ baseQuantity: number; pack: PackConversion | null; variant: ProductVariant }> {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new CatalogError("INVALID", "Quantity must be a positive whole number.");
  const variant = await scoped.productVariant.findUnique({ where: { id: variantId } });
  if (!variant) throw new CatalogError("NOT_FOUND", "Variant not found.");
  const wanted = unit ? normalizeKey(unit) : variant.baseUnit;
  if (wanted === variant.baseUnit) return { baseQuantity: quantity, pack: null, variant };
  const pack = await scoped.packConversion.findFirst({ where: { variantId, normalizedName: wanted } });
  if (!pack) {
    throw new CatalogError("UNIT_NOT_DECLARED", `'${unit}' has no declared conversion to ${variant.baseUnit} for ${variant.sku}.`);
  }
  const baseQuantity = quantity * pack.baseQuantity;
  if (!Number.isSafeInteger(baseQuantity) || baseQuantity > 2_000_000_000) throw new CatalogError("INVALID", "That quantity is too large.");
  return { baseQuantity, pack, variant };
}

/** Finds a variant by SKU, barcode or alias (in that order). Tenant-scoped; returns null when nothing matches. */
export async function findVariantByText(scoped: TenantScopedClient, text: string): Promise<ProductVariant | null> {
  const raw = text.trim();
  if (!raw) return null;
  const bySku = await scoped.productVariant.findFirst({ where: { sku: raw } });
  if (bySku) return bySku;
  const byBarcode = await scoped.productVariant.findFirst({ where: { barcode: raw } });
  if (byBarcode) return byBarcode;
  const alias = await scoped.variantAlias.findFirst({ where: { normalizedAlias: normalizeKey(raw) } });
  return alias ? scoped.productVariant.findUnique({ where: { id: alias.variantId } }) : null;
}

export interface CatalogVariantView {
  variantId: string;
  productName: string;
  sku: string;
  name: string;
  baseUnit: string;
  status: ProductStatus;
  packs: { name: string; baseQuantity: number }[];
}

/** Merchant-side listing. Never includes cost: cost lives on StockBalance and is not part of any catalog view. */
export async function listCatalog(scoped: TenantScopedClient): Promise<CatalogVariantView[]> {
  const variants = await scoped.productVariant.findMany({
    orderBy: { sku: "asc" },
    include: { product: true, packs: { orderBy: { baseQuantity: "asc" } } },
  });
  return variants.map((v) => ({
    variantId: v.id,
    productName: v.product.name,
    sku: v.sku,
    name: v.name,
    baseUnit: v.baseUnit,
    status: v.status,
    packs: v.packs.map((p) => ({ name: p.name, baseQuantity: p.baseQuantity })),
  }));
}

export interface LegacyAdoptionResult {
  adopted: number;
  alreadyAdopted: number;
  openingMovements: number;
  priceRules: number;
}

/**
 * Brings the legacy `InventoryItem` rows into the catalog: one Product + Variant per item (SKU "LEG-xxxxxxxx",
 * base unit from the item or "piece"), an OPENING_BALANCE stock movement equal to the item's estimate, labelled
 * MIGRATED_OPENING, and a retail price rule when the item had a /setprice price. Idempotent: an item that already
 * has a variant is skipped. Nothing about cost is invented (the opening movement has no cost).
 */
export async function adoptLegacyInventory(
  scoped: TenantScopedClient,
  input: { businessId: string; shopId: string; currencyCode: string },
  postOpening: (variant: ProductVariant, item: InventoryItem) => Promise<boolean>,
): Promise<LegacyAdoptionResult> {
  const result: LegacyAdoptionResult = { adopted: 0, alreadyAdopted: 0, openingMovements: 0, priceRules: 0 };
  const items = await scoped.inventoryItem.findMany({ orderBy: { createdAt: "asc" }, include: { variant: true } });
  let retailList: { id: string } | null = null;
  for (const item of items) {
    if (item.variant) {
      result.alreadyAdopted++;
      continue;
    }
    const product = await scoped.product.create({
      data: { businessId: input.businessId, name: item.name, status: "DRAFT", imageUrls: [] },
    });
    const variant = await scoped.productVariant.create({
      data: {
        businessId: input.businessId,
        productId: product.id,
        sku: `LEG-${item.id.slice(0, 8)}`,
        name: item.name,
        baseUnit: normalizeKey(item.unit ?? "piece") || "piece",
        trackStock: true,
        lowStockThreshold: item.lowStockThreshold,
        status: "DRAFT",
        inventoryItemId: item.id,
      },
    });
    result.adopted++;
    if (await postOpening(variant, item)) result.openingMovements++;
    if (item.priceMinor !== null && item.priceMinor > 0n) {
      retailList ??=
        (await scoped.priceList.findFirst({ where: { kind: "RETAIL", name: "Retail", currencyCode: input.currencyCode } })) ??
        (await scoped.priceList.create({
          data: { businessId: input.businessId, name: "Retail", kind: "RETAIL", currencyCode: input.currencyCode },
        }));
      await scoped.priceRule.create({
        data: { businessId: input.businessId, priceListId: retailList.id, variantId: variant.id, minQuantity: 1, unitPriceMinor: item.priceMinor },
      });
      result.priceRules++;
    }
  }
  return result;
}
