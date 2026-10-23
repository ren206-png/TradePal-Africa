import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeBusiness, seedReference } from "./helpers/phase2.js";
import {
  accountNet, postDebtCollection, postExpense, postFee, postOwnerWithdrawal, postRefund, postSale, postStockPurchase, reverseJournalEntry, trialBalance,
} from "../src/domain/accounting.js";
import { DailyCloseError, closeDay, dayBoundsForDate, listDailyCloses, localDateString, previewDailyClose } from "../src/domain/dailyClose.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

const TZ = "Africa/Lagos"; // UTC+1, no DST
const DAY = "2026-10-20";
const NOW = new Date("2026-10-21T08:00:00Z"); // the morning after
let k = 0;
const key = () => `dc-${++k}`;
const at = (iso: string) => new Date(iso);

async function seedDay() {
  const env = await makeBusiness(prisma);
  const c = { businessId: env.businessId, currencyCode: "NGN" };
  // before the day: owner put 10,000 of cash in the drawer
  await postSale(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-19T12:00:00Z"), totalMinor: 10_000n, receipts: [{ method: "CASH", amountMinor: 10_000n }] });
  // the day (Lagos 2026-10-20 = 2026-10-19T23:00Z .. 2026-10-20T23:00Z)
  await postSale(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T09:00:00Z"), totalMinor: 20_000n, receipts: [{ method: "CASH", amountMinor: 20_000n }] });
  await postSale(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T10:00:00Z"), totalMinor: 30_000n, receipts: [{ method: "MOBILE_MONEY", amountMinor: 30_000n }] });
  await postSale(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T11:00:00Z"), totalMinor: 9_000n, receipts: [{ method: "CASH", amountMinor: 3_000n }] }); // 6,000 on credit
  await postDebtCollection(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T12:00:00Z"), amountMinor: 1_000n, method: "CASH" });
  await postFee(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T10:05:00Z"), amountMinor: 450n, from: "MOBILE_MONEY" });
  await postRefund(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T13:00:00Z"), amountMinor: 5_000n, paidWith: "CASH" });
  await postOwnerWithdrawal(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T14:00:00Z"), amountMinor: 4_000n, from: "CASH" });
  await postStockPurchase(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T08:00:00Z"), amountMinor: 12_000n, paidWith: "CASH" });
  await postExpense(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T15:00:00Z"), amountMinor: 700n, paidWith: "CASH" });
  // method never recorded (earlier WhatsApp flow): must not be assumed to be cash
  await postSale(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T16:00:00Z"), totalMinor: 8_000n, receipts: [{ method: "UNSPECIFIED", amountMinor: 8_000n }] });
  // after the day (Lagos 2026-10-21 00:30)
  await postSale(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T23:30:00Z"), totalMinor: 99_000n, receipts: [{ method: "CASH", amountMinor: 99_000n }] });
  return { env, input: { businessId: env.businessId, businessDate: DAY, currencyCode: "NGN", timeZone: TZ } };
}

/** The first close of a business is its starting point (no comparison); tests that exercise a comparison close an earlier day first. */
async function alreadyHasAClose(env: Awaited<ReturnType<typeof seedDay>>["env"], input: { businessId: string; businessDate: string; currencyCode: string; timeZone: string }) {
  await closeDay(env.scoped, { ...input, businessDate: "2026-10-18", countedCashMinor: 0n }, NOW);
}

describe("business-day boundaries", () => {
  it("are midnight-to-midnight in the business timezone", () => {
    const { start, end } = dayBoundsForDate(DAY, TZ);
    expect(start.toISOString()).toBe("2026-10-19T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-20T23:00:00.000Z");
    expect(localDateString(new Date("2026-10-20T23:30:00Z"), TZ)).toBe("2026-10-21");
    expect(localDateString(new Date("2026-10-20T22:59:00Z"), TZ)).toBe("2026-10-20");
  });
});

describe("daily close preview: expected vs counted cash (scenario 5)", () => {
  it("builds the day's picture from the books, with the day's edges respected", async () => {
    const { env, input } = await seedDay();
    const p = await previewDailyClose(env.scoped, input, NOW);
    // opening 10,000; +20,000 sale; +3,000 sale part; +1,000 collection; -5,000 refund; -4,000 withdrawal; -12,000 purchase; -700 expense
    expect(p.openingCashMinor).toBe(10_000n);
    expect(p.expectedCashMinor).toBe(10_000n + 20_000n + 3_000n + 1_000n - 5_000n - 4_000n - 12_000n - 700n);
    expect(p).toMatchObject({
      salesCashMinor: 23_000n, salesMobileMoneyMinor: 30_000n, salesUnspecifiedMinor: 8_000n, creditSalesMinor: 6_000n,
      collectionsCashMinor: 1_000n, refundsMinor: 5_000n, feesMinor: 450n, expensesMinor: 700n, stockPurchasesMinor: 12_000n, ownerWithdrawalsMinor: 4_000n,
    });
    expect(p.unspecifiedReceiptsMinor).toBe(8_000n); // reported, never assumed cash
    expect(p.existingClose).toBeNull();
  });

  it("a reversal inside the day nets the sale out of the day's picture", async () => {
    const env = await makeBusiness(prisma);
    const c = { businessId: env.businessId, currencyCode: "NGN" };
    const sale = await postSale(env.scoped, { ...c, idempotencyKey: key(), occurredAt: at("2026-10-20T09:00:00Z"), totalMinor: 7_000n, receipts: [{ method: "CASH", amountMinor: 7_000n }] });
    await reverseJournalEntry(env.scoped, sale.entry.id, { occurredAt: at("2026-10-20T09:30:00Z") });
    const p = await previewDailyClose(env.scoped, { businessId: env.businessId, businessDate: DAY, currencyCode: "NGN", timeZone: TZ }, NOW);
    expect(p.salesCashMinor).toBe(0n);
    expect(p.expectedCashMinor).toBe(0n);
  });

  it("reports confirmed versus unmatched wallet payments for the day", async () => {
    const env = await makeBusiness(prisma);
    const mk = (status: "CONFIRMED" | "UNMATCHED" | "SUGGESTED", amountMinor: bigint, createdAt: string) =>
      env.scoped.mobileMoneyAlert.create({ data: { businessId: env.businessId, provider: "MTN", amountMinor, currencyCode: "NGN", rawText: "x", matchStatus: status, createdAt: at(createdAt) } });
    await mk("CONFIRMED", 5_000n, "2026-10-20T10:00:00Z");
    await mk("UNMATCHED", 2_000n, "2026-10-20T11:00:00Z");
    await mk("SUGGESTED", 1_000n, "2026-10-20T12:00:00Z");
    await mk("UNMATCHED", 9_999n, "2026-10-22T12:00:00Z"); // another day
    const p = await previewDailyClose(env.scoped, { businessId: env.businessId, businessDate: DAY, currencyCode: "NGN", timeZone: TZ }, NOW);
    expect(p.wallet.confirmed).toEqual({ count: 1, amountMinor: 5_000n });
    expect(p.wallet.unmatched).toEqual({ count: 2, amountMinor: 3_000n });
  });

  it("rejects future and impossible dates", async () => {
    const env = await makeBusiness(prisma);
    const base = { businessId: env.businessId, currencyCode: "NGN", timeZone: TZ };
    await expect(previewDailyClose(env.scoped, { ...base, businessDate: "2026-10-22" }, NOW)).rejects.toMatchObject({ code: "FUTURE_DATE" });
    await expect(previewDailyClose(env.scoped, { ...base, businessDate: "2026-02-30" }, NOW)).rejects.toMatchObject({ code: "INVALID_DATE" });
    await expect(previewDailyClose(env.scoped, { ...base, businessDate: "yesterday" }, NOW)).rejects.toMatchObject({ code: "INVALID_DATE" });
    // today is allowed
    await expect(previewDailyClose(env.scoped, { ...base, businessDate: "2026-10-21" }, NOW)).resolves.toBeDefined();
  });
});

describe("closing the day", () => {
  it("a count that matches the books closes with no adjustment, and the close is read-only afterwards", async () => {
    const { env, input } = await seedDay();
    const expected = (await previewDailyClose(env.scoped, input, NOW)).expectedCashMinor;
    const r = await closeDay(env.scoped, { ...input, countedCashMinor: expected, closedBy: "owner-1" }, NOW);
    expect(r.differenceMinor).toBe(0n);
    expect(r.adjustmentEntryId).toBeNull();
    expect(r.close).toMatchObject({ expectedCashMinor: expected, countedCashMinor: expected, differenceMinor: 0n, closedBy: "owner-1" });
    expect((r.close.summary as { wallet: unknown }).wallet).toBeDefined();
    expect(JSON.stringify(r.close.summary)).not.toContain("bigint");
    await expect(closeDay(env.scoped, { ...input, countedCashMinor: expected }, NOW)).rejects.toMatchObject({ code: "ALREADY_CLOSED" });
    await expect(testDb.db.query(`UPDATE "DailyClose" SET "countedCashMinor" = 1 WHERE id = '${r.close.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "DailyClose" WHERE id = '${r.close.id}'`)).rejects.toThrow(/append-only/);
    expect((await listDailyCloses(env.scoped)).map((c) => c.id)).toEqual([r.close.id]);
  });

  it("a shortfall needs a reason, is explained by a cash-adjustment entry, and leaves the books equal to the count", async () => {
    const { env, input } = await seedDay();
    await alreadyHasAClose(env, input);
    const expected = (await previewDailyClose(env.scoped, input, NOW)).expectedCashMinor;
    const counted = expected - 1_500n;
    await expect(closeDay(env.scoped, { ...input, countedCashMinor: counted }, NOW)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect(await env.scoped.dailyClose.count({ where: {} })).toBe(1); // only the earlier close: nothing half-written

    const r = await closeDay(env.scoped, { ...input, countedCashMinor: counted, differenceReason: "change given wrongly, 1,500 short", closedBy: "mgr-1" }, NOW);
    expect(r.differenceMinor).toBe(-1_500n);
    const adj = await env.scoped.journalEntry.findUniqueOrThrow({ where: { id: r.adjustmentEntryId! } });
    expect(adj).toMatchObject({ kind: "CASH_ADJUSTMENT", actorId: "mgr-1" });
    expect(adj.memo).toContain("1,500 short");
    // the books at the end of the day now equal the count
    const { end } = dayBoundsForDate(DAY, TZ);
    expect(await accountNet(env.scoped, "CASH", { currencyCode: "NGN", to: end })).toBe(counted);
    expect(await accountNet(env.scoped, "CASH_OVER_SHORT", { currencyCode: "NGN" })).toBe(1_500n);
    const tb = await trialBalance(env.scoped, { currencyCode: "NGN" });
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
  });

  it("the FIRST close is the starting point: any count is accepted without a reason and is posted as the opening cash; the next close compares", async () => {
    const { env, input } = await seedDay();
    const first = await previewDailyClose(env.scoped, input, NOW);
    expect(first.isFirstClose).toBe(true);
    const r = await closeDay(env.scoped, { ...input, countedCashMinor: first.expectedCashMinor + 777_000n }, NOW); // no reason given
    expect(r.differenceMinor).toBe(777_000n);
    const adj = await env.scoped.journalEntry.findUniqueOrThrow({ where: { id: r.adjustmentEntryId! } });
    expect(adj.memo).toContain("Opening cash count");
    const next = await previewDailyClose(env.scoped, { ...input, businessDate: "2026-10-21" }, NOW);
    expect(next.isFirstClose).toBe(false);
    expect(next.openingCashMinor).toBe(first.expectedCashMinor + 777_000n);
    await expect(closeDay(env.scoped, { ...input, businessDate: "2026-10-21", countedCashMinor: next.expectedCashMinor - 5n }, NOW)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("an overage is recorded as cash over", async () => {
    const { env, input } = await seedDay();
    await alreadyHasAClose(env, input);
    const expected = (await previewDailyClose(env.scoped, input, NOW)).expectedCashMinor;
    const r = await closeDay(env.scoped, { ...input, countedCashMinor: expected + 300n, differenceReason: "found an old note" }, NOW);
    expect(r.differenceMinor).toBe(300n);
    expect(await accountNet(env.scoped, "CASH_OVER_SHORT", { currencyCode: "NGN" })).toBe(-300n);
  });

  it("the next day's opening cash is what was counted", async () => {
    const { env, input } = await seedDay();
    await alreadyHasAClose(env, input);
    const expected = (await previewDailyClose(env.scoped, input, NOW)).expectedCashMinor;
    await closeDay(env.scoped, { ...input, countedCashMinor: expected - 100n, differenceReason: "short" }, NOW);
    const next = await previewDailyClose(env.scoped, { ...input, businessDate: "2026-10-21" }, NOW);
    // 2026-10-21 Lagos starts at the close of the 20th; the 99,000 cash sale at 00:30 on the 21st is in that day
    expect(next.openingCashMinor).toBe(expected - 100n);
    expect(next.salesCashMinor).toBe(99_000n);
    expect(next.expectedCashMinor).toBe(expected - 100n + 99_000n);
  });

  it("rejects a negative count and refuses to close the same day twice (including a concurrent double tap)", async () => {
    const { env, input } = await seedDay();
    await expect(closeDay(env.scoped, { ...input, countedCashMinor: -1n }, NOW)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    const expected = (await previewDailyClose(env.scoped, input, NOW)).expectedCashMinor;
    const results = await Promise.allSettled([
      closeDay(env.scoped, { ...input, countedCashMinor: expected }, NOW),
      closeDay(env.scoped, { ...input, countedCashMinor: expected }, NOW),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(DailyCloseError);
    expect(await env.scoped.dailyClose.count({ where: {} })).toBe(1);
  });

  it("is tenant-isolated", async () => {
    const { env, input } = await seedDay();
    const other = await makeBusiness(prisma);
    const expected = (await previewDailyClose(env.scoped, input, NOW)).expectedCashMinor;
    await closeDay(env.scoped, { ...input, countedCashMinor: expected }, NOW);
    expect(await listDailyCloses(other.scoped)).toEqual([]);
    const p = await previewDailyClose(other.scoped, { ...input, businessId: other.businessId }, NOW);
    expect(p.expectedCashMinor).toBe(0n);
    expect(p.existingClose).toBeNull();
  });

  it("the database refuses a DailyClose whose difference is not counted minus expected", async () => {
    const env = await makeBusiness(prisma);
    await expect(
      testDb.db.query(`INSERT INTO "DailyClose" (id,"businessId","businessDate","currencyCode","expectedCashMinor","countedCashMinor","differenceMinor",summary) VALUES ('dc-x','${env.businessId}','2026-10-20','NGN',100,90,5,'{}')`),
    ).rejects.toThrow(/check constraint|difference_check/);
  });
});
