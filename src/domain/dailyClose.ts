import type { DailyClose, Prisma } from "@prisma/client";
import { withScopedTransaction, type TenantScopedClient } from "../db/tenantScope.js";
import { accountNet, ensureChartOfAccounts, postCashAdjustment, type SystemAccountKey } from "./accounting.js";
import { getDayBoundsInTimezone } from "./dailySummary.js";

/**
 * Daily close (expansion Phase 2): the end-of-day cash count for one business day in the business's own timezone.
 *
 *   expected cash = the books' CASH balance at the end of the day (opening balance + that day's cash movements)
 *   difference    = counted - expected
 *
 * Only money explicitly recorded as CASH is expected in the drawer. Receipts whose payment method was never recorded
 * (everything logged through the earlier WhatsApp flow) are reported separately as `unspecifiedReceiptsMinor`: they are
 * NOT guessed to be cash. A non-zero difference needs a written reason and is explained by a CASH_ADJUSTMENT journal
 * entry (so the books then equal the count); the DailyClose row itself is never edited.
 *
 * The FIRST close of a business is its starting point, not a comparison: the books cannot know how much cash was already in the drawer
 * (everything logged before payment methods were recorded is unclassified), so comparing would always show a false shortage. The first
 * count is posted as the opening cash balance with the reason "Opening cash count" and needs no reason from the owner.
 */
