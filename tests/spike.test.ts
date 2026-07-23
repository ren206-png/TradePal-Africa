import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("prisma + pglite spike", () => {
  it("can insert and read real domain rows through Prisma Client over the Postgres wire protocol", async () => {
    await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
    await prisma.country.create({
      data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
    });
    await prisma.language.create({ data: { code: "en", name: "English" } });

    const business = await prisma.business.create({
      data: {
        name: "Amaka's Store",
        countryCode: "NG",
        currencyCode: "NGN",
        languageCode: "en",
        timezone: "Africa/Lagos",
      },
    });

    const transaction = await prisma.transaction.create({
      data: {
        businessId: business.id,
        type: "SALE",
        amountMinor: 150_000n,
        currencyCode: "NGN",
        paymentStatus: "PAID",
      },
    });

    const found = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(found.amountMinor).toBe(150_000n);
    expect(typeof found.amountMinor).toBe("bigint");
  });
});
