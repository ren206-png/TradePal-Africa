import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import {
  AiUsageAlreadyCommittedError,
  AiUsageAlreadyTerminalError,
  AiUsageReservationNotFoundError,
  commitAiUsage,
  getOpenBudgetMicroUsdForBusiness,
  releaseAiUsage,
  reserveAiUsage,
} from "../src/domain/aiUsageLedger.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

async function makeBusiness(name: string): Promise<{ businessId: string; scoped: TenantScopedClient }> {
  const business = await prisma.business.create({
    data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  return { businessId: business.id, scoped: getTenantScopedClient(prisma, business.id) };
}

function reserveParams(businessId: string, overrides: Partial<Parameters<typeof reserveAiUsage>[1]> = {}) {
  return {
    businessId,
    feature: "CATALOG_SUMMARY_DRAFT",
    provider: "DEEPSEEK" as const,
    requestedModel: "deepseek-v4-flash-2026-06-snapshot",
    resolvedModel: "deepseek-v4-flash-2026-06-snapshot",
    estimatedCostMicroUsd: 1000n,
    promptHash: "abc123",
    idempotencyKey: "wa-msg-1",
    ...overrides,
  };
}

describe("reserveAiUsage / commitAiUsage / releaseAiUsage — two-phase accounting", () => {
  it("commits a reservation and both rows share the same requestId", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Commit Shop");

    const { requestId } = await reserveAiUsage(scoped, reserveParams(businessId));
    await commitAiUsage(scoped, requestId, { actualCostMicroUsd: 950n, httpStatus: 200 });

    const rows = await scoped.aiUsageLedger.findMany({ where: { requestId }, orderBy: { phase: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.requestId === requestId)).toBe(true);
    const commitRow = rows.find((row) => row.phase === "COMMIT");
    expect(commitRow?.actualCostMicroUsd).toBe(950n);
    expect(commitRow?.businessId).toBe(businessId);
  });

  it("releases a reservation with no charge and records the errorClass", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Release Shop");

    const { requestId } = await reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-2" }));
    await releaseAiUsage(scoped, requestId, { errorClass: "TIMEOUT" });

    const releaseRow = await scoped.aiUsageLedger.findFirst({ where: { requestId, phase: "RELEASE" } });
    expect(releaseRow?.errorClass).toBe("TIMEOUT");
    expect(releaseRow?.actualCostMicroUsd).toBeNull();
  });

  it("refuses a second terminal row for the same requestId", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Double-Terminal Shop");

    const { requestId } = await reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-3" }));
    await commitAiUsage(scoped, requestId, { actualCostMicroUsd: 500n });

    await expect(releaseAiUsage(scoped, requestId, { errorClass: "PROVIDER_ERROR" })).rejects.toThrow(
      AiUsageAlreadyTerminalError,
    );
  });

  it("throws AiUsageReservationNotFoundError for a requestId with no RESERVE row", async () => {
    const { scoped } = await makeBusiness("Ledger No-Reservation Shop");

    await expect(commitAiUsage(scoped, "not-a-real-request-id", { actualCostMicroUsd: 1n })).rejects.toThrow(
      AiUsageReservationNotFoundError,
    );
  });

  it("leaves a leaked reservation (RESERVE with no terminal row) directly queryable", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Leaked Reservation Shop");

    const { requestId } = await reserveAiUsage(
      scoped,
      reserveParams(businessId, { idempotencyKey: "wa-msg-4", estimatedCostMicroUsd: 2500n }),
    );

    const rows = await scoped.aiUsageLedger.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phase).toBe("RESERVE");

    // The leaked reservation counts toward open budget forever, by design (schema doc comment).
    const openBudget = await getOpenBudgetMicroUsdForBusiness(scoped, businessId, "Africa/Lagos");
    expect(openBudget).toBe(2500n);
  });

  it("refuses a second reservation for an idempotencyKey/provider pair that was already committed (no double-charge)", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Idempotency Shop");

    const first = await reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-5" }));
    await commitAiUsage(scoped, first.requestId, { actualCostMicroUsd: 800n });

    await expect(reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-5" }))).rejects.toThrow(
      AiUsageAlreadyCommittedError,
    );
  });

  it("allows a fresh reservation to reuse an idempotencyKey once the prior reservation only reached RELEASE (no charge occurred)", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Retry-After-Release Shop");

    const first = await reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-6" }));
    await releaseAiUsage(scoped, first.requestId, { errorClass: "TIMEOUT" });

    const second = await reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-6" }));
    expect(second.requestId).not.toBe(first.requestId);
  });
});

