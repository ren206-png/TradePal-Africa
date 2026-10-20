import type { PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../../src/db/tenantScope.js";
import { ensureDefaultShopFor } from "../../src/domain/shops.js";
import { enableFlag } from "./phase2.js";
import { PawaPayFake } from "./pawapayFake.js";
import { buildBillingConfigFromEnv, setBillingConfig, DAY_MS } from "../../src/domain/subscriptions/common.js";
import { resetBillingConfCacheForTests } from "../../src/domain/subscriptions/renewal.js";
import { resetKeyRefreshForTests } from "../../src/domain/subscriptions/collection.js";
import { createPlanVersion, publishPlanVersion, setPlanPrice } from "../../src/domain/subscriptions/plans.js";

export const AUTHORITY = "api.tradepal.test";
export const PHONE = "23276123456";

/** Sierra Leone reference data (the only country pawaPay billing can serve today). */
export async function seedSierraLeone(prisma: PrismaClient): Promise<void> {
  await prisma.currency.upsert({ where: { code: "SLE" }, update: {}, create: { code: "SLE", name: "Sierra Leonean Leone", minorUnitExp: 2 } });
  await prisma.country.upsert({ where: { code: "SL" }, update: {}, create: { code: "SL", name: "Sierra Leone", callingCode: "232", defaultCurrency: "SLE", defaultTimezone: "Africa/Freetown" } });
  // exists in production since migration 20260820000000_pawapay_deposits; that migration's data statement is not part of the test schema
  await prisma.paymentProvider.upsert({ where: { code: "PAWAPAY" }, update: {}, create: { code: "PAWAPAY", countryCode: "SL", config: {}, enabled: true } });
  await prisma.plan.upsert({ where: { code: "FREE" }, update: {}, create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "SLE", entryCapPerMonth: 50 } });
  await prisma.plan.upsert({ where: { code: "STARTER" }, update: {}, create: { code: "STARTER", name: "Starter", priceMinor: 0n, currencyCode: "SLE" } });
  await prisma.plan.upsert({ where: { code: "PRO" }, update: {}, create: { code: "PRO", name: "Pro", priceMinor: 0n, currencyCode: "SLE" } });
}

let n = 0;
/** A Sierra Leone business with an owner merchant, the billing flags on, and pawaPay switched on for the country. */
export async function makeSlBusiness(prisma: PrismaClient, opts: { flags?: string[]; name?: string } = {}) {
  n++;
  const business = await prisma.business.create({ data: { name: opts.name ?? `SL Biz ${n}`, countryCode: "SL", currencyCode: "SLE", languageCode: "en", timezone: "Africa/Freetown" } });
  const scoped = getTenantScopedClient(prisma, business.id);
  const shop = await ensureDefaultShopFor(scoped, business.id);
  const merchant = await prisma.merchant.create({ data: { businessId: business.id, phoneNumber: `2327700${String(1000 + n)}`, role: "OWNER", onboardingStep: "COMPLETE" as never } });
  for (const f of opts.flags ?? ["pawapayBilling"]) await enableFlag(prisma, business.id, f);
  return { business, businessId: business.id, scoped, shop, shopId: shop.id, merchant, merchantId: merchant.id };
}

/** Wires the fake pawaPay as the sandbox, sets the billing configuration, and opens the country switch. */
export async function billingWorld(prisma: PrismaClient) {
  const fake = new PawaPayFake();
  const deps = { apiToken: "sandbox-token", apiBaseUrl: "https://api.sandbox.pawapay.io/v2", fetchImpl: fake.fetchImpl };
  const cfg = buildBillingConfigFromEnv({ PAWAPAY_ENVIRONMENT: "SANDBOX", PAWAPAY_BILLING_CALLBACK_AUTHORITY: AUTHORITY, NODE_ENV: "test" } as NodeJS.ProcessEnv, deps);
  if (!cfg.ok) throw new Error(cfg.reason);
  setBillingConfig(cfg);
  resetBillingConfCacheForTests();
  resetKeyRefreshForTests();
  await prisma.billingSwitch.upsert({ where: { provider_countryCode_purpose: { provider: "pawapay", countryCode: "SL", purpose: "PLATFORM_SUBSCRIPTION" } }, update: { newAttemptsEnabled: true }, create: { provider: "pawapay", countryCode: "SL", newAttemptsEnabled: true } });
  return { fake, cfg: cfg.config };
}

/** A published plan version with a TEST price (these are fixtures, not price points: the product has none). */
export async function publishedPlan(prisma: PrismaClient, planCode = "STARTER", opts: { priceMinor?: bigint; features?: string[]; graceDays?: number; periodDays?: number } = {}) {
  const v = await createPlanVersion(prisma, { planCode, features: opts.features ?? ["trade", "marketplace", "reorder", "storefront"], graceDays: opts.graceDays ?? 3, billingPeriodDays: opts.periodDays ?? 30 });
  await setPlanPrice(prisma, { planVersionId: v.id, countryCode: "SL", priceMinor: opts.priceMinor ?? 5_000_00n });
  return publishPlanVersion(prisma, v.id);
}
export { DAY_MS };
