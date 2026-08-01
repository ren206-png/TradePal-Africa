export interface CountryDefinition {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  callingCode: string;
  currency: { code: string; name: string; minorUnitExp: number };
  defaultTimezone: string; // IANA
  defaultLanguage: string;
  /** Krio (SL), Sheng (KE), Nigerian Pidgin (NG), and Twi (GH) are all weak-to-unsupported by
   * general ASR vendors (PHASE_0_FINDINGS KQ4/ADR-3). Only Sierra Leone is fully gated off at
   * MVP since no vendor has any confirmed Krio support at all; the other three ship with voice
   * enabled but explicit low-confidence-expected handling.
   *
   * Liberia (Liberian Kreyol/English) and Gambia (Gambian English/Wolof) have NOT had the
   * equivalent per-country ASR vendor check done — unlike the original four, there's no
   * PHASE_0_FINDINGS entry backing a voiceEnabled=true call for them. Defaulted to false
   * (text-first, same precautionary treatment as Sierra Leone) until that research happens;
   * flip individually once a vendor's support is actually confirmed. */
  voiceEnabled: boolean;
}

export const SUPPORTED_COUNTRIES: readonly CountryDefinition[] = [
  {
    code: "NG",
    name: "Nigeria",
    callingCode: "234",
    currency: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 },
    defaultTimezone: "Africa/Lagos",
    defaultLanguage: "en",
    voiceEnabled: true,
  },
  {
    code: "KE",
    name: "Kenya",
    callingCode: "254",
    currency: { code: "KES", name: "Kenyan Shilling", minorUnitExp: 2 },
    defaultTimezone: "Africa/Nairobi",
    defaultLanguage: "en",
    voiceEnabled: true,
  },
  {
    code: "SL",
    name: "Sierra Leone",
    callingCode: "232",
    currency: { code: "SLE", name: "Sierra Leonean Leone", minorUnitExp: 2 },
    defaultTimezone: "Africa/Freetown",
    defaultLanguage: "en",
    voiceEnabled: false,
  },
  {
    code: "GH",
    name: "Ghana",
    callingCode: "233",
    currency: { code: "GHS", name: "Ghanaian Cedi", minorUnitExp: 2 },
    defaultTimezone: "Africa/Accra",
    defaultLanguage: "en",
    voiceEnabled: true,
  },
  // Mano River Union expansion (mobile-money outreach targets): Liberia and Gambia.
  // Guinea was also an outreach target but is deliberately NOT added yet — held back pending
  // further review (its GNF currency and French defaultLanguage are the odd ones out among all
  // other supported countries here); add it as its own follow-up once that's resolved.
  {
    code: "LR",
    name: "Liberia",
    callingCode: "231",
    currency: { code: "LRD", name: "Liberian Dollar", minorUnitExp: 2 },
    defaultTimezone: "Africa/Monrovia",
    defaultLanguage: "en",
    voiceEnabled: false,
  },
  {
    code: "GM",
    name: "Gambia",
    callingCode: "220",
    currency: { code: "GMD", name: "Gambian Dalasi", minorUnitExp: 2 },
    defaultTimezone: "Africa/Banjul",
    defaultLanguage: "en",
    voiceEnabled: false,
  },
];

/**
 * Every `defaultLanguage` code used by SUPPORTED_COUNTRIES needs a matching Language row
 * (CountryConfig.defaultLanguage is a foreign key to Language.code — see schema.prisma). Kept
 * here, next to SUPPORTED_COUNTRIES itself, as the single source of truth every seed script
 * (prisma/seed.ts and its test-DB equivalents) reads names from, rather than each duplicating
 * its own code->name map that could silently drift out of sync with a newly added country.
 */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
};

const BY_CODE = new Map(SUPPORTED_COUNTRIES.map((c) => [c.code, c]));

// Sorted longest-first so a calling code that's a prefix of another (none currently, but
// defensive) can't cause a wrong match.
const BY_CALLING_CODE = [...SUPPORTED_COUNTRIES].sort((a, b) => b.callingCode.length - a.callingCode.length);

export function getCountryByCode(code: string): CountryDefinition | undefined {
  return BY_CODE.get(code);
}

/** Infers country from a WhatsApp phone number's leading digits (no `+`), e.g. "2348012345678" -> Nigeria. */
export function getCountryByPhoneNumber(phoneNumber: string): CountryDefinition | undefined {
  const digitsOnly = phoneNumber.replace(/\D/g, "");
  return BY_CALLING_CODE.find((c) => digitsOnly.startsWith(c.callingCode));
}