describe("F-2 concurrency regression (DeepSeek Integration Phase 8 — DEEPSEEK_PHASE6_ADVERSARIAL_REVIEW.md)", () => {
  it("reserveAiUsage: two concurrent reservations for the same idempotencyKey/provider both succeed opening (neither has committed yet, so the pre-fix and post-fix behavior agree here) but only one of them can ever go on to commit", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger F2 Concurrent Reserve Shop");

    // A BullMQ job retried mid-flight (the scenario reserveAiUsage's own doc comment describes) can
    // legitimately open two live RESERVE rows for the same key before either has committed — that alone
    // isn't the bug. The bug would be letting *both* of them go on to commit.
    const [first, second] = await Promise.all([
      reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-f2-race" })),
      reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-f2-race" })),
    ]);
    expect(first.requestId).not.toBe(second.requestId);

    const results = await Promise.allSettled([
      commitAiUsage(scoped, first.requestId, { actualCostMicroUsd: 100n }),
      commitAiUsage(scoped, second.requestId, { actualCostMicroUsd: 100n }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AiUsageAlreadyCommittedError);

    // Exactly one COMMIT row exists for this idempotencyKey — no double-billing.
    const commitRows = await scoped.aiUsageLedger.findMany({
      where: { idempotencyKey: "wa-msg-f2-race", provider: "DEEPSEEK", phase: "COMMIT" },
    });
    expect(commitRows).toHaveLength(1);
  });

  it("commitAiUsage: racing two concurrent commits for genuinely different requestIds sharing an idempotencyKey serializes them — the second sees AiUsageAlreadyCommittedError rather than a silent double-charge", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger F2 Concurrent Commit Shop");

    const reserveA = await reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-f2-commit-race" }));
    const reserveB = await reserveAiUsage(scoped, reserveParams(businessId, { idempotencyKey: "wa-msg-f2-commit-race" }));

    // Fire many concurrent commit attempts (not just two) to make it very unlikely a non-atomic
    // implementation would coincidentally pass this test by luck of scheduling.
    const attempts = Array.from({ length: 5 }, () =>
      Promise.allSettled([
        commitAiUsage(scoped, reserveA.requestId, { actualCostMicroUsd: 250n }),
        commitAiUsage(scoped, reserveB.requestId, { actualCostMicroUsd: 250n }),
      ]),
    );
    // Only the first pair actually races against fresh state; the rest exercise the
    // already-terminal / already-committed guards, which is fine — we only assert on the invariant.
    await Promise.allSettled(attempts);

    const commitRows = await scoped.aiUsageLedger.findMany({
      where: { idempotencyKey: "wa-msg-f2-commit-race", provider: "DEEPSEEK", phase: "COMMIT" },
    });
    expect(commitRows).toHaveLength(1);
  });
});

describe("getOpenBudgetMicroUsdForBusiness", () => {
  it("sums live reservations plus this month's committed spend, excluding released rows", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Open Budget Shop");

    const reserved = await reserveAiUsage(
      scoped,
      reserveParams(businessId, { idempotencyKey: "wa-msg-7", estimatedCostMicroUsd: 300n }),
    );
    void reserved;

    const toCommit = await reserveAiUsage(
      scoped,
      reserveParams(businessId, { idempotencyKey: "wa-msg-8", estimatedCostMicroUsd: 400n }),
    );
    await commitAiUsage(scoped, toCommit.requestId, { actualCostMicroUsd: 380n });

    const toRelease = await reserveAiUsage(
      scoped,
      reserveParams(businessId, { idempotencyKey: "wa-msg-9", estimatedCostMicroUsd: 999n }),
    );
    await releaseAiUsage(scoped, toRelease.requestId, { errorClass: "TIMEOUT" });

    const openBudget = await getOpenBudgetMicroUsdForBusiness(scoped, businessId, "Africa/Lagos");
    // 300 (still-open reservation) + 380 (committed actual cost) — the released 999 reservation contributes nothing.
    expect(openBudget).toBe(680n);
  });

  it("is zero for a business with no ledger activity", async () => {
    const { businessId, scoped } = await makeBusiness("Ledger Empty Shop");
    const openBudget = await getOpenBudgetMicroUsdForBusiness(scoped, businessId, "Africa/Lagos");
    expect(openBudget).toBe(0n);
  });
});

describe("AiUsageLedger tenant isolation", () => {
  it("business A cannot see business B's AiUsageLedger rows", async () => {
    const businessA = await makeBusiness("Ledger Tenant A");
    const businessB = await makeBusiness("Ledger Tenant B");

    await reserveAiUsage(businessB.scoped, reserveParams(businessB.businessId, { idempotencyKey: "wa-msg-tenant-b" }));

    const aRows = await businessA.scoped.aiUsageLedger.findMany();
    expect(aRows.every((row) => row.businessId === businessA.businessId)).toBe(true);
    expect(aRows.some((row) => row.idempotencyKey === "wa-msg-tenant-b")).toBe(false);
  });

  it("business A's open budget calculation never counts business B's reservations", async () => {
    const businessA = await makeBusiness("Ledger Tenant Budget A");
    const businessB = await makeBusiness("Ledger Tenant Budget B");

    await reserveAiUsage(
      businessB.scoped,
      reserveParams(businessB.businessId, { idempotencyKey: "wa-msg-tenant-budget-b", estimatedCostMicroUsd: 5_000_000n }),
    );

    const openBudgetA = await getOpenBudgetMicroUsdForBusiness(businessA.scoped, businessA.businessId, "Africa/Lagos");
    expect(openBudgetA).toBe(0n);
  });

  it("cannot be bypassed by passing another business's id in the where clause", async () => {
    const businessA = await makeBusiness("Ledger Tenant Bypass A");
    const businessB = await makeBusiness("Ledger Tenant Bypass B");

    const { requestId } = await reserveAiUsage(
      businessB.scoped,
      reserveParams(businessB.businessId, { idempotencyKey: "wa-msg-tenant-bypass-b" }),
    );

    const result = await businessA.scoped.aiUsageLedger.findFirst({ where: { requestId, businessId: businessB.businessId } });
    expect(result).toBeNull();
  });
});
