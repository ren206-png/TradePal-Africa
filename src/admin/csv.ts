/**
 * Formula-safe CSV (expansion §18). Spreadsheet programs execute a cell that begins with = + - @ (or a tab/CR) as a
 * formula, which turns an exported merchant note into an attack on whoever opens the file. Every free-text cell that
 * starts with one of those is prefixed with an apostrophe so it is treated as text. Columns known to be pure
 * integers are passed through `csvNumber`, which refuses anything else, so a legitimate negative amount stays a number.
 */
const DANGEROUS_START = /^[=+\-@\t\r]/;

export function csvText(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Leading whitespace can hide the trigger character from a human reviewer but not from the spreadsheet.
  if (DANGEROUS_START.test(text.trimStart()) || DANGEROUS_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

export function csvNumber(value: bigint | number | string): string {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error(`csvNumber: not an integer: ${text.slice(0, 20)}`);
  return text;
}

export function csvRow(cells: string[]): string {
  return cells.join(",");
}
