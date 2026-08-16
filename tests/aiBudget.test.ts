import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import {
  DEFAULT_AI_BUDGET_THRESHOLDS,
  evaluateAiBudget,
  isAiCallPermitted,
  isPremiumModelRestricted,
} from "../src/domain/aiBudget.js";

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
    update: { aiDeepseekMonthlyBudgetMicroUsd: null },
    create: {
      code: "FREE",
      name: "Free",
      priceMinor: 0n,
      currencyCode: "NGN",
      entryCapPerMonth: 100,
      voiceEnabled: false,
      aiDeepseekMonthlyBudgetMicroUsd: null,
    },
  });
  await prisma.plan.upsert({
    where: { code: "CAPPED" },
    update: { aiDeepseekMonthlyBudgetMicroUsd: 1_000_000n },
    create: {
      code: "CAPPED",
      name: "Capped",
      priceMinor: 500000n,
      currencyCode: "NGN",
      entryCapPerMonth: null,
      voiceEnabled: true,
      aiDeepseekMonthlyBudgetMicroUsd: 1_000_000n,
    },
  });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

async function makeBusiness(name: string, planCode?: string): Promise<{ businessId: string; scoped: TenantScopedClient }> {
  const business = await prisma.business.create({
    data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });

  if (planCode) {
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId: business.id,
        planCode,
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }

  return { businessId: business.id, scoped: getTenantScopedClient(prisma, business.id) };
}

/** Bypasses the two-phase reserve/commit cycle to seed a specific committed spend directly — this suite is testing evaluateAiBudget's math, not aiUsageLedger's own accounting (covered by aiUsageLedger.test.ts). */
async function seedCommittedSpend(scoped: TenantScopedClient, businessId: string, actualCostMicroUsd: bigint): Promise<void> {
  await scoped.aiUsageLedger.create({
    data: {
      requestId: crypto.randomUUID(),
      phase: "COMMIT",
      businessId,
      feature: "CATALOG_SUMMARY_DRAFT",
      provider: "DEEPSEEK",
      requestedModel: "deepseek-v4-flash-2026-06-snapshot",
      resolvedModel: "deepseek-v4-flash-2026-06-snapshot",
      actualCostMicroUsd,
      promptHash: "seed-hash",
      idempotencyKey: crypto.randomUUID(),
    },
  });
}

describe("evaluateAiBudget", () => {
  it("is always RECORD, with a null fractionUsed, for a business whose plan has no DeepSeek budget cap", async () => {
    const { businessId, scoped } = await makeBusiness("Uncapped Shop", "FREE");
    await seedCommittedSpend(scoped, businessId, 999_999_999n);

    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false);
    expect(evaluation.level).toBe("RECORD");
    expect(evaluation.budgetMicroUsd).toBeNull();
    expect(evaluation.fractionUsed).toBeNull();
  });

  it("falls back to the FREE (uncapped) plan for a business with no Subscription row", async () => {
    const { businessId, scoped } = await makeBusiness("No Subscription Budget Shop");
    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false);
    expect(evaluation.budgetMicroUsd).toBeNull();
    expect(evaluation.level).toBe("RECORD");
  });

  it("stays RECORD below the warn threshold", async () => {
    const { businessId, scoped } = await makeBusiness("Below Warn Shop", "CAPPED");
    await seedCommittedSpend(scoped, businessId, 100_000n); // 10% of 1,000,000

    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false);
    expect(evaluation.level).toBe("RECORD");
    expect(evaluation.fractionUsed).toBeCloseTo(0.1);
  });

  it("reaches WARN at the configured warn fraction", async () => {
    const { businessId, scoped } = await makeBusiness("Warn Shop", "CAPPED");
    await seedCommittedSpend(scoped, businessId, 600_000n); // 60% of 1,000,000, past the 50% default warn threshold

    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false);
    expect(evaluation.level).toBe("WARN");
  });

  it("reaches ALERT at the configured alert fraction", async () => {
    const { businessId, scoped } = await makeBusiness("Alert Shop", "CAPPED");
    await seedCommittedSpend(scoped, businessId, 800_000n); // 80%, past the 75% default alert threshold

    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false);
    expect(evaluation.level).toBe("ALERT");
  });

  it("reaches RESTRICT_PREMIUM at the configured restrict-premium fraction", async () => {
    const { businessId, scoped } = await makeBusiness("Restrict Premium Shop", "CAPPED");
    await seedCommittedSpend(scoped, businessId, 950_000n); // 95%, past the 90% default restrict-premium threshold

    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false);
    expect(evaluation.level).toBe("RESTRICT_PREMIUM");
  });

  it("reaches BLOCK_OPTIONAL_AI once the budget is fully consumed", async () => {
    const { businessId, scoped } = await makeBusiness("Block Optional AI Shop", "CAPPED");
    await seedCommittedSpend(scoped, businessId, 1_100_000n); // 110%, past the 100% default block threshold

    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false);
    expect(evaluation.level).toBe("BLOCK_OPTIONAL_AI");
  });

  it("honors custom thresholds when supplied", async () => {
    const { businessId, scoped } = await makeBusiness("Custom Thresholds Shop", "CAPPED");
    await seedCommittedSpend(scoped, businessId, 200_000n); // 20%

    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", false, new Date(), {
      warnAtFraction: 0.1,
      alertAtFraction: 0.3,
      restrictPremiumAtFraction: 0.6,
      blockOptionalAiAtFraction: 0.9,
    });
    expect(evaluation.level).toBe("WARN"); // 20% is past the custom 10% warn threshold but below the custom 30% alert threshold
  });

  it("echoes back the enforcementEnabled flag it was called with", async () => {
    const { businessId, scoped } = await makeBusiness("Enforcement Echo Shop", "CAPPED");
    const evaluation = await evaluateAiBudget(scoped, businessId, "Africa/Lagos", true);
    expect(evaluation.enforcementEnabled).toBe(true);
  });
});

