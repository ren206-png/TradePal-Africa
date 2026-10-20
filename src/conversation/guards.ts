import type { LoggableParsedIntent } from "../ai/applyParsedIntent.js";
import { formatMoney } from "../domain/money.js";

/**
 * Deterministic checks on what a person typed (or what a transcript says) and on what the model made of it. None of this calls a
 * model: the point is that the model cannot talk its way past these rules. Treat the raw text, the transcript and the parse as
 * untrusted data.
 */
export type RiskReason = "INJECTION" | "LARGE_AMOUNT" | "AMOUNT_NOT_IN_MESSAGE" | "PACK_UNIT" | "NEW_ITEM";

export interface RiskAssessment {
  reasons: RiskReason[];
  /** A bare YES is not enough: the person must type a code that appears only in the preview. */
  needsCode: boolean;
  /** The message names a currency or denomination other than the business's own (or an old/new one). Nothing is proposed; the person is asked to re-send. */
  currencyAmbiguous: boolean;
  currencyMentioned: string | null;
}

const INJECTION: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+|your\s+|previous\s+|prior\s+|above\s+)+(instructions?|rules?|prompts?)/i,
  /disregard\s+(all\s+|the\s+|your\s+|previous\s+)*(instructions?|rules?)/i,
  /\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\bdeveloper\s+mode\b|\bjailbreak\b/i,
  /\bas\s+an\s+ai\b/i,
  /\b(drop|truncate|delete\s+from|insert\s+into|update)\s+(table\s+)?["'`]?\w+["'`]?\s*(;|where|set|values)/i,
  /;\s*(drop|delete|update|insert|select)\b/i,
  /<\s*\/?\s*(script|iframe|system|assistant)\b/i,
  /\bconfirm\s+(it\s+|this\s+)?(automatically|for\s+me)\b|\bauto[-\s]?confirm\b|\bwithout\s+(asking|confirmation)\b/i,
  /\b(reply|respond|answer)\s+(with\s+)?["']?yes["']?\s+(for|on\s+behalf)/i,
  /\b(mark|set)\b.{0,30}\b(paid|confirmed|approved)\b.{0,30}\b(without|regardless)\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

const SYMBOL_CODES: [RegExp, string][] = [
  [/\bUS\$|\$/, "USD"], [/€/, "EUR"], [/£/, "GBP"], [/₦/, "NGN"],
];
const WORD_CODES: [RegExp, string][] = [
  [/\b(usd|dollars?|bucks)\b/i, "USD"], [/\b(eur|euros?)\b/i, "EUR"], [/\b(gbp|pounds?|sterling)\b/i, "GBP"],
  [/\b(ngn|naira)\b/i, "NGN"], [/\b(ghs|cedis?)\b/i, "GHS"], [/\b(kes|shillings?|bob)\b/i, "KES"],
  [/\b(xof|xaf|cfa|francs?)\b/i, "XOF"], [/\bsll\b/i, "SLL"], [/\bsle\b/i, "SLE"],
];

/**
 * Finds a currency or denomination in the message that is not the business's own. "Old leones" / "SLL" are always flagged: we do
 * NOT convert between old and new denominations here (the factor and the date belong to the central bank, and a wrong guess moves
 * 1000x), we ask the person to write the amount again in the business currency.
 */
export function detectCurrencyConflict(text: string, businessCurrency: string): string | null {
  const found = new Set<string>();
  for (const [re, code] of SYMBOL_CODES) if (re.test(text)) found.add(code);
  for (const [re, code] of WORD_CODES) if (re.test(text)) found.add(code);
  if (/\bold\s+(le\b|leones?|money|notes?)|\b(le|leones?)\s+old\b|\bold\s+and\s+new\b|\bnew\s+and\s+old\b/i.test(text)) found.add("SLL");
  for (const code of found) if (code !== businessCurrency) return code;
  return null;
}

const MULT: Record<string, number> = { k: 1_000, thousand: 1_000, m: 1_000_000, million: 1_000_000 };
/** Whole-unit values the message states as digits (with commas, decimals, k / m / thousand / million). */
export function numbersInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/gi)) {
    const base = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    out.push(base * (m[2] ? MULT[m[2].toLowerCase()]! : 1));
  }
  return out;
}

const PACK_WORDS = /\b(cartons?|bags?|dozens?|crates?|boxes|box|packs?|sacks?|bundles?|trays?)\b/i;

export function itemNamesOf(parsed: LoggableParsedIntent): string[] {
  if (parsed.intent === "STOCK_ADJUSTMENT") return [parsed.itemName];
  if (parsed.intent === "SALE" || parsed.intent === "PURCHASE") return (parsed.items ?? []).map((i) => i.itemName);
  return [];
}

export function amountMinorOf(parsed: LoggableParsedIntent): bigint | null {
  return parsed.intent === "STOCK_ADJUSTMENT" ? null : BigInt(parsed.amountMinor);
}

