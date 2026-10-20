/**
 * Locale registry (expansion Phase 7). A locale is listed here so the framework knows it is wanted, NOT because any text
 * exists for it. Nothing in this file is a translation.
 *
 * Coverage statuses:
 *  - SOURCE          the language the catalog is written in.
 *  - HUMAN_REVIEWED  every served string was written or approved by a named human reviewer.
 *  - UNREVIEWED      strings exist but nobody qualified has approved them; they are NEVER served.
 *  - MISSING         no strings exist. Requests fall back to English and say so.
 *
 * Krio and other dialects are deliberately MISSING: no string for them may be invented, machine-translated or guessed. They
 * are added only when a person who speaks the language supplies and reviews the text.
 */
export type LocaleStatus = "SOURCE" | "HUMAN_REVIEWED" | "UNREVIEWED" | "MISSING";

export interface LocaleInfo {
  code: string;
  name: string;
  status: LocaleStatus;
  note: string;
}

export const SOURCE_LOCALE = "en";

export const LOCALES: readonly LocaleInfo[] = [
  { code: "en", name: "English", status: "SOURCE", note: "Source language of the catalog." },
  { code: "fr", name: "French", status: "MISSING", note: "Wanted for francophone launch countries. No text yet; needs a reviewer." },
  { code: "kri", name: "Krio", status: "MISSING", note: "Wanted for Sierra Leone. Not translated and never machine-translated; needs a Krio-speaking reviewer." },
];

export function localeInfo(code: string): LocaleInfo | undefined {
  return LOCALES.find((l) => l.code === code);
}

/** Whether strings of this locale may be shown to a person. */
export function isServable(status: LocaleStatus): boolean {
  return status === "SOURCE" || status === "HUMAN_REVIEWED";
}
