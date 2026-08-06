import type { FinalAction, Merchant, PrismaClient } from "@prisma/client";
import { applyLoggableIntent, type LoggableParsedIntent } from "./ai/applyParsedIntent.js";
import { assertWithinQuotaIfEnabled, getEffectivePlan, QuotaExceededError } from "./domain/billing.js";
import { isFeatureEnabled } from "./domain/featureFlags.js";
import { recordAiParseLog } from "./ai/logParse.js";
import { parseTransactionText, type AiParseResult } from "./ai/parse.js";
import type { AiProvider } from "./ai/provider.js";
import type { ParsedIntent } from "./ai/schema.js";
import { handleCommand } from "./commands/commandRouter.js";
import { isBusinessSuspended } from "./domain/businessModeration.js";
import { getTenantScopedClient } from "./db/tenantScope.js";
import {
  continueOnboarding,
  findMerchantByPhoneNumber,
  isOnboardingComplete,
  startOnboarding,
  UnsupportedCountryError,
} from "./onboarding/onboardingFlow.js";
import type { FlutterwaveDeps } from "./flutterwave/client.js";
import type { AlertEmailDeps } from "./monitoring/alerts.js";
import { reportIncident } from "./monitoring/alerts.js";
import type { CircuitBreaker } from "./monitoring/circuitBreaker.js";
import type { SttProvider } from "./stt/provider.js";
import { downloadWhatsAppMedia } from "./whatsapp/mediaGateway.js";
import { sendWhatsAppTextMessage, type OutboundGatewayDeps } from "./whatsapp/outboundGateway.js";
import type { InboundMessageJob } from "./whatsapp/webhookHandler.js";
import { extractInboundMessages, parseWhatsAppWebhookPayload } from "./whatsapp/webhookPayload.js";

/** Every reportIncident call in this file is tagged with this, since dispatchInboundMessage only ever runs inside worker.ts. */
const SERVICE_NAME = "worker";

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
  /**
   * Optional: monitoring-system email alerting (monitoring/alerts.ts).
   * Unset means every reportIncident call below still logs to console (via
   * that function's own unconditional console.error), it just never emails —
   * same "additive, never a boot/behavior requirement" treatment as every
   * other optional dep here.
   */
  alerts?: AlertEmailDeps | undefined;
  /**
   * Optional: gates the AI-parse call below so a sustained Anthropic outage
   * degrades to AI_PROVIDER_DEGRADED_REPLY for every merchant instead of
   * every single message separately paying the full latency of a doomed
   * call. Unset means every call is attempted directly, exactly as before
   * this monitoring system existed — tests that don't care about circuit-
   * breaker behavior are unaffected.
   */
  aiCircuitBreaker?: CircuitBreaker | undefined;
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

/**
 * Phase 29: platform-moderation suspension (src/domain/businessModeration.ts)
 * — a whole `Business` cut off by a SUPER_ADMIN for violating platform rules.
 * Checked before the per-merchant MERCHANT_REMOVED_REPLY gate below since a
 * business-wide suspension is the more severe, higher-precedence condition
 * (it blocks every merchant on the business, not just one removed staffer).
 */
const BUSINESS_SUSPENDED_REPLY =
  "This account has been suspended for a violation of our terms of service. Contact support if you believe this is a mistake.";

const VOICE_NOT_SUPPORTED_REPLY = "Sorry, I can only understand text messages right now — please type your message.";
const VOICE_TRANSCRIPTION_FAILED_REPLY =
  "Sorry, I couldn't quite make out that voice note — please try typing your message instead.";
const STOCK_ADJUSTMENT_UNSUPPORTED_REPLY =
  "Stock tracking isn't available yet — I can still log sales, expenses, payments, and debts.";
const GREETING_REPLY = "Hello! Tell me about a sale, expense, or debt in plain language, or type /help to see commands.";
const QUERY_REPLY = "Try /today for today's summary or /customer <name> to see what someone owes.";
const CLARIFICATION_REPLY =
  'I couldn\'t confidently understand that. Try rephrasing, e.g. "sold 2 bread for 500" or "paid 3000 to supplier".';
/**
 * Shown instead of CLARIFICATION_REPLY specifically when the AI provider
 * call was skipped or failed (see parseWithCircuitBreaker below) — a
 * distinct message so the merchant knows the problem is transient/on
 * TradePal's end, not that their message itself was unclear, and so they
 * know to simply retry shortly rather than rephrase.
 */
const AI_PROVIDER_DEGRADED_REPLY =
  "Sorry, I'm having trouble understanding messages right now — please try again in a few minutes. Commands like /today and /help still work.";
/**
 * Best-effort reply for the "something in dispatchInboundMessage itself
 * threw" case (see that function's try/catch) — deliberately generic, since
 * by definition this path is reached by a failure this file didn't already
 * have a specific reply for.
 */
const GENERIC_FAILURE_REPLY = "Sorry, something went wrong processing that message. Please try again in a moment.";

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

