import type { TenantScopedClient } from "../../db/tenantScope.js";
import { TradeError, cumulativeValue } from "./common.js";

/**
 * Seller-side trade-credit rules. These record terms the SELLER chose (a limit, an overdue cut-off); TradePal does not
 * lend, guarantee or score anyone, and no AI is involved in a credit decision. A block can be overridden by a person
 * with the right permission, who must give a reason (the caller records it in the audit log).
 */
export interface CreditEvaluation {
  allowed: boolean;
  reasons: { code: "LIMIT_EXCEEDED" | "OVERDUE_BLOCK"; message: string }[];
  /** Unpaid invoices plus accepted-but-not-yet-invoiced order value for this customer. */
  exposureMinor: bigint;
  limitMinor: bigint | null;
  /** Days the oldest unpaid invoice is past due (0 when none). */
  oldestOverdueDays: number;
}

export function outstandingOf(inv: { totalMinor: bigint; creditedMinor: bigint; paidMinor: bigint }): bigint {
  return inv.totalMinor - inv.creditedMinor - inv.paidMinor;
}

export async function evaluateTradeCredit(
  scoped: TenantScopedClient,
  input: { partnerId: string; additionalMinor: bigint; now?: Date },
): Promise<CreditEvaluation> {
  const now = input.now ?? new Date();
  const partner = await scoped.tradePartner.findUnique({ where: { id: input.partnerId } });
  if (!partner) throw new TradeError("NOT_FOUND", "Partner not found.");

  const invoices = await scoped.tradeInvoice.findMany({ where: { partnerId: partner.id, side: "SELL", status: "ISSUED" } });
  let exposure = 0n;
  let oldestOverdueDays = 0;
  for (const inv of invoices) {
    const out = outstandingOf(inv);
    if (out <= 0n) continue;
    exposure += out;
    if (inv.dueDate && inv.dueDate < now) oldestOverdueDays = Math.max(oldestOverdueDays, Math.floor((now.getTime() - inv.dueDate.getTime()) / 86_400_000));
  }
  const open = await scoped.tradeOrder.findMany({ where: { partnerId: partner.id, side: "SELL", acceptance: "ACCEPTED" }, include: { lines: true } });
  for (const order of open) {
    for (const l of order.lines) exposure += l.lineTotalMinor - cumulativeValue(l.lineTotalMinor, l.baseQuantity, l.shippedBase);
  }

  const reasons: CreditEvaluation["reasons"] = [];
  if (partner.creditLimitMinor !== null && exposure + input.additionalMinor > partner.creditLimitMinor) {
    reasons.push({ code: "LIMIT_EXCEEDED", message: `This would take ${partner.name} to ${exposure + input.additionalMinor} against a limit of ${partner.creditLimitMinor} (minor units).` });
  }
  if (partner.blockWhenOverdueDays !== null && oldestOverdueDays >= partner.blockWhenOverdueDays && oldestOverdueDays > 0) {
    reasons.push({ code: "OVERDUE_BLOCK", message: `${partner.name} has an invoice ${oldestOverdueDays} days overdue (your rule: block from ${partner.blockWhenOverdueDays} days).` });
  }
  return { allowed: reasons.length === 0, reasons, exposureMinor: exposure, limitMinor: partner.creditLimitMinor, oldestOverdueDays };
}
