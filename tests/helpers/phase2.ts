import type { PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../../src/db/tenantScope.js";
import { ensureDefaultShopFor } from "../../src/domain/shops.js";

/** Reference data every Phase 2 suite needs (idempotent). */
export async function seedReference(prisma: PrismaClient): Promise<void> {
  await prisma.currency.upsert({ where: { code: "NGN" }, update: {}, create: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.upsert({
    where: { code: "NG" },
    update: {},
    create: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.upsert({ where: { code: "en" }, update: {}, create: { code: "en", name: "English" } });
}

let counter = 0;
export async function makeBusiness(prisma: PrismaClient, name?: string) {
  counter++;
  const business = await prisma.business.create({
    data: { name: name ?? `Phase2 Biz ${counter}`, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  const scoped = getTenantScopedClient(prisma, business.id);
  const shop = await ensureDefaultShopFor(scoped, business.id);
  return { business, businessId: business.id, scoped, shop, shopId: shop.id };
}

export async function enableFlag(prisma: PrismaClient, businessId: string, flagKey: string, enabled = true) {
  await prisma.businessFeatureFlag.upsert({
    where: { businessId_flagKey: { businessId, flagKey } },
    update: { enabled },
    create: { businessId, flagKey, enabled },
  });
}
