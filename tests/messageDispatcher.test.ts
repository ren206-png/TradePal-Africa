import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  dispatchInboundMessage,
  STOCK_TRACKING_FEATURE_FLAG_KEY,
  VOICE_TRANSCRIPTION_FEATURE_FLAG_KEY,
  type DispatcherDeps,
} from "../src/messageDispatcher.js";
import type { InboundMessageJob } from "../src/whatsapp/webhookHandler.js";
import type { AiParseRequest, AiProvider } from "../src/ai/provider.js";
import type { SttProvider } from "../src/stt/provider.js";
import { SUPPORTED_COUNTRIES } from "../src/config/countries.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";
import { setFeatureFlagForBusiness } from "../src/domain/featureFlags.js";
import { BILLING_QUOTA_FEATURE_FLAG_KEY } from "../src/domain/billing.js";

let testDb: TestDb;
let prisma: PrismaClient;

/** Mirrors prisma/seed.ts (tests seed a PGlite instance, not the real DB seed.ts entrypoint). */
async function runSeed(client: PrismaClient): Promise<void> {
  await client.language.upsert({ where: { code: "en" }, update: {}, create: { code: "en", name: "English" } });

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
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false },
  });
}

function fakeProvider(response: unknown): AiProvider {
  return {
    parseTransactionText: async (_request: AiParseRequest) => response,
  };
}

function buildDeps(aiProvider: AiProvider): { deps: DispatcherDeps; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
  const deps: DispatcherDeps = {
    prisma,
    aiProvider,
    outboundGateway: { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
  };
  return { deps, fetchImpl };
}

/** A fake SttProvider: resolves to `outcome` if given a string, or rejects with it if given an Error. */
function fakeSttProvider(outcome: string | Error): SttProvider {
  return {
    transcribe: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

/**
 * Like buildDeps, but also wires up an sttProvider and a fetchImpl mock covering the two-step
 * WhatsApp media download (see mediaGateway.ts) ahead of the eventual outbound-send call, so
 * resolveVoiceNote's downloadWhatsAppMedia call succeeds regardless of which gate/outcome a given
 * test is exercising.
 */
function buildVoiceDeps(
  aiProvider: AiProvider,
  sttProvider: SttProvider | undefined,
): { deps: DispatcherDeps; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "https://lookaside.example/media-1", mime_type: "audio/ogg" }), { status: 200 }),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
  const deps: DispatcherDeps = {
    prisma,
    aiProvider,
    sttProvider,
    outboundGateway: { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
  };
  return { deps, fetchImpl };
}

/** Enables the (off-by-default) voiceTranscription flag for one business, creating the FeatureFlag row if needed. */
async function enableVoiceTranscriptionFlag(businessId: string): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key: VOICE_TRANSCRIPTION_FEATURE_FLAG_KEY },
    update: {},
    create: { key: VOICE_TRANSCRIPTION_FEATURE_FLAG_KEY, description: "test", enabledByDefault: false },
  });
  const scopedPrisma = getTenantScopedClient(prisma, businessId);
  await setFeatureFlagForBusiness(scopedPrisma, businessId, VOICE_TRANSCRIPTION_FEATURE_FLAG_KEY, true);
}

/** Creates a voice-enabled Plan and an ACTIVE Subscription to it for one business. */
async function giveBusinessVoiceEnabledPlan(businessId: string, planCode: string): Promise<void> {
  await prisma.plan.upsert({
    where: { code: planCode },
    update: {},
    create: { code: planCode, name: planCode, priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 1000, voiceEnabled: true },
  });
  const now = new Date();
  await prisma.subscription.create({
    data: {
      businessId,
      planCode,
      status: "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    },
  });
}

/** Stores a WhatsApp text webhook payload as a WebhookEvent row and returns the job that would be enqueued for it. */
async function storeInboundTextMessage(params: {
  waMessageId: string;
  fromNumber: string;
  text: string;
}): Promise<InboundMessageJob> {
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
              metadata: { display_phone_number: "15550001111", phone_number_id: "pn-1" },
              messages: [
                { id: params.waMessageId, from: params.fromNumber, timestamp: "1700000000", type: "text", text: { body: params.text } },
              ],
            },
          },
        ],
      },
    ],
  };

  const webhookEvent = await prisma.webhookEvent.create({
    data: { waMessageId: params.waMessageId, payload },
  });

  return {
    webhookEventId: webhookEvent.id,
    waMessageId: params.waMessageId,
    fromNumber: params.fromNumber,
    toNumber: "15550001111",
    messageType: "text",
  };
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await runSeed(prisma);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await testDb.teardown();
});

