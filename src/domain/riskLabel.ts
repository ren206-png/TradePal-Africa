import type { RiskLabel } from "@prisma/client";

export interface DebtHistoryEntry {
  status: "OPEN" | "PARTIALLY_PAID" | "PAID" | "WRITTEN_OFF";
  dueDate: Date | null;
  updatedAt: Date;
}

/**
 * Derived only from payment history — never from AI inference (schema
 * comment on `Customer.riskLabel`) — so this takes plain debt rows, not a
 * WhatsApp message or model output.
 */
export function computeRiskLabel(debts: readonly DebtHistoryEntry[], now: Date = new Date()): RiskLabel {
  if (debts.length === 0) return "UNKNOWN";

  const isOverdueOpen = (d: DebtHistoryEntry): boolean =>
    (d.status === "OPEN" || d.status === "PARTIALLY_PAID") && d.dueDate !== null && d.dueDate < now;
  if (debts.some(isOverdueOpen)) return "RISKY";

  const isPaidLate = (d: DebtHistoryEntry): boolean =>
    d.status === "PAID" && d.dueDate !== null && d.updatedAt > d.dueDate;
  if (debts.some(isPaidLate)) return "LATE_PAYER";

  return debts.some((d) => d.status === "PAID") ? "GOOD_PAYER" : "UNKNOWN";
}
