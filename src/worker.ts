import "dotenv/config";
import { Worker } from "bullmq";
import { prisma } from "./db/client.js";
import { dispatchInboundMessage } from "./messageDispatcher.js";
import { AnthropicAiProvider } from "./ai/provider.js";
import { DeepSeekAiProvider } from "./ai/deepseekProvider.js";
import { buildDeepSeekDepsFromEnv } from "./config/deepseekEnv.js";
import { buildFlutterwaveDepsFromEnv, buildPawaPayDepsFromEnv, getFlutterwaveCheckoutRedirectUrl } from "./config/paymentsEnv.js";
import { parseTestRecipientTrunkPrefixCallingCodesFromEnv } from "./config/outboundGatewayEnv.js";
import { buildAlertEmailDepsFromEnv } from "./config/monitoringEnv.js";
import { reportIncident } from "./monitoring/alerts.js";
import { CircuitBreaker } from "./monitoring/circuitBreaker.js";
import { installCrashReporting, installGracefulShutdown } from "./monitoring/processGuards.js";
import { WhisperSttProvider } from "./stt/provider.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { INBOUND_MESSAGE_QUEUE_NAME } from "./queue/inboundMessageQueue.js";
import type { InboundMessageJob } from "./whatsapp/webhookHandler.js";

const SERVICE_NAME = "worker";

// Optional (mirrors every other credential dep below): a deployment that
// hasn't signed up for an email-alerting provider yet still boots this
// worker exactly as before this monitoring phase — reportIncident's own
// unconditional console.error is the fallback (see monitoring/alerts.ts).
const alerts = buildAlertEmailDepsFromEnv();
if (!alerts) {
  console.warn(
    "worker: ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set — crash/incident alerts will only be logged to console, not emailed.",
  );
}

// Any uncaughtException/unhandledRejection escaping this process from here
// on is reported, then the process exits so Railway's restart policy can
// bring up a clean replacement — see processGuards.ts's own doc comment for
// why "restart" (not an in-place patch) is this codebase's actual "fix it
// automatically" step for a genuine crash.
installCrashReporting(SERVICE_NAME, alerts);

/**
 * Guards the one call this worker makes to an external AI vendor
 * (messageDispatcher.ts's parseWithCircuitBreaker) — see circuitBreaker.ts's
 * own doc comment for the full state-machine reasoning. Thresholds are a
 * first, deliberately simple guess (3 consecutive failures, 1-minute
 * cooldown before probing again) rather than tuned against real incident
 * data, since none exists yet for this codebase.
 */
const aiCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  onOpen: (consecutiveFailures) => {
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "AI provider circuit breaker opened",
      detail:
        `Tripped open after ${consecutiveFailures} consecutive AI-parse failures — every inbound free-text ` +
        "message will get a degraded reply until the breaker recovers (see messageDispatcher.ts).",
    });
  },
  onClose: () => {
    void reportIncident(alerts, {
      service: SERVICE_NAME,
      title: "AI provider circuit breaker closed",
      detail: "AI-parse calls are succeeding again — back to normal, degraded replies have stopped.",
    });
  },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const aiProvider = new AnthropicAiProvider({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

// Voice-note transcription (see messageDispatcher.ts's resolveVoiceNote) is a new,
// off-by-default, optional feature — an unset OPENAI_API_KEY should mean "skip
// voice transcription", not "refuse to boot the worker at all", mirroring how
// subscriptionExpiryWorker.ts treats missing WhatsApp send credentials.
const openAiApiKey = process.env["OPENAI_API_KEY"];
if (!openAiApiKey) {
  console.warn("OPENAI_API_KEY is not set — voice-note transcription will be unavailable (voice notes get the standard 'text only' reply).");
}
const sttProvider = openAiApiKey ? new WhisperSttProvider({ apiKey: openAiApiKey }) : undefined;

/**
 * DeepSeek Integration Phase 8 (explicit, user-directed reversal of Phase
 * 2's inert-only posture — cost-driven; see PHASE_0_FINDINGS.md's "Phase 8"
 * entry for the full record): `deepseekProvider`/`deepseekCircuitBreaker`
 * below are now added to the `deps` object a few lines down, so
 * `dispatchInboundMessage` -> `messageDispatcher.ts`'s
 * `parseWithProviderFallback` can actually attempt DeepSeek as the primary
 * transaction-parsing provider, with Anthropic (`aiProvider`, above) as its
 * automatic fallback.
 *
 * Two gates, both read here, are the boot-time half of the two-gate flag
 * topology (the DB-backed `aiProviderDeepseek` FeatureFlag, checked inside
 * `parseWithProviderFallback`, is the other, per-business live half — both
 * must pass for any single business's messages to actually reach DeepSeek):
 *   1. AI_PROVIDER_DEEPSEEK_ENABLED — boot-time master switch, unset/false
 *      by default (Appendix B). Off means the code path below is skipped
 *      entirely, mirroring sttProvider's own "absent, not just unused" bar —
 *      `deps.deepseekProvider` stays `undefined` and every message goes
 *      straight to Anthropic exactly as it did before this phase.
 *   2. DEEPSEEK_API_KEY (via buildDeepSeekDepsFromEnv) — same all-or-nothing
 *      optionality as every other build*DepsFromEnv() bundle in this file.
 */
const deepSeekEnabled = process.env["AI_PROVIDER_DEEPSEEK_ENABLED"] === "true";
const deepSeekDeps = deepSeekEnabled ? buildDeepSeekDepsFromEnv() : undefined;
if (deepSeekEnabled && !deepSeekDeps) {
  console.warn(
    "worker: AI_PROVIDER_DEEPSEEK_ENABLED=true but DEEPSEEK_API_KEY/AI_DEEPSEEK_MODEL are missing or invalid — DeepSeekAiProvider will not be constructed this run.",
  );
}
const deepseekProvider = deepSeekDeps
  ? new DeepSeekAiProvider({ apiKey: deepSeekDeps.apiKey, modelKey: deepSeekDeps.modelKey })
  : undefined;
/**
 * Second, independent breaker instance (mirrors aiCircuitBreaker above,
 * lines 45-64, including its alerting pattern) — DeepSeek's own failure
 * history must never trip, or be tripped by, the Anthropic breaker guarding
 * the fallback path. onOpen/onClose alert titles are named explicitly for
 * DeepSeek so an operator reading incident emails can immediately tell
 * which provider's breaker fired without opening the detail field.
 */
const deepseekCircuitBreaker = deepseekProvider
  ? new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
      onOpen: (consecutiveFailures) => {
        void reportIncident(alerts, {
          service: SERVICE_NAME,
          title: "DeepSeek circuit breaker opened",
          detail:
            `Tripped open after ${consecutiveFailures} consecutive DeepSeek transaction-parse failures — ` +
            "inbound messages will fall back to Anthropic until the breaker recovers (see messageDispatcher.ts's parseWithProviderFallback).",
        });
      },
      onClose: () => {
        void reportIncident(alerts, {
          service: SERVICE_NAME,
          title: "DeepSeek circuit breaker closed",
          detail: "DeepSeek transaction-parse calls are succeeding again — back to DeepSeek-primary routing.",
        });
      },
    })
  : undefined;

// Mirrors WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME/_LANGUAGE and the digest/
// deletion-resolution template pairs (config/outboundGatewayEnv.ts) — both-or-
// neither-set opt-in for the addStaffMerchant proactive notification
// (merchantIdentity.ts) to send as a Meta-approved template instead of
// free-form text, closing that feature's own disclosed 24-hour-window gap.
// Configured here directly rather than via outboundGatewayEnv.ts since this
// worker (unlike server.ts's other three sweep/admin-triggered sends) already
// builds its base outboundGateway inline, and addStaffMerchant's gateway
// flows through messageDispatcher's shared deps rather than being built per-feature.
const staffAddedTemplateName = process.env["WHATSAPP_STAFF_ADDED_TEMPLATE_NAME"];
const staffAddedTemplateLanguage = process.env["WHATSAPP_STAFF_ADDED_TEMPLATE_LANGUAGE"];
const staffAddedTemplate =
  staffAddedTemplateName && staffAddedTemplateLanguage
    ? { name: staffAddedTemplateName, languageCode: staffAddedTemplateLanguage }
    : undefined;

