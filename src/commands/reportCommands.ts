import type { CommandContext } from "./commandRouter.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { FLAG_REPORTS, REPORT_NAMES, ReportError, canExportReports, canViewReports, isReportName, parseRange, reportText, runReport } from "../reports/index.js";
import { CODE_MINUTES, FLAG_REPORTS_WEB, issueConnectCode, reportsWebSwitchOn } from "../offline/devices.js";

/**
 * `/report [name] [today | week | month | <from> <to>]`: bookkeeping reports on WhatsApp, behind the per-business `reportsV2` flag (default
 * OFF; while off the command answers like any unknown one). `/report link` gives a one-time code for the phone page, where the same reports
 * can be opened and downloaded as CSV.
 */
export const REPORT_COMMANDS = new Set(["/report"]);

const HELP = [
  "Reports (bookkeeping, not tax filings, not profit statements):",
  "/report sales [period]",
  "/report cash [period]",
  "/report stock - what your stock is worth now",
  "/report owed - money customers and partners owe you",
  "/report payable - money you owe suppliers",
  "/report margin [period] - gross margin with completeness warnings",
  "/report payments [period]",
  "/report differences [period] - stock that does not add up",
  "/report link - a code to open and download reports on a phone",
  "Period: today, week, month (default), or two dates like 2026-10-01 2026-10-31.",
].join("\n");

const ALIASES: Record<string, (typeof REPORT_NAMES)[number]> = {
  sales: "sales", cash: "cash-flow", "cash-flow": "cash-flow", stock: "inventory-valuation", inventory: "inventory-valuation", owed: "ar-aging", receivable: "ar-aging",
  payable: "ap-aging", owe: "ap-aging", margin: "gross-margin", payments: "payment-reconciliation", differences: "stock-discrepancies", discrepancies: "stock-discrepancies",
};

export async function handleReportCommand(ctx: CommandContext, command: string, args: string): Promise<string | null> {
  if (!REPORT_COMMANDS.has(command)) return null;
  if (!(await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, FLAG_REPORTS))) return null;
  if (!canViewReports(ctx.merchantRole)) return "You do not have permission to see reports. Ask the owner.";
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const word = (parts.shift() ?? "help").toLowerCase();
  if (word === "help") return HELP;

  if (word === "link") {
    if (!canExportReports(ctx.merchantRole)) return "Only the owner or a manager can download reports.";
    if (!reportsWebSwitchOn() || !(await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, FLAG_REPORTS_WEB))) return "Downloading reports on a phone is not switched on yet. You can still read them here with /report.";
    const { code } = await issueConnectCode(ctx.prisma, { businessId: ctx.businessId, merchantId: ctx.merchantId, shared: false });
    const base = process.env["OFFLINE_PUBLIC_URL"] ?? "";
    return [`Your one-time code to open reports on a phone is ${code}. It works once and expires in ${CODE_MINUTES} minutes. Do not share it.`, base ? `Open ${base.replace(/\/$/, "")}/m/ and type the code.` : "Open the TradePal page (/m/) on that phone and type the code.", "Send /disconnect to sign phones out."].join("\n");
  }

  const name = ALIASES[word] ?? (isReportName(word) ? word : null);
  if (!name) return `I do not have a report called "${word}".\n${HELP}`;
  try {
    const range = parseRange(parts, ctx.timezone);
    const report = await runReport({ scoped: ctx.scopedPrisma, businessId: ctx.businessId, currencyCode: ctx.currencyCode, minorUnitExp: ctx.minorUnitExp, timezone: ctx.timezone }, name, range);
    return reportText(report);
  } catch (error) {
    if (error instanceof ReportError) return error.message;
    throw error;
  }
}
