import { describe, expect, it } from "vitest";
import { computeRiskLabel } from "../src/domain/riskLabel.js";

const NOW = new Date("2026-07-08T00:00:00Z");

describe("computeRiskLabel", () => {
  it("is UNKNOWN when the customer has no debt history", () => {
    expect(computeRiskLabel([], NOW)).toBe("UNKNOWN");
  });

  it("is RISKY when any open or partially-paid debt is past its due date", () => {
    const debts = [
      { status: "OPEN" as const, dueDate: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") },
      { status: "PAID" as const, dueDate: new Date("2026-06-01"), updatedAt: new Date("2026-05-01") },
    ];
    expect(computeRiskLabel(debts, NOW)).toBe("RISKY");
  });

  it("is LATE_PAYER when a debt was paid after its due date and nothing is currently overdue", () => {
    const debts = [
      { status: "PAID" as const, dueDate: new Date("2026-01-01"), updatedAt: new Date("2026-01-15") },
    ];
    expect(computeRiskLabel(debts, NOW)).toBe("LATE_PAYER");
  });

  it("is GOOD_PAYER when all paid debts were paid on or before their due date", () => {
    const debts = [
      { status: "PAID" as const, dueDate: new Date("2026-01-15"), updatedAt: new Date("2026-01-01") },
      { status: "PAID" as const, dueDate: null, updatedAt: new Date("2026-02-01") },
    ];
    expect(computeRiskLabel(debts, NOW)).toBe("GOOD_PAYER");
  });

  it("is UNKNOWN when the only debts are open/not-yet-due, with no paid history yet", () => {
    const debts = [{ status: "OPEN" as const, dueDate: new Date("2026-12-01"), updatedAt: new Date("2026-07-01") }];
    expect(computeRiskLabel(debts, NOW)).toBe("UNKNOWN");
  });

  it("prioritizes RISKY over LATE_PAYER when both conditions hold", () => {
    const debts = [
      { status: "OPEN" as const, dueDate: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") },
      { status: "PAID" as const, dueDate: new Date("2026-02-01"), updatedAt: new Date("2026-03-01") },
    ];
    expect(computeRiskLabel(debts, NOW)).toBe("RISKY");
  });
});
