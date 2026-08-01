import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { LANGUAGE_NAMES, SUPPORTED_COUNTRIES } from "../src/config/countries.js";
import { startOnboarding } from "../src/onboarding/onboardingFlow.js";

let testDb: TestDb;
let prisma: PrismaClient;

async function runSeed(client: PrismaClient): Promise<void> {
  const languageCodes = new Set(SUPPORTED_COUNTRIES.map((c) => c.defaultLanguage));
  for (const code of languageCodes) {
    await client.language.upsert({ where: { code }, update: {}, create: { code, name: LANGUAGE_NAMES[code] ?? code } });
  }

  for (const country of SUPPORTED_COUNTRIES) {
    await client.currency.upsert({
      where: { code: country.currency.code },
      update: {},
      create: { code: country.currency.code, name: country.currency.name, minorUnitExp: country.currency.minorUnitExp },
    });

    await client.country.upsert({
      where: { code: country.code },
      update: {},
      create: {
        code: country.code,
        name: country.name,
        callingCode: country.callingCode,
        defaultCurrency: country.currency.code,
        defaultTimezone: country.defaultTimezone,
      },
    });

    await client.countryConfig.upsert({
      where: { countryCode: country.code },
      update: {},
      create: { countryCode: country.code, defaultLanguage: country.defaultLanguage, voiceEnabled: country.voiceEnabled },
    });
  }

  await client.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false },
  });
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("seed data", () => {
  it("seeds all six launch countries with matching currencies and country configs, idempotently", async () => {
    await runSeed(prisma);
    await runSeed(prisma); // must be safe to run twice (upsert, not create)

    const countries = await prisma.country.findMany();
    expect(countries).toHaveLength(6);
    expect(countries.map((c) => c.code).sort()).toEqual(["GH", "GM", "KE", "LR", "NG", "SL"]);

    const slConfig = await prisma.countryConfig.findUniqueOrThrow({ where: { countryCode: "SL" } });
    expect(slConfig.voiceEnabled).toBe(false);

    const ngConfig = await prisma.countryConfig.findUniqueOrThrow({ where: { countryCode: "NG" } });
    expect(ngConfig.voiceEnabled).toBe(true);

    const freePlan = await prisma.plan.findUniqueOrThrow({ where: { code: "FREE" } });
    expect(freePlan.priceMinor).toBe(0n);
  });

  it("seeded reference data is sufficient for onboarding to run end to end", async () => {
    const { merchant } = await startOnboarding(prisma, "233201234567");
    expect(merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");

    const business = await prisma.business.findUniqueOrThrow({ where: { id: merchant.businessId } });
    expect(business.countryCode).toBe("GH");
    expect(business.currencyCode).toBe("GHS");
  });
});
