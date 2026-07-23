import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, TenantIsolationViolationError } from "../src/db/tenantScope.js";

let testDb: TestDb;
let prisma: PrismaClient;
let businessAId: string;
let businessBId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  const businessA = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Shop B", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessAId = businessA.id;
  businessBId = businessB.id;
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("tenant-isolation Prisma Client extension", () => {
  it("defaults businessId on create when omitted", async () => {
    const scopedA = getTenantScopedClient(prisma, businessAId);

    const customer = await scopedA.customer.create({ data: { businessId: businessAId, name: "John the tailor" } });
    expect(customer.businessId).toBe(businessAId);
  });

  it("rejects a create whose data names a different business than the active scope", async () => {
    const scopedA = getTenantScopedClient(prisma, businessAId);

    await expect(
      scopedA.customer.create({ data: { businessId: businessBId, name: "Sneaky cross-tenant write" } }),
    ).rejects.toThrow(TenantIsolationViolationError);
  });

  it("scopes reads so business A cannot see business B's rows", async () => {
    const scopedA = getTenantScopedClient(prisma, businessAId);
    const scopedB = getTenantScopedClient(prisma, businessBId);

    await scopedB.customer.create({ data: { businessId: businessBId, name: "Customer only visible to B" } });

    const aCustomers = await scopedA.customer.findMany();
    expect(aCustomers.every((c) => c.businessId === businessAId)).toBe(true);
    expect(aCustomers.some((c) => c.name === "Customer only visible to B")).toBe(false);
  });

  it("cannot be bypassed by passing another business's id in the where clause", async () => {
    const scopedA = getTenantScopedClient(prisma, businessAId);
    const bCustomer = await prisma.customer.findFirstOrThrow({ where: { businessId: businessBId } });

    const result = await scopedA.customer.findUnique({ where: { id: bCustomer.id } });
    expect(result).toBeNull();
  });

  it("blocks update and delete on Transaction, the append-only ledger table", async () => {
    const scopedA = getTenantScopedClient(prisma, businessAId);

    const transaction = await scopedA.transaction.create({
      data: { businessId: businessAId, type: "SALE", amountMinor: 1000n, currencyCode: "NGN", paymentStatus: "PAID" },
    });

    await expect(
      scopedA.transaction.update({ where: { id: transaction.id }, data: { amountMinor: 2000n } }),
    ).rejects.toThrow(TenantIsolationViolationError);

    await expect(scopedA.transaction.delete({ where: { id: transaction.id } })).rejects.toThrow(
      TenantIsolationViolationError,
    );
  });
});
