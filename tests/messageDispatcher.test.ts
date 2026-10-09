import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Merchant, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  dispatchInboundMessage,
  AI_PROVIDER_DEEPSEEK_FEATURE_FLAG_KEY,
  STOCK_TRACKING_FEATURE_FLAG_KEY,
  VOICE_TRANSCRIPTION_FEATURE_FLAG_KEY,
  type DispatcherDeps,
} from "../src/messageDispatcher.js";
import type { InboundMessageJob } from "../src/whatsapp/webhookHandler.js";
import type { AiParseRequest, AiProvider } from "../src/ai/provider.js";
import { DeepSeekAiProvider } from "../src/ai/deepseekProvider.js";
import type { AiModelRegistryKey } from "../src/ai/modelRegistry.js";
import { CircuitBreaker } from "../src/monitoring/circuitBreaker.js";
import type { SttProvider } from "../src/stt/provider.js";
import { LANGUAGE_NAMES, SUPPORTED_COUNTRIES } from "../src/config/countries.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";
import { setFeatureFlagForBusiness } from "../src/domain/featureFlags.js";
import { BILLING_QUOTA_FEATURE_FLAG_KEY } from "../src/domain/billing.js";
import { commitAiUsage } from "../src/domain/aiUsageLedger.js";

// Wraps (does not replace) the real commitAiUsage so one test can make it fail once, simulating a
// ledger-write DB blip that happens AFTER a successful, billed DeepSeek call.
vi.mock("../src/domain/aiUsageLedger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/aiUsageLedger.js")>();
  return { ...actual, commitAiUsage: vi.fn(actual.commitAiUsage) };
});

let testDb: TestDb;
let prisma: PrismaClient;

/** Mirrors prisma/seed.ts (tests seed a PGlite instance, not the real DB seed.ts entrypoint). */
async function runSeed(client: PrismaClient): Promise<void> {
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
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false },
  });
}

function fakeProvider(response: unknown): AiProvider {
  return {
    parseTransactionText: async (_request: AiParseRequest) => response,
  };
}

/** An AiProvider whose parseTransactionText always rejects — for AI-provider-outage/circuit-breaker tests. */
function fakeFailingProvider(error: Error): AiProvider {
  return {
    parseTransactionText: async (_request: AiParseRequest) => {
      throw error;
    },
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

/** Enables the (off-by-default) aiProviderDeepseek flag for one business, creating the FeatureFlag row if needed. */
async function enableDeepSeekProviderFlag(businessId: string): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key: AI_PROVIDER_DEEPSEEK_FEATURE_FLAG_KEY },
    update: {},
    create: { key: AI_PROVIDER_DEEPSEEK_FEATURE_FLAG_KEY, description: "test", enabledByDefault: false },
  });
  const scopedPrisma = getTenantScopedClient(prisma, businessId);
  await setFeatureFlagForBusiness(scopedPrisma, businessId, AI_PROVIDER_DEEPSEEK_FEATURE_FLAG_KEY, true);
}

/** A DeepSeek chat-completion HTTP response wrapping a given JSON `content` string, mirroring tests/deepseekProvider.test.ts's own helper. */
function deepSeekCompletionResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });
}

