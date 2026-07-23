import crypto from "node:crypto";

/**
 * Flutterwave webhooks authenticate via a static shared-secret string in the
 * `verif-hash` header — set once in the Flutterwave dashboard, echoed back
 * unchanged on every webhook call — unlike WhatsApp's per-request HMAC over
 * the raw body (see whatsapp/signature.ts). This only proves the request
 * carries a secret the caller shouldn't have; it says nothing about the
 * payload's integrity, which is why confirmSubscriptionPayment re-verifies
 * the transaction server-to-server rather than trusting the webhook body.
 * `crypto.timingSafeEqual` still applies here for the same reason it does
 * for an HMAC comparison: a naive `===` leaks the secret's bytes one
 * character at a time via response-time differences.
 */
export function isValidFlutterwaveWebhookSignature(providedHash: string | undefined, secretHash: string): boolean {
  if (!providedHash) return false;

  const provided = Buffer.from(providedHash);
  const expected = Buffer.from(secretHash);
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}
