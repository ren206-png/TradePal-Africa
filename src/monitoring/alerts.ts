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

/** One row per attempt to tell a person about something, and whether the channel accepted it. Written through the recorder below. */
export interface AlertDeliveryRecord {
  service: string;
  title: string;
  kind: "INCIDENT" | "CHANNEL_CHECK";
  channel: "EMAIL" | "WHATSAPP";
  status: "DELIVERED" | "FAILED";
  providerMessageId?: string;
  httpStatus?: number;
  error?: string;
}

let recorder: ((record: AlertDeliveryRecord) => Promise<void>) | null = null;

/** Registers where delivery outcomes are written (the database, in production). Unset in tests that do not care. */
export function setAlertDeliveryRecorder(fn: ((record: AlertDeliveryRecord) => Promise<void>) | null): void {
  recorder = fn;
}

async function record(r: AlertDeliveryRecord): Promise<void> {
  if (!recorder) return;
  try {
    await recorder(r);
  } catch (error) {
    // The record is for humans to review; failing to write it must never break alerting.
    console.error("Alert delivery record failed:", error);
  }
}

export interface EmailOutcome {
  delivered: boolean;
  providerMessageId?: string;
  httpStatus?: number;
  error?: string;
}

async function sendAlertEmail(deps: AlertEmailDeps, incident: Incident): Promise<EmailOutcome> {
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
      return { delivered: false, httpStatus: response.status, error: errorBody.slice(0, 300) };
    }
    // Accepted by the email service. That is what we can verify; arrival in an inbox is not observable from here.
    let id: string | undefined;
    try {
      id = ((await response.json()) as { id?: string }).id;
    } catch {
      id = undefined;
    }
    return { delivered: true, httpStatus: response.status, ...(id ? { providerMessageId: id } : {}) };
  } catch (error) {
    // Never let an alerting failure become its own uncaught incident.
    console.error("Alert email send threw:", error);
    return { delivered: false, error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The single entrypoint every crash/error-handling call site in this
 * codebase reports through. Always logs to console first (unconditional,
 * synchronous-looking record independent of email deliverability), then —
 * only when `deps` is configured and this exact incident hasn't already
 * been DELIVERED within the dedupe window — best-effort emails it. Never throws.
 *
 * Phase 7: the outcome of every send is recorded (when a recorder is registered), a send the email service REFUSED does not use up
 * the dedupe window (the next occurrence tries again), and a process with no email channel configured records that fact once per
 * window instead of staying silent.
 */
export async function reportIncident(deps: AlertEmailDeps | undefined, incident: Incident): Promise<void> {
  console.error(`[incident] ${incident.service}: ${incident.title} — ${incident.detail}`);

  const key = `${incident.service}:${incident.title}`;

  if (!deps) {
    // No email channel: say so once per window (its own bookkeeping, so it never uses up the email window of a later configured send).
    if (!shouldSendNow(`no-channel:${key}`)) return;
    await record({ service: incident.service, title: incident.title, kind: "INCIDENT", channel: "EMAIL", status: "FAILED", error: "No alert channel is configured (ALERT_EMAIL_API_KEY / ALERT_EMAIL_FROM / ALERT_EMAIL_TO unset)" });
    return;
  }

  if (!shouldSendNow(key)) return;
  const outcome = await sendAlertEmail(deps, incident);
  if (!outcome.delivered) lastSentAt.delete(key);
  await record({
    service: incident.service, title: incident.title, kind: "INCIDENT", channel: "EMAIL", status: outcome.delivered ? "DELIVERED" : "FAILED",
    ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
    ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}

/**
 * Proves the channel works RIGHT NOW by sending a clearly labelled test message and recording the outcome. Run it after changing the
 * email key or address, and on a schedule worth the noise. "Delivered" means the email service accepted it (HTTP success and a message id).
 */
export async function verifyAlertChannel(deps: AlertEmailDeps | undefined, now: Date = new Date()): Promise<EmailOutcome> {
  const incident: Incident = { service: "alert-channel-check", title: "TradePal alert channel check", detail: `This is a test of the alert channel, sent ${now.toISOString()}. Nothing is wrong. If you can read this, alerts can reach you.` };
  if (!deps) {
    const outcome: EmailOutcome = { delivered: false, error: "No alert channel is configured (ALERT_EMAIL_API_KEY / ALERT_EMAIL_FROM / ALERT_EMAIL_TO unset)" };
    await record({ service: incident.service, title: incident.title, kind: "CHANNEL_CHECK", channel: "EMAIL", status: "FAILED", error: outcome.error! });
    return outcome;
  }
  const outcome = await sendAlertEmail(deps, incident);
  await record({
    service: incident.service, title: incident.title, kind: "CHANNEL_CHECK", channel: "EMAIL", status: outcome.delivered ? "DELIVERED" : "FAILED",
    ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
    ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  return outcome;
}
