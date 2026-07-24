import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";
import {
  continueOnboarding,
  findMerchantByPhoneNumber,
  isOnboardingComplete,
  startOnboarding,
  UnsupportedCountryError,
} from "../src/onboarding/onboardingFlow.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.createMany({
    data: [
      { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 },
      { code: "KES", name: "Kenyan Shilling", minorUnitExp: 2 },
    ],
  });
  await prisma.country.createMany({
    data: [
      { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
      { code: "KE", name: "Kenya", callingCode: "254", defaultCurrency: "KES", defaultTimezone: "Africa/Nairobi" },
    ],
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("startOnboarding", () => {
  it("infers the country from the phone number's calling code and creates a Business + Merchant", async () => {
    const { merchant, reply } = await startOnboarding(prisma, "2348012345678");

    expect(merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");
    expect(reply).toContain("Nigeria");

    const business = await prisma.business.findUniqueOrThrow({ where: { id: merchant.businessId } });
    expect(business.countryCode).toBe("NG");
    expect(business.currencyCode).toBe("NGN");
    expect(business.timezone).toBe("Africa/Lagos");
  });

  it("refuses to onboard a phone number from an unsupported country", async () => {
    await expect(startOnboarding(prisma, "19995551234")).rejects.toThrow(UnsupportedCountryError);
  });
});

describe("continueOnboarding", () => {
  it("walks a merchant through business name, consent, and adding a first customer to completion, logging both consent types", async () => {
    const started = await startOnboarding(prisma, "254712345678");
    expect(started.merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");

    const afterName = await continueOnboarding(prisma, started.merchant, "Amina's Provisions");
    expect(afterName.merchant.onboardingStep).toBe("AWAITING_CONSENT");
    expect(afterName.reply).toMatch(/YES/);

    const business = await prisma.business.findUniqueOrThrow({ where: { id: started.merchant.businessId } });
    expect(business.name).toBe("Amina's Provisions");

    const afterGarbage = await continueOnboarding(prisma, afterName.merchant, "maybe later");
    expect(afterGarbage.merchant.onboardingStep).toBe("AWAITING_CONSENT");

    const afterConsent = await continueOnboarding(prisma, afterGarbage.merchant, "yes");
    expect(afterConsent.merchant.onboardingStep).toBe("AWAITING_FIRST_CUSTOMER");
    expect(afterConsent.reply).toMatch(/first customer/i);
    expect(isOnboardingComplete(afterConsent.merchant)).toBe(false);

    const logs = await prisma.consentLog.findMany({ where: { merchantId: started.merchant.id } });
    expect(logs.map((l) => l.consentType).sort()).toEqual(["DATA_PROCESSING", "ONBOARDING_TERMS"]);

    const afterCustomer = await continueOnboarding(prisma, afterConsent.merchant, "Chinedu");
    expect(afterCustomer.merchant.onboardingStep).toBe("COMPLETE");
    expect(isOnboardingComplete(afterCustomer.merchant)).toBe(true);
    expect(afterCustomer.reply).toContain("Chinedu");

    const scoped = getTenantScopedClient(prisma, started.merchant.businessId);
    const customer = await scoped.customer.findFirst({ where: { name: "Chinedu" } });
    expect(customer).not.toBeNull();
  });

  it("lets a merchant skip adding a first customer and still reach completion", async () => {
    const started = await startOnboarding(prisma, "254711112222");
    const afterName = await continueOnboarding(prisma, started.merchant, "Bosco Traders");
    const afterConsent = await continueOnboarding(prisma, afterName.merchant, "yes");
    expect(afterConsent.merchant.onboardingStep).toBe("AWAITING_FIRST_CUSTOMER");

    const afterSkip = await continueOnboarding(prisma, afterConsent.merchant, "skip");
    expect(afterSkip.merchant.onboardingStep).toBe("COMPLETE");
    expect(isOnboardingComplete(afterSkip.merchant)).toBe(true);
    expect(afterSkip.reply).toMatch(/no problem/i);
  });

  it("re-prompts for a business name instead of accepting a blank reply", async () => {
    const started = await startOnboarding(prisma, "2347098765432");
    const afterBlank = await continueOnboarding(prisma, started.merchant, "   ");

    expect(afterBlank.merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");
  });

  it("re-prompts for a customer name instead of accepting a blank reply", async () => {
    const started = await startOnboarding(prisma, "254733334444");
    const afterName = await continueOnboarding(prisma, started.merchant, "Zawadi Shop");
    const afterConsent = await continueOnboarding(prisma, afterName.merchant, "yes");

    const afterBlank = await continueOnboarding(prisma, afterConsent.merchant, "   ");
    expect(afterBlank.merchant.onboardingStep).toBe("AWAITING_FIRST_CUSTOMER");
  });
});

describe("findMerchantByPhoneNumber", () => {
  it("finds a merchant created during onboarding by phone number", async () => {
    await startOnboarding(prisma, "2348055555555");
    const found = await findMerchantByPhoneNumber(prisma, "2348055555555");

    expect(found).not.toBeNull();
    expect(found?.phoneNumber).toBe("2348055555555");
  });

  it("returns null for a phone number that has never messaged in", async () => {
    const found = await findMerchantByPhoneNumber(prisma, "2340000000000");
    expect(found).toBeNull();
  });
});
