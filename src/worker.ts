import "dotenv/config";
import { Worker } from "bullmq";
import { prisma } from "./db/client.js";
import { dispatchInboundMessage } from "./messageDispatcher.js";
import { AnthropicAiProvider } from "./ai/provider.js";
import { buildFlutterwaveDepsFromEnv, getFlutterwaveCheckoutRedirectUrl } from "./config/paymentsEnv.js";
import { WhisperSttProvider } from "./stt/provider.js";
import { getRedisConnectionOptions } from "./queue/connection.js";
import { INBOUND_MESSAGE_QUEUE_NAME } from "./queue/inboundMessageQueue.js";
import type { InboundMessageJob } from "./whatsapp/webhookHandler.js";

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
