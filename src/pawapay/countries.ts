/**
 * Maps a TradePal business currency to the PawaPay country (ISO 3166-1 alpha-3) its mobile-money
 * collections run in. TradePal's own country list (config/countries.ts) is keyed by alpha-2, and
 * PawaPay's APIs by alpha-3 — and a business's currency already pins down its country, so this
 * keys off the currency the command layer has to hand.
 *
 * Guinea (GNF → GIN) is intentionally absent: Guinea isn't a supported TradePal country yet (see
 * the note in config/countries.ts), so no business can have GNF as its currency. Add the entry
 * here in the same change that adds Guinea there.
 */
const PAWAPAY_COUNTRY_BY_CURRENCY: Readonly<Record<string, { country: string; name: string }>> = {
  SLE: { country: "SLE", name: "Sierra Leone" },
  LRD: { country: "LBR", name: "Liberia" },
  GMD: { country: "GMB", name: "Gambia" },
};

/** The PawaPay country for a business currency, or undefined when PawaPay collection isn't offered for it. */
export function getPawaPayCountryForCurrency(currencyCode: string): { country: string; name: string } | undefined {
  return PAWAPAY_COUNTRY_BY_CURRENCY[currencyCode];
}
