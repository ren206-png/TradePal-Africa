import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { recordTransaction, reverseTransaction } from "../src/domain/ledger.js";
import { setFeatureFlagForBusiness } from "../src/domain/featureFlags.js";
import {
  assertWithinQuota,
  assertWithinQuotaIfEnabled,
  BILLING_QUOTA_FEATURE_FLAG_KEY,
  getEffectivePlan,
  getQuotaStatus,
  PlanNotFoundError,
  QuotaExceededError,
} from "../src/domain/billing.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  await prisma.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false },
  });
  await prisma.plan.upsert({
    where: { code: "PRO" },
    update: {},
    create: { code: "PRO", name: "Pro", priceMinor: 500000n, currencyCode: "NGN", entryCapPerMonth: null, voiceEnabled: true },
  });

  await prisma.featureFlag.upsert({
    where: { key: BILLING_QUOTA_FEATURE_FLAG_KEY },
    update: {},
    create: { key: BILLING_QUOTA_FEATURE_FLAG_KEY, description: "test", enabledByDefault: false },
  });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

async function makeBusiness(name: string): Promise<{ businessId: string; scoped: TenantScopedClient }> {
  const business = await prisma.business.create({
    data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  return { businessId: business.id, scoped: getTenantScopedClient(prisma, business.id) };
}

describe("getEffectivePlan", () => {
  it("falls back to the FREE plan for a business with no Subscription row", async () => {
    const { businessId, scoped } = await makeBusiness("No Subscription Shop");
    const plan = await getEffectivePlan(scoped, businessId);

    expect(plan.code).toBe("FREE");
    expect(plan.entryCapPerMonth).toBe(100);
  });

  it("uses the plan on an ACTIVE Subscription instead of the FREE fallback", async () => {
    const { businessId, scoped } = await makeBusiness("Pro Shop");
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const plan = await getEffectivePlan(scoped, businessId);
    expect(plan.code).toBe("PRO");
    expect(plan.entryCapPerMonth).toBeNull();
  });

  it("ignores an ACTIVE Subscription whose currentPeriodEnd has already passed, falling back to FREE", async () => {
    // Phase 6: getEffectivePlan must stop treating a lapsed-but-not-yet-swept row as entitled,
    // independent of whether the periodic subscriptionExpiry sweep has run yet.
    const { businessId, scoped } = await makeBusiness("Lapsed Sub Shop");
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 24 * 60 * 60 * 1000), // ended yesterday
      },
    });

    const plan = await getEffectivePlan(scoped, businessId, now);
    expect(plan.code).toBe("FREE");
  });

  it("falls through a lapsed ACTIVE row to an earlier still-valid ACTIVE row", async () => {
    const { businessId, scoped } = await makeBusiness("Fallthrough Shop");
    const now = new Date();
    // Older row, still within its period.
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "FREE",
        status: "ACTIVE",
        currentPeriodStart: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
      },
    });
    // Newer row (would normally win by createdAt), but its period already lapsed.
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      },
    });

    const plan = await getEffectivePlan(scoped, businessId, now);
    expect(plan.code).toBe("FREE");
  });

  it("ignores a CANCELED Subscription and falls back to FREE", async () => {
    const { businessId, scoped } = await makeBusiness("Canceled Sub Shop");
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "CANCELED",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const plan = await getEffectivePlan(scoped, businessId);
    expect(plan.code).toBe("FREE");
  });

  // Note: a Subscription.planCode referencing a nonexistent Plan can't be created
  // against this schema (Subscription_planCode_fkey enforces it at the DB level),
  // so the reachable case for PlanNotFoundError is the FREE fallback itself being
  // absent — exercised below against an isolated database that never seeds a FREE
  // plan, to avoid poisoning the shared connection with a real FK violation.
  it("throws PlanNotFoundError when even the FREE fallback plan doesn't exist (no Subscription row)", async () => {
    const localDb = await createTestDb();
    try {
      const localPrisma = localDb.prisma;
      await localPrisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
      await localPrisma.country.create({
        data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
      });
      await localPrisma.language.create({ data: { code: "en", name: "English" } });
      const business = await localPrisma.business.create({
        data: { name: "No Plan Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const localScoped = getTenantScopedClient(localPrisma, business.id);

      await expect(getEffectivePlan(localScoped, business.id)).rejects.toThrow(PlanNotFoundError);
    } finally {
      await localDb.teardown();
    }
  }, 60_000);
});

describe("getQuotaStatus / assertWithinQuota", () => {
  it("reports zero usage and full remaining quota for a business with no transactions", async () => {
    const { businessId, scoped } = await makeBusiness("Fresh Quota Shop");
    const status = await getQuotaStatus(scoped, businessId, "Africa/Lagos");

    expect(status.plan.code).toBe("FREE");
    expect(status.usedThisMonth).toBe(0);
    expect(status.remaining).toBe(100);
  });

  it("counts non-reversal transactions posted this month, and excludes reversal rows", async () => {
    const { businessId, scoped } = await makeBusiness("Counting Shop");

    const t1 = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 1000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await recordTransaction(scoped, {
      businessId,
      type: "EXPENSE",
      amountMinor: 500n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await reverseTransaction(scoped, t1.id, "test reversal");

    const status = await getQuotaStatus(scoped, businessId, "Africa/Lagos");
    // 2 original entries count; the reversal row itself does not.
    expect(status.usedThisMonth).toBe(2);
    expect(status.remaining).toBe(98);
  });

  it("excludes a transaction posted last month from this month's usage", async () => {
    const { businessId, scoped } = await makeBusiness("Last Month Shop");
    const stale = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 1000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await prisma.transaction.update({ where: { id: stale.id }, data: { createdAt: lastMonth } });

    const status = await getQuotaStatus(scoped, businessId, "Africa/Lagos");
    expect(status.usedThisMonth).toBe(0);
  });

  it("treats an uncapped (PRO) plan as always having null remaining quota, never throwing", async () => {
    const { businessId, scoped } = await makeBusiness("Uncapped Shop");
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    for (let i = 0; i < 5; i++) {
      await recordTransaction(scoped, {
        businessId,
        type: "SALE",
        amountMinor: 1000n,
        currencyCode: "NGN",
        paymentStatus: "PAID",
      });
    }

    const status = await assertWithinQuota(scoped, businessId, "Africa/Lagos");
    expect(status.remaining).toBeNull();
  });

  it("assertWithinQuota throws QuotaExceededError once usage reaches the cap", async () => {
    const { businessId, scoped } = await makeBusiness("Tiny Cap Shop");
    await prisma.plan.upsert({
      where: { code: "TINY" },
      update: {},
      create: { code: "TINY", name: "Tiny", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 1, voiceEnabled: false },
    });
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "TINY",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await assertWithinQuota(scoped, businessId, "Africa/Lagos"); // 0 used, cap 1: fine

    await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 1000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });

    await expect(assertWithinQuota(scoped, businessId, "Africa/Lagos")).rejects.toThrow(QuotaExceededError);
  });
});

describe("assertWithinQuotaIfEnabled", () => {
  it("resolves to null (never throws) when the flag is off for the business, regardless of usage", async () => {
    const { businessId, scoped } = await makeBusiness("Flag Off Shop");
    await prisma.plan.upsert({
      where: { code: "TINY2" },
      update: {},
      create: { code: "TINY2", name: "Tiny 2", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 0, voiceEnabled: false },
    });
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "TINY2",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const result = await assertWithinQuotaIfEnabled(scoped, businessId, "Africa/Lagos");
    expect(result).toBeNull();
  });

  it("enforces the cap once the flag is enabled for the business", async () => {
    const { businessId, scoped } = await makeBusiness("Flag On Shop");
    await prisma.plan.upsert({
      where: { code: "TINY3" },
      update: {},
      create: { code: "TINY3", name: "Tiny 3", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 0, voiceEnabled: false },
    });
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "TINY3",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    await setFeatureFlagForBusiness(scoped, businessId, BILLING_QUOTA_FEATURE_FLAG_KEY, true);

    await expect(assertWithinQuotaIfEnabled(scoped, businessId, "Africa/Lagos")).rejects.toThrow(QuotaExceededError);
  });
});
