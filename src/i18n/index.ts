import { CATALOG, type CatalogKey } from "./catalog.js";
import { LOCALES, SOURCE_LOCALE, isServable, localeInfo } from "./locales.js";

export { CATALOG, type CatalogKey } from "./catalog.js";
export { LOCALES, SOURCE_LOCALE, localeInfo, type LocaleInfo, type LocaleStatus } from "./locales.js";

export interface Translated {
  text: string;
  /** The locale actually used. */
  locale: string;
  /** True when the requested locale could not be served and English was used instead. */
  fallbackUsed: boolean;
}

/**
 * Looks a string up for a locale. A translation is served only when its locale is human-reviewed (or the source language)
 * AND that exact key has a reviewed translation; anything else falls back to English and reports it. `{name}` placeholders
 * are filled from `params`; a missing parameter throws (a message with a hole in it must never reach a person).
 */
export function t(key: CatalogKey, params: Record<string, string | number> = {}, locale: string = SOURCE_LOCALE): Translated {
  const entry = CATALOG[key];
  const info = localeInfo(locale);
  let raw: string = entry.en;
  let used: string = SOURCE_LOCALE;
  if (locale !== SOURCE_LOCALE && info && isServable(info.status)) {
    const translated = entry.translations?.[locale];
    if (translated && translated.reviewedBy) {
      raw = translated.text;
      used = locale;
    }
  }
  const text = raw.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`i18n: message '${key}' needs parameter '${name}'`);
    return String(value);
  });
  return { text, locale: used, fallbackUsed: used !== locale };
}

export interface LocaleCoverage {
  code: string;
  name: string;
  status: string;
  /** Catalog entries with a human-reviewed translation in this locale. */
  keysServed: number;
  keysTotal: number;
  /**
   * What this number does NOT say: whether the text reads naturally, whether people understand it, or whether the messages
   * work for them. Key coverage is a count, not a measure of comprehension. Nothing here is measured with users.
   */
  caveat: string;
}

export function localeCoverage(): LocaleCoverage[] {
  const keys = Object.keys(CATALOG) as CatalogKey[];
  return LOCALES.map((l) => ({
    code: l.code,
    name: l.name,
    status: l.status,
    keysServed: l.code === SOURCE_LOCALE ? keys.length : keys.filter((k) => isServable(l.status) && CATALOG[k].translations?.[l.code]?.reviewedBy).length,
    keysTotal: keys.length,
    caveat: "Key count only. Comprehension and quality are not measured.",
  }));
}
