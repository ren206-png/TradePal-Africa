import type { Basket, PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import { normalizeKey } from "../catalog.js";
import { PriceError, resolvePrice } from "../pricing.js";
import { ensureDefaultShopFor } from "../shops.js";
import { getStockLevel } from "../stock.js";
import { StoreError, loadPublicStorefrontById, newToken, sha256 } from "./common.js";
import { retailListOf } from "./storefront.js";

/**
 * The shopper's basket: a cross-seller list of references, reachable only by its secret token (kept in an HttpOnly cookie
 * by the web layer). It holds no prices: every price and availability is re-read live, and checkout re-prices again, so a
 * stale basket can never buy at an old price. At checkout it is split into independent per-seller orders.
 */
export const BASKET_TTL_DAYS = 7;
export const MAX_BASKET_LINES = 100;
export const MAX_LINE_QUANTITY = 999;
const DAY = 86_400_000;

export async function loadBasket(prisma: PrismaClient, token: string | null | undefined, now: Date = new Date()): Promise<Basket | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const basket = await prisma.basket.findUnique({ where: { tokenHash: sha256(token) } });
  if (!basket || basket.status !== "OPEN" || basket.expiresAt <= now) return null;
  return basket;
}

export async function createBasket(prisma: PrismaClient, now: Date = new Date()): Promise<{ basket: Basket; token: string }> {
  const token = newToken();
  const basket = await prisma.basket.create({ data: { tokenHash: sha256(token), expiresAt: new Date(now.getTime() + BASKET_TTL_DAYS * DAY) } });
  return { basket, token };
}

export interface AddInput {
  token?: string | null;
  businessId: string;
  variantId: string;
  unit: string;
  quantity: number;
  now?: Date;
}

/** Adds (or tops up) a line. The listing must be live and the quantity must be priceable at that unit (minimums enforced). */
export async function addToBasket(prisma: PrismaClient, input: AddInput): Promise<{ token: string; basket: Basket }> {
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_LINE_QUANTITY) throw new StoreError("INVALID", `Choose a quantity from 1 to ${MAX_LINE_QUANTITY}.`);
  const sf = await loadPublicStorefrontById(prisma, input.businessId);
  if (!sf) throw new StoreError("UNAVAILABLE", "This shop is not open right now.");
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const listing = await scoped.listing.findFirst({ where: { variantId: input.variantId, channel: "STOREFRONT", status: "ACTIVE", moderation: "VISIBLE" }, include: { variant: { include: { packs: true } } } });
  if (!listing || listing.variant.status === "ARCHIVED") throw new StoreError("UNAVAILABLE", "That item is no longer available.");
  const unit = normalizeKey(input.unit);
  const units = [listing.variant.baseUnit, ...listing.variant.packs.map((p) => p.normalizedName)];
  if (!units.includes(unit)) throw new StoreError("INVALID", "Choose one of the sizes offered.");
  const list = await retailListOf(scoped);
  if (!list) throw new StoreError("UNAVAILABLE", "That item has no price right now.");

  let basket = await loadBasket(prisma, input.token, now);
  let token = input.token ?? "";
  if (!basket) {
    const created = await createBasket(prisma, now);
    basket = created.basket;
    token = created.token;
  }
  const existing = await prisma.basketLine.findFirst({ where: { basketId: basket.id, variantId: input.variantId, unit } });
  const newQty = Math.min(MAX_LINE_QUANTITY, (existing?.quantity ?? 0) + input.quantity);
  try {
    await resolvePrice(scoped, { priceListId: list.id, variantId: input.variantId, quantity: newQty, unit, at: now });
  } catch (error) {
    if (error instanceof PriceError) throw new StoreError("INVALID", error.code === "BELOW_MINIMUM" ? error.message : "That size cannot be bought right now.");
    throw error;
  }
  if (!existing && (await prisma.basketLine.count({ where: { basketId: basket.id } })) >= MAX_BASKET_LINES) throw new StoreError("INVALID", "The basket is full.");
  if (existing) await prisma.basketLine.update({ where: { id: existing.id }, data: { quantity: newQty } });
  else await prisma.basketLine.create({ data: { basketId: basket.id, sellerBusinessId: input.businessId, variantId: input.variantId, unit, quantity: newQty } });
  const refreshed = await prisma.basket.update({ where: { id: basket.id }, data: { expiresAt: new Date(now.getTime() + BASKET_TTL_DAYS * DAY) } });
  return { token, basket: refreshed };
}

export async function setLineQuantity(prisma: PrismaClient, token: string, lineId: string, quantity: number, now: Date = new Date()): Promise<void> {
  const basket = await loadBasket(prisma, token, now);
  if (!basket) throw new StoreError("NOT_FOUND", "Your basket has expired.");
  const line = await prisma.basketLine.findFirst({ where: { id: lineId, basketId: basket.id } });
  if (!line) throw new StoreError("NOT_FOUND", "That line is not in your basket.");
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_LINE_QUANTITY) throw new StoreError("INVALID", `Choose a quantity from 0 to ${MAX_LINE_QUANTITY}.`);
  if (quantity === 0) await prisma.basketLine.delete({ where: { id: line.id } });
  else await prisma.basketLine.update({ where: { id: line.id }, data: { quantity } });
}

