import { createHash } from "node:crypto";
import type { FinalAction, Merchant, PrismaClient } from "@prisma/client";
import { applyLoggableIntent, type LoggableParsedIntent } from "./ai/applyParsedIntent.js";
import { assertWithinQuotaIfEnabled, getEffectivePlan, QuotaExceededError } from "./domain/billing.js";
import { evaluateAiBudget } from "./domain/aiBudget.js";
import { isFeatureEnabled } from "./domain/featureFlags.js";
import { DebtOverpaymentError, findCustomerByName, listOpenDebtsForCustomer } from "./domain/debtBook.js";
import { formatMoney } from "./domain/money.js";
import { parseListMessage, type ListSection, type ParsedList } from "./ai/listEntry.js";
import { isUndoTypo, matchBareCommand, matchBareCommandWithArgs, matchPlainWord, UNDO_CONFIRM_REPLY } from "./commands/bareCommands.js";
import { recordAiParseLog } from "./ai/logParse.js";
import { buildAiParseResult, parseTransactionText, type AiParseResult } from "./ai/parse.js";
import { classifyAiProviderFailure } from "./ai/failureClass.js";
import type { AiProvider } from "./ai/provider.js";
import type { DeepSeekAiProvider } from "./ai/deepseekProvider.js";
import { estimateCostMicroUsd, resolveAiModel } from "./ai/modelRegistry.js";
import type { ParsedIntent } from "./ai/schema.js";
import { handleCommand } from "./commands/commandRouter.js";
import { isBusinessSuspended } from "./domain/businessModeration.js";
import { getTenantScopedClient, type TenantScopedClient } from "./db/tenantScope.js";
import {
  AiUsageAlreadyCommittedError,
  commitAiUsage,
  releaseAiUsage,
  reserveAiUsage,
} from "./domain/aiUsageLedger.js";
import {
  continueOnboarding,
  findMerchantByPhoneNumber,
  isOnboardingComplete,
  startOnboarding,
  UnsupportedCountryError,
} from "./onboarding/onboardingFlow.js";
import type { FlutterwaveDeps } from "./flutterwave/client.js";
import type { PawaPayDeps } from "./pawapay/client.js";
import { redactPayerNumberInStoredMessage } from "./whatsapp/redaction.js";
import type { AlertEmailDeps } from "./monitoring/alerts.js";
import { reportIncident } from "./monitoring/alerts.js";
import type { CircuitBreaker } from "./monitoring/circuitBreaker.js";
import type { SttProvider } from "./stt/provider.js";
import { downloadWhatsAppMedia } from "./whatsapp/mediaGateway.js";
import { conversationEnabled, proposeLoggable, tryHandleReply, type ConversationCtx, type InputSource } from "./conversation/flow.js";
import { applyStart, applyStop, consentKeyword, hasConsentHistory, parseUpdatesMessage, verifyUpdatesByCode } from "./messaging/consent.js";
import { sendMessage } from "./messaging/send.js";
import { whatsappTransport } from "./messaging/transport.js";
import { sendWhatsAppTextMessage, type OutboundGatewayDeps } from "./whatsapp/outboundGateway.js";
import type { InboundMessageJob } from "./whatsapp/webhookHandler.js";
import { maybeSendUnsupportedCountryNotice } from "./whatsapp/unsupportedCountryNotice.js";
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
  /** PawaPay mobile-money collection (`/collect`); omitted when PAWAPAY_API_TOKEN isn't set, in which case /collect reports itself unavailable. */
  pawapay?: PawaPayDeps | undefined;
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
  /**
   * DeepSeek Integration Phase 8: the primary transaction-parsing provider
   * (Anthropic, above, is now the fallback — see `parseWithProviderFallback`
   * below and PHASE_0_FINDINGS.md's "Phase 8" entry for the user-directed,
   * cost-driven reversal of Phase 0's original posture). Concretely typed as
   * `DeepSeekAiProvider`, not the narrower `AiProvider` interface, because
   * `parseWithProviderFallback` needs `parseTransactionTextWithUsage` (real
   * token usage for the cost ledger) and `modelKey` (for cost estimation),
   * neither of which `AiProvider` exposes. Unset — mirrors every other
   * optional credential dep in this file — means DeepSeek is never attempted
   * and every message goes straight to the existing Anthropic path, exactly
   * as before this phase.
   */
  deepseekProvider?: DeepSeekAiProvider | undefined;
  /** Independent breaker instance from aiCircuitBreaker (above) — DeepSeek's own failure history must never trip, or be tripped by, the breaker guarding the Anthropic path. */
  deepseekCircuitBreaker?: CircuitBreaker | undefined;
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
 * DeepSeek Integration Phase 8: the per-business live half of the two-gate
 * flag topology (see src/worker.ts's own doc comment for the boot-time half,
 * AI_PROVIDER_DEEPSEEK_ENABLED). Off by default (Standard #7) — see
 * prisma/seed.ts. A business only gets DeepSeek as its primary parser once
 * this flag is on AND the worker was booted with a configured
 * `deps.deepseekProvider` — see `parseWithProviderFallback` below.
 */
export const AI_PROVIDER_DEEPSEEK_FEATURE_FLAG_KEY = "aiProviderDeepseek";

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
const QUERY_REPLY = "Try /today for today's summary, /debts to see everyone who owes you, or /customer <name> for one person.";
const CLARIFICATION_REPLY =
  'I couldn\'t confidently understand that. Try rephrasing, e.g. "sold 2 bread for 500" or "spent 3000 on transport".';
/**
 * Shown instead of CLARIFICATION_REPLY when a multi-line message could not be read as a list (see
 * ai/listEntry.ts): a real shop owner sent a whole day's sales and debts in one message and only got
 * the generic reply, with no hint how to send it.
 */
const MULTILINE_CLARIFICATION_REPLY = [
  "I couldn't read that list. To send several entries at once, start with a heading line (Sale, Debt, Expense or Payment) and put each entry on its own line, ending with the amount:",
  "",
  "Sale",
  "Sneakers 2 pair =1200",
  "Bread 3 =300",
  "Debt",
  "Manager =650",
  "",
  'Or send one entry per message, e.g. "sold 2 sneakers 1200".',
].join("\n");
const LIST_ALREADY_RECORDED_REPLY = "I've already recorded that list, so I haven't added it again.";

function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}
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
    // A billing/auth failure (see isAiProviderConfigurationError's own doc comment for the
    // production incident this closes) is not transient — the circuit breaker will keep
    // probing it every resetTimeoutMs forever, and every probe will keep failing the same
    // way, until a human tops up billing or rotates the key. Reporting it under a distinct
    // title (rather than folding it into the generic "AI provider call failed" bucket that
    // also covers ordinary transient blips) keeps it from being lost in routine noise, and
    // gives it its own alerts.ts dedupe window so it doesn't get silently suppressed by an
    // unrelated transient failure that happened to fire first.
    const failure = classifyAiProviderFailure(error);
    await reportIncident(deps.alerts, {
      service: SERVICE_NAME,
      title: failure ? failure.title : "AI provider call failed",
      detail: `${failure ? `${failure.advice} (HTTP ${failure.status ?? "?"})\n` : ""}${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    });
    return { result: AI_PROVIDER_UNAVAILABLE_RESULT, degraded: true };
  }
}

/**
 * Rough, deliberately conservative pre-call token estimate for
 * `reserveAiUsage`'s `estimatedCostMicroUsd` — refined to the real,
 * vendor-reported token counts at `commitAiUsage` time once the call
 * returns (F-3's whole point: the estimate only ever guards the RESERVE
 * phase's budget hold, never what's actually billed). ~4 characters/token
 * is a standard rough estimator for English-like text; the merchant's raw
 * message is what's actually sent, so its length is what's estimated from —
 * SYSTEM_PROMPT's own (much larger, fixed) token cost is deliberately not
 * included here, since a rough per-message estimate only needs to be in the
 * right ballpark for a budget hold, not exact.
 */
function estimateDeepSeekPromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
const ESTIMATED_DEEPSEEK_COMPLETION_TOKENS = 150;

/**
 * DeepSeek Integration Phase 8, F-2/F-3 closure — the first live caller of
 * `src/domain/aiUsageLedger.ts`'s RESERVE -> COMMIT/RELEASE flow (that
 * module was fully built and tested in isolation but never wired to any
 * call path before this phase). Returns `undefined` whenever the caller
 * (`parseWithProviderFallback`) should fall through to the existing
 * Anthropic path instead — DeepSeek not being attempted at all (a gate
 * closed) and DeepSeek being attempted-but-failing are both treated
 * identically by the caller, so this function doesn't need to distinguish
 * them in its return type.
 */
async function tryParseWithDeepSeek(
  deps: DispatcherDeps,
  scopedPrisma: TenantScopedClient,
  business: { id: string },
  text: string,
  idempotencyKey: string,
): Promise<{ result: AiParseResult; degraded: boolean } | undefined> {
  const provider = deps.deepseekProvider;
  if (!provider) return undefined;

  const flagOn = await isFeatureEnabled(scopedPrisma, business.id, AI_PROVIDER_DEEPSEEK_FEATURE_FLAG_KEY);
  if (!flagOn) return undefined;

  const breaker = deps.deepseekCircuitBreaker;
  if (breaker && !breaker.canAttempt()) return undefined;

  const modelEntry = resolveAiModel(provider.modelKey);
  if (!modelEntry) return undefined; // misconfigured registry key — fall back to Anthropic rather than throw mid-dispatch

  const estimatedCostMicroUsd = estimateCostMicroUsd(
    modelEntry,
    estimateDeepSeekPromptTokens(text),
    ESTIMATED_DEEPSEEK_COMPLETION_TOKENS,
  );
  const promptHash = createHash("sha256").update(text).digest("hex");

  let requestId: string;
  try {
    ({ requestId } = await reserveAiUsage(scopedPrisma, {
      businessId: business.id,
      feature: "TRANSACTION_PARSE",
      provider: "DEEPSEEK",
      requestedModel: modelEntry.apiModelName,
      resolvedModel: modelEntry.apiModelName,
      estimatedCostMicroUsd,
      promptHash,
      idempotencyKey,
    }));
  } catch (error) {
    if (error instanceof AiUsageAlreadyCommittedError) {
      // Already billed for this exact idempotencyKey/provider pair — e.g. a BullMQ retry of a
      // job that already completed. Never re-call the vendor for an already-committed message;
      // fall back to Anthropic's own fresh attempt rather than risk a second charge.
      return undefined;
    }
    // A ledger-write failure (DB blip) shouldn't strand the merchant behind a broken cost-
    // tracking system — degrade to Anthropic exactly as if DeepSeek were simply unavailable.
    await reportIncident(deps.alerts, {
      service: SERVICE_NAME,
      title: "AiUsageLedger reserveAiUsage failed for a DeepSeek attempt",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return undefined;
  }

  let parsed: Awaited<ReturnType<DeepSeekAiProvider["parseTransactionTextWithUsage"]>>;
  try {
    parsed = await provider.parseTransactionTextWithUsage({ text });
  } catch (error) {
    breaker?.recordFailure();
    await releaseAiUsage(scopedPrisma, requestId, {
      errorClass: error instanceof Error ? error.constructor.name : "UNKNOWN",
    }).catch((releaseError: unknown) => {
      void reportIncident(deps.alerts, {
        service: SERVICE_NAME,
        title: "AiUsageLedger releaseAiUsage failed after a DeepSeek call failure",
        detail: releaseError instanceof Error ? (releaseError.stack ?? releaseError.message) : String(releaseError),
      });
    });
    // DeepSeek out of balance, or its key rejected, never fixes itself and is invisible to merchants while Anthropic covers: it gets its own title.
    const failure = classifyAiProviderFailure(error);
    await reportIncident(deps.alerts, {
      service: SERVICE_NAME,
      title: failure ? failure.title : "DeepSeek transaction-parse call failed — falling back to Anthropic",
      detail: `${failure ? `${failure.advice} (HTTP ${failure.status ?? "?"}). Merchants are being served by the fallback provider meanwhile.\n` : ""}${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    });
    return undefined;
  }

  // The vendor call succeeded and was billed, so the parse result is good no matter what happens
  // to the cost ledger below. A ledger-write failure (DB blip) must NOT discard it: falling back
  // to Anthropic here would pay for a second parse and wrongly count a DeepSeek failure against
  // its circuit breaker. Report it and carry on — the RESERVE row simply stays uncommitted.
  breaker?.recordSuccess();
  try {
    const actualCostMicroUsd = estimateCostMicroUsd(modelEntry, parsed.usage.promptTokens, parsed.usage.completionTokens);
    await commitAiUsage(scopedPrisma, requestId, { actualCostMicroUsd });
  } catch (error) {
    await reportIncident(deps.alerts, {
      service: SERVICE_NAME,
      title: "AiUsageLedger commitAiUsage failed after a successful DeepSeek call",
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
  return { result: buildAiParseResult(parsed.data), degraded: false };
}

/**
 * DeepSeek Integration Phase 8: tries DeepSeek first as the primary
 * transaction-parsing provider (explicit, user-directed reversal of Phase
 * 0's Anthropic-only posture — cost-driven; see PHASE_0_FINDINGS.md's
 * "Phase 8" entry for the full record of that decision), falling back to
 * the existing `parseWithCircuitBreaker` (Anthropic) path unchanged whenever
 * DeepSeek is not attempted at all (any of `tryParseWithDeepSeek`'s three
 * gates closed) or is attempted and fails. DeepSeek failing never itself
 * produces a degraded reply to the merchant — only Anthropic also failing
 * (or the Anthropic breaker also being open) does, exactly as before this
 * phase for that path.
 */
async function parseWithProviderFallback(
  deps: DispatcherDeps,
  scopedPrisma: TenantScopedClient,
  business: { id: string },
  text: string,
  idempotencyKey: string,
): Promise<{ result: AiParseResult; degraded: boolean }> {
  const deepseekOutcome = await tryParseWithDeepSeek(deps, scopedPrisma, business, text, idempotencyKey);
  if (deepseekOutcome) return deepseekOutcome;

  return parseWithCircuitBreaker(deps, text);
}

/**
 * First live wiring of `src/domain/aiBudget.ts`'s graduated evaluator — that
 * module was fully built and tested (Phase 3) but, per its own doc comment,
 * never called from any live path before now. Deliberately RECORD-only:
 * `enforcementEnabled` is hardcoded `false` here (not read from an env var
 * yet), so this can only ever observe and alert, never block or downgrade a
 * call — `isAiCallPermitted`/`isPremiumModelRestricted` are intentionally
 * not invoked anywhere in this file. Flipping real enforcement on is a
 * separate, later decision (needs the placeholder thresholds in
 * aiBudget.ts replaced with real, business-approved numbers first).
 *
 * Awaited by the caller (same convention as this function's neighboring
 * `assertWithinQuotaIfEnabled` check) so its ordering relative to the reply
 * is deterministic and testable, but every error is caught here rather than
 * propagated — a slow query or DB blip in this purely-observational check
 * must never fail message dispatch or the merchant's reply. Runs once per
 * free-text (AI-parsed) message rather than per-command, since it only has
 * something to observe when an AI call was actually attempted, and
 * piggybacking on that path keeps the extra DB reads proportionally small
 * next to the LLM call itself.
 */
async function recordAiBudgetObservation(
  deps: DispatcherDeps,
  scopedPrisma: TenantScopedClient,
  business: { id: string; timezone: string },
): Promise<void> {
  try {
    const evaluation = await evaluateAiBudget(scopedPrisma, business.id, business.timezone, false);
    if (evaluation.level === "RECORD") return;

    await reportIncident(deps.alerts, {
      service: SERVICE_NAME,
      title: `AI budget ${evaluation.level} threshold reached`,
      detail:
        `businessId=${business.id} usedMicroUsd=${evaluation.usedMicroUsd} ` +
        `budgetMicroUsd=${evaluation.budgetMicroUsd} fractionUsed=${evaluation.fractionUsed} ` +
        "— record-only mode: nothing was blocked or downgraded.",
    });
  } catch (error) {
    console.error(
      "recordAiBudgetObservation failed (non-fatal, record-only):",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
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

/**
 * Applies a list message (see ai/listEntry.ts) through the same applyLoggableIntent path single
 * entries use: all Sale lines become ONE sale with line items, and each Debt / Expense / Payment line
 * its own entry. Replies with a summary of what was saved and which lines were skipped. A message
 * that already produced entries (a re-driven webhook) is never applied twice.
 */
async function handleListMessage(
  deps: DispatcherDeps,
  merchant: Merchant,
  business: { id: string; name: string; currencyCode: string; timezone: string; currency: { minorUnitExp: number } },
  scopedPrisma: TenantScopedClient,
  list: ParsedList,
  whatsappMessageId: string,
): Promise<void> {
  if ((await scopedPrisma.transaction.count({ where: { whatsappMessageId } })) > 0) {
    await reply(deps, merchant.phoneNumber, LIST_ALREADY_RECORDED_REPLY);
    return;
  }

  const exp = business.currency.minorUnitExp;
  const money = (amountMinor: bigint): string => `${formatMoney(amountMinor, exp)} ${business.currencyCode}`;
  const stockTrackingEnabled = list.entries.some((e) => e.section === "SALE")
    ? await isFeatureEnabled(scopedPrisma, business.id, STOCK_TRACKING_FEATURE_FLAG_KEY)
    : false;
  const ctx = {
    scopedPrisma,
    businessId: business.id,
    currencyCode: business.currencyCode,
    minorUnitExp: exp,
    whatsappMessageId,
    stockTrackingEnabled,
    businessName: business.name,
  };

  const summary: string[] = [];
  const skipped = [...list.unreadable];
  let stoppedBy: string | null = null;

  const apply = async (intent: LoggableParsedIntent, skippedLabel: string): Promise<boolean> => {
    if (stoppedBy) {
      skipped.push(skippedLabel);
      return false;
    }
    try {
      await assertWithinQuotaIfEnabled(scopedPrisma, business.id, business.timezone);
      await applyLoggableIntent(ctx, intent);
      return true;
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        stoppedBy = error.message;
        skipped.push(skippedLabel);
        return false;
      }
      if (error instanceof DebtOverpaymentError) {
        skipped.push(`${skippedLabel} (more than they owe, or no open debt)`);
        return false;
      }
      throw error;
    }
  };

  const sales = list.entries.filter((e) => e.section === "SALE");
  if (sales.length > 0) {
    const total = sales.reduce((sum, e) => sum + e.amountMinor, 0n);
    const done = await apply(
      {
        intent: "SALE",
        confidence: 1,
        amountMinor: Number(total),
        paymentStatus: "PAID",
        items: sales.map((e) => ({ itemName: e.name, quantity: e.quantity, unitPriceMinor: Number(e.unitPriceMinor) })),
      },
      `Sale of ${sales.length} item${sales.length === 1 ? "" : "s"}`,
    );
    if (done) summary.push(`Sales: ${sales.length} item${sales.length === 1 ? "" : "s"}, ${money(total)}`);
  }

  const groups: Array<[ListSection, string]> = [
    ["DEBT", "Debts"],
    ["PAYMENT", "Payments received"],
    ["EXPENSE", "Expenses"],
  ];
  for (const [section, label] of groups) {
    const saved: string[] = [];
    for (const entry of list.entries.filter((e) => e.section === section)) {
      const amount = Number(entry.amountMinor);
      const intent: LoggableParsedIntent =
        section === "DEBT"
          ? { intent: "DEBT_NOTE", confidence: 1, amountMinor: amount, customerName: entry.name }
          : section === "PAYMENT"
            ? { intent: "PAYMENT_RECEIVED", confidence: 1, amountMinor: amount, customerName: entry.name }
            : { intent: "EXPENSE", confidence: 1, amountMinor: amount, description: entry.name };
      if (await apply(intent, `${entry.name} ${money(entry.amountMinor)}`)) saved.push(`${entry.name} ${formatMoney(entry.amountMinor, exp)}`);
    }
    if (saved.length > 0) summary.push(`${label} (${saved.length}): ${saved.join(", ")} ${business.currencyCode}`);
  }

  const lines: string[] = [summary.length > 0 ? "Done! Here's what I saved:" : "I couldn't save anything from that list."];
  for (const line of summary) lines.push(`- ${line}`);
  if (skipped.length > 0) {
    lines.push("", "I skipped these lines (send them one at a time, e.g. \"sold 2 sneakers 1200\"):");
    for (const line of skipped) lines.push(`- ${line}`);
  }
  if (stoppedBy) lines.push("", stoppedBy);
  if (list.headingDate) lines.push("", `Your list says ${list.headingDate}. TradePal saves entries with today's date.`);
  if (summary.length > 0) lines.push("", 'To take back the last entry, send "undo" (each undo removes one entry).');

  await reply(deps, merchant.phoneNumber, lines.join("\n"));
}

async function dispatchCommandOrParse(
  deps: DispatcherDeps,
  merchant: Merchant,
  text: string,
  whatsappMessageId: string,
  source: InputSource = "TEXT",
): Promise<void> {
  const business = await deps.prisma.business.findUniqueOrThrow({
    where: { id: merchant.businessId },
    include: { currency: true },
  });
  const scopedPrisma = getTenantScopedClient(deps.prisma, business.id);

  // Phase 7 (per-business flag, default OFF): AI-read entries are previewed and saved only after the person confirms. With the
  // flag off, every line below behaves exactly as it did before.
  const conversational = await conversationEnabled(scopedPrisma, business.id);
  const convCtx: ConversationCtx = { prisma: deps.prisma, scoped: scopedPrisma, merchant, business };
  if (conversational) {
    if (source === "VOICE") text = text.replace(/^\s*\/+/, ""); // a transcript is never run as a slash command
    if (!text.trim().startsWith("/")) {
      const answer = await tryHandleReply(convCtx, text, source);
      if (answer !== null) {
        await reply(deps, merchant.phoneNumber, answer);
        return;
      }
    }
  }

  // Shop owners on a phone often type just the word, with a slip of the finger ("Today", "stok", "debst",
  // "remnd Amina"): a few unambiguous read-only commands work without the slash and with one wrong letter.
  // See commands/bareCommands.ts for exactly what is (and deliberately isn't) matched.
  const bare = matchBareCommand(text);
  // A command typed WITHOUT its slash but WITH a name or amount ("paid Amina 300", "customer Amina", "add staff 0803..."): see
  // commands/bareCommands.ts. If the command turns out not to be available to this business, the message is read the normal way instead.
  let viaBare: { original: string; hint: string } | null = null;
  if (bare) text = bare;
  else if (isUndoTypo(text)) {
    // A near-miss of "undo" is never acted on (an undo can't itself be undone); ask for the exact word.
    await reply(deps, merchant.phoneNumber, UNDO_CONFIRM_REPLY);
    return;
  } else if (source !== "VOICE" && !text.trim().startsWith("/")) {
    // (A voice note is never read this way: a mis-heard word must not change a record.)
    const plain = matchPlainWord(text);
    if (plain) {
      viaBare = { original: text, hint: "" };
      text = plain;
    }
    else {
      const match = await matchBareCommandWithArgs(text, {
        customerExists: async (name) => (await findCustomerByName(scopedPrisma, name)) !== null,
        customerHasOpenDebt: async (name) => {
          const c = await findCustomerByName(scopedPrisma, name);
          return c !== null && (await listOpenDebtsForCustomer(scopedPrisma, c.id)).length > 0;
        },
      });
      if (match) {
        viaBare = { original: text, hint: match.hint };
        text = match.command;
      }
    }
  }

  if (text.trim().startsWith("/")) {
    let replyText: string;
    try {
      replyText = await handleCommand(
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
          pawapay: deps.pawapay,
          paymentsCheckoutRedirectUrl: deps.paymentsCheckoutRedirectUrl,
        },
        text,
      );
    } finally {
      // /collect carries the customer's mobile-money number as its last word (Standard #9: don't keep it).
      // In a finally so even a command that throws can't leave the number in the stored message.
      if (/^\/collect(\s|$)/i.test(text.trim())) {
        await redactPayerNumberInStoredMessage(deps.prisma, whatsappMessageId);
      }
    }
    if (viaBare && /^Unrecognized command/.test(replyText)) {
      // Not a command this business has switched on: it was ordinary writing after all. Read it the normal way.
      text = viaBare.original;
    } else {
      await reply(deps, merchant.phoneNumber, viaBare?.hint ? `${replyText}\n\n${viaBare.hint}` : replyText);
      return;
    }
  }

  // A whole day written as a list (heading + one entry per line) is read with plain rules, not the AI.
  const list = parseListMessage(text, { currencyCode: business.currencyCode, minorUnitExp: business.currency.minorUnitExp });
  if (list) {
    await handleListMessage(deps, merchant, business, scopedPrisma, list, whatsappMessageId);
    return;
  }

  const { result, degraded } = await parseWithProviderFallback(deps, scopedPrisma, business, text, whatsappMessageId);
  await recordAiBudgetObservation(deps, scopedPrisma, business);
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

  if (outcome.loggable && conversational) {
    try {
      await assertWithinQuotaIfEnabled(scopedPrisma, business.id, business.timezone);
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) throw error;
      await recordAiParseLog(deps.prisma, { businessId: business.id, whatsappMessageId, rawInput: text, result, finalAction: "REJECTED" });
      await reply(deps, merchant.phoneNumber, error.message);
      return;
    }
    const proposal = await proposeLoggable(convCtx, { parsed: outcome.loggable, parse: result, rawText: text, whatsappMessageId, source });
    await reply(deps, merchant.phoneNumber, proposal.reply);
    return;
  }

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
    replyText =
      outcome.replyText === CLARIFICATION_REPLY && countNonEmptyLines(text) >= 2
        ? MULTILINE_CLARIFICATION_REPLY
        : outcome.replyText;
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
/**
 * STOP / START from a number that is NOT a registered merchant and has a consent history with us (Phase 7). Handled before the
 * onboarding path so a shopper who replies STOP is never signed up as a merchant. The only message sent back is the one
 * confirmation, and it is allowed even though the number is now blocked. Returns false (untouched) for anything else, including
 * a STOP from a number we have no consent record for, so the older behaviour for strangers is unchanged.
 */
async function handleConsentKeyword(deps: DispatcherDeps, job: InboundMessageJob, text: string): Promise<boolean> {
  // "UPDATES <code>" from the shopper's own phone verifies their order-update consent (never a sign-up; never from a registered merchant).
  const updatesCode = parseUpdatesMessage(text);
  if (updatesCode) {
    const transport = whatsappTransport({ prisma: deps.prisma, ...deps.outboundGateway });
    const now = new Date();
    const v = await verifyUpdatesByCode(deps.prisma, { phone: job.fromNumber, code: updatesCode, now });
    const base = { toPhone: job.fromNumber, idempotencyKey: `updates:${job.waMessageId}`, lastInboundAt: now, now };
    if (v.result === "VERIFIED") await sendMessage(deps.prisma, transport, { ...base, classId: "CONSUMER_UPDATES_STARTED", params: { seller: v.sellerName, reference: v.reference } });
    else await sendMessage(deps.prisma, transport, { ...base, classId: v.result === "BLOCKED" ? "CONSUMER_UPDATES_BLOCKED" : "CONSUMER_UPDATES_UNMATCHED" });
    return true;
  }
  const keyword = consentKeyword(text);
  if (!keyword || !(await hasConsentHistory(deps.prisma, job.fromNumber))) return false;
  const transport = whatsappTransport({ prisma: deps.prisma, ...deps.outboundGateway });
  const now = new Date();
  if (keyword === "STOP") {
    await applyStop(deps.prisma, job.fromNumber);
    await sendMessage(deps.prisma, transport, { classId: "CONSUMER_OPT_OUT_CONFIRMATION", toPhone: job.fromNumber, idempotencyKey: `stop:${job.waMessageId}`, lastInboundAt: now, now });
  } else {
    const result = await applyStart(deps.prisma, job.fromNumber);
    // Only say "on again" when something was actually turned back on; an operator block, or a number whose consents were never
    // withdrawn by STOP, gets no claim it cannot keep (and no reply).
    if (result.restored > 0) {
      await sendMessage(deps.prisma, transport, { classId: "CONSUMER_OPT_IN_CONFIRMATION", toPhone: job.fromNumber, idempotencyKey: `start:${job.waMessageId}`, lastInboundAt: now, now });
    }
  }
  return true;
}

export async function dispatchInboundMessage(deps: DispatcherDeps, job: InboundMessageJob): Promise<void> {
  try {
    const text = await extractMessageText(deps.prisma, job);
    const merchant = await findMerchantByPhoneNumber(deps.prisma, job.fromNumber);

    if (!merchant && text !== null && (await handleConsentKeyword(deps, job, text))) {
      // A shopper's STOP / START: recorded and answered. Never treated as a sign-up.
    } else if (!merchant) {
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
        // No Merchant row exists (or ever will, for this number), and the normal outbound path
        // refuses unregistered numbers (Non-Negotiable Standard #9). Rather than leave the person
        // in silence, send the single fixed "not available in your country yet" notice through
        // its own narrowly-scoped path (once per number per day; nothing stored).
        await maybeSendUnsupportedCountryNotice({ prisma: deps.prisma, ...deps.outboundGateway }, job.fromNumber);
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
          await dispatchCommandOrParse(deps, merchant, outcome.text, job.waMessageId, "VOICE");
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
