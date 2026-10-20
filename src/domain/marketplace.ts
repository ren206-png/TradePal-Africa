import type { PrismaClient, ReportReason } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "./featureFlags.js";
import { normalizeKey } from "./catalog.js";
import { FLAG_STOREFRONT, StoreError } from "./store/common.js";
import { buildPublicItem, resolveOptionPrice, retailListOf, type PublicItem } from "./store/storefront.js";

/**
 * The public marketplace (expansion section 10): discovery of listed items across sellers, separate from having a storefront.
 *
 * What is, and is not, in it:
 *  - A seller opts in (`marketplace` flag AND the seller's own switch) and must be ready: an open storefront, a contact number and at
 *    least one priced, published listing. There is no review step before publishing; moderation happens after, by reports.
 *  - Seller identity is always shown (the shop's name, contact and country). There are no reviews, ratings, trust badges, volumes or
 *    delivery guarantees: none exist to show, and none are invented.
 *  - RANKING INPUTS, in order, nothing else: (1) how well the words searched match the item (name starts with > name contains >
 *    code/alias/description contains); (2) availability (in stock before low stock before out of stock); (3) how recently the seller
 *    updated the listing; (4) listing id, so ordering is stable. There is no paid placement and no personalisation.
 *  - A suspended seller, an unpublished listing, a closed shop or an inactive business is absent from search and from its direct URL.
 *    Orders already placed carry on (token pages and the seller's own tools are untouched).
 */
export const FLAG_MARKETPLACE = "marketplace";

export const MARKETPLACE_CATEGORIES = [
  "Food and drink", "Groceries", "Farm produce", "Clothing and fashion", "Phones and electronics", "Home and kitchen", "Beauty and personal care", "Building and hardware", "Other",
] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export const REPORT_REASONS = ["PROHIBITED_ITEM", "COUNTERFEIT", "MISLEADING_PRICE", "SCAM", "OTHER"] as const;

export const categoryOf = (text: string): MarketplaceCategory | null => {
  const k = normalizeKey(text);
  return MARKETPLACE_CATEGORIES.find((c) => normalizeKey(c) === k || normalizeKey(c).startsWith(k)) ?? null;
};

// ------------------------------------------------------------------------------------ seller side

/** Is this seller allowed to be on the marketplace right now (for the seller's own `/store marketplace` messages)? */
export async function marketplaceReadiness(prisma: PrismaClient, businessId: string): Promise<{ ready: boolean; missing: string[] }> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const missing: string[] = [];
  const sf = await scoped.storefront.findFirst({ where: {} });
  if (!sf || !sf.enabled) missing.push("open your shop first (/store open)");
  if (!sf?.supportPhone) missing.push("add a contact number (/store phone)");
  if (!(await isFeatureEnabled(scoped, businessId, FLAG_MARKETPLACE))) missing.push("the marketplace is not switched on for your account yet");
  const published = await scoped.listing.count({ where: { channel: "MARKETPLACE", status: "ACTIVE", moderation: "VISIBLE", category: { not: null } } });
  if (published === 0) missing.push("publish at least one item with a category (/store publish <sku> <category>)");
  return { ready: missing.length === 0, missing };
}

export async function enableMarketplace(prisma: PrismaClient, businessId: string): Promise<void> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const sf = await scoped.storefront.findFirst({ where: {} });
  if (!sf) throw new StoreError("NOT_READY", "Set up your shop first (/store).");
  if (sf.marketplaceStatus === "SUSPENDED") throw new StoreError("SUSPENDED", `Your marketplace presence is suspended${sf.marketplaceNote ? `: ${sf.marketplaceNote}` : ""}. You can appeal with /store appeal <what happened>.`);
  const r = await marketplaceReadiness(prisma, businessId);
  if (!r.ready) throw new StoreError("NOT_READY", `Before you go on the marketplace: ${r.missing.join("; ")}.`);
  await scoped.storefront.update({ where: { id: sf.id }, data: { marketplaceStatus: "ACTIVE" } });
}

export async function disableMarketplace(prisma: PrismaClient, businessId: string): Promise<void> {
  const scoped = getTenantScopedClient(prisma, businessId);
  await scoped.storefront.updateMany({ where: { marketplaceStatus: "ACTIVE" }, data: { marketplaceStatus: "OFF" } });
}

