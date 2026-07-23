import type { FinalAction, Merchant, PrismaClient } from "@prisma/client";
import { applyLoggableIntent, type LoggableParsedIntent } from "./ai/applyParsedIntent.js";
import { assertWithinQuotaIfEnabled, getEffectivePlan, QuotaExceededError } from "./domain/billing.js";
import { isFeatureEnabled } from "./domain/featureFlags.js";
import { recordAiParseLog } from "./ai/logParse.js";
import { parseTransactionText, type AiParseResult } from "./ai/parse.js";
import type { AiProvider } from "./ai/provider.js";
import type { ParsedIntent } from "./ai/schema.js";
import { handleCommand } from "./commands/commandRouter.js";
import { getTenantScopedClient } from "./db/tenantScope.js";
import {
  continueOnboarding,
  findMerchantByPhoneNumber,
  isOnboardingComplete,
  startOnboarding,
  UnsupportedCountryError,
} from "./onboarding/onboardingFlow.js";
import type { FlutterwaveDeps } from "./flutterwave/client.js";
import type { SttProvider } from "./stt/provider.js";
import { downloadWhatsAppMedia } from "./whatsapp/mediaGateway.js";
import { sendWhatsAppTextMessage, type OutboundGatewayDeps } from "./whatsapp/outboundGateway.js";
import type { InboundMessageJob } from "./whatsapp/webhookHandler.js";
import { extractInboundMessages, parseWhatsAppWebhookPayload } from "./whatsapp/webhookPayload.js";

export interface DispatcherDeps {
  prisma: PrismaClient;
  aiProvider: AiProvider;
  /**
   * Optional: voice-note transcription (below) is skipped entirely, falling
   * back to VOICE_NOT_SUPPORTED_REPLY, whenever this isn't supplied —
   * mirroring how subscriptionExpiryWorker.ts treats missing WhatsApp send
   * credentials as "skip the feature", not "crash the process", since a
   * missing OPENAI_API_KEY shouldn't take down message dispatch entirely.
   */
  sttProvider?: SttProvider | undefined;
  outboundGateway: Omit<OutboundGatewayDeps, "prisma">;
  /**
   * Optional: mirrors sttProvider's missing-credential handling. When unset,
   * /upgrade (commandRouter.ts's handleUpgrade) tells the merchant plan
   * upgrades aren't configured yet rather than crashing dispatch.
   */
  flutterwave?: FlutterwaveDeps | undefined;
  paymentsCheckoutRedirectUrl?: string | undefined;
}

/** Off by default (Standard #7). See resolveVoiceNote's doc comment for the full gating story. */
export const VOICE_TRANSCRIPTION_FEATURE_FLAG_KEY = "voiceTranscription";

/**
 * Off by default (Standard #7) — see prisma/seed.ts. Gates the STOCK_ADJUSTMENT
 * AI intent (see applyParsedIntent.ts's applyStockAdjustment and
 * src/domain/inventory.ts). When off, a STOCK_ADJUSTMENT parse still falls
 * through to STOCK_ADJUSTMENT_UNSUPPORTED_REPLY exactly as it did before
 * Phase 14 — enabling the flag is the only thing that changes.
 */
export const STOCK_TRACKING_FEATURE_FLAG_KEY = "stockTracking";

/**
 * Phase 14: a soft-removed (`/removestaff`'d) Merchant row is kept around
 * (see the Merchant.removedAt doc comment in prisma/schema.prisma) rather
 * than deleted, so it must be actively gated out of the live dispatch path
 * here — otherwise a removed staff member's WhatsApp number would keep
 * working exactly as before, since findMerchantByPhoneNumber has no reason
 * to filter it out itself (removal is a business-logic concept, not a data-
 * integrity one).
 */
const MERCHANT_REMOVED_REPLY =
  "This WhatsApp number no longer has access to this business. Contact the business owner if this is a mistake.";

const VOICE_NOT_SUPPORTED_REPLY = "Sorry, I can only understand text messages right now — please type your message.";
const VOICE_TRANSCRIPTION_FAILED_REPLY =
  "Sorry, I couldn't quite make out that voice note — please try typing your message instead.";
const STOCK_ADJUSTMENT_UNSUPPORTED_REPLY =
  "Stock tracking isn't available yet — I can still log sales, expenses, payments, and debts.";
