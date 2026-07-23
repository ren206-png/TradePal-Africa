import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { createDebt, findOrCreateCustomerByName, listOpenDebtsForCustomer } from "../src/domain/debtBook.js";
import { generateReminderForCustomer, NoOutstandingDebtError } from "../src/domain/reminders.js";

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

describe("generateReminderForCustomer", () => {
  it("generates forwardable reminder text covering the customer's total outstanding debt and persists a Reminder row", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Dara");
    await createDebt(scoped, { businessId, customerId: customer.id, amountMinor: 1500n, currencyCode: "NGN" });
    await createDebt(scoped, { businessId, customerId: customer.id, amountMinor: 500n, currencyCode: "NGN" });
    const openDebts = await listOpenDebtsForCustomer(scoped, customer.id);

    const { reminder, replyText } = await generateReminderForCustomer(scoped, {
      businessId,
      customer,
      openDebts,
      languageCode: "en",
      currencyCode: "NGN",
      minorUnitExp: 2,
    });

    expect(reminder.businessId).toBe(businessId);
    expect(reminder.customerId).toBe(customer.id);
    expect(reminder.languageCode).toBe("en");
    expect(reminder.generatedText).toContain("Dara");
    expect(reminder.generatedText).toContain("20.00");
    expect(reminder.deliveredToMerchantAt).not.toBeNull();

    expect(replyText).toContain("Forward this message to your customer yourself");
    expect(replyText).toContain(reminder.generatedText);
  });

  it("refuses to generate a reminder when the customer has no open debt", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Femi");

    await expect(
      generateReminderForCustomer(scoped, {
        businessId,
        customer,
        openDebts: [],
        languageCode: "en",
        currencyCode: "NGN",
        minorUnitExp: 2,
      }),
    ).rejects.toThrow(NoOutstandingDebtError);
  });
});
