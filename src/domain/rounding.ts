/**
 * Rounding and allocation rules (expansion invariant 4). All money is integer minor units; nothing here uses floats.
 *
 *  - Division rounds HALF AWAY FROM ZERO (the common retail convention): 2.5 -> 3, -2.5 -> -3.
 *  - A percentage is expressed in basis points (1% = 100 bps) and rounded once, on the amount it applies to.
 *  - Splitting an amount across lines (discounts, fees, payments) uses the LARGEST-REMAINDER method so the parts
 *    always add back to the total exactly; ties go to the earlier line. Order totals, invoice totals and payment
 *    allocations therefore cannot drift apart by a cent.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = (2n * n + denominator) / (2n * denominator); // floor(n/d + 1/2)
  return negative ? -q : q;
}

/** `bps` basis points of `amount`, rounded half away from zero. bps must be a non-negative integer. */
export function percentOfBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError("bps must be a non-negative integer");
  return divRoundHalfUp(amount * BigInt(bps), 10_000n);
}

/**
 * Splits `total` (>= 0) across `weights` (each >= 0, at least one > 0) proportionally. The result has the same
 * length as `weights` and sums to exactly `total`.
 */
export function allocateProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new RangeError("total must be non-negative");
  if (weights.some((w) => w < 0n)) throw new RangeError("weights must be non-negative");
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new RangeError("at least one weight must be positive");

  const base = weights.map((w) => (total * w) / sum);
  let leftover = total - base.reduce((a, b) => a + b, 0n);
  const remainders = weights
    .map((w, index) => ({ index, rem: (total * w) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  const out = [...base];
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    out[index] = out[index]! + 1n;
    leftover -= 1n;
  }
  return out;
}
