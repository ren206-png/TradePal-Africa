import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  assignSubscription,
  BusinessNotFoundError,
  cancelActiveSubscription,
  CurrencyNotFoundError,
  InvalidSubscriptionPeriodError,
  listPlans,
  NoActiveSubscriptionError,
  PlanNotFoundError,
  PlanValidationError,
  upsertPlan,
} from "../src/domain/planAdmin.js";
import { getEffectivePlan } from "../src/domain/billing.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";

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
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

async function makeBusiness(name: string): Promise<string> {
  const business = await prisma.business.create({
    data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  return business.id;
}

describe("listPlans / upsertPlan", () => {
  it("creates a new plan and lists it", async () => {
    await upsertPlan(prisma, {
      code: "STARTER",
      name: "Starter",
      priceMinor: 250000n,
      currencyCode: "NGN",
      entryCapPerMonth: 500,
      voiceEnabled: false,
      staffCapCount: null,
    });

    const plans = await listPlans(prisma);
    const starter = plans.find((p) => p.code === "STARTER");
    expect(starter).toBeDefined();
    expect(starter?.priceMinor).toBe(250000n);
    expect(starter?.entryCapPerMonth).toBe(500);
  });

  it("updates an existing plan in place (matched by code) rather than creating a duplicate", async () => {
    await upsertPlan(prisma, {
      code: "STARTER",
      name: "Starter (updated)",
      priceMinor: 300000n,
      currencyCode: "NGN",
      entryCapPerMonth: 750,
      voiceEnabled: true,
      staffCapCount: 3,
    });

    const plans = await listPlans(prisma);
    const matches = plans.filter((p) => p.code === "STARTER");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Starter (updated)");
    expect(matches[0]?.priceMinor).toBe(300000n);
    expect(matches[0]?.voiceEnabled).toBe(true);
    expect(matches[0]?.staffCapCount).toBe(3);
  });

  it("rejects a negative priceMinor with PlanValidationError", async () => {
    await expect(
      upsertPlan(prisma, {
        code: "BAD",
        name: "Bad Plan",
        priceMinor: -1n,
        currencyCode: "NGN",
        entryCapPerMonth: 10,
        voiceEnabled: false,
        staffCapCount: null,
      }),
    ).rejects.toThrow(PlanValidationError);
  });

  it("rejects a currencyCode that doesn't exist with CurrencyNotFoundError", async () => {
    await expect(
      upsertPlan(prisma, {
        code: "BAD2",
        name: "Bad Plan 2",
        priceMinor: 100n,
        currencyCode: "DOES-NOT-EXIST",
        entryCapPerMonth: 10,
        voiceEnabled: false,
        staffCapCount: null,
      }),
    ).rejects.toThrow(CurrencyNotFoundError);
  });

  it("rejects a negative staffCapCount with PlanValidationError", async () => {
    await expect(
      upsertPlan(prisma, {
        code: "BAD3",
        name: "Bad Plan 3",
        priceMinor: 100n,
        currencyCode: "NGN",
        entryCapPerMonth: 10,
        voiceEnabled: false,
        staffCapCount: -1,
      }),
    ).rejects.toThrow(PlanValidationError);
  });
});

describe("assignSubscription", () => {
  it("assigns a business to a plan and makes it the effective plan", async () => {
    const businessId = await makeBusiness("Assign Shop");
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const subscription = await assignSubscription(prisma, {
      businessId,
      planCode: "STARTER",
      currentPeriodStart: now,
      currentPeriodEnd: end,
      reason: "Manual upgrade requested via support call.",
    });

    expect(subscription.planCode).toBe("STARTER");
    expect(subscription.status).toBe("ACTIVE");

    const scoped = getTenantScopedClient(prisma, businessId);
    const effective = await getEffectivePlan(scoped, businessId);
    expect(effective.code).toBe("STARTER");

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "Subscription", action: "SUBSCRIPTION_ASSIGNED" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("does not cancel a prior ACTIVE subscription — the newest one wins", async () => {
    const businessId = await makeBusiness("Reassign Shop");
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await assignSubscription(prisma, { businessId, planCode: "FREE", currentPeriodStart: now, currentPeriodEnd: end });
    await assignSubscription(prisma, { businessId, planCode: "STARTER", currentPeriodStart: now, currentPeriodEnd: end });

    const activeCount = await prisma.subscription.count({ where: { businessId, status: "ACTIVE" } });
    expect(activeCount).toBe(2); // both rows remain ACTIVE; getEffectivePlan resolves the newest one.

    const scoped = getTenantScopedClient(prisma, businessId);
    const effective = await getEffectivePlan(scoped, businessId);
    expect(effective.code).toBe("STARTER");
  });

  it("throws BusinessNotFoundError for an unknown businessId", async () => {
    const now = new Date();
    await expect(
      assignSubscription(prisma, {
        businessId: "does-not-exist",
        planCode: "STARTER",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 1000),
      }),
    ).rejects.toThrow(BusinessNotFoundError);
  });

  it("throws PlanNotFoundError for an unknown planCode", async () => {
    const businessId = await makeBusiness("Unknown Plan Shop");
    const now = new Date();
    await expect(
      assignSubscription(prisma, {
        businessId,
        planCode: "DOES-NOT-EXIST",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 1000),
      }),
    ).rejects.toThrow(PlanNotFoundError);
  });

  it("throws InvalidSubscriptionPeriodError when currentPeriodEnd is not after currentPeriodStart", async () => {
    const businessId = await makeBusiness("Bad Period Shop");
    const now = new Date();
    await expect(
      assignSubscription(prisma, {
        businessId,
        planCode: "STARTER",
        currentPeriodStart: now,
        currentPeriodEnd: now,
      }),
    ).rejects.toThrow(InvalidSubscriptionPeriodError);
  });
});

describe("cancelActiveSubscription", () => {
  it("cancels the current ACTIVE subscription and falls the business back to FREE", async () => {
    const businessId = await makeBusiness("Cancel Shop");
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await assignSubscription(prisma, { businessId, planCode: "STARTER", currentPeriodStart: now, currentPeriodEnd: end });

    const canceled = await cancelActiveSubscription(prisma, businessId, { reason: "Merchant churned." });
    expect(canceled.status).toBe("CANCELED");

    const scoped = getTenantScopedClient(prisma, businessId);
    const effective = await getEffectivePlan(scoped, businessId);
    expect(effective.code).toBe("FREE");

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "Subscription", action: "SUBSCRIPTION_CANCELED" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("throws NoActiveSubscriptionError when the business has no active subscription", async () => {
    const businessId = await makeBusiness("Never Subscribed Shop");
    await expect(cancelActiveSubscription(prisma, businessId)).rejects.toThrow(NoActiveSubscriptionError);
  });
});
