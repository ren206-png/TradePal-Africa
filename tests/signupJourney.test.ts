import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { dispatchInboundMessage, type DispatcherDeps } from "../src/messageDispatcher.js";
import type { InboundMessageJob } from "../src/whatsapp/webhookHandler.js";
import type { AiParseRequest, AiProvider } from "../src/ai/provider.js";
import { LANGUAGE_NAMES, SUPPORTED_COUNTRIES } from "../src/config/countries.js";
import { setFeatureFlagGlobalDefault } from "../src/domain/featureFlags.js";

/**
 * A whole first-day journey for a brand-new Sierra Leone shop owner, driven through the real
 * dispatcher exactly as a WhatsApp webhook would: sign up -> log a sale in plain language ->
 * ask for the day's numbers -> use the commands the landing page promises. Only the outbound
 * WhatsApp HTTP call and the AI parser are faked. It also pins the feature-flag rollout:
 * stock tracking and reminders are "not available" until their global default is flipped on.
 */

let testDb: TestDb;
let prisma: PrismaClient;

const SL_NUMBER = "23277000111";
const BOT_NUMBER = "18258239920";

async function seedReferenceData(client: PrismaClient): Promise<void> {
  const languageCodes = new Set(SUPPORTED_COUNTRIES.map((c) => c.defaultLanguage));
  for (const code of languageCodes) {
    await client.language.upsert({ where: { code }, update: {}, create: { code, name: LANGUAGE_NAMES[code] ?? code } });
  }
  for (const country of SUPPORTED_COUNTRIES) {
    await client.currency.upsert({
      where: { code: country.currency.code },
      update: {},
      create: { code: country.currency.code, name: country.currency.name, minorUnitExp: country.currency.minorUnitExp },
    });
    await client.country.upsert({
      where: { code: country.code },
      update: {},
      create: {
        code: country.code,
        name: country.name,
        callingCode: country.callingCode,
        defaultCurrency: country.currency.code,
        defaultTimezone: country.defaultTimezone,
      },
    });
    await client.countryConfig.upsert({
      where: { countryCode: country.code },
      update: {},
      create: { countryCode: country.code, defaultLanguage: country.defaultLanguage, voiceEnabled: country.voiceEnabled },
    });
  }
  await client.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 50, voiceEnabled: false },
  });
  // Mirrors production: every flag exists and starts OFF (Standard #7).
  for (const key of ["stockTracking", "reminders"]) {
    await client.featureFlag.upsert({ where: { key }, update: {}, create: { key, description: key, enabledByDefault: false } });
  }
}

/** Replies to "sold ..." text with a clean SALE parse, like the real AI provider would. */
const saleParser: AiProvider = {
  parseTransactionText: async (_request: AiParseRequest) => ({
    intent: "SALE",
    amountMinor: 1_200_000, // 12,000.00 in a 2-decimal currency
    paymentStatus: "PAID",
    confidence: 0.95,
  }),
};

let messageCounter = 0;

/** Sends one inbound WhatsApp text and returns the text TradePal replied with. */
async function say(text: string): Promise<string> {
  const waMessageId = `wamid.JOURNEY.${++messageCounter}`;
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: BOT_NUMBER, phone_number_id: "pn-1" },
              messages: [{ id: waMessageId, from: SL_NUMBER, timestamp: "1700000000", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  const webhookEvent = await prisma.webhookEvent.create({ data: { waMessageId, payload } });
  const job: InboundMessageJob = {
    webhookEventId: webhookEvent.id,
    waMessageId,
    fromNumber: SL_NUMBER,
    toNumber: BOT_NUMBER,
    messageType: "text",
  };

  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
  const deps: DispatcherDeps = {
    prisma,
    aiProvider: saleParser,
    outboundGateway: { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
  };
  await dispatchInboundMessage(deps, job);

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const sent = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
  return sent.text.body as string;
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReferenceData(prisma);
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("first-day journey of a new Sierra Leone shop owner", () => {
  it("signs up from the very first message and lands in the right country and currency", async () => {
    expect(await say("hi")).toContain("Welcome to TradePal");
    expect(await say("Mariatu's Provisions")).toContain("Terms of Service");
    expect(await say("yes")).toMatch(/customer|skip/i);
    await say("SKIP");

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: SL_NUMBER } });
    expect(merchant.onboardingStep).toBe("COMPLETE");
    const business = await prisma.business.findUniqueOrThrow({ where: { id: merchant.businessId } });
    expect(business.name).toBe("Mariatu's Provisions");
    expect(business.countryCode).toBe("SL");
  });

  it("answers /help with the commands, and logs a sale written in plain language", async () => {
    expect(await say("/help")).toContain("Available commands");

    const logged = await say("sold 2 bags of rice for 12000");
    expect(logged).toBe("Logged sale of 12000.00 SLE.");
  });

  it("shows the day's numbers with /today, and /undo takes the sale back", async () => {
    const today = await say("/today");
    expect(today).toContain("Today (Africa/Freetown):");
    expect(today).toContain("Sales: 12000.00 SLE");
    expect(today).toContain("Net: 12000.00 SLE");

    expect(await say("/undo")).toBe("Undone: SALE of 12000.00 SLE.");
    expect(await say("/today")).toContain("Sales: 0.00 SLE");
  });

  it("keeps stock tracking and reminders switched off until the rollout flips them on", async () => {
    expect(await say("/stock")).toMatch(/isn't available/i);
    expect(await say("/remind Amina")).toMatch(/isn't available/i);
  });

  it("offers stock tracking and reminders to every shop once their global default is on", async () => {
    await setFeatureFlagGlobalDefault(prisma, "stockTracking", true);
    await setFeatureFlagGlobalDefault(prisma, "reminders", true);

    expect(await say("/stock")).not.toMatch(/isn't available/i);
    expect(await say("/remind Amina")).not.toMatch(/isn't available/i);
  });
});
