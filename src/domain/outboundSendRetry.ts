import { OutboundSendRefusedError } from "../whatsapp/outboundGateway.js";

/**
 * Phase 14 gap closure: this transient-vs-permanent classification and
 * bounded-retry loop used to be duplicated, near-verbatim, between
 * subscriptionExpiry.ts's sendLapseNotificationWithRetry (Phase 7/9) and
 * businessDigest.ts's sendDigestWithRetry (Phase 12) — both modules
 * explicitly disclosed the duplication as a follow-up "once a third
 * periodic-notification feature needs the same logic" (see
 * PHASE_0_FINDINGS.md's Phase 12 section). Rather than wait for a third
 * feature to justify it, this phase extracts the existing two into one
 * shared module, with no behavior change at either call site.
 *
 * `OutboundSendRefusedError` (Non-Negotiable Standard #9's registered-
 * merchant guard) is never transient — the phone number simply isn't a
 * registered merchant, retrying changes nothing. A parsed HTTP status of 429
 * (rate limited) or 5xx (Meta-side error) is treated as transient; any other
 * parsed status (e.g. 400 invalid template, 401 bad token) is not, since
 * resending the exact same request would fail the exact same way. An error
 * whose message doesn't match the "WhatsApp send failed (status)" shape at
 * all (e.g. `fetch` itself throwing on a network blip) is treated as
 * transient by default.
 */
export function isRetryableWhatsAppSendError(error: unknown): boolean {
  if (error instanceof OutboundSendRefusedError) return false;
  if (!(error instanceof Error)) return true;
  const match = /WhatsApp send failed \((\d+)\)/.exec(error.message);
  if (!match) return true;
  const status = Number(match[1]);
  return status === 429 || status >= 500;
}

/**
 * Fixed, not exponential/jittered or configurable — deliberately simple,
 * since every current caller runs inside an hourly sweep (not a latency-
 * sensitive path). Overridable per-call via `options` if a future caller
 * ever needs something different.
 */
export const DEFAULT_SEND_MAX_ATTEMPTS = 3;
export const DEFAULT_SEND_RETRY_DELAYS_MS = [250, 750];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `sendFn` up to `maxAttempts` times, but only for errors
 * `isRetryableWhatsAppSendError` considers transient — a permanent error
 * (e.g. bad template, invalid token) fails on the first attempt rather than
 * wasting further identical requests. Returns the attempt number the send
 * finally succeeded on (for audit metadata). Once attempts are exhausted or
 * a non-retryable error occurs, throws whatever `makeError` constructs —
 * callers supply their own Error subclass so existing `instanceof` checks
 * (e.g. `NotificationSendFailedError`, `DigestSendFailedError`) keep working
 * completely unchanged.
 */
export async function sendWithRetry<E extends Error>(
  sendFn: () => Promise<void>,
  makeError: (message: string, attempts: number) => E,
  options?: { maxAttempts?: number; retryDelaysMs?: number[] },
): Promise<number> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_SEND_MAX_ATTEMPTS;
  const retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_SEND_RETRY_DELAYS_MS;

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await sendFn();
      return attempt;
    } catch (error) {
      const exhausted = attempt >= maxAttempts;
      if (!isRetryableWhatsAppSendError(error) || exhausted) {
        const message = error instanceof Error ? error.message : String(error);
        throw makeError(message, attempt);
      }
      await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 750);
    }
  }
}
