import type { TenantScopedClient } from "../db/tenantScope.js";
import { sumMoney } from "./money.js";

function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));

  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Midnight-to-midnight in `timeZone`, expressed as UTC instants — the
 * business's own IANA timezone is stored explicitly (KQ7) precisely so
 * "today" means the merchant's local day, not the server's.
 */
export function getDayBoundsInTimezone(now: Date, timeZone: string): { start: Date; end: Date } {
  const offsetMinutes = getTimezoneOffsetMinutes(now, timeZone);
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const localMidnightAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const start = new Date(localMidnightAsUtc - offsetMinutes * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Calendar-month bounds (1st of the month at local midnight, through the 1st
 * of the following month) in `timeZone`, expressed as UTC instants — mirrors
 * getDayBoundsInTimezone's technique. A single offset sample is sufficient
 * (rather than resampling at the month boundary) because none of TradePal's
 * supported countries (Nigeria, Kenya, Sierra Leone, Ghana) observe DST, so
 * the UTC offset is constant across the whole month.
 */
export function getMonthBoundsInTimezone(now: Date, timeZone: string): { start: Date; end: Date } {
  const offsetMinutes = getTimezoneOffsetMinutes(now, timeZone);
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const localMonthStartAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  const localNextMonthStartAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1);
  const start = new Date(localMonthStartAsUtc - offsetMinutes * 60_000);
  const end = new Date(localNextMonthStartAsUtc - offsetMinutes * 60_000);
  return { start, end };
}

/**
 * The most recently *completed* Mon-Sun week relative to `now`, in
 * `timeZone` — e.g. if `now` falls on a Wednesday, this returns last week's
 * Monday 00:00 through this week's Monday 00:00 (not the still-in-progress
 * current week). Built for src/domain/businessDigest.ts, whose weekly sweep
 * summarizes "the week that just ended" rather than a partial in-progress
 * week. Mirrors getDayBoundsInTimezone/getMonthBoundsInTimezone's single-
 * offset-sample technique — valid for the same no-DST reason.
 */
export function getWeekBoundsInTimezone(now: Date, timeZone: string): { start: Date; end: Date } {
  const offsetMinutes = getTimezoneOffsetMinutes(now, timeZone);
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const localMidnightAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());

  // JS getUTCDay(): 0=Sunday..6=Saturday. Shift so Monday=0..Sunday=6.
  const dayOfWeek = new Date(localMidnightAsUtc).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const thisWeekMondayAsUtc = localMidnightAsUtc - daysSinceMonday * 24 * 60 * 60 * 1000;
  const lastWeekMondayAsUtc = thisWeekMondayAsUtc - 7 * 24 * 60 * 60 * 1000;

  const start = new Date(lastWeekMondayAsUtc - offsetMinutes * 60_000);
  const end = new Date(thisWeekMondayAsUtc - offsetMinutes * 60_000);
  return { start, end };
}

export interface DailySummary {
  transactionCount: number;
  totalSalesMinor: bigint;
  totalExpensesMinor: bigint;
  totalPaymentsReceivedMinor: bigint;
  netMinor: bigint;
}

/**
 * Shared by getDailySummary and the weekly business digest
 * (businessDigest.ts) — both need "total up every Transaction in this
 * UTC-instant range, split by type" and differ only in how the range itself
 * is computed (a day vs. a completed week).
 */
export async function getSummaryForRange(
  scopedPrisma: TenantScopedClient,
  start: Date,
  end: Date,
): Promise<DailySummary> {
  const transactions = await scopedPrisma.transaction.findMany({
    where: { createdAt: { gte: start, lt: end } },
  });

  return {
    transactionCount: transactions.length,
    totalSalesMinor: sumMoney(transactions.filter((t) => t.type === "SALE").map((t) => t.amountMinor)),
    totalExpensesMinor: sumMoney(transactions.filter((t) => t.type === "EXPENSE").map((t) => t.amountMinor)),
    totalPaymentsReceivedMinor: sumMoney(
      transactions.filter((t) => t.type === "PAYMENT_RECEIVED").map((t) => t.amountMinor),
    ),
    netMinor: sumMoney(transactions.map((t) => t.amountMinor)),
  };
}

export async function getDailySummary(
  scopedPrisma: TenantScopedClient,
  timezone: string,
  now: Date = new Date(),
): Promise<DailySummary> {
  const { start, end } = getDayBoundsInTimezone(now, timezone);
  return getSummaryForRange(scopedPrisma, start, end);
}
