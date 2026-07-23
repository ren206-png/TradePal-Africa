import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { recordAuditLog } from "../src/domain/auditLog.js";

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

describe("recordAuditLog", () => {
  it("writes one row per call, capturing actor/action/entity", async () => {
    const row = await recordAuditLog(scoped, {
      businessId,
      actorType: "MERCHANT",
      actorId: "merchant-1",
      action: "DEBT_RECORDED",
      entityType: "Debt",
      entityId: "debt-1",
    });

    expect(row.businessId).toBe(businessId);
    expect(row.actorType).toBe("MERCHANT");
    expect(row.action).toBe("DEBT_RECORDED");
    expect(row.entityType).toBe("Debt");
    expect(row.entityId).toBe("debt-1");
  });

  it("stores metadata as JSON when provided, and defaults to JSON null otherwise", async () => {
    const withMetadata = await recordAuditLog(scoped, {
      businessId,
      actorType: "SYSTEM",
      action: "SOMETHING_HAPPENED",
      entityType: "Business",
      entityId: businessId,
      metadata: { reason: "test" },
    });
    expect(withMetadata.metadata).toEqual({ reason: "test" });

    const withoutMetadata = await recordAuditLog(scoped, {
      businessId,
      actorType: "ADMIN",
      action: "SOMETHING_ELSE_HAPPENED",
      entityType: "Business",
      entityId: businessId,
    });
    expect(withoutMetadata.metadata).toBeNull();
  });

  it("is scoped to the business it was created against", async () => {
    const row = await recordAuditLog(scoped, {
      businessId,
      actorType: "MERCHANT",
      action: "SCOPE_CHECK",
      entityType: "Business",
    });

    const otherBusiness = await prisma.business.create({
      data: { name: "Shop B", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const otherScoped = getTenantScopedClient(prisma, otherBusiness.id);

    const found = await otherScoped.auditLog.findUnique({ where: { id: row.id } });
    expect(found).toBeNull();
  });
});