export interface BasketLineView {
  lineId: string;
  variantId: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceMinor: bigint | null;
  lineTotalMinor: bigint | null;
  problem: string | null;
}

export interface BasketSellerView {
  businessId: string;
  slug: string;
  sellerName: string;
  currencyCode: string;
  minorUnitExp: number;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  pickupLocation: string | null;
  zones: { id: string; name: string; feeMinor: bigint; minOrderMinor: bigint | null }[];
  paymentMethods: ("PAY_ON_COLLECTION" | "ONLINE_SIMULATED")[];
  lines: BasketLineView[];
  subtotalMinor: bigint;
  /** True when every line can be bought right now. */
  checkoutReady: boolean;
}

/** The basket grouped by seller, each group with its own totals, currency and terms. Prices and availability are read live. */
export async function basketView(prisma: PrismaClient, token: string | null | undefined, opts: { allowOnlinePayment?: boolean; now?: Date } = {}): Promise<{ sellers: BasketSellerView[]; empty: boolean }> {
  const now = opts.now ?? new Date();
  const basket = await loadBasket(prisma, token, now);
  if (!basket) return { sellers: [], empty: true };
  const lines = await prisma.basketLine.findMany({ where: { basketId: basket.id }, orderBy: { addedAt: "asc" } });
  const bySeller = new Map<string, typeof lines>();
  for (const l of lines) bySeller.set(l.sellerBusinessId, [...(bySeller.get(l.sellerBusinessId) ?? []), l]);
  const sellers: BasketSellerView[] = [];
  for (const [businessId, ls] of bySeller) {
    const sf = await loadPublicStorefrontById(prisma, businessId);
    const business = await prisma.business.findUnique({ where: { id: businessId }, include: { currency: true } });
    if (!business) continue;
    const scoped = getTenantScopedClient(prisma, businessId);
    const list = sf ? await retailListOf(scoped) : null;
    const zones = sf ? await scoped.deliveryZone.findMany({ where: { active: true }, orderBy: { name: "asc" } }) : [];
    const shop = await ensureDefaultShopFor(scoped, businessId);
    const views: BasketLineView[] = [];
    for (const l of ls) {
      const variant = await scoped.productVariant.findUnique({ where: { id: l.variantId }, include: { product: true, packs: true } });
      const listing = await scoped.listing.findFirst({ where: { variantId: l.variantId, channel: "STOREFRONT", status: "ACTIVE", moderation: "VISIBLE" } });
      const name = variant ? `${variant.product.name}${variant.name && variant.name !== variant.product.name ? ` ${variant.name}` : ""}` : "Item";
      let problem: string | null = null;
      let price: bigint | null = null;
      let total: bigint | null = null;
      if (!sf) problem = "This shop is closed right now.";
      else if (!variant || !listing || variant.status === "ARCHIVED") problem = "No longer available.";
      else if (!list) problem = "No price right now.";
      else {
        try {
          const r = await resolvePrice(scoped, { priceListId: list.id, variantId: l.variantId, quantity: l.quantity, unit: l.unit, at: now });
          price = r.unitPriceMinor;
          total = r.lineTotalMinor;
          if (variant.trackStock) {
            const lvl = await getStockLevel(scoped, shop.id, variant.id);
            if (lvl.available < r.baseQuantity) problem = lvl.available <= 0 ? "Out of stock." : "Not enough in stock for that quantity.";
          }
        } catch (error) {
          if (!(error instanceof PriceError)) throw error;
          problem = error.code === "BELOW_MINIMUM" ? error.message : "Cannot be bought in that size right now.";
        }
      }
      views.push({ lineId: l.id, variantId: l.variantId, name, unit: l.unit, quantity: l.quantity, unitPriceMinor: price, lineTotalMinor: total, problem });
    }
    sellers.push({
      businessId, slug: sf?.slug ?? "", sellerName: sf?.title ?? business.name, currencyCode: business.currencyCode, minorUnitExp: business.currency.minorUnitExp,
      pickupEnabled: sf?.pickupEnabled ?? false, deliveryEnabled: sf?.deliveryEnabled ?? false, pickupLocation: sf?.pickupLocation ?? null,
      zones: zones.map((z) => ({ id: z.id, name: z.name, feeMinor: z.feeMinor, minOrderMinor: z.minOrderMinor })),
      paymentMethods: opts.allowOnlinePayment ? ["PAY_ON_COLLECTION", "ONLINE_SIMULATED"] : ["PAY_ON_COLLECTION"],
      lines: views, subtotalMinor: views.reduce((n, v) => n + (v.lineTotalMinor ?? 0n), 0n), checkoutReady: !!sf && views.every((v) => v.problem === null),
    });
  }
  sellers.sort((a, b) => a.sellerName.localeCompare(b.sellerName));
  return { sellers, empty: lines.length === 0 };
}
