import { createHash } from "node:crypto";
import { sendUnsupportedCountryNotice, type OutboundGatewayDeps } from "./outboundGateway.js";

/**
 * Answers a person from outside the launch countries who messaged TradePal, at most once per
 * NOTICE_WINDOW_MS, so a repeat sender can't be answered over and over. The "have we already told
 * this number" memory is in-process, holds only a SHA-256 of the number (never the number), is
 * capped in size, and simply resets on a restart (worst case: one extra notice) — nothing about
 * the person is written to the database.
 *
 * Never throws: failing to send a courtesy notice must not fail the message-processing job.
 */
const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED = 10_000;

const lastNoticeAt = new Map<string, number>();

export function resetUnsupportedCountryNoticeLimiterForTests(): void {
  lastNoticeAt.clear();
}

export async function maybeSendUnsupportedCountryNotice(
  deps: OutboundGatewayDeps,
  toPhoneNumber: string,
  now: number = Date.now(),
): Promise<"sent" | "skipped" | "failed"> {
  const key = createHash("sha256").update(toPhoneNumber).digest("hex");
  const last = lastNoticeAt.get(key);
  if (last !== undefined && now - last < NOTICE_WINDOW_MS) return "skipped";

  try {
    await sendUnsupportedCountryNotice(deps, toPhoneNumber);
  } catch (error) {
    // Don't log the number or the Graph error body (which may echo it); the class and a short hint are enough.
    console.warn(`unsupported-country notice not sent (${error instanceof Error ? error.constructor.name : "error"})`);
    return "failed";
  }

  lastNoticeAt.delete(key);
  lastNoticeAt.set(key, now);
  if (lastNoticeAt.size > MAX_REMEMBERED) {
    const oldest = lastNoticeAt.keys().next().value;
    if (oldest !== undefined) lastNoticeAt.delete(oldest);
  }
  return "sent";
}