/** A real DeepSeekAiProvider (not a hand-rolled fake) whose HTTP calls are answered by `fetchImpl` — same construction pattern as tests/deepseekProvider.test.ts. */
function fakeDeepSeekProvider(fetchImpl: ReturnType<typeof vi.fn>): DeepSeekAiProvider {
  return new DeepSeekAiProvider({
    apiKey: "test-deepseek-key",
    fetchImpl,
    retryBudget: { maxAttempts: 2, perAttemptTimeoutMs: 200, totalBudgetMs: 1000, baseDelayMs: 1, maxDelayMs: 2 },
  });
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

/** Fully onboards a fresh merchant (hi -> business name -> yes -> SKIP) via a throwaway GREETING-only provider, returning the merchant row. */
async function onboardMerchant(fromNumber: string, businessName: string): Promise<Merchant> {
  const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
  await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: `wamid.${fromNumber}.1`, fromNumber, text: "hi" }));
  await dispatchInboundMessage(
    deps,
    await storeInboundTextMessage({ waMessageId: `wamid.${fromNumber}.2`, fromNumber, text: businessName }),
  );
  await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: `wamid.${fromNumber}.3`, fromNumber, text: "yes" }));
  await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: `wamid.${fromNumber}.skip`, fromNumber, text: "SKIP" }));
  return prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
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

  it("rolls back the new merchant when the welcome reply fails to send, so the next message gets a clean onboarding retry", async () => {
    const fromNumber = "2348011110099";
    // Simulates Meta rejecting the send (e.g. the recipient isn't on a test-tier allowlist) —
    // the failure happens on the outbound HTTP call itself, after startOnboarding() has already
    // committed a Business/Merchant row.
    const failingFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "(#131030) Recipient phone number not in allowed list" } }), {
          status: 400,
        }),
      );
    const deps: DispatcherDeps = {
      prisma,
      aiProvider: fakeProvider({ intent: "GREETING", confidence: 0.9 }),
      outboundGateway: { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl: failingFetch },
    };

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.ROLLBACK.1", fromNumber, text: "Hi TradePal, I'd like to set up my shop." }),
    );

    // No half-onboarded merchant left behind for a future message to be silently misread against.
    expect(await prisma.merchant.findUnique({ where: { phoneNumber: fromNumber } })).toBeNull();
    // Only the one failed welcome-message attempt: the best-effort failure reply can't send
    // either (no merchant row left to pass the outbound gateway's registered-merchant guard), so
    // it never reaches a second HTTP call.
    expect(failingFetch).toHaveBeenCalledTimes(1);

    // A later message from the same number gets a genuine fresh onboarding start, not "Hey"
    // silently misread as an answer to a business-name question they never received.
    const { deps: retryDeps, fetchImpl: retryFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    await dispatchInboundMessage(retryDeps, await storeInboundTextMessage({ waMessageId: "wamid.ROLLBACK.2", fromNumber, text: "Hey" }));

    expect(retryFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((retryFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("Welcome to TradePal");

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");
  });

  it("reverts onboardingStep (not merchant deletion) when a later step's reply fails to send, so retry lands on the step actually prompted", async () => {
    const fromNumber = "2348011110098";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.REVERT.1", fromNumber, text: "hi" }));

    let merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");

    // The business-name step's own DB write (Business.name) commits fine, but the reply
    // confirming it and asking for consent fails to send.
    const failingFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "(#131030) Recipient phone number not in allowed list" } }), {
          status: 400,
        }),
      );
    const failingDeps: DispatcherDeps = {
      prisma,
      aiProvider: fakeProvider({ intent: "GREETING", confidence: 0.9 }),
      outboundGateway: { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl: failingFetch },
    };

    // dispatchInboundMessage never rethrows to its caller (see its own doc comment: a failed
    // reply is reported as an incident, not allowed to fail the BullMQ job) — it resolves
    // normally here even though the step reply itself failed to send.
    await dispatchInboundMessage(
      failingDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.REVERT.2", fromNumber, text: "Amina's Provisions" }),
    );

    // Business name side effect is still committed...
    merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    const business = await prisma.business.findUniqueOrThrow({ where: { id: merchant.businessId } });
    expect(business.name).toBe("Amina's Provisions");
    // ...but the step pointer is reverted, not silently left one step ahead.
    expect(merchant.onboardingStep).toBe("AWAITING_BUSINESS_NAME");

    // A retry message is correctly re-treated as an answer to the business-name question
    // they actually saw, not misread as a reply to the consent prompt they never received.
    const { deps: retryDeps, fetchImpl: retryFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    await dispatchInboundMessage(
      retryDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.REVERT.3", fromNumber, text: "Amina's Provisions" }),
    );

    expect(retryFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((retryFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("Terms of Service");

    merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_CONSENT");
  });

  it("does not create duplicate ConsentLog rows when the consent-step reply fails to send and the merchant retries", async () => {
    const fromNumber = "2348011110097";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.DUPCONSENT.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DUPCONSENT.2", fromNumber, text: "Amina's Provisions" }),
    );

    let merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_CONSENT");

    // First "yes" is genuinely received and processed (ConsentLog rows are created), but the
    // reply confirming it and asking for the first customer fails to send.
    const failingFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "(#131030) Recipient phone number not in allowed list" } }), {
          status: 400,
        }),
      );
    const failingDeps: DispatcherDeps = {
      prisma,
      aiProvider: fakeProvider({ intent: "GREETING", confidence: 0.9 }),
      outboundGateway: { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl: failingFetch },
    };

    await dispatchInboundMessage(
      failingDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.DUPCONSENT.3", fromNumber, text: "yes" }),
    );

    merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_CONSENT");
    let consentLogs = await prisma.consentLog.findMany({ where: { merchantId: merchant.id } });
    expect(consentLogs).toHaveLength(2);

    // Retrying "yes" must not log a second, duplicate pair of consent rows for the same consent.
    const { deps: retryDeps, fetchImpl: retryFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    await dispatchInboundMessage(
      retryDeps,
      await storeInboundTextMessage({ waMessageId: "wamid.DUPCONSENT.4", fromNumber, text: "yes" }),
    );

    expect(retryFetch).toHaveBeenCalledTimes(1);
    merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    expect(merchant.onboardingStep).toBe("AWAITING_FIRST_CUSTOMER");
    consentLogs = await prisma.consentLog.findMany({ where: { merchantId: merchant.id } });
    expect(consentLogs).toHaveLength(2);
  });

  it("silently drops the reply for an unsupported-country number, still marking the webhook processed", async () => {
    const fromNumber = "19995550001"; // +1, not one of the six launch countries
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

  it("refuses all processing and replies with a fixed message when the merchant's Business is SUSPENDED (Phase 29)", async () => {
    const fromNumber = "2348011110019";
    const { deps } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));

    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SUSPENDED.1", fromNumber, text: "hi" }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.SUSPENDED.2", fromNumber, text: "Suspended Merchant Shop" }),
    );
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SUSPENDED.3", fromNumber, text: "yes" }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.SUSPENDED.skip", fromNumber, text: "SKIP" }));

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await prisma.business.update({
      where: { id: merchant.businessId },
      data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "Platform rules violation." },
    });

    const { deps: suspendedDeps, fetchImpl: suspendedFetch } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    const job = await storeInboundTextMessage({ waMessageId: "wamid.SUSPENDED.4", fromNumber, text: "/today" });
    await dispatchInboundMessage(suspendedDeps, job);

    expect(suspendedFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((suspendedFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/suspended/i);

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

  it("replies with GREETING_REPLY for a post-onboarding free-text greeting, and logs it ANSWERED rather than AUTO_LOGGED", async () => {
    const fromNumber = "2348011110020";
    await onboardMerchant(fromNumber, "Greeting Reply Stores");

    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "GREETING", confidence: 0.9 }));
    await dispatchInboundMessage(deps, await storeInboundTextMessage({ waMessageId: "wamid.GREET.1", fromNumber, text: "hello there" }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/tell me about a sale, expense, or debt/i);

    const parseLog = await prisma.aiParseLog.findFirst({ where: { whatsappMessageId: "wamid.GREET.1" } });
    expect(parseLog?.finalAction).toBe("ANSWERED");
  });

  it("replies with QUERY_REPLY for a post-onboarding free-text query, and logs it ANSWERED rather than AUTO_LOGGED", async () => {
    const fromNumber = "2348011110021";
    await onboardMerchant(fromNumber, "Query Reply Stores");

    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "QUERY", confidence: 0.9 }));
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.QUERYREPLY.1", fromNumber, text: "how much do I have today" }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/\/today for today's summary/i);

    const parseLog = await prisma.aiParseLog.findFirst({ where: { whatsappMessageId: "wamid.QUERYREPLY.1" } });
    expect(parseLog?.finalAction).toBe("ANSWERED");
  });
});

