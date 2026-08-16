import "dotenv/config";
import { Worker } from "bullmq";
import { prisma } from "./db/client.js";
import { dispatchInboundMessage } from "./messageDispatcher.js";
import { AnthropicAiProvider } from "./ai/provider.js";
import { DeepSeekAiProvider } from "./ai/deepseekProvider.js";
import { buildDeepSeekDepsFromEnv } from "./config/deepseekEnv.js";
import { buildFlutterwaveDepsFromEnv, getFlutterwaveCheckoutRedirectUrl } from "./config/paymentsEnv.js";
import { buildAlertEmailDepsFromEnv } from "./config/monitoringEnv.js";
import { reportIncident } from "./monitoring/alerts.js";
import { CircuitBreaker } from "./monitoring/circuitBreaker.js";
import { WhisperSttProvider } from "./stt/provider.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { INBOUND_MESSAGE_QUEUE_NAME } from "./queue/inboundMessageQueue.js";
import type { InboundMessageJob } from "./whatsapp/webhookHandler.js";

const SERVICE_NAME = "worker";

// Optional, same as every other credential dep below: a deployment that
// hasn't signed up for an email-alerting provider yet still boots this
// worker exactly as before — reportIncident's own unconditional
// console.error is the fallback (see monitoring/alerts.ts). Built here
// (rather than only inline where DeepSeek's breaker needs it) since it's
// the same alerts bundle DeepSeek's circuit-breaker alerting below uses.
const alerts = buildAlertEmailDepsFromEnv();
if (!alerts) {
  console.warn(
    "worker: ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set — DeepSeek circuit-breaker incident alerts will only be logged to console, not emailed.",
  );
}

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
 * Guards the DeepSeek call in messageDispatcher.ts's parseWithProviderFallback
 * — see circuitBreaker.ts's own doc comment for the full state-machine
 * reasoning. Thresholds are a first, deliberately simple guess (3
 * consecutive failures, 1-minute cooldown before probing again) rather than
 * tuned against real incident data, since none exists yet for DeepSeek.
 * DeepSeek's own failure history must never trip, or be tripped by, any
 * breaker guarding the Anthropic fallback path — this is an entirely
 * independent instance.
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
const paymentsCheckoutRedirectUrl = getFlutterwaveCheckoutRedirectUrl();

const deps = {
  prisma,
  aiProvider,
  sttProvider,
  flutterwave,
  paymentsCheckoutRedirectUrl,
  alerts,
  deepseekProvider,
  deepseekCircuitBreaker,
  outboundGateway: {
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    ...(staffAddedTemplate ? { staffAddedTemplate } : {}),
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
});

console.log(`TradePal inbound-message worker listening on queue "${INBOUND_MESSAGE_QUEUE_NAME}"`);
