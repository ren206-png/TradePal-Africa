/**
 * All money in TradePal is an integer count of a currency's minor unit
 * (bigint), never a float — the only float-adjacent step is display
 * formatting, which happens here and nowhere else.
 */
export function sumMoney(amounts: readonly bigint[]): bigint {
  return amounts.reduce((total, amount) => total + amount, 0n);
}

export function formatMoney(amountMinor: bigint, minorUnitExp: number): string {
  if (minorUnitExp === 0) return amountMinor.toString();

  const divisor = 10n ** BigInt(minorUnitExp);
  const sign = amountMinor < 0n ? "-" : "";
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  const whole = absolute / divisor;
  const fraction = absolute % divisor;

  return `${sign}${whole}.${fraction.toString().padStart(minorUnitExp, "0")}`;
}

export class InvalidAmountError extends Error {}

/**
 * Parses a merchant-typed major-unit decimal string (e.g. "500", "500.50")
 * into minor-unit bigint, entirely via string manipulation — never via
 * `parseFloat`/`Number`, which would reintroduce float error for the exact
 * values this whole domain exists to avoid.
 */
export function parseAmountToMinorUnits(amountText: string, minorUnitExp: number): bigint {
  const trimmed = amountText.trim();
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new InvalidAmountError(`"${amountText}" is not a valid amount.`);
  }

  const wholePart = match[1] as string;
  const fractionPart = match[2] ?? "";
  if (fractionPart.length > minorUnitExp) {
    throw new InvalidAmountError(
      `"${amountText}" has more decimal places than this currency supports (${minorUnitExp}).`,
    );
  }

  const sign = wholePart.startsWith("-") ? -1n : 1n;
  const absoluteWhole = wholePart.startsWith("-") ? wholePart.slice(1) : wholePart;
  const paddedFraction = fractionPart.padEnd(minorUnitExp, "0");

  return sign * (BigInt(absoluteWhole) * 10n ** BigInt(minorUnitExp) + BigInt(paddedFraction || "0"));
}
