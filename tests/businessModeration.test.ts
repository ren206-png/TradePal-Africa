import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  BusinessAlreadySuspendedError,
  BusinessNotFoundError,
  BusinessNotSuspendedError,
  isBusinessSuspended,
  reinstateBusiness,
  suspendBusiness,
} from "../src/domain/businessModeration.js";

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

async function makeBusiness(name: string): Promise<string> {
  const business = await prisma.business.create({
    data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  return business.id;
}

describe("suspendBusiness", () => {
  it("suspends an ACTIVE business, stamping suspendedAt/suspensionReason and recording an audit log", async () => {
    const businessId = await makeBusiness("Violator Shop");

    const suspended = await suspendBusiness(prisma, {
      businessId,
      reason: "Repeated fraudulent payment links reported by customers.",
      suspendedByAdminUserId: "admin-1",
    });

    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.suspendedAt).not.toBeNull();
    expect(suspended.suspensionReason).toBe("Repeated fraudulent payment links reported by customers.");

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "Business", action: "BUSINESS_SUSPENDED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorId).toBe("admin-1");
    expect(auditRows[0]?.actorType).toBe("ADMIN");

    expect(await isBusinessSuspended(prisma, businessId)).toBe(true);
  });

  it("rejects an empty reason", async () => {
    const businessId = await makeBusiness("Empty Reason Shop");
    await expect(suspendBusiness(prisma, { businessId, reason: "   " })).rejects.toThrow(
      "suspendBusiness requires a non-empty reason.",
    );
  });

  it("throws BusinessNotFoundError for an unknown businessId", async () => {
    await expect(suspendBusiness(prisma, { businessId: "does-not-exist", reason: "Any reason" })).rejects.toThrow(
      BusinessNotFoundError,
    );
  });

  it("throws BusinessAlreadySuspendedError when suspending an already-suspended business", async () => {
    const businessId = await makeBusiness("Double Suspend Shop");
    await suspendBusiness(prisma, { businessId, reason: "First violation." });
    await expect(suspendBusiness(prisma, { businessId, reason: "Second attempt." })).rejects.toThrow(
      BusinessAlreadySuspendedError,
    );
  });
});

describe("reinstateBusiness", () => {
  it("clears status/suspendedAt/suspensionReason back to ACTIVE and records an audit log", async () => {
    const businessId = await makeBusiness("Reinstated Shop");
    await suspendBusiness(prisma, { businessId, reason: "Under review." });

    const reinstated = await reinstateBusiness(prisma, {
      businessId,
      reason: "Investigation cleared the merchant.",
      reinstatedByAdminUserId: "admin-2",
    });

    expect(reinstated.status).toBe("ACTIVE");
    expect(reinstated.suspendedAt).toBeNull();
    expect(reinstated.suspensionReason).toBeNull();

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "Business", action: "BUSINESS_REINSTATED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorId).toBe("admin-2");

    expect(await isBusinessSuspended(prisma, businessId)).toBe(false);
  });

  it("throws BusinessNotFoundError for an unknown businessId", async () => {
    await expect(reinstateBusiness(prisma, { businessId: "does-not-exist" })).rejects.toThrow(BusinessNotFoundError);
  });

  it("throws BusinessNotSuspendedError when reinstating a business that isn't suspended", async () => {
    const businessId = await makeBusiness("Never Suspended Shop");
    await expect(reinstateBusiness(prisma, { businessId })).rejects.toThrow(BusinessNotSuspendedError);
  });
});

describe("isBusinessSuspended", () => {
  it("returns false for an unknown businessId rather than throwing", async () => {
    expect(await isBusinessSuspended(prisma, "does-not-exist")).toBe(false);
  });
});