const GREETING_REPLY = "Hello! Tell me about a sale, expense, or debt in plain language, or type /help to see commands.";
const QUERY_REPLY = "Try /today for today's summary or /customer <name> to see what someone owes.";
const CLARIFICATION_REPLY =
  'I couldn\'t confidently understand that. Try rephrasing, e.g. "sold 2 bread for 500" or "paid 3000 to supplier".';

async function extractMessageText(prisma: PrismaClient, job: InboundMessageJob): Promise<string | null> {
  const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
  const parsed = parseWhatsAppWebhookPayload(webhookEvent.payload);
  if (!parsed.success) return null;

  const match = extractInboundMessages(parsed.data).find(({ message }) => message.id === job.waMessageId);
  return match?.message.text?.body ?? null;
}

interface InboundAudio {
  id: string;
  mimeType?: string | undefined;
}

async function extractMessageAudio(prisma: PrismaClient, job: InboundMessageJob): Promise<InboundAudio | null> {
  const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: job.webhookEventId } });
  const parsed = parseWhatsAppWebhookPayload(webhookEvent.payload);
  if (!parsed.success) return null;

  const match = extractInboundMessages(parsed.data).find(({ message }) => message.id === job.waMessageId);
  if (!match?.message.audio) return null;
  return { id: match.message.audio.id, mimeType: match.message.audio.mime_type };
}

type VoiceOutcome =
  | { kind: "not_eligible" }
  | { kind: "transcription_failed" }
  | { kind: "transcribed"; text: string };

/**
 * A voice note is only ever attempted for a fully-onboarded merchant, and
 * only once three independent gates all pass:
 *
 * 1. The off-by-default `voiceTranscription` FeatureFlag (Standard #7) is
 *    enabled for the business — this is a brand-new external paid
 *    integration, so it follows the same off-by-default rollout convention
 *    as every other risky new behavior in this codebase.
 * 2. `CountryConfig.voiceEnabled` for the business's own country — false
 *    for Sierra Leone per PHASE_0_FINDINGS KQ4/ADR-3, since no ASR vendor
 *    has confirmed Krio support at all; attempting transcription anyway
 *    would just burn cost and the merchant's time on a near-guaranteed
 *    failure.
 * 3. `Plan.voiceEnabled` (the commercial/plan-tier gate) for the business's
 *    currently-effective plan.
 *
 * All three must pass before any network call is made. A transcription
 * result is never silently trusted: an empty transcript (Whisper's own
 * signal that it heard no intelligible speech) is treated as a hard
 * failure. Anything else is handed to the existing AI-parse
 * confidence/clarification path exactly like typed text — that step is
 * already responsible for asking the merchant to rephrase on an ambiguous
 * or low-confidence parse, so it doubles as the safety net for a noisy
 * transcript too, rather than this function inventing its own unvalidated
 * ASR-confidence threshold.
 *
 * Per Standard #8, note this deliberately does NOT record its own AuditLog
 * row: a merchant transcribing their own voice note isn't an admin/business
 * state-changing action needing an audit trail — whatever the transcript
 * resolves to (a logged sale, a command, a clarification request) is
 * already covered by that path's own logging (e.g. AiParseLog).
 */
async function resolveVoiceNote(
  deps: DispatcherDeps,
  business: { id: string; countryCode: string },
  audio: InboundAudio,
): Promise<VoiceOutcome> {
  if (!deps.sttProvider) return { kind: "not_eligible" };

  const scopedPrisma = getTenantScopedClient(deps.prisma, business.id);

  const flagOn = await isFeatureEnabled(scopedPrisma, business.id, VOICE_TRANSCRIPTION_FEATURE_FLAG_KEY);
  if (!flagOn) return { kind: "not_eligible" };

  const countryConfig = await deps.prisma.countryConfig.findUnique({ where: { countryCode: business.countryCode } });
  if (!countryConfig?.voiceEnabled) return { kind: "not_eligible" };

  const plan = await getEffectivePlan(scopedPrisma, business.id);
  if (!plan.voiceEnabled) return { kind: "not_eligible" };

  try {
    const media = await downloadWhatsAppMedia(
      { accessToken: deps.outboundGateway.accessToken, fetchImpl: deps.outboundGateway.fetchImpl },
      audio.id,
    );
    const transcript = await deps.sttProvider.transcribe({
      audioBuffer: media.buffer,
      mimeType: audio.mimeType ?? media.mimeType,
    });
    return transcript.length > 0 ? { kind: "transcribed", text: transcript } : { kind: "transcription_failed" };
  } catch (error) {
    console.error(`Voice-note transcription failed for business '${business.id}':`, error);
    return { kind: "transcription_failed" };
  }
}

