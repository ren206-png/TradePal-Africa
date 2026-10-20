import type { DeliveryZone, PrismaClient, Storefront } from "@prisma/client";
import { assertEntitled } from "../subscriptions/entitlements.js";
import { getTenantScopedClient, type TenantScopedClient } from "../../db/tenantScope.js";
import { normalizeKey } from "../catalog.js";
import { PriceError, resolvePrice, type ResolvedPrice } from "../pricing.js";
import { ensureDefaultShopFor } from "../shops.js";
import { getStockLevel } from "../stock.js";
import { StoreError, isUniqueViolation } from "./common.js";

/**
 * The seller's side of the storefront (setup) and the PUBLIC projection of its catalog. The projection is the only thing a
 * shopper ever sees of a seller's data: name, unit options with price, and an availability label. It never carries cost,
 * stock quantities, margin, notes, customers or staff.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;

export async function retailListOf(scoped: TenantScopedClient) {
  return scoped.priceList.findFirst({ where: { kind: "RETAIL", status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
}

export interface StorefrontPatch {
  slug?: string;
  title?: string;
  about?: string | null;
  supportPhone?: string | null;
  pickupEnabled?: boolean;
  pickupLocation?: string | null;
  pickupInstructions?: string | null;
  deliveryEnabled?: boolean;
  reservationMinutes?: number;
  pickupHoldHours?: number;
  returnWindowDays?: number | null;
  termsText?: string | null;
  enabled?: boolean;
}

function defaultSlug(name: string): string {
  const base = normalizeKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return base.length >= 3 ? base : `shop-${base || "x"}`.slice(0, 30);
}

export async function ensureStorefront(prisma: PrismaClient, businessId: string): Promise<Storefront> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const existing = await scoped.storefront.findFirst({ where: {} });
  if (existing) return existing;
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } });
  const base = defaultSlug(business.name);
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base.slice(0, 33)}-${i + 1}`;
    if (await prisma.storefront.findUnique({ where: { slug } })) continue;
    try {
      return await scoped.storefront.create({ data: { businessId, slug, title: business.name } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const mine = await scoped.storefront.findFirst({ where: {} });
      if (mine) return mine;
    }
  }
  throw new StoreError("DUPLICATE", "Could not choose a web address for your shop; set one yourself.");
}

/** Changes the storefront. Turning it ON needs the basics a shopper depends on (a way to get the goods and a contact). */
export async function updateStorefront(prisma: PrismaClient, businessId: string, patch: StorefrontPatch): Promise<Storefront> {
  const sf = await ensureStorefront(prisma, businessId);
  const scoped = getTenantScopedClient(prisma, businessId);
  const next = { ...sf, ...patch } as Storefront;
  if (patch.slug !== undefined && !SLUG.test(patch.slug)) throw new StoreError("INVALID", "A shop address is 3 to 40 lowercase letters, numbers or dashes, starting with a letter or number.");
  if (patch.title !== undefined && !patch.title.trim()) throw new StoreError("INVALID", "The shop needs a name.");
  for (const [k, v] of [["reservationMinutes", patch.reservationMinutes], ["pickupHoldHours", patch.pickupHoldHours]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1)) throw new StoreError("INVALID", `${k} must be a whole number of at least 1.`);
  }
  if (patch.returnWindowDays !== undefined && patch.returnWindowDays !== null && (!Number.isInteger(patch.returnWindowDays) || patch.returnWindowDays < 0)) {
    throw new StoreError("INVALID", "The return window is a whole number of days, or none.");
  }
  if (patch.enabled === true && !sf.enabled) await assertEntitled(scoped, businessId, "store.open"); // opening is premium; closing and edits are not
  if (patch.enabled === true || (sf.enabled && patch.enabled !== false)) {
    if (!next.pickupEnabled && !next.deliveryEnabled) throw new StoreError("INVALID", "Offer pickup or delivery before opening the shop.");
    if (next.pickupEnabled && !next.pickupLocation?.trim()) throw new StoreError("INVALID", "Say where shoppers collect their orders (a landmark or address).");
    if (next.deliveryEnabled && (await scoped.deliveryZone.count({ where: { active: true } })) === 0) throw new StoreError("INVALID", "Add at least one delivery area with its fee before offering delivery.");
    if (!next.supportPhone?.trim()) throw new StoreError("INVALID", "Give a phone number shoppers can reach you on.");
  }
  if (patch.slug !== undefined && patch.slug !== sf.slug && (await prisma.storefront.findUnique({ where: { slug: patch.slug } }))) throw new StoreError("DUPLICATE", "That shop address is taken. Choose another.");
  try {
    return await scoped.storefront.update({ where: { id: sf.id }, data: { ...patch } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreError("DUPLICATE", "That shop address is taken. Choose another.");
    throw error;
  }
}

export async function addDeliveryZone(prisma: PrismaClient, businessId: string, input: { name: string; feeMinor: bigint; minOrderMinor?: bigint }): Promise<DeliveryZone> {
  const sf = await ensureStorefront(prisma, businessId);
  const scoped = getTenantScopedClient(prisma, businessId);
  const name = input.name.trim();
  if (!name) throw new StoreError("INVALID", "A delivery area needs a name.");
  if (input.feeMinor < 0n) throw new StoreError("INVALID", "A fee cannot be negative.");
  const existing = await scoped.deliveryZone.findFirst({ where: { storefrontId: sf.id, name } });
  if (existing) return scoped.deliveryZone.update({ where: { id: existing.id }, data: { feeMinor: input.feeMinor, minOrderMinor: input.minOrderMinor ?? null, active: true } });
  return scoped.deliveryZone.create({ data: { businessId, storefrontId: sf.id, name, feeMinor: input.feeMinor, minOrderMinor: input.minOrderMinor ?? null } });
}

export async function setZoneActive(prisma: PrismaClient, businessId: string, name: string, active: boolean): Promise<void> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const r = await scoped.deliveryZone.updateMany({ where: { name: name.trim() }, data: { active } });
  if (r.count !== 1) throw new StoreError("NOT_FOUND", `No delivery area called '${name}'.`);
}

