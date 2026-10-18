import { InvalidAmountError, parseAmountToMinorUnits } from "../domain/money.js";

/**
 * Shop owners often write their day as a list instead of one entry per message:
 *
 *   Sale on 17/10/26
 *   Sneakers 2 pair =1200Sle
 *   T shirt 2 =500Sle
 *   Debt
 *   Manager =650Sle
 *
 * This reads that shape with plain, strict rules (no AI): a heading line picks the kind of entry
 * (Sale / Debt / Expense / Payment), and each following line is "<name> [qty] [=] <amount>[currency]".
 * Anything that doesn't fit is reported back untouched in `unreadable` rather than guessed at, and
 * a message only counts as a list when at least two lines are readable and there are three or more
 * lines, so ordinary multi-line prose still goes to the normal parser.
 */
export type ListSection = "SALE" | "DEBT" | "EXPENSE" | "PAYMENT";

export interface ListEntry {
  section: ListSection;
  /** Item name (sale), customer name (debt/payment) or description (expense). */
  name: string;
  quantity: number;
  /** For a sale line: price of one unit (total / quantity). */
  unitPriceMinor: bigint;
  /** The line's total in minor units. */
  amountMinor: bigint;
}

export interface ParsedList {
  entries: ListEntry[];
  /** Lines that looked like entries but couldn't be read (shown to the merchant verbatim). */
  unreadable: string[];
  /** A date written in the heading (e.g. "17/10/26"), if any. TradePal saves entries with today's date. */
  headingDate?: string;
}

const SECTION_WORDS: Array<[RegExp, ListSection]> = [
  [/^(sales?|sold|sale\s+on)\b/i, "SALE"],
  [/^(debts?|debtors?|credits?|owing|owes?)\b/i, "DEBT"],
  [/^(expenses?|spent|spending)\b/i, "EXPENSE"],
  [/^(payments?|paid|received)\b/i, "PAYMENT"],
];

export const MAX_LIST_ENTRIES = 40;

const DATE_PATTERN = /\b\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}\b/;
const ENTRY_PATTERN = /^(.*?)\s*[=:\-–]?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*([A-Za-z]{0,4})\s*$/;

/** A heading is a line that starts with a section word and carries no amount (a date is fine). */
function readHeading(line: string): { section: ListSection; date?: string } | null {
  if (line.includes("=") || line.split(/\s+/).length > 6) return null;
  const section = SECTION_WORDS.find(([pattern]) => pattern.test(line))?.[1];
  if (!section) return null;
  const date = DATE_PATTERN.exec(line)?.[0];
  const withoutDate = date ? line.replace(date, "") : line;
  if (/\d/.test(withoutDate)) return null;
  return date ? { section, date } : { section };
}

function readEntry(
  line: string,
  section: ListSection,
  currencyCode: string,
  minorUnitExp: number,
): ListEntry | null {
  const match = ENTRY_PATTERN.exec(line);
  if (!match) return null;

  const rawName = (match[1] ?? "").trim().replace(/[=:\-–]+$/, "").trim();
  const amountText = (match[2] ?? "").replace(/,/g, "");
  const currencyToken = (match[3] ?? "").toLowerCase();

  // A currency written after the amount must be this business's own code ("Sle", "SLE"); a short suffix
  // like "Le" or "kg" is tolerated, but any other 3-4 letter code (USD, NGN...) means a different
  // currency or unit, so the line is skipped rather than saved with the wrong meaning.
  if (currencyToken.length > 2 && currencyToken !== currencyCode.toLowerCase()) return null;
  if (!/[A-Za-z]/.test(rawName) || rawName.length > 60) return null;

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountToMinorUnits(amountText, minorUnitExp);
  } catch (error) {
    if (error instanceof InvalidAmountError) return null;
    throw error;
  }
  if (amountMinor <= 0n) return null;

  let name = rawName;
  let quantity = 1;
  if (section === "SALE") {
    // "Sneakers 2 pair" -> 2 x "Sneakers pair". Only when the total divides evenly by that quantity.
    const qtyMatch = /(^|\s)(\d{1,3})(?=\s|$)/.exec(rawName);
    const qty = qtyMatch ? Number(qtyMatch[2]) : 0;
    if (qtyMatch && qty > 0 && amountMinor % BigInt(qty) === 0n) {
      const stripped = rawName.replace(qtyMatch[0], " ").replace(/\s+/g, " ").trim();
      if (/[A-Za-z]/.test(stripped)) {
        name = stripped;
        quantity = qty;
      }
    }
  }

  return { section, name, quantity, unitPriceMinor: amountMinor / BigInt(quantity), amountMinor };
}

export function parseListMessage(
  text: string,
  options: { currencyCode: string; minorUnitExp: number },
): ParsedList | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 3 || lines.some((line) => line.startsWith("/"))) return null;

  let section: ListSection = "SALE";
  let headingDate: string | undefined;
  const entries: ListEntry[] = [];
  const unreadable: string[] = [];

  for (const line of lines) {
    const heading = readHeading(line);
    if (heading) {
      section = heading.section;
      if (heading.date && !headingDate) headingDate = heading.date;
      continue;
    }
    const entry = readEntry(line, section, options.currencyCode, options.minorUnitExp);
    if (entry) entries.push(entry);
    else unreadable.push(line);
  }

  // Cap a single list so one message can never write an unbounded number of ledger rows.
  if (entries.length < 2 || entries.length > MAX_LIST_ENTRIES) return null;
  return { entries, unreadable, ...(headingDate ? { headingDate } : {}) };
}