async function reply(deps: DispatcherDeps, toPhoneNumber: string, body: string): Promise<void> {
  await sendWhatsAppTextMessage({ prisma: deps.prisma, ...deps.outboundGateway }, { toPhoneNumber, body });
}

const LOGGABLE_INTENTS = new Set(["SALE", "PURCHASE", "EXPENSE", "PAYMENT_RECEIVED", "DEBT_NOTE", "STOCK_ADJUSTMENT"]);

/** Narrows a validated, HIGH-confidence ParsedIntent down to the subset applyLoggableIntent understands. */
function isLoggableIntent(parsed: ParsedIntent): parsed is LoggableParsedIntent {
  return LOGGABLE_INTENTS.has(parsed.intent);
}

interface ParseOutcome {
  replyText: string;
  finalAction: FinalAction;
  loggable?: LoggableParsedIntent;
}

/**
 * `stockTrackingEnabled` is resolved by the caller (a DB-backed FeatureFlag
 * check) rather than looked up in here, keeping this function a pure
 * synchronous mapping — mirrors how quota-checking (assertWithinQuotaIfEnabled)
 * is also done by the caller rather than from inside a pure helper.
 */
function replyForParseResult(result: AiParseResult, stockTrackingEnabled: boolean): ParseOutcome {
  if (!result.validationPassed || result.requiresClarification || !result.parsed) {
    return { replyText: CLARIFICATION_REPLY, finalAction: "REJECTED" };
  }
  if (result.parsed.intent === "QUERY") return { replyText: QUERY_REPLY, finalAction: "ANSWERED" };
  if (result.parsed.intent === "GREETING") return { replyText: GREETING_REPLY, finalAction: "ANSWERED" };
  if (result.parsed.intent === "STOCK_ADJUSTMENT" && !stockTrackingEnabled) {
    return { replyText: STOCK_ADJUSTMENT_UNSUPPORTED_REPLY, finalAction: "REJECTED" };
  }
  if (result.parsed.intent === "UNKNOWN") {
    return { replyText: CLARIFICATION_REPLY, finalAction: "REJECTED" };
  }
  if (isLoggableIntent(result.parsed)) {
    return { replyText: "", finalAction: "AUTO_LOGGED", loggable: result.parsed };
  }
  return { replyText: CLARIFICATION_REPLY, finalAction: "REJECTED" };
}