/**
 * A synthetic AiParseResult standing in for "the AI provider was never even
 * called" (circuit open) or "it was called and threw" (caught below) —
 * shaped so it still satisfies `recordAiParseLog`'s "every parse is logged,
 * success or failure" contract (Standard #8) with a real, if minimal,
 * AiParseResult row, rather than skipping the log for this case.
 * `rawModelOutput` deliberately isn't plain `null`: `AiParseLog.rawModelOutput`
 * is a non-nullable `Json` column (schema.prisma), and Prisma rejects a bare
 * JS `null` there (it requires `Prisma.JsonNull` for an explicit database
 * NULL) — a small, valid JSON object sidesteps that entirely.
 */
const AI_PROVIDER_UNAVAILABLE_RESULT: AiParseResult = {
  rawModelOutput: { error: "ai_provider_unavailable" },
  validationPassed: false,
  confidenceTier: "LOW",
  requiresClarification: true,
};

/**
 * Wraps the raw `parseTransactionText` call with the optional
 * `aiCircuitBreaker` (see DispatcherDeps's doc comment): when the breaker
 * says not to attempt the call at all (open, mid-outage), or when the call
 * itself throws (network blip, Anthropic-side error, etc.), this degrades to
 * AI_PROVIDER_UNAVAILABLE_RESULT/AI_PROVIDER_DEGRADED_REPLY instead of
 * propagating the failure — a thrown error here, uncaught, is exactly the
 * "single AI hiccup permanently strands a WebhookEvent" gap this monitoring
 * phase closes. A thrown error is also reported as an incident; the breaker
 * being open is not (that's an already-reported, ongoing condition, not a
 * new one — see circuitBreaker.ts's own onOpen callback for where that
 * one-time report happens instead).
 */
