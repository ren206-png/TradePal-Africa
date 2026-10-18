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