/** Publishes one item (already on the seller's shop and priced) to the marketplace under a category from the fixed list. */
export async function publishMarketplaceListing(prisma: PrismaClient, businessId: string, variantId: string, categoryText: string): Promise<{ category: MarketplaceCategory }> {
  const category = categoryOf(categoryText);
  if (!category) throw new StoreError("INVALID", `Choose a category: ${MARKETPLACE_CATEGORIES.join(", ")}.`);
  const scoped = getTenantScopedClient(prisma, businessId);
  const shopListing = await scoped.listing.findFirst({ where: { variantId, channel: "STOREFRONT", status: "ACTIVE" } });
  if (!shopListing) throw new StoreError("NOT_LISTED", "List the item in your shop first (/store list <sku>).");
  const list = await retailListOf(scoped);
  const variant = await scoped.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  if (!list || !(await resolveOptionPrice(scoped, list.id, variantId, variant.baseUnit, new Date()))) throw new StoreError("INVALID", "That item has no retail price right now.");
  const existing = await scoped.listing.findFirst({ where: { variantId, channel: "MARKETPLACE" } });
  if (existing) {
    if (existing.moderation === "UNPUBLISHED") throw new StoreError("UNPUBLISHED", `A TradePal moderator unpublished this item${existing.moderationReason ? `: ${existing.moderationReason}` : ""}. You can appeal with /store appeal <what happened>.`);
    await scoped.listing.update({ where: { id: existing.id }, data: { status: "ACTIVE", category } });
  } else {
    await scoped.listing.create({ data: { businessId, variantId, channel: "MARKETPLACE", category } });
  }
  return { category };
}

export async function unpublishMarketplaceListing(prisma: PrismaClient, businessId: string, variantId: string): Promise<void> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const r = await scoped.listing.updateMany({ where: { variantId, channel: "MARKETPLACE" }, data: { status: "PAUSED" } });
  if (r.count !== 1) throw new StoreError("NOT_FOUND", "That item is not on the marketplace.");
}

// ------------------------------------------------------------------------------------ public side

export interface MarketplaceSeller {
  businessId: string;
  name: string;
  slug: string;
  countryCode: string;
  supportPhone: string | null;
  pickup: boolean;
  delivery: boolean;
  areas: string[];
}
export interface MarketplaceResult {
  listingId: string;
  category: string | null;
  seller: MarketplaceSeller;
  currencyCode: string;
  minorUnitExp: number;
  item: PublicItem;
}

const AVAIL_RANK = { IN_STOCK: 2, LOW_STOCK: 1, OUT_OF_STOCK: 0 } as const;

/** The visible-listing filter, in one place so search and direct URLs agree exactly. */
const visibleWhere = (country?: string) => ({
  channel: "MARKETPLACE" as const, status: "ACTIVE" as const, moderation: "VISIBLE" as const, category: { not: null },
  variant: { status: { not: "ARCHIVED" as const } },
  business: { status: "ACTIVE" as const, ...(country ? { countryCode: country } : {}), storefronts: { some: { enabled: true, marketplaceStatus: "ACTIVE" as const } } },
});

async function sellerAllowed(prisma: PrismaClient, businessId: string, cache: Map<string, boolean>): Promise<boolean> {
  const hit = cache.get(businessId);
  if (hit !== undefined) return hit;
  const scoped = getTenantScopedClient(prisma, businessId);
  const ok = (await isFeatureEnabled(scoped, businessId, FLAG_MARKETPLACE)) && (await isFeatureEnabled(scoped, businessId, FLAG_STOREFRONT));
  cache.set(businessId, ok);
  return ok;
}