/** Shows a variant on the storefront. It must have a retail price a shopper can actually pay. */
export async function listVariant(prisma: PrismaClient, businessId: string, variantId: string): Promise<void> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const variant = await scoped.productVariant.findUnique({ where: { id: variantId } });
  if (!variant || variant.status === "ARCHIVED") throw new StoreError("NOT_FOUND", "Product not found.");
  const list = await retailListOf(scoped);
  if (!list) throw new StoreError("INVALID", "Set a retail price first: you have no retail price list.");
  const priced = await resolveOptionPrice(scoped, list.id, variantId, variant.baseUnit, new Date());
  if (!priced) {
    throw new StoreError("INVALID", `${variant.sku} has no retail price yet. Set one before listing it.`);
  }
  const existing = await scoped.listing.findFirst({ where: { variantId, channel: "STOREFRONT" } });
  if (existing) await scoped.listing.update({ where: { id: existing.id }, data: { status: "ACTIVE" } });
  else await scoped.listing.create({ data: { businessId, variantId, channel: "STOREFRONT" } });
}

export async function unlistVariant(prisma: PrismaClient, businessId: string, variantId: string): Promise<void> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const r = await scoped.listing.updateMany({ where: { variantId, channel: "STOREFRONT" }, data: { status: "PAUSED" } });
  if (r.count !== 1) throw new StoreError("NOT_FOUND", "That product is not listed.");
}

// ------------------------------------------------------------------------------------ pricing

export interface PriceOption {
  unit: string;
  label: string;
  packBaseQuantity: number;
  minQuantity: number;
  unitPriceMinor: bigint;
}

/** The retail price of one unit option at its smallest orderable quantity, or null if it cannot be priced right now. */
export async function resolveOptionPrice(scoped: TenantScopedClient, priceListId: string, variantId: string, unit: string, at: Date): Promise<ResolvedPrice | null> {
  try {
    return await resolvePrice(scoped, { priceListId, variantId, quantity: 1, unit, at });
  } catch (error) {
    if (error instanceof PriceError && error.code === "BELOW_MINIMUM" && error.minimumQuantity) {
      try {
        return await resolvePrice(scoped, { priceListId, variantId, quantity: error.minimumQuantity, unit, at });
      } catch {
        return null;
      }
    }
    return null;
  }
}

export type Availability = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

