import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { parseTransactionText } from "../src/ai/parse.js";
import { recordAiParseLog } from "../src/ai/logParse.js";
import type { AiParseRequest, AiProvider } from "../src/ai/provider.js";

let testDb: TestDb;
let prisma: PrismaClient;
let businessId: string;

function fakeProvider(response: unknown): AiProvider {
  return {
    parseTransactionText: async (_request: AiParseRequest) => response,
  };
}

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
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("recordAiParseLog", () => {
  it("logs a successful high-confidence parse", async () => {
    const result = await parseTransactionText(
      fakeProvider({ intent: "EXPENSE", amountMinor: 500, description: "fuel", confidence: 0.9 }),
      { text: "spent 500 on fuel" },
    );

    const log = await recordAiParseLog(prisma, {
      businessId,
      rawInput: "spent 500 on fuel",
      result,
      finalAction: "AUTO_LOGGED",
    });

    expect(log.intent).toBe("EXPENSE");
    expect(log.confidenceTier).toBe("HIGH");
    expect(log.validationPassed).toBe(true);
  });

  it("logs a validation failure without a resulting transaction, defaulting intent to UNKNOWN", async () => {
    const result = await parseTransactionText(fakeProvider({ intent: "SALE", amountMinor: "garbage", confidence: 1 }), {
      text: "garbled",
    });

    const log = await recordAiParseLog(prisma, {
      businessId,
      rawInput: "garbled",
      result,
      finalAction: "REJECTED",
    });

    expect(log.intent).toBe("UNKNOWN");
    expect(log.validationPassed).toBe(false);
    expect(log.resultingTransactionId).toBeNull();
  });
});
