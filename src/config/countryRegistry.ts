import type { PrismaClient } from "@prisma/client";
import { SUPPORTED_COUNTRIES, type CountryDefinition } from "./countries.js";

/**
 * Country configuration as DATA (expansion decision G4: country expansion is configuration, not hard-coded
 * branches). The database tables Country / Currency / CountryConfig are the source of truth for which countries
 * TradePal serves; the static list in countries.ts is the seed and the fallback for an empty or unreachable
 * database, so a fresh environment still boots. Adding a country is: insert its rows (a migration or an admin
 * action), no code change, no deploy. A drift test keeps the static list and the seeded rows identical.
 */
export interface CountryRegistry {
  all(): readonly CountryDefinition[];
  byCode(code: string): CountryDefinition | undefined;
  /** Country whose calling code is a prefix of the digits (longest code wins). */
  byPhoneNumber(phoneNumber: string): CountryDefinition | undefined;
  readonly source: "database" | "static-fallback";
}

function buildRegistry(countries: readonly CountryDefinition[], source: CountryRegistry["source"]): CountryRegistry {
  const byCode = new Map(countries.map((c) => [c.code, c]));
  const byLongestCallingCode = [...countries].sort((a, b) => b.callingCode.length - a.callingCode.length);
  return {
    source,
    all: () => countries,
    byCode: (code) => byCode.get(code),
    byPhoneNumber: (phoneNumber) => {
      const digits = phoneNumber.replace(/\D/g, "");
      return byLongestCallingCode.find((c) => digits.startsWith(c.callingCode));
    },
  };
}

export const STATIC_COUNTRY_REGISTRY: CountryRegistry = buildRegistry(SUPPORTED_COUNTRIES, "static-fallback");

/** Reads the registry straight from the database. Rows without a CountryConfig are not "supported" and are skipped. */
export async function loadCountryRegistryFromDb(prisma: PrismaClient): Promise<CountryRegistry | null> {
  const rows = await prisma.country.findMany({
    include: { currency: true, countryConfig: true },
    orderBy: { code: "asc" },
  });
  const countries: CountryDefinition[] = [];
  for (const row of rows) {
    const config = row.countryConfig[0];
    if (!config) continue;
    countries.push({
      code: row.code,
      name: row.name,
      callingCode: row.callingCode,
      currency: { code: row.currency.code, name: row.currency.name, minorUnitExp: row.currency.minorUnitExp },
      defaultTimezone: row.defaultTimezone,
      defaultLanguage: config.defaultLanguage,
      voiceEnabled: config.voiceEnabled,
    });
  }
  return countries.length > 0 ? buildRegistry(countries, "database") : null;
}

const CACHE_TTL_MS = 60_000;
let cached: { at: number; registry: CountryRegistry } | undefined;

export function resetCountryRegistryCacheForTests(): void {
  cached = undefined;
}

/** The registry in use: database rows when present (cached for a minute), else the static fallback. Never throws. */
export async function getCountryRegistry(prisma: PrismaClient, now: number = Date.now()): Promise<CountryRegistry> {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.registry;
  let registry: CountryRegistry | null = null;
  try {
    registry = await loadCountryRegistryFromDb(prisma);
  } catch (error) {
    console.error("country registry: database read failed, using the static fallback:", error instanceof Error ? error.message : error);
  }
  const chosen = registry ?? STATIC_COUNTRY_REGISTRY;
  cached = { at: now, registry: chosen };
  return chosen;
}