/**
 * Monitoring-phase gap closure (see messageDispatcher.ts's own doc comments
 * on DispatcherDeps.aiCircuitBreaker/alerts and dispatchInboundMessage's
 * try/catch/finally): before this phase, an AI-provider failure or any other
 * unexpected thrown error left the WebhookEvent permanently un-PROCESSED and
 * gave the merchant no reply at all. These tests exercise both the
 * degraded-AI-reply path and the "always ends up PROCESSED, with some reply"
 * guarantee for a genuinely unexpected failure elsewhere in dispatch.
 */
describe("dispatchInboundMessage: AI-provider outage / unexpected-error handling", () => {
  it("degrades to AI_PROVIDER_DEGRADED_REPLY, still logs the parse, and marks the webhook processed when the AI provider call throws", async () => {
    const fromNumber = "2348011119001";
    await onboardMerchant(fromNumber, "Outage Stores");

    const { deps, fetchImpl } = buildDeps(fakeFailingProvider(new Error("Anthropic API is down")));
    const job = await storeInboundTextMessage({ waMessageId: "wamid.OUTAGE.1", fromNumber, text: "sold bread for 2000" });

    await dispatchInboundMessage(deps, job);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/having trouble understanding/i);

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    const parseLogs = await prisma.aiParseLog.findMany({ where: { businessId: merchant.businessId, whatsappMessageId: "wamid.OUTAGE.1" } });
    expect(parseLogs).toHaveLength(1);
    expect(parseLogs[0]?.finalAction).toBe("REJECTED");
    expect(parseLogs[0]?.validationPassed).toBe(false);

    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
    expect(webhookEvent.status).toBe("PROCESSED");
  });

  it("reports the failure to and trips the circuit breaker on a thrown AI-provider error", async () => {
    const fromNumber = "2348011119002";
    await onboardMerchant(fromNumber, "Breaker Stores");

    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const { deps } = buildDeps(fakeFailingProvider(new Error("Anthropic API is down")));
    deps.aiCircuitBreaker = breaker;

    expect(breaker.getState()).toBe("closed");
    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.BREAKER.1", fromNumber, text: "sold bread for 2000" }),
    );
    expect(breaker.getState()).toBe("open");
  });

  /**
   * Regression coverage for the 2026-08-04–2026-08-09 production outage: a $0
   * credit balance made every AI-parse call fail the same way as an ordinary
   * transient blip, and both were reported under the same generic incident
   * title — so the 5-day outage never stood out from routine noise. These two
   * tests assert parseWithCircuitBreaker's catch block (messageDispatcher.ts)
   * now routes a billing/auth-shaped Anthropic.APIError to a distinct,
   * high-severity title via isAiProviderConfigurationError (src/ai/provider.ts),
   * while an ordinary thrown error still gets the generic title.
   */
  it("reports a distinct, high-severity incident title for a billing/auth configuration failure, not the generic outage title", async () => {
    const fromNumber = "2348011119005";
    await onboardMerchant(fromNumber, "Billing Stores");

    const billingError = new Anthropic.APIError(
      400,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        },
      },
      "error",
      new Headers(),
    );
    const { deps } = buildDeps(fakeFailingProvider(billingError));
    const alertFetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    deps.alerts = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl: alertFetchImpl };

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.BILLING.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(alertFetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = alertFetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.subject).toContain("billing/auth failure");
    expect(body.subject).not.toContain("AI provider call failed");
  });

  it("reports the generic outage incident title for an ordinary (non-billing) thrown error", async () => {
    const fromNumber = "2348011119006";
    await onboardMerchant(fromNumber, "Generic Outage Stores");

    const { deps } = buildDeps(fakeFailingProvider(new Error("Anthropic API is down")));
    const alertFetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    deps.alerts = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl: alertFetchImpl };

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.GENERIC.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(alertFetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = alertFetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.subject).toContain("AI provider call failed");
  });

  it("skips the AI provider call entirely when the circuit breaker is open, still giving a degraded reply", async () => {
    const fromNumber = "2348011119003";
    await onboardMerchant(fromNumber, "Open Breaker Stores");

    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    breaker.recordFailure(); // Pre-trip the breaker open, as if a prior message already failed.
    expect(breaker.getState()).toBe("open");

    const parseSpy = vi.fn(async () => ({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 }));
    const { deps, fetchImpl } = buildDeps({ parseTransactionText: parseSpy });
    deps.aiCircuitBreaker = breaker;

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.OPENBREAKER.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(parseSpy).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/having trouble understanding/i);
  });

  it("marks the webhook processed and gives a generic reply when an unexpected error is thrown outside the AI-parse path", async () => {
    const fromNumber = "2348011119004";
    await onboardMerchant(fromNumber, "Bug Stores");

    const { deps, fetchImpl } = buildDeps(fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 }));
    const job = await storeInboundTextMessage({ waMessageId: "wamid.BUG.1", fromNumber, text: "sold bread for 2000" });

    // Simulates a genuinely unexpected bug/DB blip somewhere dispatchCommandOrParse doesn't
    // already handle, well downstream of (and unrelated to) the AI-parse circuit breaker above.
    //
    // NOTE: deliberately never call `businessSpy.mockRestore()` here. Prisma 6's client Proxy
    // (src/db/tenantScope.ts's $extends usage relies on the same delegate machinery) treats any
    // model-delegate method key once touched via Object.defineProperty as permanently "owned by
    // the target" — its `get` trap short-circuits to reading the target object directly from
    // then on, for the lifetime of the process. vi.spyOn(...).mockRestore() writes back a
    // *synthesized* `{ value: undefined, writable: true, ... }` descriptor (since the proxy's own
    // getOwnPropertyDescriptor trap has nothing real to report for a key that was never a plain
    // own-property before spying), which permanently replaces the REAL findUniqueOrThrow with
    // `undefined` on `prisma.business` for every later test in this file — confirmed by a
    // dedicated repro. Falling back to a captured-before-spying real implementation instead keeps
    // the delegate fully functional forever without ever needing to "restore" the descriptor.
    const realFindUniqueOrThrow = prisma.business.findUniqueOrThrow.bind(prisma.business);
    const businessSpy = vi.spyOn(prisma.business, "findUniqueOrThrow");
    businessSpy.mockRejectedValueOnce(new Error("simulated unexpected DB error"));
    businessSpy.mockImplementation(realFindUniqueOrThrow as typeof prisma.business.findUniqueOrThrow);

    await dispatchInboundMessage(deps, job);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/something went wrong/i);

    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
    expect(webhookEvent.status).toBe("PROCESSED");
  });
});

