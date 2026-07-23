import { describe, expect, it } from "vitest";
import { formatMoney, InvalidAmountError, parseAmountToMinorUnits, sumMoney } from "../src/domain/money.js";

describe("money", () => {
  it("sums bigint minor units without float error", () => {
    expect(sumMoney([1000n, 250n, 50n])).toBe(1300n);
    expect(sumMoney([])).toBe(0n);
  });

  it("formats a 2-decimal currency", () => {
    expect(formatMoney(150075n, 2)).toBe("1500.75");
    expect(formatMoney(5n, 2)).toBe("0.05");
    expect(formatMoney(-150075n, 2)).toBe("-1500.75");
  });

  it("formats a 0-decimal currency (e.g. TZS) without a decimal point", () => {
    expect(formatMoney(15000n, 0)).toBe("15000");
  });

  it("parses merchant-typed amounts into minor units without float error", () => {
    expect(parseAmountToMinorUnits("500", 2)).toBe(50000n);
    expect(parseAmountToMinorUnits("500.5", 2)).toBe(50050n);
    expect(parseAmountToMinorUnits("500.50", 2)).toBe(50050n);
    expect(parseAmountToMinorUnits("0.01", 2)).toBe(1n);
    expect(parseAmountToMinorUnits("15000", 0)).toBe(15000n);
    expect(parseAmountToMinorUnits("  250  ", 2)).toBe(25000n);
  });

  it("rejects malformed or over-precise amounts", () => {
    expect(() => parseAmountToMinorUnits("abc", 2)).toThrow(InvalidAmountError);
    expect(() => parseAmountToMinorUnits("500.123", 2)).toThrow(InvalidAmountError);
    expect(() => parseAmountToMinorUnits("", 2)).toThrow(InvalidAmountError);
    expect(() => parseAmountToMinorUnits("-500", 2)).not.toThrow();
  });
});