async function dispatchCommandOrParse(
  deps: DispatcherDeps,
  merchant: Merchant,
  text: string,
  whatsappMessageId: string,
): Promise<void> {
  const business = await deps.prisma.business.findUniqueOrThrow({
    where: { id: merchant.businessId },
    include: { currency: true },
  });
  const scopedPrisma = getTenantScopedClient(deps.prisma, business.id);

  if (text.trim().startsWith("/")) {
    const replyText = await handleCommand(
      {
        prisma: deps.prisma,
        scopedPrisma,
        businessId: business.id,
        currencyCode: business.currencyCode,
        minorUnitExp: business.currency.minorUnitExp,
        timezone: business.timezone,
        languageCode: business.languageCode,
        merchantId: merchant.id,
        merchantRole: merchant.role,
        whatsappMessageId,
        outboundGateway: deps.outboundGateway,
        flutterwave: deps.flutterwave,
        paymentsCheckoutRedirectUrl: deps.paymentsCheckoutRedirectUrl,
      },
      text,
    );
    await reply(deps, merchant.phoneNumber, replyText);
    return;
  }

  const result = await parseTransactionText(deps.aiProvider, { text });
  // Phase 15: also needed for a SALE/PURCHASE carrying itemized `items`, so
  // those can link to InventoryItem too — not just the STOCK_ADJUSTMENT
  // intent from Phase 14. Still skipped for every other parse (QUERY,
  // GREETING, EXPENSE, etc.) to avoid an unnecessary DB round-trip.
  const needsStockTrackingCheck =
    result.parsed?.intent === "STOCK_ADJUSTMENT" ||
    ((result.parsed?.intent === "SALE" || result.parsed?.intent === "PURCHASE") && (result.parsed.items?.length ?? 0) > 0);
  const stockTrackingEnabled = needsStockTrackingCheck
    ? await isFeatureEnabled(scopedPrisma, business.id, STOCK_TRACKING_FEATURE_FLAG_KEY)
    : false;
  const outcome = replyForParseResult(result, stockTrackingEnabled);
  let finalAction = outcome.finalAction;
  let replyText: string;

  if (outcome.loggable) {
    try {
      await assertWithinQuotaIfEnabled(scopedPrisma, business.id, business.timezone);
      replyText = await applyLoggableIntent(
        {
          scopedPrisma,
          businessId: business.id,
          currencyCode: business.currencyCode,
          minorUnitExp: business.currency.minorUnitExp,
          whatsappMessageId,
          stockTrackingEnabled,
          businessName: business.name,
        },
        outcome.loggable,
      );
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) throw error;
      // Quota-blocked free-text entries are refused the same way a
      // low-confidence parse is refused (FinalAction has no dedicated
      // "quota exceeded" value) — the merchant sees why in replyText.
      replyText = error.message;
      finalAction = "REJECTED";
    }
  } else {
    replyText = outcome.replyText;
  }

  await recordAiParseLog(deps.prisma, {
    businessId: business.id,
    whatsappMessageId,
    rawInput: text,
    result,
    finalAction,
  });

  await reply(deps, merchant.phoneNumber, replyText);
}

/**
 * The BullMQ worker's single entrypoint per job: resolves onboarding vs.
 * command vs. free-text parsing, applies the result, and always leaves the
 * WebhookEvent row PROCESSED — a webhook is durably recorded the moment it's
 * accepted (webhookHandler.ts), so a downstream failure here must not turn
 * into an infinite BullMQ retry storm on top of whatever already failed.
 */
export async function dispatchInboundMessage(deps: DispatcherDeps, job: InboundMessageJob): Promise<void> {
  const text = await extractMessageText(deps.prisma, job);
  const merchant = await findMerchantByPhoneNumber(deps.prisma, job.fromNumber);

  if (!merchant) {
    try {
      const started = await startOnboarding(deps.prisma, job.fromNumber);
      await reply(deps, job.fromNumber, started.reply);
    } catch (error) {
      if (!(error instanceof UnsupportedCountryError)) throw error;
      // No Merchant row exists (or ever will, for this number) to send to — the outbound
      // gateway would refuse it anyway (Non-Negotiable Standard #9), so there is nothing to do.
    }
  } else if (merchant.removedAt) {
    await reply(deps, job.fromNumber, MERCHANT_REMOVED_REPLY);
  } else if (!isOnboardingComplete(merchant)) {
    if (text === null) {
      await reply(deps, job.fromNumber, VOICE_NOT_SUPPORTED_REPLY);
    } else {
      const onboarding = await continueOnboarding(deps.prisma, merchant, text);
      await reply(deps, job.fromNumber, onboarding.reply);
    }
  } else if (text === null) {
    const audio = await extractMessageAudio(deps.prisma, job);
    if (!audio) {
      await reply(deps, job.fromNumber, VOICE_NOT_SUPPORTED_REPLY);
    } else {
      const business = await deps.prisma.business.findUniqueOrThrow({ where: { id: merchant.businessId } });
      const outcome = await resolveVoiceNote(deps, business, audio);
      if (outcome.kind === "not_eligible") {
        await reply(deps, job.fromNumber, VOICE_NOT_SUPPORTED_REPLY);
      } else if (outcome.kind === "transcription_failed") {
        await reply(deps, job.fromNumber, VOICE_TRANSCRIPTION_FAILED_REPLY);
      } else {
        await dispatchCommandOrParse(deps, merchant, outcome.text, job.waMessageId);
      }
    }
  } else {
    await dispatchCommandOrParse(deps, merchant, text, job.waMessageId);
  }

  await deps.prisma.webhookEvent.update({
    where: { id: job.webhookEventId },
    data: { status: "PROCESSED", processedAt: new Date() },
  });
}