export interface RiskInput {
  rawText: string;
  parsed: LoggableParsedIntent;
  businessCurrency: string;
  minorUnitExp: number;
  /** Largest amount recorded so far and how many entries exist. */
  history: { largestMinor: bigint | null; count: number };
  /** Lower-cased names of the stock items the business already has; present only when stock tracking is on. */
  knownItems?: Set<string>;
}

const ABSOLUTE_LARGE_MAJOR = 1_000_000n;

export function assessRisk(input: RiskInput): RiskAssessment {
  const { rawText, parsed } = input;
  const reasons: RiskReason[] = [];
  const names = itemNamesOf(parsed);

  if (looksLikeInjection(rawText) || names.some(looksLikeInjection) || ("customerName" in parsed && looksLikeInjection(parsed.customerName ?? "")) || ("description" in parsed && looksLikeInjection(parsed.description ?? ""))) {
    reasons.push("INJECTION");
  }

  const amount = amountMinorOf(parsed);
  if (amount !== null) {
    const unit = 10n ** BigInt(input.minorUnitExp);
    const big = input.history.count >= 5 && input.history.largestMinor !== null ? amount > input.history.largestMinor * 10n : amount >= ABSOLUTE_LARGE_MAJOR * unit;
    if (big) reasons.push("LARGE_AMOUNT");
    // The model must not invent an amount: when the message has digits and the amount is stated outright (no itemised lines), one of them has to match.
    const hasItems = (parsed.intent === "SALE" || parsed.intent === "PURCHASE") && (parsed.items?.length ?? 0) > 0;
    const nums = numbersInText(rawText);
    if (!hasItems && nums.length > 0) {
      const major = Number(amount) / Number(unit);
      if (!nums.some((n) => Math.abs(n - major) < 0.005)) reasons.push("AMOUNT_NOT_IN_MESSAGE");
    }
  } else if (parsed.intent === "STOCK_ADJUSTMENT" && Math.abs(parsed.quantityDelta) > 1000) {
    reasons.push("LARGE_AMOUNT");
  }

  if (names.some((n) => PACK_WORDS.test(n)) || (parsed.intent === "SALE" || parsed.intent === "PURCHASE" ? PACK_WORDS.test(rawText) && (parsed.items?.length ?? 0) > 0 : false)) reasons.push("PACK_UNIT");
  if (input.knownItems && names.some((n) => !input.knownItems!.has(n.trim().toLowerCase()))) reasons.push("NEW_ITEM");

  const currencyMentioned = detectCurrencyConflict(rawText, input.businessCurrency);
  const needsCode = reasons.includes("INJECTION") || reasons.includes("LARGE_AMOUNT") || reasons.includes("AMOUNT_NOT_IN_MESSAGE");
  return { reasons, needsCode, currencyAmbiguous: currencyMentioned !== null, currencyMentioned };
}

/** Items that match the typed name loosely but not exactly, when there are two or more of them. */
export function findAmbiguousItem(names: string[], known: string[]): { typed: string; candidates: string[] } | null {
  const lower = new Map(known.map((k) => [k.toLowerCase(), k]));
  for (const typed of names) {
    const t = typed.trim().toLowerCase();
    if (lower.has(t)) continue;
    const candidates = known.filter((k) => k.toLowerCase().includes(t) || t.includes(k.toLowerCase()));
    if (candidates.length >= 2) return { typed, candidates: candidates.slice(0, 5) };
  }
  return null;
}

/** One line a person can check. Amounts come from the structured parse, never from the model's prose. */
export function summarise(parsed: LoggableParsedIntent, currency: string, exp: number): string {
  const money = (n: number) => `${formatMoney(BigInt(n), exp)} ${currency}`;
  switch (parsed.intent) {
    case "SALE": {
      const lines = parsed.items?.length ? ` (${parsed.items.map((i) => `${i.quantity} x ${i.itemName} at ${money(i.unitPriceMinor)}`).join(", ")})` : "";
      return `Sale of ${money(parsed.amountMinor)}${lines}, ${parsed.paymentStatus === "PAID" ? "paid" : parsed.paymentStatus === "CREDIT" ? "on credit" : "part-paid"}${parsed.customerName ? ` - ${parsed.customerName}` : ""}`;
    }
    case "PURCHASE": {
      const lines = parsed.items?.length ? ` (${parsed.items.map((i) => `${i.quantity} x ${i.itemName} at ${money(i.unitPriceMinor)}`).join(", ")})` : "";
      return `Purchase of ${money(parsed.amountMinor)}${lines}${parsed.supplierName ? ` from ${parsed.supplierName}` : ""}`;
    }
    case "EXPENSE": return `Expense of ${money(parsed.amountMinor)}${parsed.description ? ` - ${parsed.description}` : ""}`;
    case "PAYMENT_RECEIVED": return `Payment received: ${money(parsed.amountMinor)} from ${parsed.customerName}`;
    case "DEBT_NOTE": return `Debt note: ${parsed.customerName} owes ${money(parsed.amountMinor)}`;
    case "STOCK_ADJUSTMENT": return `Stock change: ${parsed.quantityDelta >= 0 ? "+" : ""}${parsed.quantityDelta} ${parsed.itemName}`;
  }
}
