import type { PrismaClient } from "@prisma/client";
import { createProduct, createVariant, addPackConversion, setVariantStatus } from "../../src/domain/catalog.js";
import { createPriceList, addPriceRule } from "../../src/domain/pricing.js";
import { receiveStock } from "../../src/domain/stock.js";
import { acceptLink, createPartner, inviteLink, shareWholesaleList } from "../../src/domain/trade/partners.js";
import { enableFlag, makeBusiness } from "./phase2.js";

export type Biz = Awaited<ReturnType<typeof makeBusiness>>;

/**
 * A wholesaler (W) and a retailer (R), both with trade/stock/journals on, linked, with W's wholesale price list shared:
 * W sells COLA-330 by the piece or the carton of 24 (220,000 per carton, 210,000 from 5 cartons); R has its own COLA variant.
 */
export async function tradeWorld(prisma: PrismaClient, opts: { wholesalerStock?: number; share?: boolean; link?: boolean } = {}) {
  const W = await makeBusiness(prisma, "Alpha Wholesale");
  const R = await makeBusiness(prisma, "Retail Corner");
  for (const b of [W, R]) for (const f of ["tradeOrders", "stockV2", "accountingJournals"]) await enableFlag(prisma, b.businessId, f);

  const wp = await createProduct(W.scoped, { businessId: W.businessId, name: "Cola" });
  const wVariantRaw = await createVariant(W.scoped, { businessId: W.businessId, productId: wp.id, sku: "COLA-330", name: "330 ml can", baseUnit: "piece" });
  const wVariant = await setVariantStatus(W.scoped, wVariantRaw.id, "PUBLISHED");
  await addPackConversion(W.scoped, W.businessId, wVariant.id, "carton", 24);
  await receiveStock(W.scoped, { businessId: W.businessId, shopId: W.shopId, variantId: wVariant.id, quantity: opts.wholesalerStock ?? 200, unitCostMinor: 8_000n, currencyCode: "NGN" });
  const wList = await createPriceList(W.scoped, { businessId: W.businessId, name: "Wholesale", kind: "WHOLESALE", currencyCode: "NGN" });
  await addPriceRule(W.scoped, { businessId: W.businessId, priceListId: wList.id, variantId: wVariant.id, unit: "carton", unitPriceMinor: 220_000n, minQuantity: 1 });
  await addPriceRule(W.scoped, { businessId: W.businessId, priceListId: wList.id, variantId: wVariant.id, unit: "carton", unitPriceMinor: 210_000n, minQuantity: 5 });

  const rp = await createProduct(R.scoped, { businessId: R.businessId, name: "Cola" });
  const rVariant = await createVariant(R.scoped, { businessId: R.businessId, productId: rp.id, sku: "COLA", name: "330 ml can", baseUnit: "piece" });

  const rPartner = await createPartner(R.scoped, { businessId: R.businessId, name: "Alpha Wholesale", role: "SUPPLIER", paymentTermsDays: 14 });
  let link = null as Awaited<ReturnType<typeof acceptLink>> | null;
  let wPartnerId: string | null = null;
  if (opts.link !== false) {
    const invite = await inviteLink(prisma, { inviterBusinessId: R.businessId, partnerId: rPartner.id });
    link = await acceptLink(prisma, { inviteeBusinessId: W.businessId, token: invite.token });
    wPartnerId = link.inviteePartnerId;
    if (opts.share !== false) await shareWholesaleList(prisma, { businessId: W.businessId, priceListId: wList.id, linkId: link.id });
  }
  return { W, R, wVariant, rVariant, wList, rPartner, wPartnerId, link };
}
export type World = Awaited<ReturnType<typeof tradeWorld>>;
