import type { AlertEmailDeps } from "../monitoring/alerts.js";

/**
 * All-or-nothing optional, mirroring the exact pattern
 * `buildSubscriptionExpiryOutboundGatewayFromEnv` (outboundGatewayEnv.ts)
 * already uses for WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID: a
 * deployment that hasn't signed up for an email-alerting provider yet
 * (Resend requires its own account, which is not something this codebase
 * can create on a deployment's behalf) must still be able to boot every
 * process — `reportIncident` (monitoring/alerts.ts) always logs to console
 * regardless, so alerting is a strictly additive layer, never a boot
 * requirement. ALERT_EMAIL_TO is comma-separated to allow more than one
 * recipient.
 */
export function buildAlertEmailDepsFromEnv(): AlertEmailDeps | undefined {
  const apiKey = process.env["ALERT_EMAIL_API_KEY"];
  const from = process.env["ALERT_EMAIL_FROM"];
  const toRaw = process.env["ALERT_EMAIL_TO"];
  if (!apiKey || !from || !toRaw) return undefined;

  const to = toRaw
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
  if (to.length === 0) return undefined;

  return { apiKey, from, to };
}
