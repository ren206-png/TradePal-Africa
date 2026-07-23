import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { recordTransaction } from "../src/domain/ledger.js";
import {
  getDayBoundsInTimezone,
  getDailySummary,
  getMonthBoundsInTimezone,
  getWeekBoundsInTimezone,
} from "../src/domain/dailySummary.js";

let testDb: TestDb;
let prisma: PrismaClient;
let scoped: TenantScopedClient;
let businessId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  const business = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessId = business.id;
  scoped = getTenantScopedClient(prisma, businessId);
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("getDayBoundsInTimezone", () => {
  it("computes midnight-to-midnight bounds in the given IANA timezone, not UTC", () => {
    // Africa/Lagos is UTC+1 year-round (no DST).
    const now = new Date("2026-07-08T22:30:00Z"); // 23:30 local Lagos time
    const { start, end } = getDayBoundsInTimezone(now, "Africa/Lagos");

    expect(start.toISOString()).toBe("2026-07-07T23:00:00.000Z"); // 2026-07-08T00:00:00 Lagos
    expect(end.toISOString()).toBe("2026-07-08T23:00:00.000Z");
  });
});

describe("getMonthBoundsInTimezone", () => {
  it("computes 1st-of-month-to-1st-of-next-month bounds in the given IANA timezone, not UTC", () => {
    // Africa/Lagos is UTC+1 year-round (no DST).
    const now = new Date("2026-07-08T22:30:00Z"); // 23:30 local Lagos time, mid-July
    const { start, end } = getMonthBoundsInTimezone(now, "Africa/Lagos");

    expect(start.toISOString()).toBe("2026-06-30T23:00:00.000Z"); // 2026-07-01T00:00:00 Lagos
    expect(end.toISOString()).toBe("2026-07-31T23:00:00.000Z"); // 2026-08-01T00:00:00 Lagos
  });

  it("handles a date right at the start of the month correctly", () => {
    const now = new Date("2026-01-01T00:30:00Z"); // 01:30 local Lagos time, Jan 1st
    const { start, end } = getMonthBoundsInTimezone(now, "Africa/Lagos");

    expect(start.toISOString()).toBe("2025-12-31T23:00:00.000Z"); // 2026-01-01T00:00:00 Lagos
    expect(end.toISOString()).toBe("2026-01-31T23:00:00.000Z"); // 2026-02-01T00:00:00 Lagos
  });
});

describe("getWeekBoundsInTimezone", () => {
  it("returns the most recently completed Mon-Sun week, not the still-in-progress current week", () => {
    // Africa/Lagos is UTC+1 year-round (no DST). 2026-07-08 is a Wednesday.
    const now = new Date("2026-07-08T22:30:00Z"); // 23:30 local Lagos time, Wednesday
    const { start, end } = getWeekBoundsInTimezone(now, "Africa/Lagos");

    expect(start.toISOString()).toBe("2026-06-28T23:00:00.000Z"); // 2026-06-29T00:00:00 Lagos (Monday)
    expect(end.toISOString()).toBe("2026-07-05T23:00:00.000Z"); // 2026-07-06T00:00:00 Lagos (Monday)
  });

  it("still returns last week's Mon-Sun bounds early on the Monday the new week starts", () => {
    const now = new Date("2026-07-06T00:30:00Z"); // 01:30 local Lagos time, Monday
    const { start, end } = getWeekBoundsInTimezone(now, "Africa/Lagos");

    expect(start.toISOString()).toBe("2026-06-28T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-05T23:00:00.000Z");
  });
});

describe("getDailySummary", () => {
  it("totals only today's transactions in the business timezone, split by type", async () => {
    const now = new Date();
    const { start } = getDayBoundsInTimezone(now, "Africa/Lagos");
    const yesterday = new Date(start.getTime() - 60 * 60 * 1000);

    await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 5000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await recordTransaction(scoped, {
      businessId,
      type: "EXPENSE",
      amountMinor: 1200n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await recordTransaction(scoped, {
      businessId,
      type: "PAYMENT_RECEIVED",
      amountMinor: 800n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });

    // A transaction from "yesterday" (in business-local time) that must be excluded.
    const stale = await prisma.transaction.create({
      data: {
        businessId,
        type: "SALE",
        amountMinor: 999999n,
        currencyCode: "NGN",
        paymentStatus: "PAID",
      },
    });
    await prisma.transaction.update({ where: { id: stale.id }, data: { createdAt: yesterday } });

    const summary = await getDailySummary(scoped, "Africa/Lagos", now);

    expect(summary.transactionCount).toBe(3);
    expect(summary.totalSalesMinor).toBe(5000n);
    expect(summary.totalExpensesMinor).toBe(1200n);
    expect(summary.totalPaymentsReceivedMinor).toBe(800n);
    expect(summary.netMinor).toBe(5000n + 1200n + 800n);
  });
});