// Phase 22: same optionality as sttProvider above — /upgrade (commandRouter.ts's
// handleUpgrade) just tells the merchant plan upgrades aren't configured yet
// when either half is missing, rather than this worker refusing to boot.
const flutterwave = buildFlutterwaveDepsFromEnv();
// Optional, like Flutterwave: unset means /collect (PawaPay mobile-money collection) reports itself unavailable.
const pawapay = buildPawaPayDepsFromEnv();
const paymentsCheckoutRedirectUrl = getFlutterwaveCheckoutRedirectUrl();

// See OutboundGatewayDeps.testRecipientTrunkPrefixCallingCodes's doc comment
// (whatsapp/outboundGateway.ts) — works around a Meta free/test-number
// allowlist quirk; unset env var means no behavior change.
const testRecipientTrunkPrefixCallingCodes = parseTestRecipientTrunkPrefixCallingCodesFromEnv();

const deps = {
  prisma,
  aiProvider,
  sttProvider,
  flutterwave,
  pawapay,
  paymentsCheckoutRedirectUrl,
  alerts,
  aiCircuitBreaker,
  deepseekProvider,
  deepseekCircuitBreaker,
  outboundGateway: {
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    ...(staffAddedTemplate ? { staffAddedTemplate } : {}),
    ...(testRecipientTrunkPrefixCallingCodes ? { testRecipientTrunkPrefixCallingCodes } : {}),
  },
};

/**
 * The BullMQ consumer side of the queue producer in queue/inboundMessageQueue.ts.
 * Each job is a single inbound WhatsApp message; dispatchInboundMessage owns
 * turning that into onboarding/command/AI-parse effects and always leaves the
 * originating WebhookEvent PROCESSED (see messageDispatcher.ts doc comment),
 * so a job is never retried just because a downstream reply failed to send.
 */
const worker = new Worker<InboundMessageJob>(
  INBOUND_MESSAGE_QUEUE_NAME,
  async (job) => {
    await dispatchInboundMessage(deps, job.data);
  },
  { connection: getRedisConnectionOptions() },
);

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id ?? "(unknown)"} failed:`, error);
  void reportIncident(alerts, {
    service: SERVICE_NAME,
    title: "Inbound-message job failed",
    detail: `Job ${job?.id ?? "(unknown)"}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  });
});

/**
 * Monitoring-phase gap closure: BullMQ's Worker is an EventEmitter, and
 * Node's own contract for EventEmitter is that an "error" event with no
 * listener throws, crashing the process (see
 * https://nodejs.org/api/events.html#error-events) — this worker had no
 * such listener before this phase, for a queue-connection-level failure
 * (e.g. Redis dropping) that BullMQ surfaces this way rather than through
 * "failed" (which is per-job, not per-connection).
 */
worker.on("error", (error) => {
  console.error("Inbound-message worker connection error:", error);
  void reportIncident(alerts, {
    service: SERVICE_NAME,
    title: "Worker connection error",
    detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
});

console.log(`TradePal inbound-message worker listening on queue "${INBOUND_MESSAGE_QUEUE_NAME}"`);

// See processGuards.ts's own doc comment: SIGTERM (sent by Railway on every
// redeploy) previously had no listener here, so Node's default behavior —
// terminate immediately — could kill a job mid-flight rather than letting
// BullMQ's own Worker.close() finish the one currently active job first.
installGracefulShutdown(SERVICE_NAME, [
  { name: "bullmq-worker", close: () => worker.close() },
  { name: "prisma", close: () => prisma.$disconnect() },
]);
