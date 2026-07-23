import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  sendWeeklyBusinessDigests,
  computeWeeklyDigest,
  buildWeeklyDigestMessage,
  buildWeeklyDigestTemplateParams,
  WEEKLY_DIGEST_JOB_NAME,
  WEEKLY_DIGEST_FEATURE_FLAG_KEY,
} from "../src/domain/businessDigest.js";
import { getWeekBoundsInTimezone } from "../src/domain/dailySummary.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";
import { setFeatureFlagForBusiness } from "../src/domain/featureFlags.js";
import { recordTransaction } from "../src/domain/ledger.js";
import { recordDebtNote } from "../src/domain/debtBook.js";

let testDb: TestDb;
let prisma: PrismaClient;

// A fixed instant inside a fixed Wednesday so every test summarizes the same
// completed Mon-Sun week regardless of when the suite actually runs.
const NOW = new Date("2026-07-08T22:30:00Z"); // Wednesday, Africa/Lagos local time 23:30

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  await prisma.featureFlag.create({
    data: { key: WEEKLY_DIGEST_FEATURE_FLAG_KEY, description: "test flag", enabledByDefault: false },
  });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

let businessCounter = 0;

async function makeBusiness(createdAt: Date = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000)): Promise<string> {
  businessCounter++;
  const business = await prisma.business.create({
    data: {
      name: `Shop ${businessCounter}`,
      countryCode: "NG",
      currencyCode: "NGN",
      languageCode: "en",
      timezone: "Africa/Lagos",
    },
  });
  // createdAt has @default(now()) with no direct setter on create; backdate it explicitly
  // so "business too new" guard tests can control whether the business predates the week.
  await prisma.business.update({ where: { id: business.id }, data: { createdAt } });
  return business.id;
}

describe("computeWeeklyDigest / buildWeeklyDigestMessage", () => {
  it("totals the completed week's transactions and finds the largest open debt", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    const { start } = getWeekBoundsInTimezone(NOW, "Africa/Lagos");
    const withinWeek = new Date(start.getTime() + 60 * 60 * 1000);

    const sale = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 10_000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await prisma.transaction.update({ where: { id: sale.id }, data: { createdAt: withinWeek } });

    const expense = await recordTransaction(scoped, {
      businessId,
      type: "EXPENSE",
      amountMinor: 3_000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await prisma.transaction.update({ where: { id: expense.id }, data: { createdAt: withinWeek } });

    // Outside the week entirely — must not be counted.
    await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 999_999n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });

    await recordDebtNote(scoped, {
      businessId,
      customerId: (await scoped.customer.create({ data: { businessId, name: "Small Debtor" } })).id,
      customerName: "Small Debtor",
      amountMinor: 500n,
      currencyCode: "NGN",
    });
    await recordDebtNote(scoped, {
      businessId,
      customerId: (await scoped.customer.create({ data: { businessId, name: "Big Debtor" } })).id,
      customerName: "Big Debtor",
      amountMinor: 7_000n,
      currencyCode: "NGN",
    });

    const digest = await computeWeeklyDigest(scoped, "Africa/Lagos", NOW);

    // Only the 2 explicitly-backdated transactions fall inside the mocked week; the
    // "outside the week" sale above and the debt-note transactions below (which use
    // their own real createdAt, not NOW) are correctly excluded.
    expect(digest.summary.transactionCount).toBe(2);
    expect(digest.summary.totalSalesMinor).toBe(10_000n);
    expect(digest.summary.totalExpensesMinor).toBe(3_000n);
    expect(digest.topDebtor?.customerName).toBe("Big Debtor");
    expect(digest.topDebtor?.outstandingAmountMinor).toBe(7_000n);

    const message = buildWeeklyDigestMessage(digest, "Africa/Lagos", "NGN", 2);
    expect(message).toContain("Sales: 100.00 NGN");
    expect(message).toContain("Expenses: 30.00 NGN");
    expect(message).toContain("Top outstanding debt: Big Debtor owes 70.00 NGN");
  });

  it("reports no outstanding debts when the business has none", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);

    const digest = await computeWeeklyDigest(scoped, "Africa/Lagos", NOW);
    expect(digest.topDebtor).toBeNull();
    expect(buildWeeklyDigestMessage(digest, "Africa/Lagos", "NGN", 2)).toContain("No outstanding debts.");
  });

  /**
   * Phase 14 gap closure verification (added under a later "build all" once
   * investigation found this specific behavior — WeeklyDigest.previousWeekSummary
   * and formatWeekOverWeekLine — had shipped with zero test coverage; the other
   * two candidates originally proposed alongside it turned out to already be
   * covered or to be deliberate non-goals, see PHASE_0_FINDINGS.md).
   */
  it("buckets a transaction from the immediately preceding completed week into previousWeekSummary, and renders a signed vs-last-week delta", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    const { start } = getWeekBoundsInTimezone(NOW, "Africa/Lagos");
    const previousWeekStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
    const withinPreviousWeek = new Date(previousWeekStart.getTime() + 60 * 60 * 1000);
    const withinCurrentWeek = new Date(start.getTime() + 60 * 60 * 1000);

    const lastWeekSale = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 5_000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await prisma.transaction.update({ where: { id: lastWeekSale.id }, data: { createdAt: withinPreviousWeek } });

    const thisWeekSale = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 8_000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await prisma.transaction.update({ where: { id: thisWeekSale.id }, data: { createdAt: withinCurrentWeek } });

    const digest = await computeWeeklyDigest(scoped, "Africa/Lagos", NOW);

    expect(digest.previousWeekSummary.transactionCount).toBe(1);
    expect(digest.previousWeekSummary.totalSalesMinor).toBe(5_000n);
    expect(digest.previousWeekSummary.netMinor).toBe(5_000n);
    expect(digest.summary.transactionCount).toBe(1);
    expect(digest.summary.totalSalesMinor).toBe(8_000n);

    const message = buildWeeklyDigestMessage(digest, "Africa/Lagos", "NGN", 2);
    expect(message).toContain("vs last week: +30.00 NGN (last week's net was 50.00 NGN)");
  });

  it("reports 'no data from the previous week to compare' rather than a misleading delta when the previous week had no transactions", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    const { start } = getWeekBoundsInTimezone(NOW, "Africa/Lagos");
    const withinCurrentWeek = new Date(start.getTime() + 60 * 60 * 1000);

    const thisWeekSale = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 4_000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await prisma.transaction.update({ where: { id: thisWeekSale.id }, data: { createdAt: withinCurrentWeek } });

    const digest = await computeWeeklyDigest(scoped, "Africa/Lagos", NOW);
    expect(digest.previousWeekSummary.transactionCount).toBe(0);

    const message = buildWeeklyDigestMessage(digest, "Africa/Lagos", "NGN", 2);
    expect(message).toContain("vs last week: no data from the previous week to compare.");
  });
});

