/**
 * Crash/bug alerting: the "send me a notification of what has been done"
 * half of the monitoring system. Every incident is always logged to the
 * console (so it shows up in Railway's log stream regardless of email
 * configuration), and additionally emailed via Resend's HTTP API
 * (https://resend.com/docs/api-reference/emails/send-email) when
 * `AlertEmailDeps` is supplied — built from raw `fetch` rather than an SDK
 * dependency, the same convention `stt/provider.ts` and `flutterwave/
 * client.ts` already use for their own outbound HTTP calls.
 *
 * Deliberately fire-and-forget and failure-tolerant: `reportIncident` never
 * throws, and never blocks its caller for longer than `EMAIL_TIMEOUT_MS`. An
 * alerting system that can itself crash the process it's supposed to be
 * reporting on, or that turns a real incident into a second, alerting-
 * related incident, is worse than no alerting at all.
 */
export interface AlertEmailDeps {
  apiKey: string;
  from: string;
  to: string[];
  fetchImpl?: typeof fetch;
}

export interface Incident {
  /** Which process/entrypoint this came from, e.g. "worker", "server", "business-digest-worker". */
  service: string;
  /** Short, stable summary — used as (half of) the dedupe key, so keep it constant across occurrences of the same problem. */
  title: string;
  /** Longer, free-form detail — may vary per-occurrence (stack trace, job id, etc.) without affecting dedupe. */
  detail: string;
}

const EMAIL_TIMEOUT_MS = 5000;

/**
 * Repeated identical incidents (e.g. every job failing the same way for
 * several minutes) must not flood the inbox — deduped per `${service}:
 * ${title}` within this window. Deliberately in-memory/per-process, same
 * "acceptable, self-correcting tradeoff" as circuitBreaker.ts's own state:
 * a redeploy or a second replica resets/duplicates the window, which is fine
 * for a notify-a-human feature (unlike, say, a payment idempotency key).
 */
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;
let lastSentAt = new Map<string, number>();

/** Test-only: clears the dedupe window so each test starts from a clean slate. */
export function resetAlertDedupeForTests(): void {
  lastSentAt = new Map();
}

function shouldSendNow(key: string): boolean {
  const last = lastSentAt.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;
  lastSentAt.set(key, now);
  return true;
}

async function sendAlertEmail(deps: AlertEmailDeps, incident: Incident): Promise<void> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);

  try {
    const response = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: deps.from,
        to: deps.to,
        subject: `[TradePal ${incident.service}] ${incident.title}`,
        text: incident.detail,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Alert email send failed (${response.status}): ${errorBody}`);
    }
  } catch (error) {
    // Never let an alerting failure become its own uncaught incident.
    console.error("Alert email send threw:", error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The single entrypoint every crash/error-handling call site in this
 * codebase reports through. Always logs to console first (unconditional,
 * synchronous-looking record independent of email deliverability), then —
 * only when `deps` is configured and this exact incident hasn't already
 * fired within the dedupe window — best-effort emails it. Never throws.
 */
export async function reportIncident(deps: AlertEmailDeps | undefined, incident: Incident): Promise<void> {
  console.error(`[incident] ${incident.service}: ${incident.title} — ${incident.detail}`);

  if (!deps) return;
  if (!shouldSendNow(`${incident.service}:${incident.title}`)) return;

  await sendAlertEmail(deps, incident);
}
