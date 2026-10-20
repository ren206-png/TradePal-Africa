import { canMerchant, membershipRoleForLegacyMerchantRole, type MerchantPermission } from "../auth/permissions.js";
import { csvNumber, csvRow, csvText } from "../admin/csv.js";
import { formatMoney } from "../domain/money.js";
import { getDayBoundsInTimezone, getMonthBoundsInTimezone } from "../domain/dailySummary.js";
import {
  apAgingReport, arAgingReport, cashFlowReport, grossMarginReport, inventoryValuationReport, paymentReconciliationReport, salesReport, stockDiscrepancyReport,
} from "./reports.js";
import { ReportError, type RangeInput, type Report, type ReportContext, type ReportName } from "./common.js";

export * from "./common.js";
export * from "./reports.js";

export const REPORT_NAMES: readonly ReportName[] = ["sales", "cash-flow", "inventory-valuation", "ar-aging", "ap-aging", "gross-margin", "payment-reconciliation", "stock-discrepancies"];
export const isReportName = (s: string): s is ReportName => (REPORT_NAMES as readonly string[]).includes(s);

/** Reports are read with `reports:view`; the file download needs `finance:export`. Both are checked against the person's membership role, never their name. */
export function canViewReports(merchantRole: "OWNER" | "STAFF"): boolean {
  return canMerchant(membershipRoleForLegacyMerchantRole(merchantRole), "reports:view" satisfies MerchantPermission);
}
/**
 * Reports that show what goods COST, or where the money sits, are for the people who handle the books (owner, manager, finance operator):
 * a sales clerk can read the sales, money-owed and stock-difference reports but not margin, stock value, cash flow or payment reconciliation.
 */
export const REPORT_PERMISSION: Record<ReportName, MerchantPermission> = {
  "sales": "reports:view", "ar-aging": "reports:view", "ap-aging": "reports:view", "stock-discrepancies": "reports:view",
  "gross-margin": "finance:reconcile", "inventory-valuation": "finance:reconcile", "cash-flow": "finance:reconcile", "payment-reconciliation": "finance:reconcile",
};
export function canRunReport(merchantRole: "OWNER" | "STAFF", name: ReportName): boolean {
  return canMerchant(membershipRoleForLegacyMerchantRole(merchantRole), REPORT_PERMISSION[name]);
}
export function canExportReports(merchantRole: "OWNER" | "STAFF"): boolean {
  return canMerchant(membershipRoleForLegacyMerchantRole(merchantRole), "finance:export" satisfies MerchantPermission);
}

export async function runReport(ctx: ReportContext, name: ReportName, range: RangeInput): Promise<Report<unknown>> {
  switch (name) {
    case "sales": return salesReport(ctx, range);
    case "cash-flow": return cashFlowReport(ctx, range);
    case "inventory-valuation": return inventoryValuationReport(ctx);
    case "ar-aging": return arAgingReport(ctx);
    case "ap-aging": return apAgingReport(ctx);
    case "gross-margin": return grossMarginReport(ctx, range);
    case "payment-reconciliation": return paymentReconciliationReport(ctx, range);
    case "stock-discrepancies": return stockDiscrepancyReport(ctx, range);
  }
}

/** The business's current local month to date, or a named period. Calendar days are in the business's own timezone. */
export function defaultRange(timezone: string, now: Date = new Date()): RangeInput {
  const m = getMonthBoundsInTimezone(now, timezone);
  return { from: m.start, to: m.end };
}

export function parseRange(args: string[], timezone: string, now: Date = new Date()): RangeInput {
  if (args.length === 0) return defaultRange(timezone, now);
  const word = (args[0] ?? "").toLowerCase();
  if (args.length === 1 && word === "today") { const d = getDayBoundsInTimezone(now, timezone); return { from: d.start, to: d.end }; }
  if (args.length === 1 && word === "month") return defaultRange(timezone, now);
  if (args.length === 1 && word === "week") {
    const d = getDayBoundsInTimezone(now, timezone);
    return { from: new Date(d.start.getTime() - 6 * 86_400_000), to: d.end };
  }
  if (args.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(args[0]!) && /^\d{4}-\d{2}-\d{2}$/.test(args[1]!)) {
    // both days are INCLUDED; each is a local calendar day in the business timezone
    const a = new Date(`${args[0]}T12:00:00Z`);
    const b = new Date(`${args[1]}T12:00:00Z`);
    // a real calendar day: 2026-02-31 and 2026-13-45 are refused rather than rolled over
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a.toISOString().slice(0, 10) !== args[0] || b.toISOString().slice(0, 10) !== args[1]) throw new ReportError("INVALID_RANGE", "Those are not real dates. Use a form like 2026-10-31.");
    const start = getDayBoundsInTimezone(a, timezone).start;
    const end = getDayBoundsInTimezone(b, timezone).end;
    return { from: start, to: end };
  }
  throw new ReportError("INVALID_RANGE", "Use: today, week, month, or two dates like 2026-10-01 2026-10-31.");
}