async function availabilityOf(scoped: TenantScopedClient, businessId: string, variant: { id: string; trackStock: boolean; lowStockThreshold: number | null }): Promise<{ label: Availability; availableBase: number | null }> {
  if (!variant.trackStock) return { label: "IN_STOCK", availableBase: null };
  const shop = await ensureDefaultShopFor(scoped, businessId);
  const lvl = await getStockLevel(scoped, shop.id, variant.id);
  if (lvl.available <= 0) return { label: "OUT_OF_STOCK", availableBase: 0 };
  return { label: variant.lowStockThreshold !== null && lvl.available <= variant.lowStockThreshold ? "LOW_STOCK" : "IN_STOCK", availableBase: lvl.available };
}

export interface PublicItem {
  variantId: string;
  name: string;
  variantName: string | null;
  baseUnit: string;
  imageUrl: string | null;
  availability: Availability;
  options: (PriceOption & { available: boolean })[];
}

export interface PublicCatalog {
  currencyCode: string;
  minorUnitExp: number;
  items: PublicItem[];
  hasMore: boolean;
}


type VariantForItem = { id: string; name: string | null; baseUnit: string; trackStock: boolean; lowStockThreshold: number | null; product: { name: string; imageUrls: string[] }; packs: { normalizedName: string }[] };

/** One variant as a shopper sees it: name, availability label, and every unit it can be bought in with its price. Null if it cannot be priced. */
export async function buildPublicItem(scoped: TenantScopedClient, businessId: string, v: VariantForItem, priceListId: string, at: Date): Promise<PublicItem | null> {
  const av = await availabilityOf(scoped, businessId, v);
  const options: PublicItem["options"] = [];
  for (const unit of [v.baseUnit, ...v.packs.map((p) => p.normalizedName)]) {
    const r = await resolveOptionPrice(scoped, priceListId, v.id, unit, at);
    if (!r) continue;
    const available = av.availableBase === null || av.availableBase >= r.baseQuantity;
    options.push({ unit: r.unit, label: r.unit === v.baseUnit ? r.unit : `${r.unit} of ${r.baseQuantity / r.quantity}`, packBaseQuantity: r.baseQuantity / r.quantity, minQuantity: r.quantity, unitPriceMinor: r.unitPriceMinor, available });
  }
  if (options.length === 0) return null;
  return {
    variantId: v.id, name: v.product.name, variantName: v.name && v.name !== v.product.name ? v.name : null, baseUnit: v.baseUnit,
    imageUrl: v.product.imageUrls[0] && /^https:\/\//.test(v.product.imageUrls[0]) ? v.product.imageUrls[0] : null, availability: av.label, options,
  };
}

/** Items on a seller's storefront (published fields only). Tenant-scoped to that seller; search is within this one shop. */
export async function publicCatalog(prisma: PrismaClient, businessId: string, opts: { q?: string; take?: number; skip?: number; at?: Date } = {}): Promise<PublicCatalog> {
  const at = opts.at ?? new Date();
  const take = Math.min(Math.max(opts.take ?? 30, 1), 50);
  const skip = Math.max(opts.skip ?? 0, 0);
  const scoped = getTenantScopedClient(prisma, businessId);
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { currency: true } });
  const list = await retailListOf(scoped);
  const q = opts.q?.trim();
  const listings = await scoped.listing.findMany({
    where: {
      channel: "STOREFRONT", status: "ACTIVE", moderation: "VISIBLE", variant: { status: { not: "ARCHIVED" },
        ...(q ? { OR: [{ sku: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { product: { name: { contains: q, mode: "insensitive" } } }, { aliases: { some: { normalizedAlias: { contains: normalizeKey(q) } } } }] } : {}) },
    },
    orderBy: { createdAt: "asc" }, take: take + 1, skip,
    include: { variant: { include: { product: true, packs: true } } },
  });
  const items: PublicItem[] = [];
  if (list) {
    for (const l of listings.slice(0, take)) {
      const item = await buildPublicItem(scoped, businessId, l.variant, list.id, at);
      if (item) items.push(item);
    }
  }
  return { currencyCode: business.currencyCode, minorUnitExp: business.currency.minorUnitExp, items, hasMore: listings.length > take };
}