describe("dispatchInboundMessage", () => {
  it("starts onboarding for a brand-new merchant and marks the webhook processed", async () => {
    const fromNumber = "2348011110001";
    const job = await storeInboundTextMessage({ waMessageId: "wamid.ONBOARD.1", fromNumber, text: "hi" });
    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, job);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("Welcome to TradePal");

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");

    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
    expect(webhookEvent.status).toBe("PROCESSED");
    expect(webhookEvent.processedAt).not.toBeNull();
  });

  it("silently drops the reply for an unsupported-country number, still marking the webhook processed", async () => {
    const fromNumber = "19995550001"; // +1, not one of the four launch countries
    const job = await storeInboundTextMessage({ waMessageId: "wamid.UNSUPPORTED.1", fromNumber, text: "hi" });
    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, job);

    expect(fetchImpl).not.toHaveBeenCalled();
    const merchant = await prisma.merchant.findUnique({ where: { phoneNumber: fromNumber } });
    expect(merchant).toBeNull();

    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
    expect(webhookEvent.status).toBe("PROCESSED");
  });

  it("continues onboarding through business name, consent, and first-customer prompt to completion", async () => {
    const fromNumber = "2348011110002";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.OB2.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.OB2.2", fromNumber, text: "Amina's Provisions" }),
    );

    let merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_CONSENT");

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.OB2.3", fromNumber, text: "yes" }));

    merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_FIRST_CUSTOMER");

    const consentLogs = await prisma.consentLog.findMany({ where: { merchantId: merchant.id } });
    expect(consentLogs).toHaveLength(2);

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.OB2.4", fromNumber, text: "SKIP" }));

    merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("COMPLETE");
  });

  it("routes a slash command to the command router for an onboarded merchant", async () => {
    const fromNumber = "2348011110003";
    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.CMD.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.CMD.2", fromNumber, text: "Bola Stores" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.CMD.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.CMD.skip", fromNumber, text: "SKIP" }));

    fetchImpl.mockClear();
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.CMD.4", fromNumber, text: "/help" }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("Available commands");
  });

  it("auto-logs a HIGH-confidence sale from free text and replies with the logged amount", async () => {
    const fromNumber = "2348011110004";
    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALE.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.SALE.2", fromNumber, text: "Tunde Trading" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALE.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALE.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });

    const saleProvider = fakeProvider({
      intent: "SALE",
      amountMinor: 2000,
      paymentStatus: "PAID",
      confidence: 0.95,
    });
    const { deps: saleDeps, fetchImpl: saleFetch } = buildDeps(saleProvider);

    await dispatchInboundMessage(
      saleDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.SALE.4", fromNumber, text: "sold bread for 2000" }),
    );

    expect(saleFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((saleFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");

    const transactions = await prisma.transaction.findMany({ where: { businessId: merchant.businessId, type: "SALE" } });
    expect(transactions).toHaveLength(1);

    const parseLogs = await prisma.aiParseLog.findMany({ where: { businessId: merchant.businessId } });
    expect(parseLogs.some((l) => l.finalAction === "AUTO_LOGGED")).toBe(true);
  });

  it("asks for clarification instead of logging a low-confidence transaction", async () => {
    const fromNumber = "2348011110005";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.LOW.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.LOW.2", fromNumber, text: "Chidi Shop" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.LOW.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.LOW.skip", fromNumber, text: "SKIP" }));

    const lowConfidenceProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.4 });
    const { deps: lowDeps, fetchImpl: lowFetch } = buildDeps(lowConfidenceProvider);

    await dispatchInboundMessage(
      lowDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.LOW.4", fromNumber, text: "sold something maybe" }),
    );

    expect(lowFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((lowFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/couldn't confidently understand/i);
  });

  it("replies that stock tracking isn't supported yet for a STOCK_ADJUSTMENT intent", async () => {
    const fromNumber = "2348011110006";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STOCK.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STOCK.2", fromNumber, text: "Ngozi Mart" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STOCK.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STOCK.skip", fromNumber, text: "SKIP" }));

    const stockProvider = fakeProvider({ intent: "STOCK_ADJUSTMENT", itemName: "bread", quantityDelta: -2, confidence: 0.95 });
    const { deps: stockDeps, fetchImpl: stockFetch } = buildDeps(stockProvider);

    await dispatchInboundMessage(
      stockDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.STOCK.4", fromNumber, text: "sold 2 bread from stock" }),
    );

    expect(stockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((stockFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/stock tracking isn't available/i);
  });

  it("actually applies a STOCK_ADJUSTMENT intent once the stockTracking feature flag is enabled for the business", async () => {
    const fromNumber = "2348011110017";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STOCKON.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.STOCKON.2", fromNumber, text: "Ngozi Mart 2" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STOCKON.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STOCKON.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await prisma.featureFlag.upsert({
      where: { key: STOCK_TRACKING_FEATURE_FLAG_KEY },
      update: {},
      create: { key: STOCK_TRACKING_FEATURE_FLAG_KEY, description: "test", enabledByDefault: false },
    });
    const scopedPrisma = getTenantScopedClient(prisma, merchant.businessId);
    await setFeatureFlagForBusiness(scopedPrisma, merchant.businessId, STOCK_TRACKING_FEATURE_FLAG_KEY, true);

    const stockProvider = fakeProvider({ intent: "STOCK_ADJUSTMENT", itemName: "bread", quantityDelta: -2, confidence: 0.95 });
    const { deps: stockDeps, fetchImpl: stockFetch } = buildDeps(stockProvider);

    await dispatchInboundMessage(
      stockDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.STOCKON.4", fromNumber, text: "sold 2 bread from stock" }),
    );

    expect(stockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((stockFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/removed 2 bread from stock/i);

    const item = await prisma.inventoryItem.findFirst({ where: { businessId: merchant.businessId, name: "bread" } });
    expect(item?.estimatedStockQty).toBe(-2);
  });

  it("Phase 15: a SALE with itemized items decrements stock and links TransactionItem.inventoryItemId once stockTracking is enabled", async () => {
    const fromNumber = "2348011110019";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALEITEMS.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.SALEITEMS.2", fromNumber, text: "Bola Stores" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALEITEMS.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALEITEMS.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await prisma.featureFlag.upsert({
      where: { key: STOCK_TRACKING_FEATURE_FLAG_KEY },
      update: {},
      create: { key: STOCK_TRACKING_FEATURE_FLAG_KEY, description: "test", enabledByDefault: false },
    });
    const scopedPrisma = getTenantScopedClient(prisma, merchant.businessId);
    await setFeatureFlagForBusiness(scopedPrisma, merchant.businessId, STOCK_TRACKING_FEATURE_FLAG_KEY, true);

    // Seed the item with existing stock so the decrement is visible against a non-zero baseline.
    await prisma.inventoryItem.create({
      data: { businessId: merchant.businessId, name: "Milo", normalizedName: "milo", estimatedStockQty: 10 },
    });

    const saleProvider = fakeProvider({
      intent: "SALE",
      amountMinor: 3000,
      paymentStatus: "PAID",
      confidence: 0.95,
      items: [{ itemName: "Milo", quantity: 3, unitPriceMinor: 1000 }],
    });
    const { deps: saleDeps, fetchImpl: saleFetch } = buildDeps(saleProvider);

    await dispatchInboundMessage(
      saleDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.SALEITEMS.4", fromNumber, text: "sold 3 milo for 3000" }),
    );

    expect(saleFetch).toHaveBeenCalledTimes(1);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { businessId: merchant.businessId, name: "Milo" } });
    expect(item.estimatedStockQty).toBe(7); // 10 - 3

    const transactionItem = await prisma.transactionItem.findFirstOrThrow({
      where: { businessId: merchant.businessId, itemName: "Milo" },
    });
    expect(transactionItem.inventoryItemId).toBe(item.id);

    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.quantityDelta).toBe(-3);
    expect(movements[0]?.source).toBe("SALE");
    expect(movements[0]?.transactionId).toBe(transactionItem.transactionId);
  });

  it("Phase 15: a SALE with itemized items never touches InventoryItem when stockTracking is off", async () => {
    const fromNumber = "2348011110020";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALEOFF.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.SALEOFF.2", fromNumber, text: "Kemi Store" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALEOFF.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SALEOFF.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });

    const saleProvider = fakeProvider({
      intent: "SALE",
      amountMinor: 1000,
      paymentStatus: "PAID",
      confidence: 0.95,
      items: [{ itemName: "Sugar", quantity: 1, unitPriceMinor: 1000 }],
    });
    const { deps: saleDeps, fetchImpl: saleFetch } = buildDeps(saleProvider);

    await dispatchInboundMessage(
      saleDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.SALEOFF.4", fromNumber, text: "sold sugar for 1000" }),
    );

    expect(saleFetch).toHaveBeenCalledTimes(1);

    const item = await prisma.inventoryItem.findFirst({ where: { businessId: merchant.businessId, name: "Sugar" } });
    expect(item).toBeNull();

    const transactionItem = await prisma.transactionItem.findFirstOrThrow({
      where: { businessId: merchant.businessId, itemName: "Sugar" },
    });
    expect(transactionItem.inventoryItemId).toBeNull();
  });

  it("refuses all processing and replies with a fixed message for a merchant whose removedAt is set", async () => {
    const fromNumber = "2348011110018";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.REMOVED.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.REMOVED.2", fromNumber, text: "Removed Merchant Shop" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.REMOVED.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.REMOVED.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await prisma.merchant.update({ where: { id: merchant.id }, data: { removedAt: new Date() } });

    const { deps: removedDeps, fetchImpl: removedFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    const job = await storeInboundTextMessage({ waMessageId: "wamid.REMOVED.4", fromNumber, text: "/today" });
    await dispatchInboundMessage(removedDeps, job);

    expect(removedFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((removedFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/no longer has access/i);

    // The webhook event is still marked PROCESSED, exactly like every other branch of dispatchInboundMessage.
    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
    expect(webhookEvent.status).toBe("PROCESSED");
  });

  async function storeInboundAudioMessage(params: { waMessageId: string; fromNumber: string }): Promise<InboundMessageJob> {
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
                metadata: { display_phone_number: "15550001111", phone_number_id: "pn-1" },
                messages: [
                  {
                    id: params.waMessageId,
                    from: params.fromNumber,
                    timestamp: "1700000000",
                    type: "audio",
                    audio: { id: "media-1" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const webhookEvent = await prisma.webhookEvent.create({ data: { waMessageId: params.waMessageId, payload } });
    return {
      webhookEventId: webhookEvent.id,
      waMessageId: params.waMessageId,
      fromNumber: params.fromNumber,
      toNumber: "15550001111",
      messageType: "audio",
    };
  }

  it("replies that voice isn't supported for a not-yet-onboarded merchant sending audio", async () => {
    const fromNumber = "2348011110007";
    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICE.1", fromNumber }));

    // Brand-new number with no Merchant row yet: onboarding starts instead of a voice reply.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    let body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("Welcome to TradePal");
    fetchImpl.mockClear();

    // Mid-onboarding (AWAITING_BUSINESS_NAME), audio still isn't understood.
    await dispatchInboundMessage(deps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICE.2", fromNumber }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/only understand text messages/i);
    fetchImpl.mockClear();

    // Fully onboarded, audio is still refused the same way.
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.VOICE.3", fromNumber, text: "Aisha's Kiosk" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICE.4", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICE.skip", fromNumber, text: "SKIP" }));
    fetchImpl.mockClear();

    await dispatchInboundMessage(deps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICE.5", fromNumber }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/only understand text messages/i);
  });

  it("blocks a HIGH-confidence free-text entry once the business's monthly plan cap is used up (flag enabled)", async () => {
    const fromNumber = "2348011110008";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.QUOTA.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.QUOTA.2", fromNumber, text: "Quota Test Shop" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.QUOTA.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.QUOTA.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    const scopedPrisma = getTenantScopedClient(prisma, merchant.businessId);

    await prisma.plan.upsert({
      where: { code: "TESTCAP-MD" },
      update: {},
      create: {
        code: "TESTCAP-MD",
        name: "Test Cap MD",
        priceMinor: 0n,
        currencyCode: "NGN",
        entryCapPerMonth: 1,
        voiceEnabled: false,
      },
    });
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId: merchant.businessId,
        planCode: "TESTCAP-MD",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.featureFlag.upsert({
      where: { key: BILLING_QUOTA_FEATURE_FLAG_KEY },
      update: {},
      create: { key: BILLING_QUOTA_FEATURE_FLAG_KEY, description: "test", enabledByDefault: false },
    });
    await setFeatureFlagForBusiness(scopedPrisma, merchant.businessId, BILLING_QUOTA_FEATURE_FLAG_KEY, true);

    const saleProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });

    const { deps: firstSaleDeps, fetchImpl: firstSaleFetch } = buildDeps(saleProvider);
    await dispatchInboundMessage(
      firstSaleDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.QUOTA.4", fromNumber, text: "sold bread for 2000" }),
    );
    expect(firstSaleFetch).toHaveBeenCalledTimes(1);
    let body = JSON.parse((firstSaleFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");

    const { deps: secondSaleDeps, fetchImpl: secondSaleFetch } = buildDeps(saleProvider);
    await dispatchInboundMessage(
      secondSaleDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.QUOTA.5", fromNumber, text: "sold bread for 2000" }),
    );
    expect(secondSaleFetch).toHaveBeenCalledTimes(1);
    body = JSON.parse((secondSaleFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/monthly entry limit reached/i);

    const transactions = await prisma.transaction.findMany({ where: { businessId: merchant.businessId, type: "SALE" } });
    expect(transactions).toHaveLength(1);

    const quotaBlockedLog = await prisma.aiParseLog.findFirst({ where: { whatsappMessageId: "wamid.QUOTA.5" } });
    expect(quotaBlockedLog?.finalAction).toBe("REJECTED");
  });

  it("transcribes a voice note and auto-logs it once all three voice gates pass", async () => {
    const fromNumber = "2348011110009";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEOK.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEOK.2", fromNumber, text: "Kemi Foods" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEOK.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEOK.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await enableVoiceTranscriptionFlag(merchant.businessId);
    await giveBusinessVoiceEnabledPlan(merchant.businessId, "VOICE-OK-PLAN");

    const saleProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });
    const { deps: voiceDeps, fetchImpl: voiceFetch } = buildVoiceDeps(saleProvider, fakeSttProvider("sold bread for 2000"));

    await dispatchInboundMessage(voiceDeps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICEOK.4", fromNumber }));

    // Media metadata, media bytes, then the outbound WhatsApp reply — in that order.
    expect(voiceFetch).toHaveBeenCalledTimes(3);
    expect(voiceFetch.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v21.0/media-1");
    expect(voiceFetch.mock.calls[1]?.[0]).toBe("https://lookaside.example/media-1");
    const body = JSON.parse((voiceFetch.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");

    const transactions = await prisma.transaction.findMany({ where: { businessId: merchant.businessId, type: "SALE" } });
    expect(transactions).toHaveLength(1);
  });

  it("replies with the voice-transcription-failed message when Whisper returns an empty transcript", async () => {
    const fromNumber = "2348011110010";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEEMPTY.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.VOICEEMPTY.2", fromNumber, text: "Emeka Stores" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEEMPTY.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEEMPTY.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await enableVoiceTranscriptionFlag(merchant.businessId);
    await giveBusinessVoiceEnabledPlan(merchant.businessId, "VOICE-EMPTY-PLAN");

    const { deps: voiceDeps, fetchImpl: voiceFetch } = buildVoiceDeps(
      fakeProvider({ intent: "GREETING", confidence: 0.9 }),
      fakeSttProvider(""),
    );

    await dispatchInboundMessage(voiceDeps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICEEMPTY.4", fromNumber }));

    expect(voiceFetch).toHaveBeenCalledTimes(3);
    const body = JSON.parse((voiceFetch.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/couldn't quite make out that voice note/i);
  });

  it("replies with the voice-transcription-failed message and still marks the webhook processed when the STT provider throws", async () => {
    const fromNumber = "2348011110011";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEERR.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.VOICEERR.2", fromNumber, text: "Funke Foods" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEERR.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEERR.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await enableVoiceTranscriptionFlag(merchant.businessId);
    await giveBusinessVoiceEnabledPlan(merchant.businessId, "VOICE-ERR-PLAN");

    const { deps: voiceDeps, fetchImpl: voiceFetch } = buildVoiceDeps(
      fakeProvider({ intent: "GREETING", confidence: 0.9 }),
      fakeSttProvider(new Error("Whisper API is down")),
    );

    const job = await storeInboundAudioMessage({ waMessageId: "wamid.VOICEERR.4", fromNumber });
    await dispatchInboundMessage(voiceDeps, job);

    const body = JSON.parse((voiceFetch.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/couldn't quite make out that voice note/i);

    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
    expect(webhookEvent.status).toBe("PROCESSED");
  });

  it("replies that voice isn't supported when the voiceTranscription feature flag is off, even with country/plan gates on", async () => {
    const fromNumber = "2348011110012";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEFLAGOFF.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.VOICEFLAGOFF.2", fromNumber, text: "Yemi Traders" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEFLAGOFF.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEFLAGOFF.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    // Deliberately NOT calling enableVoiceTranscriptionFlag — the flag stays off by default.
    await giveBusinessVoiceEnabledPlan(merchant.businessId, "VOICE-FLAGOFF-PLAN");

    const { deps: voiceDeps, fetchImpl: voiceFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    voiceDeps.sttProvider = fakeSttProvider("should never be reached");

    await dispatchInboundMessage(voiceDeps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICEFLAGOFF.4", fromNumber }));

    // Gated out before any media download is attempted: only the single reply call happens.
    expect(voiceFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((voiceFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/only understand text messages/i);
  });

  it("replies that voice isn't supported for a business in a voice-disabled country (Sierra Leone), even with flag/plan gates on", async () => {
    const fromNumber = "23276000001";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICESL.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.VOICESL.2", fromNumber, text: "Freetown Traders" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICESL.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICESL.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await enableVoiceTranscriptionFlag(merchant.businessId);
    await giveBusinessVoiceEnabledPlan(merchant.businessId, "VOICE-SL-PLAN");

    const { deps: voiceDeps, fetchImpl: voiceFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    voiceDeps.sttProvider = fakeSttProvider("should never be reached");

    await dispatchInboundMessage(voiceDeps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICESL.4", fromNumber }));

    expect(voiceFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((voiceFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/only understand text messages/i);
  });

  it("replies that voice isn't supported when the business's plan doesn't have voice enabled, even with flag/country gates on", async () => {
    const fromNumber = "2348011110013";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEPLAN.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.VOICEPLAN.2", fromNumber, text: "Lagos Wares" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEPLAN.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICEPLAN.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await enableVoiceTranscriptionFlag(merchant.businessId);
    // Deliberately NOT calling giveBusinessVoiceEnabledPlan — the business stays on the default
    // FREE plan seeded by runSeed, whose voiceEnabled is false.

    const { deps: voiceDeps, fetchImpl: voiceFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    voiceDeps.sttProvider = fakeSttProvider("should never be reached");

    await dispatchInboundMessage(voiceDeps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICEPLAN.4", fromNumber }));

    expect(voiceFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((voiceFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/only understand text messages/i);
  });

  it("replies that voice isn't supported when no sttProvider is configured at all, mirroring a missing OPENAI_API_KEY in production", async () => {
    const fromNumber = "2348011110014";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICENOSTT.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.VOICENOSTT.2", fromNumber, text: "Ibadan Mart" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICENOSTT.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.VOICENOSTT.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await enableVoiceTranscriptionFlag(merchant.businessId);
    await giveBusinessVoiceEnabledPlan(merchant.businessId, "VOICE-NOSTT-PLAN");

    // buildDeps never sets sttProvider at all — same as production when OPENAI_API_KEY is unset.
    const { deps: voiceDeps, fetchImpl: voiceFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(voiceDeps, await storeInboundAudioMessage({ waMessageId: "wamid.VOICENOSTT.4", fromNumber }));

    expect(voiceFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((voiceFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/only understand text messages/i);
  });

  it("Phase 13: /addstaff provisions a STAFF merchant that skips straight to consent (not business-name) on its first message, then can use commands", async () => {
    const ownerNumber = "2348011110015";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STAFF.1", fromNumber: ownerNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.STAFF.2", fromNumber: ownerNumber, text: "Halima Wares" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STAFF.3", fromNumber: ownerNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.STAFF.skip", fromNumber: ownerNumber, text: "SKIP" }));

    const owner = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: ownerNumber } });
    await prisma.featureFlag.upsert({
      where: { key: "staffAccounts" },
      update: {},
      create: { key: "staffAccounts", description: "test", enabledByDefault: false },
    });
    const scopedPrisma = getTenantScopedClient(prisma, owner.businessId);
    await setFeatureFlagForBusiness(scopedPrisma, owner.businessId, "staffAccounts", true);

    const staffNumber = "2348011110016";
    const { deps: addStaffDeps, fetchImpl: addStaffFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    await dispatchInboundMessage(
      addStaffDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.STAFF.4", fromNumber: ownerNumber, text: `/addstaff ${staffNumber}` }),
    );
    // Two sends: (1) the proactive staff-added WhatsApp notification to the new staff number itself
    // (sent from inside addStaffMerchant, before commandRouter returns its reply text), and (2) the
    // owner's own reply confirming the command succeeded.
    expect(addStaffFetch).toHaveBeenCalledTimes(2);
    const notificationBody = JSON.parse((addStaffFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(notificationBody.to).toBe(staffNumber);
    expect(notificationBody.text.body).toMatch(/added as staff/i);

    let body = JSON.parse((addStaffFetch.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.to).toBe(ownerNumber);
    expect(body.text.body).toMatch(/added/i);

    let staffMerchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: staffNumber } });
    expect(staffMerchant.onboardingStep).toBe("AWAITING_CONSENT");
    expect(staffMerchant.role).toBe("STAFF");
    expect(staffMerchant.businessId).toBe(owner.businessId);

    // The staff member's very first-ever message skips straight to consent — no business-name question,
    // since this business already has one (set during the owner's own onboarding above).
    const { deps: staffDeps, fetchImpl: staffFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    await dispatchInboundMessage(
      staffDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.STAFF.5", fromNumber: staffNumber, text: "yes" }),
    );
    body = JSON.parse((staffFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/first customer/i);

    staffMerchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: staffNumber } });
    expect(staffMerchant.onboardingStep).toBe("AWAITING_FIRST_CUSTOMER");

    await dispatchInboundMessage(
      staffDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.STAFF.5b", fromNumber: staffNumber, text: "SKIP" }),
    );
    body = JSON.parse((staffFetch.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/no problem/i);

    staffMerchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: staffNumber } });
    expect(staffMerchant.onboardingStep).toBe("COMPLETE");

    const consentLogs = await prisma.consentLog.findMany({ where: { merchantId: staffMerchant.id } });
    expect(consentLogs).toHaveLength(2);

    // The now-onboarded staff member can log entries against the same business as the owner.
    const { deps: cmdDeps, fetchImpl: cmdFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    await dispatchInboundMessage(
      cmdDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.STAFF.6", fromNumber: staffNumber, text: "/debt Tunde 500" }),
    );
    body = JSON.parse((cmdFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("Tunde");

    const debtTransactions = await prisma.transaction.findMany({ where: { businessId: owner.businessId, type: "DEBT_NOTE" } });
    expect(debtTransactions).toHaveLength(1);
  });
});
