import type { PrismaClient } from "@prisma/client";
import { addPackConversion, createProduct, createVariant } from "../../src/domain/catalog.js";
import { addPriceRule, createPriceList } from "../../src/domain/pricing.js";
import { receiveStock } from "../../src/domain/stock.js";
import { addDeliveryZone, listVariant, updateStorefront } from "../../src/domain/store/storefront.js";
import { enableFlag, makeBusiness } from "./phase2.js";

/**
 * A seller with an OPEN storefront: pickup and delivery (zone "Ikeja" fee 500.00), one listed product sold by the can
 * (100.00) or the carton of 24 (2,000.00, minimum 1), 50 cans in stock at a private cost of 40.00 per can.
 */
export async function makeSeller(prisma: PrismaClient, name: string, opts: { stock?: number; sku?: string; delivery?: boolean; slug?: string; returnWindowDays?: number | null; flags?: string[] } = {}) {
  const biz = await makeBusiness(prisma, name);
  for (const f of ["storefront", "stockV2", "accountingJournals", ...(opts.flags ?? [])]) await enableFlag(prisma, biz.businessId, f);
  const product = await createProduct(biz.scoped, { businessId: biz.businessId, name: "Cola" });
  const variant = await createVariant(biz.scoped, { businessId: biz.businessId, productId: product.id, sku: opts.sku ?? "COLA", name: "330 ml can", baseUnit: "can", lowStockThreshold: 5 });
  await addPackConversion(biz.scoped, biz.businessId, variant.id, "carton", 24);
  await receiveStock(biz.scoped, { businessId: biz.businessId, shopId: biz.shopId, variantId: variant.id, quantity: opts.stock ?? 50, unitCostMinor: 4_000n, currencyCode: "NGN" });
  const list = await createPriceList(biz.scoped, { businessId: biz.businessId, name: "Retail", kind: "RETAIL", currencyCode: "NGN" });
  await addPriceRule(biz.scoped, { businessId: biz.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: 10_000n });
  await addPriceRule(biz.scoped, { businessId: biz.businessId, priceListId: list.id, variantId: variant.id, unit: "carton", unitPriceMinor: 200_000n });
  await listVariant(prisma, biz.businessId, variant.id);
  if (opts.delivery !== false) await addDeliveryZone(prisma, biz.businessId, { name: "Ikeja", feeMinor: 50_000n });
  await updateStorefront(prisma, biz.businessId, {
    ...(opts.slug ? { slug: opts.slug } : {}), title: name, supportPhone: "08030000000", pickupEnabled: true, pickupLocation: "Opposite the market gate, Ikeja", pickupInstructions: "Ask for the shop counter",
    deliveryEnabled: opts.delivery !== false, returnWindowDays: opts.returnWindowDays === undefined ? 7 : opts.returnWindowDays, termsText: "Goods are checked before they leave the shop.", enabled: true,
  });
  return { ...biz, product, variant, list };
}
export type Seller = Awaited<ReturnType<typeof makeSeller>>;

/** A buyer's order at a seller (default: 3 cans, pickup). `online` places it as an ONLINE_SIMULATED order (needs the simulator switch). */
export async function placeStoreOrder(
  prisma: PrismaClient, s: Seller, opts: { qty?: number; fulfilment?: "PICKUP" | "DELIVERY"; online?: boolean; now?: Date } = {},
) {
  const { addToBasket } = await import("../../src/domain/store/basket.js");
  const { checkoutBasket } = await import("../../src/domain/store/orders.js");
  const t = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: opts.qty ?? 3, ...(opts.now ? { now: opts.now } : {}) });
  const zone = await s.scoped.deliveryZone.findFirst({ where: {} });
  const prev = process.env["STOREFRONT_SIMULATOR_ENABLED"];
  if (opts.online) process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
  try {
    const r = await checkoutBasket(prisma, {
      basketToken: t.token, buyer: { name: "Amaka Obi", phone: "08031234567", contactConsent: true }, allowOnline: opts.online ?? false, ...(opts.now ? { now: opts.now } : {}),
      sellers: [{ businessId: s.businessId, fulfilment: opts.fulfilment ?? "PICKUP", paymentMethod: opts.online ? "ONLINE_SIMULATED" : "PAY_ON_COLLECTION", ...(opts.fulfilment === "DELIVERY" ? { zoneId: zone!.id, address: { landmark: "Near the blue gate" } } : {}) }],
    });
    const o = r.outcomes[0]!;
    if (!o.ok) throw new Error(`placement failed: ${o.error}`);
    return { order: o.order, token: o.accessToken };
  } finally {
    if (opts.online) {
      if (prev === undefined) delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
      else process.env["STOREFRONT_SIMULATOR_ENABLED"] = prev;
    }
  }
}