async function parseWithCircuitBreaker(
  deps: DispatcherDeps,
  text: string,
): Promise<{ result: AiParseResult; degraded: boolean }> {
  const breaker = deps.aiCircuitBreaker;
  if (breaker && !breaker.canAttempt()) {
    return { result: AI_PROVIDER_UNAVAILABLE_RESULT, degraded: true };
  }

  try {
    const result = await parseTransactionText(deps.aiProvider, { text });
    breaker?.recordSuccess();
    return { result, degraded: false };
  } catch (error) {
    breaker?.recordFailure();
    await reportIncident(deps.alerts, {
      service: SERVICE_NAME,
      title: "AI provider call failed",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return { result: AI_PROVIDER_UNAVAILABLE_RESULT, degraded: true };
  }
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

  const { result, degraded } = await parseWithCircuitBreaker(deps, text);
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
  // Degraded (AI provider unavailable) gets its own distinct reply ahead of
  // the normal parse-result mapping — see AI_PROVIDER_DEGRADED_REPLY's doc
  // comment for why this shouldn't just fall through to CLARIFICATION_REPLY.
  const outcome: ParseOutcome = degraded
    ? { replyText: AI_PROVIDER_DEGRADED_REPLY, finalAction: "REJECTED" }
    : replyForParseResult(result, stockTrackingEnabled);
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
 *
 * Monitoring-phase gap closure: everything above the `finally` used to be
 * un-guarded, so any thrown error (a DB blip, an unhandled edge case, an AI
 * failure the circuit breaker didn't already degrade) left the WebhookEvent
 * permanently stuck un-PROCESSED with zero merchant-visible reply and only a
 * scattered console.error as a trace — confirmed live by reading the code,
 * not by an actual incident. Marking PROCESSED is now unconditional (moved
 * into `finally`, itself failure-tolerant) and any other failure is both
 * reported (reportIncident) and given a best-effort generic reply, so a
 * merchant is never left silently hanging and every failure leaves a trace
 * beyond a log line BullMQ's own `.on("failed")` might never even see (this
 * function still resolves, so BullMQ sees success — the point is never to
 * retry a job just because a reply failed, per this doc comment's own
 * long-standing rule above).
 */
export async function dispatchInboundMessage(deps: DispatcherDeps, job: InboundMessageJob): Promise<void> {
  try {
    const text = await extractMessageText(deps.prisma, job);
    const merchant = await findMerchantByPhoneNumber(deps.prisma, job.fromNumber);

    if (!merchant) {
      try {
        const started = await startOnboarding(deps.prisma, job.fromNumber);
        try {
          await reply(deps, job.fromNumber, started.reply);
        } catch (sendError) {
          // The welcome reply failed to send (e.g. Meta rejected the recipient — a known
          // failure mode while this number is still on Meta's test tier, whose recipient
          // allowlist can silently block a brand-new prospect). startOnboarding() already
          // committed a Business/Merchant row before this point, so leaving it in place would
          // strand this phone number at AWAITING_BUSINESS_NAME with no idea a question was ever
          // asked — their *next* message (e.g. "Hey") would then be silently misread as the
          // answer to "what's your business name?" instead of retrying onboarding from scratch.
          // Deleting it here means the next inbound message re-enters this same `!merchant`
          // branch and gets a clean retry instead of corrupted state. Nothing else could have
          // been created off this merchant yet (this is the very first message for this
          // number), so there's nothing else to clean up.
          //
          // If the delete itself fails (e.g. a transient DB blip), swallowing it silently would
          // leave exactly the stranded-merchant bug this whole rollback exists to prevent, just
          // invisibly — so it's reported as its own incident rather than only relying on the
          // outer catch's generic "dispatchInboundMessage threw" report for `sendError` below,
          // which wouldn't otherwise mention that cleanup also failed.
          await deps.prisma.merchant.delete({ where: { id: started.merchant.id } }).catch((deleteError: unknown) => {
            void reportIncident(deps.alerts, {
              service: SERVICE_NAME,
              title: "Failed to roll back stranded Merchant after welcome-send failure",
              detail: `merchantId=${started.merchant.id}: ${
                deleteError instanceof Error ? (deleteError.stack ?? deleteError.message) : String(deleteError)
              }`,
            });
          });
          await deps.prisma.business.delete({ where: { id: started.merchant.businessId } }).catch((deleteError: unknown) => {
            void reportIncident(deps.alerts, {
              service: SERVICE_NAME,
              title: "Failed to roll back stranded Business after welcome-send failure",
              detail: `businessId=${started.merchant.businessId}: ${
                deleteError instanceof Error ? (deleteError.stack ?? deleteError.message) : String(deleteError)
              }`,
            });
          });
          throw sendError;
        }
      } catch (error) {
        if (!(error instanceof UnsupportedCountryError)) throw error;
        // No Merchant row exists (or ever will, for this number) to send to — the outbound
        // gateway would refuse it anyway (Non-Negotiable Standard #9), so there is nothing to do.
      }
    } else if (await isBusinessSuspended(deps.prisma, merchant.businessId)) {
      await reply(deps, job.fromNumber, BUSINESS_SUSPENDED_REPLY);
    } else if (merchant.removedAt) {
      await reply(deps, job.fromNumber, MERCHANT_REMOVED_REPLY);
    } else if (!isOnboardingComplete(merchant)) {
      if (text === null) {
        await reply(deps, job.fromNumber, VOICE_NOT_SUPPORTED_REPLY);
      } else {
        const previousOnboardingStep = merchant.onboardingStep;
        const onboarding = await continueOnboarding(deps.prisma, merchant, text);
        try {
          await reply(deps, job.fromNumber, onboarding.reply);
        } catch (sendError) {
          // Mirrors the startOnboarding rollback above (see its comment for the full
          // Meta-allowlist context this was root-caused to live in production, first
          // surfaced there via Sierra Leone sign-ups) — but for every *later* onboarding
          // step, not just the first. continueOnboarding() already committed this step's
          // transition (e.g. AWAITING_BUSINESS_NAME -> AWAITING_CONSENT) before this reply
          // was attempted; left in place, the merchant would be silently parked one step
          // ahead of what they actually saw, and their next real message would be misread
          // as the answer to a question they never received (this is exactly how four real
          // Sierra Leone sign-ups ended up permanently stuck with their business name set to
          // literal greeting text like "Hi" or "Hello"). Reverting onboardingStep back to
          // where it was gives them a clean retry from a step they've actually seen a
          // prompt for. Deliberately does NOT undo any other side effect of this step (e.g.
          // handleAwaitingConsent's ConsentLog rows) — a merchant who genuinely replied YES
          // did give consent, and that record shouldn't be erased just because the
          // confirmation reply back to them failed to send; see handleAwaitingConsent's own
          // idempotency guard for how a re-entered consent step avoids double-logging it.
          await deps.prisma.merchant
            .update({ where: { id: onboarding.merchant.id }, data: { onboardingStep: previousOnboardingStep } })
            .catch((revertError: unknown) => {
              void reportIncident(deps.alerts, {
                service: SERVICE_NAME,
                title: "Failed to revert onboardingStep after step reply failed to send",
                detail: `merchantId=${onboarding.merchant.id}: ${
                  revertError instanceof Error ? (revertError.stack ?? revertError.message) : String(revertError)
                }`,
              });
            });
          throw sendError;
        }
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
  } catch (error) {
    await reportIncident(deps.alerts, {
      service: SERVICE_NAME,
      title: "dispatchInboundMessage threw",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });

    // Best-effort only: this dispatch has already failed once, so a second
    // failure here (e.g. the merchant number itself isn't sendable for some
    // reason) is logged and swallowed rather than allowed to escape and
    // skip the `finally` block below.
    try {
      await reply(deps, job.fromNumber, GENERIC_FAILURE_REPLY);
    } catch (replyError) {
      console.error(`dispatchInboundMessage: best-effort failure reply also failed for '${job.fromNumber}':`, replyError);
    }
  } finally {
    try {
      await deps.prisma.webhookEvent.update({
        where: { id: job.webhookEventId },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
    } catch (updateError) {
      console.error(`dispatchInboundMessage: failed to mark WebhookEvent '${job.webhookEventId}' PROCESSED:`, updateError);
      await reportIncident(deps.alerts, {
        service: SERVICE_NAME,
        title: "Failed to mark WebhookEvent PROCESSED",
        detail: updateError instanceof Error ? (updateError.stack ?? updateError.message) : String(updateError),
      });
    }
  }
}
