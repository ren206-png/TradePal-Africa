/**
 * Shop owners on a phone type "Today", "stok", "debst" or "Remind Amina" instead of the slash command, so
 * a few unambiguous commands are recognised without the "/" and with one slip of the finger: one missing,
 * extra, wrong or swapped letter (a Damerau-Levenshtein distance of 1).
 *
 * Deliberately narrow so it can never act on a guess that matters:
 *  - only a single word (or "remind <name>") is considered, never a sentence;
 *  - only read-only commands are typo-tolerant. "undo" reverses an entry, so it must be typed exactly;
 *  - very short words need an exact match (too easy to hit by accident).
 */
const EXACT_ONLY = new Set(["undo"]);
/** Single-word commands that take no arguments, mapped to the slash command they run. */
const TYPO_TOLERANT: ReadonlyArray<readonly [word: string, command: string]> = [
  ["today", "/today"],
  ["stock", "/stock"],
  ["lowstock", "/lowstock"],
  ["help", "/help"],
  ["debts", "/debts"],
  ["debt", "/debts"],
  ["owing", "/debts"],
  ["debtors", "/debts"],
];
/** Phrases that mean "who owes me"; matched exactly (after trimming trailing punctuation). */
const DEBT_PHRASES = new Set(["who owes me", "who owes"]);

/** Damerau-Levenshtein distance, capped: returns 2 as soon as it is known to exceed 1. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  if (a.length === b.length) {
    let first = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (first === -1) {
        first = i;
        continue;
      }
      // Second difference: only OK if it is exactly an adjacent swap.
      return first === i - 1 && a[first] === b[i] && a[i] === b[first] && a.slice(i + 1) === b.slice(i + 1);
    }
    return true; // exactly one substituted letter
  }

  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  return shorter.slice(i) === longer.slice(i + 1);
}

/** The slash command a bare message stands for, or null if it isn't one. */
export function matchBareCommand(text: string): string | null {
  const message = text.trim().toLowerCase().replace(/[?!.]+$/, "").trim();
  if (!message) return null;

  if (message === "undo") return "/undo";
  if (DEBT_PHRASES.has(message)) return "/debts";

  // "remind Amina" (also "remnd Amina"): the verb plus a name can't be a sale or an expense.
  const remind = /^(\S+)\s+(\S.*)$/.exec(message);
  if (remind && remind[1] && withinOneEdit(remind[1], "remind") && remind[1].length >= 5) {
    return `/remind ${text.trim().replace(/^\S+\s+/, "")}`;
  }

  if (!/^[a-z]+$/.test(message) || EXACT_ONLY.has(message)) return null;
  for (const [word, command] of TYPO_TOLERANT) {
    if (message === word) return command;
    if (word.length >= 5 && message.length >= 4 && withinOneEdit(message, word)) return command;
    // 4-letter words (help, debt) tolerate a missing, extra or swapped letter but not a wrong one ("held" is not "help").
    if (word.length === 4 && message.length >= 3 && message.length <= 5 && withinOneEdit(message, word) && !(message.length === 4 && !sameLetters(message, word))) {
      return command;
    }
  }
  return null;
}

function sameLetters(a: string, b: string): boolean {
  return [...a].sort().join("") === [...b].sort().join("");
}

// ---------------------------------------------------------------------------------------------------- commands with a name or an amount

/**
 * Commands that carry a name or an amount, typed without the slash: "paid Amina 300", "customer Amina", "add staff 0803...". The words must
 * be EXACT (no typo tolerance: these change records), the shape must match exactly, and a few are only read as a command when the data
 * agrees:
 *  - "paid <name> <amount>" is a debt payment ONLY when <name> is an existing customer who owes money; otherwise it is left to the normal
 *    reader ("paid transport 1500" is an expense, as before);
 *  - "customer <name>" only for an existing customer (looking someone up must not create them);
 *  - "debt <name> <amount>" is refused when the name contains words that make it a sentence ("debt collected from Amina 500").
 * A message that does not fit is NOT a command and goes to the normal reader. Voice notes are never read this way (a mis-heard word must not
 * change a record). The reply says how the message was read, so a wrong guess is visible at once.
 */
export interface BareArgsLookups {
  customerExists(name: string): Promise<boolean>;
  customerHasOpenDebt(name: string): Promise<boolean>;
}

export interface BareArgsMatch {
  /** The slash command to run. */
  command: string;
  /** Added under the reply so the person sees how the message was understood. */
  hint: string;
}

const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const PHONE = String.raw`\+?\d[\d ()-]{6,18}\d`;
const SENTENCE_WORDS = /\b(from|collected|received|repaid|owes|owed|paid|bought|sold|for|at|to)\b/i;
const amountOf = (a: string): string => a.replace(/,/g, "");
const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();