export const OPENING_REASON = "Opening cash count (first close)";
export class DailyCloseError extends Error {
  readonly code: "ALREADY_CLOSED" | "INVALID_DATE" | "FUTURE_DATE" | "INVALID_AMOUNT" | "REASON_REQUIRED";
  constructor(code: DailyCloseError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface DailyCloseSummary {
  businessDate: string;
  currencyCode: string;
  openingCashMinor: bigint;
  expectedCashMinor: bigint;
  /** Net by method for the day, from SALE entries (reversals net out). */
  salesCashMinor: bigint;
  salesMobileMoneyMinor: bigint;
  salesBankMinor: bigint;
  salesUnspecifiedMinor: bigint;
  creditSalesMinor: bigint;
  /** Customer payments on earlier credit, by method. */
  collectionsCashMinor: bigint;
  collectionsOtherMinor: bigint;
  refundsMinor: bigint;
  feesMinor: bigint;
  expensesMinor: bigint;
  stockPurchasesMinor: bigint;
  ownerWithdrawalsMinor: bigint;
  /** Money in/out whose method was never recorded; not part of expected cash. */
  unspecifiedReceiptsMinor: bigint;
  wallet: {
    confirmed: { count: number; amountMinor: bigint };
    unmatched: { count: number; amountMinor: bigint };
  };
  existingClose: DailyClose | null;
  /** True when this business has never closed a day in this currency: the count becomes the opening cash balance. */
  isFirstClose: boolean;
}

function validDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new DailyCloseError("INVALID_DATE", "Use a date like 2026-10-21.");
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw new DailyCloseError("INVALID_DATE", "That date does not exist.");
  return { y, m, d };
}

/** The business-local calendar date of `now`, as YYYY-MM-DD. */
export function localDateString(now: Date, timeZone: string): string {
  const { start } = getDayBoundsInTimezone(now, timeZone);
  const noon = new Date(start.getTime() + 12 * 3_600_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(noon);
  return parts; // en-CA => YYYY-MM-DD
}

export function dayBoundsForDate(date: string, timeZone: string): { start: Date; end: Date } {
  const { y, m, d } = validDate(date);
  return getDayBoundsInTimezone(new Date(Date.UTC(y, m - 1, d, 12)), timeZone);
}

export interface CloseInput {
  businessId: string;
  businessDate: string;
  currencyCode: string;
  timeZone: string;
}

export async function previewDailyClose(scoped: TenantScopedClient, input: CloseInput, now: Date = new Date()): Promise<DailyCloseSummary> {
  const { start, end } = dayBoundsForDate(input.businessDate, input.timeZone);
  if (localDateString(now, input.timeZone) < input.businessDate) throw new DailyCloseError("FUTURE_DATE", "That day has not happened yet.");
  await ensureChartOfAccounts(scoped, input.businessId);

  const lines = await scoped.journalLine.findMany({
    where: { entry: { currencyCode: input.currencyCode, occurredAt: { gte: start, lt: end } } },
    include: { entry: { select: { kind: true, reversalOf: { select: { kind: true } } } }, account: { select: { systemKey: true } } },
  });
  // Net debit per (effective kind, account). A reversal counts under the kind it reverses, so it nets out.
  const netBy = new Map<string, bigint>();
  for (const l of lines) {
    const kind = l.entry.reversalOf?.kind ?? l.entry.kind;
    const k = `${kind}|${l.account.systemKey}`;
    netBy.set(k, (netBy.get(k) ?? 0n) + l.debitMinor - l.creditMinor);
  }
  const n = (kind: string, account: SystemAccountKey): bigint => netBy.get(`${kind}|${account}`) ?? 0n;

  const openingCashMinor = await accountNet(scoped, "CASH", { currencyCode: input.currencyCode, to: start });
  const expectedCashMinor = openingCashMinor + (await accountNet(scoped, "CASH", { currencyCode: input.currencyCode, from: start, to: end }));
  const unspecifiedReceiptsMinor = await accountNet(scoped, "UNCLASSIFIED_FUNDS", { currencyCode: input.currencyCode, from: start, to: end });

  const alerts = await scoped.mobileMoneyAlert.findMany({ where: { createdAt: { gte: start, lt: end } } });
  const sum = (rows: typeof alerts) => ({ count: rows.length, amountMinor: rows.reduce((s, a) => s + a.amountMinor, 0n) });

  const existingClose = await scoped.dailyClose.findFirst({ where: { businessDate: new Date(`${input.businessDate}T00:00:00.000Z`), currencyCode: input.currencyCode } });

  const earlierClose = await scoped.dailyClose.findFirst({ where: { currencyCode: input.currencyCode } });

  return {
    isFirstClose: earlierClose === null,
    businessDate: input.businessDate,
    currencyCode: input.currencyCode,
    openingCashMinor,
    expectedCashMinor,
    salesCashMinor: n("SALE", "CASH"),
    salesMobileMoneyMinor: n("SALE", "MOBILE_MONEY"),
    salesBankMinor: n("SALE", "BANK"),
    salesUnspecifiedMinor: n("SALE", "UNCLASSIFIED_FUNDS"),
    creditSalesMinor: n("SALE", "AR"),
    collectionsCashMinor: n("DEBT_PAYMENT", "CASH"),
    collectionsOtherMinor: n("DEBT_PAYMENT", "MOBILE_MONEY") + n("DEBT_PAYMENT", "BANK") + n("DEBT_PAYMENT", "UNCLASSIFIED_FUNDS"),
    refundsMinor: n("REFUND", "SALES_RETURNS"),
    feesMinor: n("FEE", "PAYMENT_FEES"),
    expensesMinor: n("EXPENSE", "OPERATING_EXPENSES"),
    stockPurchasesMinor: n("STOCK_PURCHASE", "INVENTORY"),
    ownerWithdrawalsMinor: n("OWNER_WITHDRAWAL", "OWNER_WITHDRAWALS"),
    unspecifiedReceiptsMinor,
    wallet: {
      confirmed: sum(alerts.filter((a) => a.matchStatus === "CONFIRMED")),
      unmatched: sum(alerts.filter((a) => a.matchStatus !== "CONFIRMED")),
    },
    existingClose,
  };
}

function summaryToJson(s: DailyCloseSummary): Prisma.InputJsonValue {
  const { existingClose: _ignored, wallet, ...rest } = s;
  void _ignored;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) out[k] = typeof v === "bigint" ? v.toString() : v;
  out["wallet"] = {
    confirmed: { count: wallet.confirmed.count, amountMinor: wallet.confirmed.amountMinor.toString() },
    unmatched: { count: wallet.unmatched.count, amountMinor: wallet.unmatched.amountMinor.toString() },
  };
  return out as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export interface CloseDayInput extends CloseInput {
  countedCashMinor: bigint;
  closedBy?: string;
  note?: string;
  /** Required when counted differs from expected: why. */
  differenceReason?: string;
}

export async function closeDay(
  scoped: TenantScopedClient,
  input: CloseDayInput,
  now: Date = new Date(),
): Promise<{ close: DailyClose; summary: DailyCloseSummary; differenceMinor: bigint; adjustmentEntryId: string | null }> {
  if (input.countedCashMinor < 0n) throw new DailyCloseError("INVALID_AMOUNT", "The counted cash cannot be negative.");
  const summary = await previewDailyClose(scoped, input, now);
  if (summary.existingClose) throw new DailyCloseError("ALREADY_CLOSED", `${input.businessDate} is already closed.`);

  const differenceMinor = input.countedCashMinor - summary.expectedCashMinor;
  const differenceReason = summary.isFirstClose ? OPENING_REASON : input.differenceReason;
  if (differenceMinor !== 0n && !differenceReason?.trim()) {
    throw new DailyCloseError("REASON_REQUIRED", "The count differs from the books. Say why, so the difference is explained.");
  }
  const { start, end } = dayBoundsForDate(input.businessDate, input.timeZone);
  const occurredAt = now < end && now >= start ? now : new Date(end.getTime() - 1000);

  try {
    return await withScopedTransaction(scoped, async (tx) => {
      let adjustmentEntryId: string | null = null;
      if (differenceMinor !== 0n) {
        const adj = await postCashAdjustment(tx, {
          businessId: input.businessId,
          currencyCode: input.currencyCode,
          idempotencyKey: `close:${input.businessDate}:${input.currencyCode}`,
          occurredAt,
          differenceMinor,
          memo: `Daily close ${input.businessDate}: ${differenceReason!.trim()}`.slice(0, 300),
          provenance: "MERCHANT_ENTERED",
          source: { type: "DAILY_CLOSE", id: `${input.businessDate}:${input.currencyCode}` },
          actor: { type: "MERCHANT", ...(input.closedBy ? { id: input.closedBy } : {}) },
        });
        adjustmentEntryId = adj.entry.id;
      }
      const close = await tx.dailyClose.create({
        data: {
          businessId: input.businessId,
          businessDate: new Date(`${input.businessDate}T00:00:00.000Z`),
          currencyCode: input.currencyCode,
          expectedCashMinor: summary.expectedCashMinor,
          countedCashMinor: input.countedCashMinor,
          differenceMinor,
          summary: summaryToJson(summary),
          note: input.note ?? null,
          closedBy: input.closedBy ?? null,
          adjustmentEntryId,
        },
      });
      return { close, summary, differenceMinor, adjustmentEntryId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DailyCloseError("ALREADY_CLOSED", `${input.businessDate} is already closed.`);
    throw error;
  }
}

export async function listDailyCloses(scoped: TenantScopedClient, limit = 31): Promise<DailyClose[]> {
  return scoped.dailyClose.findMany({ orderBy: { businessDate: "desc" }, take: limit });
}