describe("sendWeeklyBusinessDigests", () => {
  it("skips a business whose feature flag is off", async () => {
    const businessId = await makeBusiness();
    await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220001" } });

    const fetchImpl = vi.fn();
    const result = await sendWeeklyBusinessDigests(prisma, NOW, { accessToken: "t", phoneNumberId: "p", fetchImpl });

    expect(result.processedBusinessIds).not.toContain(businessId);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a business created after the week being summarized ('too new' guard)", async () => {
    const { end } = getWeekBoundsInTimezone(NOW, "Africa/Lagos");
    const businessId = await makeBusiness(new Date(end.getTime() + 60 * 60 * 1000));
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, WEEKLY_DIGEST_FEATURE_FLAG_KEY, true);
    await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220002" } });

    const fetchImpl = vi.fn();
    const result = await sendWeeklyBusinessDigests(prisma, NOW, { accessToken: "t", phoneNumberId: "p", fetchImpl });

    expect(result.processedBusinessIds).not.toContain(businessId);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing when the flag is on but no outboundGateway is supplied, and writes no marker", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, WEEKLY_DIGEST_FEATURE_FLAG_KEY, true);
    await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220003" } });

    const result = await sendWeeklyBusinessDigests(prisma, NOW);
    expect(result.processedBusinessIds).not.toContain(businessId);

    const markerRows = await prisma.auditLog.findMany({
      where: { businessId, action: "WEEKLY_DIGEST_PERIOD_PROCESSED" },
    });
    expect(markerRows).toHaveLength(0);

    // Turn the flag back off so this still-unprocessed business doesn't get swept up
    // (and its merchant messaged) by a later test's full-database sweep with a gateway.
    await setFeatureFlagForBusiness(scoped, businessId, WEEKLY_DIGEST_FEATURE_FLAG_KEY, false);
  });

  it("sends the digest to every registered merchant and writes per-merchant + period audit rows", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, WEEKLY_DIGEST_FEATURE_FLAG_KEY, true);
    const merchantA = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220004" } });
    const merchantB = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220005", role: "STAFF" } });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    const result = await sendWeeklyBusinessDigests(prisma, NOW, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });

    expect(result.processedBusinessIds).toEqual([businessId]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sentTo = fetchImpl.mock.calls.map((call) => (JSON.parse((call[1] as RequestInit).body as string) as { to: string }).to);
    expect(sentTo.sort()).toEqual([merchantA.phoneNumber, merchantB.phoneNumber].sort());

    const sentRows = await prisma.auditLog.findMany({ where: { businessId, action: "WEEKLY_DIGEST_SENT" } });
    expect(sentRows).toHaveLength(2);
    expect(sentRows[0]?.actorType).toBe("SYSTEM");
    expect(sentRows[0]?.actorId).toBe(WEEKLY_DIGEST_JOB_NAME);

    const markerRows = await prisma.auditLog.findMany({
      where: { businessId, action: "WEEKLY_DIGEST_PERIOD_PROCESSED", entityType: "WeeklyDigestPeriod" },
    });
    expect(markerRows).toHaveLength(1);
  });

  it("is idempotent — a second sweep for the same week does not resend or double-mark", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, WEEKLY_DIGEST_FEATURE_FLAG_KEY, true);
    await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220006" } });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    const first = await sendWeeklyBusinessDigests(prisma, NOW, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });
    expect(first.processedBusinessIds).toEqual([businessId]);

    const second = await sendWeeklyBusinessDigests(prisma, NOW, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });
    expect(second.processedBusinessIds).not.toContain(businessId);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the first sweep's single merchant send

    const markerRows = await prisma.auditLog.findMany({
      where: { businessId, action: "WEEKLY_DIGEST_PERIOD_PROCESSED" },
    });
    expect(markerRows).toHaveLength(1);
  });

  it("audits a failed send without blocking the period marker from being written", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, WEEKLY_DIGEST_FEATURE_FLAG_KEY, true);
    const merchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220007" } });

    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const result = await sendWeeklyBusinessDigests(prisma, NOW, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });

    expect(result.processedBusinessIds).toEqual([businessId]);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 400 is non-retryable

    const failedRows = await prisma.auditLog.findMany({
      where: { businessId, action: "WEEKLY_DIGEST_SEND_FAILED", entityId: merchant.id },
    });
    expect(failedRows).toHaveLength(1);

    const markerRows = await prisma.auditLog.findMany({
      where: { businessId, action: "WEEKLY_DIGEST_PERIOD_PROCESSED" },
    });
    expect(markerRows).toHaveLength(1);
  });

  /**
   * Phase 18 gap closure: mirrors tests/subscriptionExpiry.test.ts's own
   * "sends via a Meta-approved template" test — the identical 24-hour-window
   * delivery risk Phase 9 fixed for the lapse notification was never fixed
   * for the weekly digest until now.
   */
  it("sends via a Meta-approved template (not free-form text) when weeklyDigestTemplate is configured", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, WEEKLY_DIGEST_FEATURE_FLAG_KEY, true);
    const merchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220008" } });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await sendWeeklyBusinessDigests(prisma, NOW, {
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
      weeklyDigestTemplate: { name: "weekly_digest_notice", languageCode: "en_US" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("weekly_digest_notice");
    expect(body.template.language).toEqual({ code: "en_US" });
    expect(body.template.components).toHaveLength(1);
    expect(body.template.components[0].parameters).toHaveLength(7);

    const sentRows = await prisma.auditLog.findMany({
      where: { businessId, action: "WEEKLY_DIGEST_SENT", entityId: merchant.id },
    });
    expect(sentRows).toHaveLength(1);
    expect((sentRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("template");
  });

  it("buildWeeklyDigestTemplateParams returns the same 7 lines buildWeeklyDigestMessage joins into free-form text", async () => {
    const businessId = await makeBusiness();
    const scoped = getTenantScopedClient(prisma, businessId);

    const digest = await computeWeeklyDigest(scoped, "Africa/Lagos", NOW);
    const params = buildWeeklyDigestTemplateParams(digest, "Africa/Lagos", "NGN", 2);
    const message = buildWeeklyDigestMessage(digest, "Africa/Lagos", "NGN", 2);

    expect(params).toHaveLength(7);
    expect(params.join("\n")).toBe(message);
  });
});
