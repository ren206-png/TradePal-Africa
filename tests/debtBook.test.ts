import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import {
  createDebt,
  DebtOverpaymentError,
  findOrCreateCustomerByName,
  listOpenDebtsByCustomer,
  listOpenDebtsForCustomer,
  recordPaymentForCustomer,
} from "../src/domain/debtBook.js";

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

describe("findOrCreateCustomerByName", () => {
  it("creates a customer once and reuses it case-insensitively thereafter", async () => {
    const created = await findOrCreateCustomerByName(scoped, businessId, "John the tailor");
    const reused = await findOrCreateCustomerByName(scoped, businessId, "JOHN THE TAILOR");

    expect(reused.id).toBe(created.id);
  });
});

describe("recordPaymentForCustomer", () => {
  it("allocates a payment across a customer's open debts oldest-first, one PAYMENT_RECEIVED transaction per debt", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Amina");

    const first = await createDebt(scoped, {
      businessId,
      customerId: customer.id,
      amountMinor: 3000n,
      currencyCode: "NGN",
    });
    const second = await createDebt(scoped, {
      businessId,
      customerId: customer.id,
      amountMinor: 5000n,
      currencyCode: "NGN",
    });

    const settlements = await recordPaymentForCustomer(scoped, {
      businessId,
      customerId: customer.id,
      amountMinor: 4000n,
    });

    expect(settlements).toHaveLength(2);
    expect(settlements[0]?.debt.id).toBe(first.id);
    expect(settlements[0]?.amountApplied).toBe(3000n);
    expect(settlements[0]?.debt.status).toBe("PAID");
    expect(settlements[1]?.debt.id).toBe(second.id);
    expect(settlements[1]?.amountApplied).toBe(1000n);
    expect(settlements[1]?.debt.status).toBe("PARTIALLY_PAID");
    expect(settlements[1]?.debt.outstandingAmountMinor).toBe(4000n);

    const remainingOpen = await listOpenDebtsForCustomer(scoped, customer.id);
    expect(remainingOpen).toHaveLength(1);
    expect(remainingOpen[0]?.outstandingAmountMinor).toBe(4000n);
  });

  it("refuses a payment that exceeds the customer's total outstanding debt, applying nothing", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Bello");
    await createDebt(scoped, { businessId, customerId: customer.id, amountMinor: 1000n, currencyCode: "NGN" });

    await expect(
      recordPaymentForCustomer(scoped, { businessId, customerId: customer.id, amountMinor: 5000n }),
    ).rejects.toThrow(DebtOverpaymentError);

    const openDebts = await listOpenDebtsForCustomer(scoped, customer.id);
    expect(openDebts[0]?.outstandingAmountMinor).toBe(1000n);
  });

  it("summarises everyone who owes money, one row per customer, biggest balance first, ignoring settled debts", async () => {
    const business = await prisma.business.create({
      data: { name: "Shop Debts", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const sc = getTenantScopedClient(prisma, business.id);
    expect(await listOpenDebtsByCustomer(sc)).toEqual([]);

    const small = await findOrCreateCustomerByName(sc, business.id, "Small Payer");
    const big = await findOrCreateCustomerByName(sc, business.id, "Big Payer");
    const settled = await findOrCreateCustomerByName(sc, business.id, "Settled");
    await createDebt(sc, { businessId: business.id, customerId: small.id, amountMinor: 10000n, currencyCode: "NGN" });
    await createDebt(sc, { businessId: business.id, customerId: big.id, amountMinor: 50000n, currencyCode: "NGN" });
    await createDebt(sc, { businessId: business.id, customerId: big.id, amountMinor: 20000n, currencyCode: "NGN", dueDate: new Date("2026-01-01T00:00:00Z") });
    await createDebt(sc, { businessId: business.id, customerId: settled.id, amountMinor: 30000n, currencyCode: "NGN" });
    await recordPaymentForCustomer(sc, { businessId: business.id, customerId: settled.id, amountMinor: 30000n });

    const rows = await listOpenDebtsByCustomer(sc);
    expect(rows.map((r) => [r.customerName, r.totalOutstandingMinor, r.openDebtCount])).toEqual([
      ["Big Payer", 70000n, 2],
      ["Small Payer", 10000n, 1],
    ]);
    expect(rows[0]?.earliestDueDate?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[1]?.earliestDueDate).toBeNull();
  });
});