// ---------------------------------------------------------------------------------------------------- text

const money = (r: Report<unknown>, v: string | null): string => (v === null ? "not available" : `${formatMoney(BigInt(v), r.meta.minorUnitExp)} ${r.meta.currencyCode}`);

/** A short WhatsApp-sized summary: headline numbers, then EVERY warning (they are part of the answer, not an appendix). */
export function reportText(report: Report<unknown>): string {
  const d = report.data as never as Record<string, any>;
  const range = report.meta.asOf ? `as of ${report.meta.asOf.slice(0, 10)}` : `${report.meta.from.slice(0, 10)} to ${new Date(new Date(report.meta.to).getTime() - 1).toISOString().slice(0, 10)}`;
  const lines: string[] = [`${report.meta.title} (${range}, ${report.meta.timezone}, ${report.meta.currencyCode})`];
  switch (report.meta.report) {
    case "sales":
      lines.push(`Sales: ${money(report, d.totals.grossSalesMinor)}`, `Returns and refunds: ${money(report, d.totals.returnsMinor)}`, `Net sales: ${money(report, d.totals.netSalesMinor)} (${d.totals.saleCount} sale${d.totals.saleCount === 1 ? "" : "s"})`);
      break;
    case "cash-flow":
      for (const r of d.rows) if (r.openingMinor !== "0" || r.inMinor !== "0" || r.outMinor !== "0") lines.push(`${r.method}: ${money(report, r.openingMinor)} + in ${money(report, r.inMinor)} - out ${money(report, r.outMinor)} = ${money(report, r.closingMinor)}`);
      break;
    case "inventory-valuation":
      lines.push(`Valued stock: ${money(report, d.totals.valuedMinor)} (${d.totals.unitsValued} units)`, `Units with no cost: ${d.totals.unitsWithoutCost}`);
      break;
    case "ar-aging":
    case "ap-aging":
      lines.push(`Total: ${money(report, d.totalMinor)}`, ...d.buckets.filter((b: any) => b.count > 0).map((b: any) => `${b.bucket} days: ${money(report, b.totalMinor)} (${b.count})`));
      break;
    case "gross-margin":
      lines.push(`Net sales: ${money(report, d.netSalesMinor)}`, `Cost of goods sold: ${money(report, d.costOfGoodsSoldMinor)}`, d.grossMarginMinor === null ? "Gross margin: not available" : `Gross margin: ${money(report, d.grossMarginMinor)}${d.grossMarginPercent ? ` (${d.grossMarginPercent}%)` : ""}`, `Cost recorded for ${d.completeness.percentComplete ?? "?"}% of stock movements`);
      break;
    case "payment-reconciliation":
      lines.push(`Captured: ${money(report, d.captured.totalMinor)}; applied: ${money(report, d.captured.allocatedMinor)}; not applied: ${money(report, d.captured.unallocatedMinor)}`, `Settled: ${money(report, d.settlement.settledGrossMinor)}; captured, not yet settled: ${money(report, d.settlement.capturedNotYetSettledMinor)}`);
      break;
    case "stock-discrepancies":
      lines.push(`Balance mismatches: ${d.balanceMismatches.length}`, `Count variances: ${d.countVariances.length}`, `Chat tracker differs: ${d.legacyDrift.length}`, `Below zero: ${d.negativeStock.length}`);
      break;
  }
  for (const w of report.meta.warnings) lines.push(`! ${w.message}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------------ CSV

const n = (v: string | number | bigint | null | undefined): string => (v === null || v === undefined ? "" : csvNumber(v));

function table(report: Report<unknown>): { header: string[]; rows: string[][] } {
  const d = report.data as never as Record<string, any>;
  switch (report.meta.report) {
    case "sales": return { header: ["day", "sales_count", "gross_sales_minor", "returns_minor", "net_sales_minor"], rows: d.days.map((x: any) => [csvText(x.day), n(x.saleCount), n(x.grossSalesMinor), n(x.returnsMinor), n(x.netSalesMinor)]) };
    case "cash-flow": return { header: ["method", "account", "opening_minor", "in_minor", "out_minor", "closing_minor"], rows: d.rows.map((x: any) => [csvText(x.method), csvText(x.account), n(x.openingMinor), n(x.inMinor), n(x.outMinor), n(x.closingMinor)]) };
    case "inventory-valuation": return { header: ["sku", "name", "unit", "on_hand", "avg_cost_minor", "value_minor", "uncosted_qty", "flag"], rows: d.rows.map((x: any) => [csvText(x.sku), csvText(x.name), csvText(x.unit), n(x.onHand), n(x.avgCostMinor), n(x.valueMinor), n(x.uncostedQty), csvText(x.flag ?? "")]) };
    case "ar-aging":
    case "ap-aging": return { header: ["party", "kind", "reference", "due_date", "age_basis", "bucket", "outstanding_minor"], rows: d.rows.map((x: any) => [csvText(x.party), csvText(x.kind), csvText(x.reference ?? ""), csvText(x.dueDate ?? ""), csvText(x.ageBasis), csvText(x.bucket), n(x.outstandingMinor)]) };
    case "gross-margin": return { header: ["net_sales_minor", "cost_of_goods_sold_minor", "gross_margin_minor", "gross_margin_percent", "cost_complete_percent", "operating_expenses_minor_not_deducted"], rows: [[n(d.netSalesMinor), n(d.costOfGoodsSoldMinor), n(d.grossMarginMinor), csvText(d.grossMarginPercent ?? ""), csvText(d.completeness.percentComplete ?? ""), n(d.operatingExpensesMinor)]] };
    case "payment-reconciliation": return { header: ["status", "attempts", "captured_minor"], rows: d.attempts.map((x: any) => [csvText(x.status), n(x.count), n(x.capturedMinor)]) };
    case "stock-discrepancies": return {
      header: ["kind", "sku", "detail", "expected", "actual"],
      rows: [
        ...d.balanceMismatches.map((x: any) => [csvText("balance_mismatch"), csvText(x.sku), csvText(x.field), n(x.expected), n(x.balance)]),
        ...d.countVariances.map((x: any) => [csvText("count_variance"), csvText(x.sku), csvText(x.reason ?? ""), n(x.expectedQty), n(x.countedQty)]),
        ...d.legacyDrift.map((x: any) => [csvText("legacy_drift"), csvText(x.sku), csvText("chat tracker vs catalog"), n(x.v2OnHand), n(x.legacyEstimate)]),
        ...d.negativeStock.map((x: any) => [csvText("negative_stock"), csvText(x.sku), csvText(""), n(0), n(x.onHand)]),
      ],
    };
  }
}

/**
 * Formula-safe CSV. Every text cell goes through `csvText` (a leading = + - @ tab or CR is neutralised) and every number through
 * `csvNumber` (which refuses anything that is not an integer). The first lines carry the report's range, currency, timezone, sources and
 * EVERY warning, so a file that leaves TradePal never loses its caveats. Amounts are integer minor units.
 */
export function reportToCsv(report: Report<unknown>): string {
  const m = report.meta;
  const head: [string, string][] = [
    ["report", m.title], ["from", m.from], ["to_exclusive", m.to], ...(m.asOf ? ([["as_of", m.asOf]] as [string, string][]) : []), ["currency", m.currencyCode], ["minor_unit_exponent", String(m.minorUnitExp)],
    ["timezone", m.timezone], ["generated_at", m.generatedAt], ["basis", m.basis], ...m.sources.map((s): [string, string] => ["source", `${s.name} (${s.rows} rows)`]),
    ...m.warnings.map((w): [string, string] => ["warning", w.message]), ["notice", m.notice],
  ];
  const t = table(report);
  return [...head.map(([k, v]) => csvRow([csvText(k), csvText(v)])), "", csvRow(t.header.map((h) => csvText(h))), ...t.rows.map(csvRow)].join("\r\n") + "\r\n";
}