/**
 * DeepSeek Integration Phase 8: `parseWithProviderFallback` (messageDispatcher.ts) tries DeepSeek
 * first — subject to its own two-gate topology (`deps.deepseekProvider` configured AND the
 * per-business `aiProviderDeepseek` FeatureFlag on) plus its own circuit breaker — falling back to
 * the existing Anthropic path unchanged whenever DeepSeek is not attempted at all or is attempted
 * and fails. These tests exercise each branch of that fallback decision, plus the ledger accounting
 * (`AiUsageLedger` RESERVE -> COMMIT/RELEASE) `tryParseWithDeepSeek` performs around the DeepSeek call.
 */
describe("dispatchInboundMessage: parseWithProviderFallback (DeepSeek primary, Anthropic fallback)", () => {
  it("uses DeepSeek and never calls Anthropic when the aiProviderDeepseek flag is on and DeepSeek succeeds, committing real usage to the ledger", async () => {
    const fromNumber = "2348011119101";
    const merchant = await onboardMerchant(fromNumber, "DeepSeek Primary Stores");
    await enableDeepSeekProviderFlag(merchant.businessId);

    const deepSeekFetch = vi
      .fn()
      .mockResolvedValue(
        deepSeekCompletionResponse(
          JSON.stringify({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 }),
          { prompt_tokens: 50, completion_tokens: 20 },
        ),
      );
    const anthropicSpy = vi.fn(async () => {
      throw new Error("Anthropic must not be called when DeepSeek succeeds");
    });

    const { deps, fetchImpl } = buildDeps({ parseTransactionText: anthropicSpy });
    deps.deepseekProvider = fakeDeepSeekProvider(deepSeekFetch);
    deps.deepseekCircuitBreaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DSPRIMARY.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(anthropicSpy).not.toHaveBeenCalled();
    expect(deepSeekFetch).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");

    const transactions = await prisma.transaction.findMany({ where: { businessId: merchant.businessId, type: "SALE" } });
    expect(transactions).toHaveLength(1);

    const commitRows = await prisma.aiUsageLedger.findMany({
      where: { businessId: merchant.businessId, provider: "DEEPSEEK", phase: "COMMIT" },
    });
    expect(commitRows).toHaveLength(1);
    expect(commitRows[0]?.actualCostMicroUsd).not.toBeNull();
  });

  it("falls back to Anthropic without ever attempting DeepSeek when the aiProviderDeepseek flag is off (default)", async () => {
    const fromNumber = "2348011119102";
    const merchant = await onboardMerchant(fromNumber, "Flag Off Stores");
    // Deliberately not calling enableDeepSeekProviderFlag — the flag stays off by default (Standard #7).

    const deepSeekFetch = vi.fn();
    const anthropicProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });

    const { deps, fetchImpl } = buildDeps(anthropicProvider);
    deps.deepseekProvider = fakeDeepSeekProvider(deepSeekFetch);
    deps.deepseekCircuitBreaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DSOFF.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(deepSeekFetch).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");

    const ledgerRows = await prisma.aiUsageLedger.findMany({ where: { businessId: merchant.businessId } });
    expect(ledgerRows).toHaveLength(0);
  });

  it("falls back to a successful Anthropic reply when DeepSeek's call fails, and records a RELEASE (not COMMIT) row for the failed DeepSeek attempt", async () => {
    const fromNumber = "2348011119103";
    const merchant = await onboardMerchant(fromNumber, "DeepSeek Failure Stores");
    await enableDeepSeekProviderFlag(merchant.businessId);

    const deepSeekFetch = vi.fn().mockImplementation(async () => new Response("upstream error", { status: 500 }));
    const anthropicProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });

    const { deps, fetchImpl } = buildDeps(anthropicProvider);
    deps.deepseekProvider = fakeDeepSeekProvider(deepSeekFetch);
    const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60_000 });
    deps.deepseekCircuitBreaker = breaker;

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DSFAIL.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(deepSeekFetch).toHaveBeenCalled(); // DeepSeek's own internal retry budget exhausted on the 500
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00"); // Anthropic's own successful reply, not a degraded one

    const releaseRows = await prisma.aiUsageLedger.findMany({
      where: { businessId: merchant.businessId, provider: "DEEPSEEK", phase: "RELEASE" },
    });
    expect(releaseRows).toHaveLength(1);

    const commitRows = await prisma.aiUsageLedger.findMany({
      where: { businessId: merchant.businessId, provider: "DEEPSEEK", phase: "COMMIT" },
    });
    expect(commitRows).toHaveLength(0);

    expect(breaker.getState()).toBe("closed"); // one recorded failure, threshold 5 — not yet tripped
  });

  it("keeps the DeepSeek result (no Anthropic fallback, breaker not tripped) when recording its cost in the ledger fails", async () => {
    const fromNumber = "2348011119110";
    const merchant = await onboardMerchant(fromNumber, "Ledger Blip Stores");
    await enableDeepSeekProviderFlag(merchant.businessId);

    const deepSeekFetch = vi
      .fn()
      .mockResolvedValue(
        deepSeekCompletionResponse(
          JSON.stringify({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 }),
          { prompt_tokens: 50, completion_tokens: 20 },
        ),
      );
    const anthropicSpy = vi.fn(async () => {
      throw new Error("Anthropic must not be called: DeepSeek already parsed (and billed) this message");
    });

    const { deps, fetchImpl } = buildDeps({ parseTransactionText: anthropicSpy });
    deps.deepseekProvider = fakeDeepSeekProvider(deepSeekFetch);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    deps.deepseekCircuitBreaker = breaker;

    vi.mocked(commitAiUsage).mockRejectedValueOnce(new Error("simulated ledger-write failure"));

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DSLEDGER.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(deepSeekFetch).toHaveBeenCalledTimes(1);
    expect(anthropicSpy).not.toHaveBeenCalled();
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");
    expect(await prisma.transaction.count({ where: { businessId: merchant.businessId, type: "SALE" } })).toBe(1);
    expect(breaker.getState()).toBe("closed"); // a ledger failure is not a DeepSeek failure (threshold is 1)
  });

  it("skips DeepSeek entirely (never calling its provider) when the DeepSeek circuit breaker is already open, and still succeeds via Anthropic", async () => {
    const fromNumber = "2348011119104";
    const merchant = await onboardMerchant(fromNumber, "DeepSeek Breaker Open Stores");
    await enableDeepSeekProviderFlag(merchant.businessId);

    const deepSeekFetch = vi.fn();
    const anthropicProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });

    const { deps, fetchImpl } = buildDeps(anthropicProvider);
    deps.deepseekProvider = fakeDeepSeekProvider(deepSeekFetch);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    breaker.recordFailure(); // pre-trip open, as if a prior DeepSeek call already failed
    expect(breaker.getState()).toBe("open");
    deps.deepseekCircuitBreaker = breaker;

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DSBREAKER.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(deepSeekFetch).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");
  });

  it("degrades to AI_PROVIDER_DEGRADED_REPLY only when both DeepSeek and Anthropic fail", async () => {
    const fromNumber = "2348011119105";
    await onboardMerchant(fromNumber, "Both Down Stores");
    const merchant2 = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: fromNumber } });
    await enableDeepSeekProviderFlag(merchant2.businessId);

    const deepSeekFetch = vi.fn().mockImplementation(async () => new Response("upstream error", { status: 500 }));
    const anthropicSpy = vi.fn(async () => {
      throw new Error("Anthropic API is down");
    });

    const { deps, fetchImpl } = buildDeps({ parseTransactionText: anthropicSpy });
    deps.deepseekProvider = fakeDeepSeekProvider(deepSeekFetch);
    deps.deepseekCircuitBreaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60_000 });

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.BOTHDOWN.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(anthropicSpy).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toMatch(/having trouble understanding/i);
  });

  it("does not attempt DeepSeek at all when deps.deepseekProvider is undefined (boot-time gate off), mirroring today's default worker config unless AI_PROVIDER_DEEPSEEK_ENABLED is set", async () => {
    const fromNumber = "2348011119106";
    const merchant = await onboardMerchant(fromNumber, "No DeepSeek Provider Stores");
    await enableDeepSeekProviderFlag(merchant.businessId);

    const anthropicProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });
    const { deps, fetchImpl } = buildDeps(anthropicProvider);
    // deps.deepseekProvider is intentionally left undefined — mirrors worker.ts's boot-time gate being off.

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DSNOPROV.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");

    const ledgerRows = await prisma.aiUsageLedger.findMany({ where: { businessId: merchant.businessId } });
    expect(ledgerRows).toHaveLength(0);
  });

  it("refuses to re-call DeepSeek for a whatsappMessageId that was already committed, falling back to Anthropic instead of risking a double charge", async () => {
    const fromNumber = "2348011119107";
    const merchant = await onboardMerchant(fromNumber, "DeepSeek Idempotency Stores");
    await enableDeepSeekProviderFlag(merchant.businessId);

    const deepSeekFetch = vi
      .fn()
      .mockResolvedValue(
        deepSeekCompletionResponse(JSON.stringify({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 }), {
          prompt_tokens: 50,
          completion_tokens: 20,
        }),
      );
    const anthropicProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });

    const { deps } = buildDeps(anthropicProvider);
    deps.deepseekProvider = fakeDeepSeekProvider(deepSeekFetch);
    deps.deepseekCircuitBreaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60_000 });

    // First message commits a DeepSeek reservation under idempotencyKey "wamid.DSIDEMPOTENT.1".
    // waMessageId is @unique on WebhookEvent (prisma/schema.prisma), so the redelivery below reuses
    // this same `job` — a fresh storeInboundTextMessage call with the same waMessageId would itself
    // throw a unique-constraint violation before dispatchInboundMessage is even reached.
    const job = await storeInboundTextMessage({ waMessageId: "wamid.DSIDEMPOTENT.1", fromNumber, text: "sold bread for 2000" });
    await dispatchInboundMessage(deps, job);
    expect(deepSeekFetch).toHaveBeenCalledTimes(1);

    // Simulates BullMQ redelivering the exact same job (same waMessageId) — e.g. after a crash between
    // the DeepSeek commit and the WebhookEvent being marked PROCESSED. reserveAiUsage's own
    // AiUsageAlreadyCommittedError guard must stop this from ever re-calling the DeepSeek vendor again.
    const anthropicSpy = vi.fn(anthropicProvider.parseTransactionText);
    deps.aiProvider = { parseTransactionText: anthropicSpy };
    await dispatchInboundMessage(deps, job);

    expect(deepSeekFetch).toHaveBeenCalledTimes(1); // not called again
    expect(anthropicSpy).toHaveBeenCalledTimes(1); // fell back to Anthropic instead

    const commitRows = await prisma.aiUsageLedger.findMany({
      where: { businessId: merchant.businessId, provider: "DEEPSEEK", phase: "COMMIT" },
    });
    expect(commitRows).toHaveLength(1); // still exactly one COMMIT — no double charge
  });

  it("falls back to Anthropic without ever calling DeepSeek or touching the ledger when the provider's modelKey isn't in the registry (config drift)", async () => {
    const fromNumber = "2348011119108";
    const merchant = await onboardMerchant(fromNumber, "DeepSeek Bad Model Key Stores");
    await enableDeepSeekProviderFlag(merchant.businessId);

    const deepSeekFetch = vi.fn();
    const anthropicProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });

    const { deps, fetchImpl } = buildDeps(anthropicProvider);
    // A modelKey that resolveAiModel (modelRegistry.ts) doesn't recognize — e.g. a registry entry
    // renamed/removed while AI_DEEPSEEK_MODEL (deepseekEnv.ts) still points at the old key.
    // tryParseWithDeepSeek's own comment: "misconfigured registry key — fall back to Anthropic
    // rather than throw mid-dispatch." The type system normally prevents this, so the cast below
    // simulates the only realistic way it happens: config drift, not a typo a compiler would catch.
    deps.deepseekProvider = new DeepSeekAiProvider({
      apiKey: "test-deepseek-key",
      fetchImpl: deepSeekFetch,
      retryBudget: { maxAttempts: 2, perAttemptTimeoutMs: 200, totalBudgetMs: 1000, baseDelayMs: 1, maxDelayMs: 2 },
      modelKey: "deepseek-vNONEXISTENT" as unknown as AiModelRegistryKey,
    });
    deps.deepseekCircuitBreaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60_000 });

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.DSBADKEY.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(deepSeekFetch).not.toHaveBeenCalled(); // never even attempted the vendor call
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00"); // Anthropic's successful reply

    const ledgerRows = await prisma.aiUsageLedger.findMany({ where: { businessId: merchant.businessId } });
    expect(ledgerRows).toHaveLength(0); // no RESERVE ever written — the gate closes before the ledger is touched
  });
});