export async function matchBareCommandWithArgs(text: string, lookups: BareArgsLookups): Promise<BareArgsMatch | null> {
  const t = tidy(text).replace(/[.!?]+$/, "");
  if (!t || t.startsWith("/") || t.length > 160) return null;
  let m: RegExpExecArray | null;
  const out = (command: string, check?: string): BareArgsMatch => ({ command, hint: `(I read that as: ${command}.${check ? ` Not what you meant? Check with ${check}.` : ""})` });

  // read-only lookups
  if ((m = /^customer\s+(.+)$/i.exec(t))) {
    const name = m[1]!;
    if (new RegExp(`^(?:${AMOUNT})$`).test(name.split(" ").pop()!)) return null; // "customer paid 500" is a sentence
    return (await lookups.customerExists(name)) ? out(`/customer ${name}`) : null;
  }
  // debts
  if ((m = new RegExp(`^debt\\s+(.+?)\\s+(${AMOUNT})(\\s+due\\s+\\d{4}-\\d{2}-\\d{2})?$`, "i").exec(t))) {
    const name = m[1]!;
    if (SENTENCE_WORDS.test(name) || name.split(" ").length > 5) return null;
    return out(`/debt ${name} ${amountOf(m[2]!)}${m[3] ?? ""}`, `/customer ${name}`);
  }
  if ((m = new RegExp(`^paid\\s+(.+?)\\s+(${AMOUNT})$`, "i").exec(t))) {
    const name = m[1]!;
    return (await lookups.customerHasOpenDebt(name)) ? out(`/paid ${name} ${amountOf(m[2]!)}`, `/customer ${name}`) : null;
  }
  // staff (the command itself still checks that the sender is the owner)
  if ((m = new RegExp(`^add\\s*staff\\s+(${PHONE})$`, "i").exec(t))) return out(`/addstaff ${m[1]}`);
  if ((m = new RegExp(`^remove\\s*staff\\s+(${PHONE})$`, "i").exec(t))) return out(`/removestaff ${m[1]}`);
  // stock alert and prices
  if ((m = /^low\s*stock\s+(.+?)\s+(\d+|off)$/i.exec(t))) return out(`/lowstock ${m[1]} ${m[2]!.toLowerCase()}`);
  if ((m = new RegExp(`^set\\s*price\\s+(.+?)\\s+(${AMOUNT})$`, "i").exec(t))) return out(`/setprice ${m[1]} ${amountOf(m[2]!)}`);
  // payment links and requests
  if ((m = new RegExp(`^pay\\s*link\\s+(.+?)\\s+(${AMOUNT})$`, "i").exec(t))) return out(`/paylink ${m[1]} ${amountOf(m[2]!)}`);
  if ((m = new RegExp(`^collect\\s+(.+?)\\s+(${AMOUNT})\\s+(${PHONE})$`, "i").exec(t))) return out(`/collect ${m[1]} ${amountOf(m[2]!)} ${m[3]}`);
  // mobile-money matches, plans, deletion request, closing the day
  if ((m = /^(confirm|reject)\s*momo\s+(\S+)$/i.exec(t))) return out(`/${m[1]!.toLowerCase()}momo ${m[2]}`);
  if ((m = /^upgrade\s+([A-Za-z0-9_-]{2,30})$/i.exec(t))) return out(`/upgrade ${m[1]}`);
  if ((m = /^forget\s*customer\s+(.+)$/i.exec(t))) return out(`/forgetcustomer ${m[1]}`);
  if ((m = new RegExp(`^close\\s+(${AMOUNT})(\\s+.+)?$`, "i").exec(t))) return out(`/close ${amountOf(m[1]!)}${m[2] ?? ""}`);
  return null;
}

/** Words that stand alone for a command that takes nothing more. */
const PLAIN_WORDS: ReadonlyArray<readonly [string, string]> = [["usage", "/usage"], ["catalog", "/catalog"], ["products", "/products"]];
export function matchPlainWord(text: string): string | null {
  const w = text.trim().toLowerCase().replace(/[?!.]+$/, "").trim();
  return PLAIN_WORDS.find(([word]) => word === w)?.[1] ?? null;
}

/**
 * True for a single word one slipped letter away from "undo" ("udno", "undoo", "unto") but not "undo"
 * itself. These never run the undo, which reverses an entry and can't itself be reversed; the dispatcher
 * answers with UNDO_CONFIRM_REPLY so the owner can resend the exact word.
 */
export function isUndoTypo(text: string): boolean {
  const message = text.trim().toLowerCase().replace(/[?!.]+$/, "").trim();
  return /^[a-z]{3,5}$/.test(message) && message !== "undo" && withinOneEdit(message, "undo");
}

export const UNDO_CONFIRM_REPLY = 'Did you mean "undo"? To take back your last entry, send exactly: undo';
