import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { recordTransaction, reverseTransaction, TransactionAlreadyReversedError } from "../src/domain/ledger.js";
import { sumMoney } from "../src/domain/money.js";

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

describe("ledger", () => {
  it("records a transaction with line items whose totals are computed from integer minor units", async () => {
    const transaction = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 3000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
      items: [{ itemName: "bread", quantity: 2, unitPriceMinor: 1000n }, { itemName: "egg", quantity: 1, unitPriceMinor: 1000n }],
    });

    expect(transaction.amountMinor).toBe(3000n);

    const items = await scoped.transactionItem.findMany({ where: { transactionId: transaction.id } });
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.itemName === "bread")?.lineTotalMinor).toBe(2000n);
  });

  it("reverses a transaction with a negated-amount contra row that nets to zero", async () => {
    const original = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 5000n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
      description: "sold 5 bread",
    });

    const reversal = await reverseTransaction(scoped, original.id, "merchant said it was a mistake");

    expect(reversal.reversalOfTransactionId).toBe(original.id);
    expect(reversal.amountMinor).toBe(-5000n);
    expect(sumMoney([original.amountMinor, reversal.amountMinor])).toBe(0n);
  });

  it("refuses to reverse a transaction that has already been reversed", async () => {
    const original = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 1200n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });

    await reverseTransaction(scoped, original.id);

    await expect(reverseTransaction(scoped, original.id)).rejects.toThrow(TransactionAlreadyReversedError);
  });

  it("refuses to reverse a reversal row itself", async () => {
    const original = await recordTransaction(scoped, {
      businessId,
      type: "SALE",
      amountMinor: 800n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    const reversal = await reverseTransaction(scoped, original.id);

    await expect(reverseTransaction(scoped, reversal.id)).rejects.toThrow(TransactionAlreadyReversedError);
  });
});