/** Countries that have at least one seller on the marketplace right now. */
export async function marketplaceCountries(prisma: PrismaClient): Promise<{ code: string; name: string }[]> {
  const rows = await prisma.listing.findMany({ where: visibleWhere(), select: { businessId: true, business: { select: { countryCode: true, country: { select: { name: true } } } } }, distinct: ["businessId"], take: 500 });
  const cache = new Map<string, boolean>();
  const out = new Map<string, string>();
  for (const r of rows) if (await sellerAllowed(prisma, r.businessId, cache)) out.set(r.business.countryCode, r.business.country.name);
  return [...out.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function searchMarketplace(
  prisma: PrismaClient,
  opts: { country: string; category?: string; q?: string; area?: string; take?: number; skip?: number; now?: Date },
): Promise<{ results: MarketplaceResult[]; hasMore: boolean }> {
  const now = opts.now ?? new Date();
  const take = Math.min(Math.max(opts.take ?? 20, 1), 40);
  const skip = Math.max(opts.skip ?? 0, 0);
  const q = normalizeKey(opts.q ?? "");
  const category = opts.category ? categoryOf(opts.category) : null;
  const area = opts.area?.trim().toLowerCase();
  const base = visibleWhere(opts.country.toUpperCase());
  const rows = await prisma.listing.findMany({
    where: {
      ...base, ...(category ? { category } : {}),
      variant: { ...base.variant, ...(q ? { OR: [{ sku: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { product: { name: { contains: q, mode: "insensitive" } } }, { product: { description: { contains: q, mode: "insensitive" } } }, { aliases: { some: { normalizedAlias: { contains: q } } } }] } : {}) },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 300,
    include: { variant: { include: { product: true, packs: true } }, business: { include: { currency: true, storefronts: { include: { zones: true } } } } },
  });

  const cache = new Map<string, boolean>();
  const lists = new Map<string, Awaited<ReturnType<typeof retailListOf>>>();
  const scored: { r: MarketplaceResult; text: number; avail: number; updated: number; id: string }[] = [];
  for (const l of rows) {
    if (!(await sellerAllowed(prisma, l.businessId, cache))) continue;
    const sf = l.business.storefronts[0]!;
    const areas = sf.zones.filter((z) => z.active).map((z) => z.name);
    if (area && !areas.some((a) => a.toLowerCase().includes(area)) && !(sf.pickupLocation ?? "").toLowerCase().includes(area)) continue;
    const scoped = getTenantScopedClient(prisma, l.businessId);
    if (!lists.has(l.businessId)) lists.set(l.businessId, await retailListOf(scoped));
    const list = lists.get(l.businessId);
    if (!list) continue;
    const item = await buildPublicItem(scoped, l.businessId, l.variant, list.id, now);
    if (!item) continue;
    const name = normalizeKey(item.name);
    const text = !q ? 0 : name.startsWith(q) ? 3 : name.includes(q) ? 2 : 1;
    scored.push({
      r: { listingId: l.id, category: l.category, seller: sellerOf(l.business, sf, areas), currencyCode: l.business.currencyCode, minorUnitExp: l.business.currency.minorUnitExp, item },
      text, avail: AVAIL_RANK[item.availability], updated: l.updatedAt.getTime(), id: l.id,
    });
  }
  scored.sort((a, b) => b.text - a.text || b.avail - a.avail || b.updated - a.updated || a.id.localeCompare(b.id));
  const page = scored.slice(skip, skip + take);
  return { results: page.map((s) => s.r), hasMore: scored.length > skip + take };
}

function sellerOf(b: { id: string; countryCode: string }, sf: { title: string; slug: string; supportPhone: string | null; pickupEnabled: boolean; deliveryEnabled: boolean }, areas: string[]): MarketplaceSeller {
  return { businessId: b.id, name: sf.title, slug: sf.slug, countryCode: b.countryCode, supportPhone: sf.supportPhone, pickup: sf.pickupEnabled, delivery: sf.deliveryEnabled, areas };
}

/** One listing by its id (the direct URL). Absent whenever search would not show it. */
export async function getMarketplaceListing(prisma: PrismaClient, listingId: string, now: Date = new Date()): Promise<MarketplaceResult | null> {
  const l = await prisma.listing.findFirst({
    where: { id: listingId, ...visibleWhere() },
    include: { variant: { include: { product: true, packs: true } }, business: { include: { currency: true, storefronts: { include: { zones: true } } } } },
  });
  if (!l || !(await sellerAllowed(prisma, l.businessId, new Map()))) return null;
  const sf = l.business.storefronts[0]!;
  const scoped = getTenantScopedClient(prisma, l.businessId);
  const list = await retailListOf(scoped);
  if (!list) return null;
  const item = await buildPublicItem(scoped, l.businessId, l.variant, list.id, now);
  if (!item) return null;
  return { listingId: l.id, category: l.category, seller: sellerOf(l.business, sf, sf.zones.filter((z) => z.active).map((z) => z.name)), currencyCode: l.business.currencyCode, minorUnitExp: l.business.currency.minorUnitExp, item };
}

// ------------------------------------------------------------------------------------ reports

/** Anyone can report a listing or a shop. A report proposes; a person decides (see moderation.ts). */
export async function fileReport(
  prisma: PrismaClient,
  input: { listingId?: string; slug?: string; reason: ReportReason; details: string; contact?: string },
): Promise<{ id: string }> {
  const details = input.details.trim();
  if (details.length < 10) throw new StoreError("INVALID", "Tell us what is wrong in a sentence or two.");
  if (details.length > 1_000) throw new StoreError("INVALID", "Please keep it under 1,000 characters.");
  let businessId: string | null = null;
  let listingId: string | null = null;
  if (input.listingId) {
    const l = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, businessId: true, channel: true } });
    if (l) {
      businessId = l.businessId;
      listingId = l.id;
    }
  } else if (input.slug) {
    const sf = await prisma.storefront.findUnique({ where: { slug: input.slug.toLowerCase() }, select: { businessId: true } });
    businessId = sf?.businessId ?? null;
  }
  if (!businessId) throw new StoreError("NOT_FOUND", "We could not find what you are reporting.");
  const open = await prisma.marketplaceReport.count({ where: { businessId, status: "OPEN" } });
  if (open >= 200) throw new StoreError("BUSY", "This has already been reported many times and is being looked at. Thank you.");
  const r = await prisma.marketplaceReport.create({
    data: { businessId, listingId, reason: input.reason, details, ...(input.contact?.trim() ? { contact: input.contact.trim().slice(0, 100) } : {}) },
  });
  return { id: r.id };
}