describe("isAiCallPermitted / isPremiumModelRestricted — record-only mode never blocks", () => {
  it("permits an optional call at BLOCK_OPTIONAL_AI level when enforcement is disabled", () => {
    const evaluation = {
      level: "BLOCK_OPTIONAL_AI" as const,
      budgetMicroUsd: 1_000_000n,
      usedMicroUsd: 2_000_000n,
      fractionUsed: 2,
      enforcementEnabled: false,
    };
    expect(isAiCallPermitted(evaluation, true)).toBe(true);
    expect(isPremiumModelRestricted(evaluation)).toBe(false);
  });

  it("blocks an optional call at BLOCK_OPTIONAL_AI level once enforcement is enabled, but still permits a non-optional call", () => {
    const evaluation = {
      level: "BLOCK_OPTIONAL_AI" as const,
      budgetMicroUsd: 1_000_000n,
      usedMicroUsd: 2_000_000n,
      fractionUsed: 2,
      enforcementEnabled: true,
    };
    expect(isAiCallPermitted(evaluation, true)).toBe(false);
    expect(isAiCallPermitted(evaluation, false)).toBe(true);
  });

  it("restricts premium models at RESTRICT_PREMIUM level once enforcement is enabled", () => {
    const evaluation = {
      level: "RESTRICT_PREMIUM" as const,
      budgetMicroUsd: 1_000_000n,
      usedMicroUsd: 950_000n,
      fractionUsed: 0.95,
      enforcementEnabled: true,
    };
    expect(isPremiumModelRestricted(evaluation)).toBe(true);
    expect(isAiCallPermitted(evaluation, true)).toBe(true); // RESTRICT_PREMIUM never blocks outright, only downgrades model choice
  });

  it("does not restrict premium models below RESTRICT_PREMIUM, even with enforcement enabled", () => {
    const evaluation = {
      level: "WARN" as const,
      budgetMicroUsd: 1_000_000n,
      usedMicroUsd: 600_000n,
      fractionUsed: 0.6,
      enforcementEnabled: true,
    };
    expect(isPremiumModelRestricted(evaluation)).toBe(false);
  });
});

describe("DEFAULT_AI_BUDGET_THRESHOLDS", () => {
  it("is strictly ascending", () => {
    const t = DEFAULT_AI_BUDGET_THRESHOLDS;
    expect(t.warnAtFraction).toBeLessThan(t.alertAtFraction);
    expect(t.alertAtFraction).toBeLessThan(t.restrictPremiumAtFraction);
    expect(t.restrictPremiumAtFraction).toBeLessThan(t.blockOptionalAiAtFraction);
  });
});
