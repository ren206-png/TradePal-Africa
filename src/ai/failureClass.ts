import Anthropic from "@anthropic-ai/sdk";
import { DeepSeekHttpError } from "./deepseekProvider.js";

/**
 * Tells a billing or credential failure of an AI provider apart from an ordinary hiccup (expansion Phase 7, scenario 26). These two
 * never fix themselves, so each gets its OWN incident title per provider and per kind: a billing alert is never swallowed by the
 * dedupe window of an auth alert, a DeepSeek alert never by an Anthropic one, and none by routine "call failed" noise.
 *
 *   Anthropic: 401 / 403 -> authentication; 400 "credit balance" -> billing.
 *   DeepSeek:  401 / 403 -> authentication; 402 (Insufficient Balance) -> billing.
 */
export type AiProviderName = "Anthropic" | "DeepSeek";
export type AiFailureKind = "BILLING" | "AUTH";

export interface AiProviderFailure {
  provider: AiProviderName;
  kind: AiFailureKind;
  status: number | null;
  title: string;
  advice: string;
}

const titleOf = (provider: AiProviderName, kind: AiFailureKind): string =>
  kind === "BILLING" ? `AI provider billing failure (${provider})` : `AI provider authentication failure (${provider})`;

const adviceOf = (kind: AiFailureKind): string =>
  kind === "BILLING"
    ? "Not retryable: the account is out of balance or credit. Top it up; retries will keep failing until then."
    : "Not retryable: the API key was rejected (revoked, rotated or mistyped). Replace the key; retries will keep failing until then.";

export function classifyAiProviderFailure(error: unknown): AiProviderFailure | null {
  if (error instanceof DeepSeekHttpError) {
    const kind: AiFailureKind | null = error.status === 402 ? "BILLING" : error.status === 401 || error.status === 403 ? "AUTH" : null;
    return kind ? { provider: "DeepSeek", kind, status: error.status, title: titleOf("DeepSeek", kind), advice: adviceOf(kind) } : null;
  }
  if (error instanceof Anthropic.APIError) {
    let kind: AiFailureKind | null = null;
    if (error.status === 401 || error.status === 403) kind = "AUTH";
    else if (error.status === 400) {
      const body = error.error as { error?: { type?: string; message?: string } } | undefined;
      if (body?.error?.type === "invalid_request_error" && /credit balance/i.test(body?.error?.message ?? "")) kind = "BILLING";
    }
    return kind ? { provider: "Anthropic", kind, status: error.status ?? null, title: titleOf("Anthropic", kind), advice: adviceOf(kind) } : null;
  }
  return null;
}
