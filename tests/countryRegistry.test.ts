import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { LANGUAGE_NAMES, SUPPORTED_COUNTRIES } from "../src/config/countries.js";
import { STATIC_COUNTRY_REGISTRY, getCountryRegistry, loadCountryRegistryFromDb, resetCountryRegistryCacheForTests } from "../src/config/countryRegistry.js";
import { UnsupportedCountryError, startOnboarding } from "../src/onboarding/onboardingFlow.js";

let testDb: TestDb;
let prisma: PrismaClient;

/** Seeds the reference tables exactly as the static list describes them (what prisma/seed.ts and the migrations do). */
async function seedFromStatic(client: PrismaClient) {
  for (const code of new Set(SUPPORTED_COUNTRIES.map((c) => c.defaultLanguage))) {
    await client.language.upsert({ where: { code }, update: {}, create: { code, name: LANGUAGE_NAMES[code] ?? code } });
  }
  for (const c of SUPPORTED_COUNTRIES) {
    await client.currency.upsert({ where: { code: c.currency.code }, update: {}, create: { code: c.currency.code, name: c.currency.name, minorUnitExp: c.currency.minorUnitExp } });
    await client.country.upsert({
      where: { code: c.code },
      update: {},
      create: { code: c.code, name: c.name, callingCode: c.callingCode, defaultCurrency: c.currency.code, defaultTimezone: c.defaultTimezone },
    });
    await client.countryConfig.upsert({
      where: { countryCode: c.code },
      update: {},
      create: { countryCode: c.code, defaultLanguage: c.defaultLanguage, voiceEnabled: c.voiceEnabled },
    });
  }
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});
beforeEach(() => resetCountryRegistryCacheForTests());

describe("country registry", () => {
  it("falls back to the static list when the database has no country rows", async () => {
    const registry = await getCountryRegistry(prisma);
    expect(registry.source).toBe("static-fallback");
    expect(registry.all()).toBe(STATIC_COUNTRY_REGISTRY.all());
  });

  it("reads the database as the source of truth, and the seeded rows match the static list exactly (no drift)", async () => {
    await seedFromStatic(prisma);
    const registry = await loadCountryRegistryFromDb(prisma);
    expect(registry?.source).toBe("database");
    const byCode = (list: readonly { code: string }[]) => [...list].sort((a, b) => a.code.localeCompare(b.code));
    expect(byCode(registry!.all())).toEqual(byCode(SUPPORTED_COUNTRIES));
  });

  it("matches calling codes longest-first and by digits only", async () => {
    await seedFromStatic(prisma);
    const registry = (await loadCountryRegistryFromDb(prisma))!;
    expect(registry.byPhoneNumber("+232 76 123456")?.code).toBe("SL");
    expect(registry.byPhoneNumber("2348012345678")?.code).toBe("NG");
    expect(registry.byPhoneNumber("14155550100")).toBeUndefined();
    expect(registry.byCode("GH")?.currency.code).toBe("GHS");
  });

  it("skips a country that has no CountryConfig, so a half-configured row is never offered", async () => {
    await prisma.currency.upsert({ where: { code: "XAF" }, update: {}, create: { code: "XAF", name: "CFA franc", minorUnitExp: 0 } });
    await prisma.country.upsert({ where: { code: "CM" }, update: {}, create: { code: "CM", name: "Cameroon", callingCode: "237", defaultCurrency: "XAF", defaultTimezone: "Africa/Douala" } });
    const registry = (await loadCountryRegistryFromDb(prisma))!;
    expect(registry.byCode("CM")).toBeUndefined();
  });
});

describe("expansion is configuration, not code (decision G4)", () => {
  it("accepts signup from a country added only as database rows, and rejects it before", async () => {
    await seedFromStatic(prisma);
    const number = "6741234567"; // a calling code no code in this repo mentions

    await expect(startOnboarding(prisma, number)).rejects.toBeInstanceOf(UnsupportedCountryError);

    await prisma.currency.create({ data: { code: "NRD", name: "Nauruan Dollar", minorUnitExp: 2 } });
    await prisma.country.create({ data: { code: "NR", name: "Nauru", callingCode: "674", defaultCurrency: "NRD", defaultTimezone: "Pacific/Nauru" } });
    await prisma.countryConfig.create({ data: { countryCode: "NR", defaultLanguage: "en", voiceEnabled: false } });
    resetCountryRegistryCacheForTests(); // (production caches for 60s)

    const started = await startOnboarding(prisma, number);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: started.merchant.businessId } });
    expect(business).toMatchObject({ countryCode: "NR", currencyCode: "NRD", timezone: "Pacific/Nauru", languageCode: "en" });
    expect(started.reply).toContain("Nauru");
  });
});
