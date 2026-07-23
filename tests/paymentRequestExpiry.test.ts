import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  expireStalePaymentRequests,
  PAYMENT_REQUEST_EXPIRY_HOURS,
  PAYMENT_REQUEST_EXPIRY_JOB_NAME,
} from "../src/domain/paymentRequestExpiry.js";

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

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

describe("expireStalePaymentRequests", () => {
  it("flips a PENDING PaymentRequest older than the staleness window to EXPIRED and records a SYSTEM-attributed audit log", async () => {
    const businessId = await makeBusiness("Stale Paylink Shop");
    const now = new Date();

    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        businessId,
        description: "Bag of rice",
        amountMinor: 120000n,
        currencyCode: "NGN",
        status: "PENDING",
        createdAt: hoursAgo(now, PAYMENT_REQUEST_EXPIRY_HOURS + 1),
      },
    });

    const result = await expireStalePaymentRequests(prisma, now);

    expect(result.expiredCount).toBe(1);
    expect(result.expiredPaymentRequestIds).toContain(paymentRequest.id);

    const reloaded = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
    expect(reloaded.status).toBe("EXPIRED");

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "PaymentRequest", entityId: paymentRequest.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("SYSTEM");
    expect(auditRows[0]?.actorId).toBe(PAYMENT_REQUEST_EXPIRY_JOB_NAME);
    expect(auditRows[0]?.action).toBe("PAYMENT_REQUEST_EXPIRED");
  });

  it("leaves a PENDING PaymentRequest within the staleness window untouched", async () => {
    const businessId = await makeBusiness("Fresh Paylink Shop");
    const now = new Date();

    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        businessId,
        description: "Bag of beans",
        amountMinor: 90000n,
        currencyCode: "NGN",
        status: "PENDING",
        createdAt: hoursAgo(now, PAYMENT_REQUEST_EXPIRY_HOURS - 1),
      },
    });

    const result = await expireStalePaymentRequests(prisma, now);

    expect(result.expiredPaymentRequestIds).not.toContain(paymentRequest.id);

    const reloaded = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
    expect(reloaded.status).toBe("PENDING");
  });

  it("leaves a PAID PaymentRequest untouched even if it's old", async () => {
    const businessId = await makeBusiness("Paid Paylink Shop");
    const now = new Date();

    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        businessId,
        description: "Crate of eggs",
        amountMinor: 300000n,
        currencyCode: "NGN",
        status: "PAID",
        createdAt: hoursAgo(now, PAYMENT_REQUEST_EXPIRY_HOURS + 48),
        paidAt: hoursAgo(now, PAYMENT_REQUEST_EXPIRY_HOURS + 24),
      },
    });

    const result = await expireStalePaymentRequests(prisma, now);

    expect(result.expiredPaymentRequestIds).not.toContain(paymentRequest.id);

    const reloaded = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
    expect(reloaded.status).toBe("PAID");
  });

  it("is idempotent: running the sweep again after a prior run doesn't re-expire or double-audit the same row", async () => {
    const businessId = await makeBusiness("Idempotent Paylink Shop");
    const now = new Date();

    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        businessId,
        description: "Sack of onions",
        amountMinor: 50000n,
        currencyCode: "NGN",
        status: "PENDING",
        createdAt: hoursAgo(now, PAYMENT_REQUEST_EXPIRY_HOURS + 1),
      },
    });

    const first = await expireStalePaymentRequests(prisma, now);
    expect(first.expiredPaymentRequestIds).toContain(paymentRequest.id);

    const second = await expireStalePaymentRequests(prisma, now);
    expect(second.expiredPaymentRequestIds).not.toContain(paymentRequest.id);

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "PaymentRequest", entityId: paymentRequest.id },
    });
    expect(auditRows).toHaveLength(1);
  });
});
