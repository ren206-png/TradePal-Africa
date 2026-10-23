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

let activeParser: AiProvider = saleParser;
let messageCounter = 0;
let lastJob: InboundMessageJob | undefined;

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
    aiProvider: activeParser,
    outboundGateway: { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
  };
  lastJob = job;
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

  it("understands bare command words typed without a slash, as people do on a phone", async () => {
    await say("sold 2 bags of rice for 12000");
    expect(await say("Today")).toContain("Today (Africa/Freetown):");
    expect(await say("help")).toContain("Available commands");
    expect(await say("undo")).toBe("Undone: SALE of 12000.00 SLE.");
  });

  it("understands \"remind Amina\" typed without a slash once reminders are on", async () => {
    await setFeatureFlagGlobalDefault(prisma, "reminders", true);
    expect(await say("remind Amina")).not.toMatch(/isn't available|couldn't confidently/i);
    await setFeatureFlagGlobalDefault(prisma, "reminders", false);
  });

  it("keeps stock tracking and reminders switched off until the rollout flips them on", async () => {
    expect(await say("/stock")).toMatch(/isn't available/i);
    expect(await say("/remind Amina")).toMatch(/isn't available/i);
  });

  it("lists in /help only the commands that are actually switched on for the shop", async () => {
    const help = await say("/help");
    for (const on of ["/debt", "/paid", "/customer", "/debts", "/today", "/undo", "/help"]) expect(help).toContain(on);
    for (const off of ["/stock", "/remind", "/momo", "/addstaff", "/upgrade", "/paylink", "/collect", "/catalog", "/setprice", "/usage"]) {
      expect(help).not.toContain(off);
    }
    expect(help).not.toMatch(/if enabled for your account/);
    expect(help).toContain("in plain language");
  });

  it("offers stock tracking and reminders to every shop once their global default is on", async () => {
    await setFeatureFlagGlobalDefault(prisma, "stockTracking", true);
    await setFeatureFlagGlobalDefault(prisma, "reminders", true);

    expect(await say("/stock")).not.toMatch(/isn't available/i);
    expect(await say("/remind Amina")).not.toMatch(/isn't available/i);
  });

  it("adds stock and reminders to /help once they are switched on", async () => {
    const help = await say("/help");
    expect(help).toContain("/stock");
    expect(help).toContain("/remind");
    expect(help).not.toContain("/paylink");
  });

  it("shows an item that was sold but never stocked as 'no stock recorded yet', not a negative number", async () => {
    activeParser = {
      parseTransactionText: async () => ({
        intent: "SALE",
        amountMinor: 120_000,
        paymentStatus: "PAID",
        items: [{ itemName: "bags of rice", quantity: 2, unitPriceMinor: 60_000 }],
        confidence: 0.95,
      }),
    };
    try {
      await say("sold 2 bags of rice for 1200");
    } finally {
      activeParser = saleParser;
    }
    const stock = await say("stock");
    expect(stock).toContain("bags of rice: no stock recorded yet (2 sold)");
    expect(stock).not.toContain("-2");
    expect(stock).toContain('bought 10 bags of rice for 5000');
  });

  it("puts the stock back when a sale is undone, so undoing doesn't leave the shelf count wrong", async () => {
    // Previous test left rice at -2 ("2 sold"). Sell 2 more, then undo that sale.
    activeParser = {
      parseTransactionText: async () => ({
        intent: "SALE",
        amountMinor: 120_000,
        paymentStatus: "PAID",
        items: [{ itemName: "bags of rice", quantity: 2, unitPriceMinor: 60_000 }],
        confidence: 0.95,
      }),
    };
    try {
      await say("sold 2 bags of rice for 1200");
      expect(await say("stock")).toContain("(4 sold)");
      expect(await say("undo")).toMatch(/^Undone: SALE/);
    } finally {
      activeParser = saleParser;
    }
    const stock = await say("stock");
    expect(stock).toContain("bags of rice: no stock recorded yet (2 sold)");
    expect(stock).not.toContain("(4 sold)");
  });

  it("logs a whole day written as a list: one sale with items plus each debt, and never logs the same message twice", async () => {
    const list = [
      "Sale on 17/10/26",
      "Sneakers 2 pair =1200Sle",
      "T shirt 2 =500Sle",
      "Debt",
      "Manager =650Sle",
      "Terror=100Sle",
    ].join("\n");

    const reply = await say(list);
    expect(reply).toContain("Done! Here's what I saved:");
    expect(reply).toContain("- Sales: 2 items, 1700.00 SLE");
    expect(reply).toContain("- Debts (2): Manager 650.00, Terror 100.00 SLE");
    expect(reply).toContain("Your list says 17/10/26. TradePal saves entries with today's date.");
    expect(reply).toContain('send "undo"');

    const waMessageId = lastJob!.waMessageId;
    const saved = await prisma.transaction.findMany({ where: { whatsappMessageId: waMessageId }, orderBy: { createdAt: "asc" } });
    expect(saved.map((t) => [t.type, t.amountMinor])).toEqual([
      ["SALE", 170000n],
      ["DEBT_NOTE", 65000n],
      ["DEBT_NOTE", 10000n],
    ]);
    expect(await prisma.transactionItem.count({ where: { transaction: { whatsappMessageId: waMessageId } } })).toBe(2);

    // A re-driven webhook for the same message must not write the list a second time.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "x" }] }), { status: 200 }));
    await dispatchInboundMessage({ prisma, aiProvider: activeParser, outboundGateway: { accessToken: "t", phoneNumberId: "pn-1", fetchImpl } }, lastJob!);
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string).text.body).toMatch(/already recorded/);
    expect(await prisma.transaction.count({ where: { whatsappMessageId: waMessageId } })).toBe(3);
  });

  it("lists skipped lines it could not read, and explains the list format when a multi-line message isn't a list", async () => {
    const partial = await say("Sale\nRice 2 =500Sle\nBread =300Sle\nsome words with no amount");
    expect(partial).toContain("- Sales: 2 items, 800.00 SLE");
    expect(partial).toContain("I skipped these lines");
    expect(partial).toContain("- some words with no amount");

    // Not a list (no amounts) and not understood by the AI: the multi-line help, not the generic reply.
    const unknownProvider: AiProvider = { parseTransactionText: async () => ({ intent: "UNKNOWN", confidence: 0.1 }) };
    activeParser = unknownProvider;
    try {
      const reply = await say("good morning\nhow was your day\nhope you are well");
      expect(reply).toContain("I couldn't read that list.");
      expect(reply).toContain("Sneakers 2 pair =1200");
      expect(await say("what")).toMatch(/spent 3000 on transport/);
    } finally {
      activeParser = saleParser;
    }
  });

  it("shows everyone who owes the shop with /debts (or just 'debts'), biggest first, and flags an overdue one", async () => {
    // The list test above left Manager 650.00 and Terror 100.00 outstanding.
    // A real owner typed just "Debt" while testing; that, similar phrases and a slipped letter mean the same overview.
    expect(await say("debst")).toContain("Who owes you: 750.00 SLE across 2 customers");
    expect(await say("Debt")).toContain("Who owes you: 750.00 SLE across 2 customers");
    expect(await say("who owes me?")).toContain("Who owes you: 750.00 SLE across 2 customers");
    const overview = await say("Debts");
    expect(overview).toContain("Who owes you: 750.00 SLE across 2 customers");
    expect(overview.indexOf("Manager: 650.00 SLE")).toBeGreaterThan(-1);
    expect(overview.indexOf("Manager: 650.00 SLE")).toBeLessThan(overview.indexOf("Terror: 100.00 SLE"));
    expect(overview).toContain("/remind <name>");

    expect(await say("/debt Kamara 500 due 2020-01-01")).toBe("Recorded: Kamara owes 500.00 SLE. Due 2020-01-01.");
    expect(await say("/debt Sesay 50 due 2026-02-31")).toMatch(/isn't a real date/);
    const withOverdue = await say("/debts");
    expect(withOverdue).toContain("Who owes you: 1250.00 SLE across 3 customers");
    expect(withOverdue).toContain("Kamara: 500.00 SLE (overdue since 2020-01-01)");
  });

  it("asks before undoing when 'undo' is mistyped, and takes nothing back until the exact word is sent", async () => {
    await say("Temp expense: sold 1 bread for 100");
    const before = await prisma.transaction.count();
    expect(await say("unto")).toBe('Did you mean "undo"? To take back your last entry, send exactly: undo');
    expect(await prisma.transaction.count()).toBe(before);
    expect(await say("undo")).toMatch(/^Undone:/);
    expect(await prisma.transaction.count()).toBe(before + 1); // the reversal row
  });
  it("understands commands with a name or an amount typed without the slash, and says how it read them", async () => {
    const debt = await say("debt Mariama 500");
    expect(debt).toContain("Recorded: Mariama owes 500.00 SLE.");
    expect(debt).toContain('(I read that as: /debt Mariama 500. Not what you meant? Send "undo".)');
    expect(await say("Customer mariama")).toContain("mariama owes 500.00 SLE across 1 debt(s).".replace("mariama owes", "Mariama owes"));
    const paid = await say("paid Mariama 300");
    expect(paid).toContain("Applied 300.00 SLE to Mariama's debt. Remaining owed: 200.00 SLE.");
    expect(paid).toContain("(I read that as: /paid Mariama 300.");
    expect(await say("paid Mariama 1,000")).toMatch(/more than|exceed|only owes|overpay/i); // the command's own checks still apply
    expect(await say("customer Mariama")).toContain("Mariama owes 200.00 SLE");
    expect(await say("undo")).toBe("Undone: payment of 300.00 SLE from Mariama. Mariama owes 500.00 SLE again."); // the way out the hint offers
    expect(await say("customer Mariama")).toContain("Mariama owes 500.00 SLE");
  });

  it("does not turn ordinary writing into a command: a payment to a non-customer is an expense, and a lookup never creates a customer", async () => {
    activeParser = { parseTransactionText: async () => ({ intent: "EXPENSE", amountMinor: 150_000, confidence: 0.95 }) };
    try {
      expect(await say("paid transport 1500")).toBe("Logged expense of 1500.00 SLE.");
      expect(await say("customer Zed")).toBe("Logged expense of 1500.00 SLE."); // not an existing customer: read the normal way
      expect(await say("debt collected from Amina 500")).toBe("Logged expense of 1500.00 SLE.");
    } finally {
      activeParser = saleParser;
    }
    expect(await prisma.customer.count({ where: { name: { equals: "Zed", mode: "insensitive" } } })).toBe(0);
  });

  it("says plainly when a command typed without the slash is not available to the shop, as the slash version does", async () => {
    expect(await say("add staff 0803 123 4567")).toMatch(/isn't available/i);
    expect(await say("set price rice 4500")).toMatch(/isn't available/i);
    expect(await say("usage")).toMatch(/isn't (available|enabled)/i);
  });
});