describe("dispatchInboundMessage: AI budget observation (record-only wiring of domain/aiBudget.ts)", () => {
  /** Gives one business a Plan with a real DeepSeek budget cap and an ACTIVE Subscription to it. */
  async function giveBusinessCappedAiBudget(businessId: string, planCode: string, budgetMicroUsd: bigint): Promise<void> {
    await prisma.plan.upsert({
      where: { code: planCode },
      update: { aiDeepseekMonthlyBudgetMicroUsd: budgetMicroUsd },
      create: {
        code: planCode,
        name: planCode,
        priceMinor: 0n,
        currencyCode: "NGN",
        entryCapPerMonth: 1000,
        voiceEnabled: false,
        aiDeepseekMonthlyBudgetMicroUsd: budgetMicroUsd,
      },
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

  /** Seeds a COMMIT row directly (bypassing reserve/commit) so a business starts already past a given fraction of its budget — same technique as tests/aiBudget.test.ts's own seedCommittedSpend. */
  async function seedCommittedAiSpend(businessId: string, actualCostMicroUsd: bigint): Promise<void> {
    const scopedPrisma = getTenantScopedClient(prisma, businessId);
    await scopedPrisma.aiUsageLedger.create({
      data: {
        requestId: crypto.randomUUID(),
        phase: "COMMIT",
        businessId,
        feature: "TRANSACTION_PARSE",
        provider: "ANTHROPIC",
        requestedModel: "claude-test",
        resolvedModel: "claude-test",
        actualCostMicroUsd,
        promptHash: "seed-hash",
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }

  it("emails an incident once a business's AI spend crosses the WARN threshold, without blocking or altering the reply", async () => {
    const fromNumber = "2348011119201";
    const merchant = await onboardMerchant(fromNumber, "Budget Warn Stores");
    await giveBusinessCappedAiBudget(merchant.businessId, "BUDGET-WARN-MD", 1_000_000n);
    await seedCommittedAiSpend(merchant.businessId, 600_000n); // 60%, past the 50% default WARN threshold

    const saleProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });
    const { deps, fetchImpl } = buildDeps(saleProvider);
    const alertFetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    deps.alerts = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl: alertFetchImpl };

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.BUDGETWARN.1", fromNumber, text: "sold bread for 2000" }),
    );

    // The merchant's own message still processed completely normally — record-only mode never blocks.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00");
    const transactions = await prisma.transaction.findMany({ where: { businessId: merchant.businessId, type: "SALE" } });
    expect(transactions).toHaveLength(1);

    // But an operator-facing incident was raised for visibility.
    expect(alertFetchImpl).toHaveBeenCalledTimes(1);
    const [, alertInit] = alertFetchImpl.mock.calls[0] as [string, RequestInit];
    const alertBody = JSON.parse(alertInit.body as string);
    expect(alertBody.subject).toContain("AI budget WARN threshold reached");
    expect(alertBody.text).toContain(merchant.businessId);
    expect(alertBody.text).toContain("record-only mode: nothing was blocked or downgraded");
  });

  it("never emails a budget incident for a business still below every threshold", async () => {
    const fromNumber = "2348011119202";
    const merchant = await onboardMerchant(fromNumber, "Budget Below Warn Stores");
    await giveBusinessCappedAiBudget(merchant.businessId, "BUDGET-BELOW-MD", 1_000_000n);
    await seedCommittedAiSpend(merchant.businessId, 100_000n); // 10%, well below the 50% default WARN threshold

    const saleProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });
    const { deps } = buildDeps(saleProvider);
    const alertFetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    deps.alerts = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl: alertFetchImpl };

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.BUDGETBELOW.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(alertFetchImpl).not.toHaveBeenCalled();
  });

  it("still fully processes the message (never blocks or downgrades) even once a business is past BLOCK_OPTIONAL_AI — record-only mode has no enforcement path", async () => {
    const fromNumber = "2348011119203";
    const merchant = await onboardMerchant(fromNumber, "Budget Block Stores");
    await giveBusinessCappedAiBudget(merchant.businessId, "BUDGET-BLOCK-MD", 1_000_000n);
    await seedCommittedAiSpend(merchant.businessId, 1_500_000n); // 150%, past the 100% default BLOCK_OPTIONAL_AI threshold

    const saleProvider = fakeProvider({ intent: "SALE", amountMinor: 2000, paymentStatus: "PAID", confidence: 0.95 });
    const { deps, fetchImpl } = buildDeps(saleProvider);
    const alertFetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    deps.alerts = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl: alertFetchImpl };

    await dispatchInboundMessage(
      deps,
      await storeInboundTextMessage({ waMessageId: "wamid.BUDGETBLOCK.1", fromNumber, text: "sold bread for 2000" }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text.body).toContain("20.00"); // sale still logged normally, not blocked
    const transactions = await prisma.transaction.findMany({ where: { businessId: merchant.businessId, type: "SALE" } });
    expect(transactions).toHaveLength(1);

    expect(alertFetchImpl).toHaveBeenCalledTimes(1);
    const [, alertInit] = alertFetchImpl.mock.calls[0] as [string, RequestInit];
    const alertBody = JSON.parse(alertInit.body as string);
    expect(alertBody.subject).toContain("AI budget BLOCK_OPTIONAL_AI threshold reached");
  });
});
