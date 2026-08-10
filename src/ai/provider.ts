import Anthropic from "@anthropic-ai/sdk";

export interface AiParseRequest {
  text: string;
  languageHint?: string;
}

/**
 * Provider-abstraction layer (PHASE_0_FINDINGS ADR-2): the parsing pipeline
 * never calls a vendor SDK directly, so the default cheap-tier model can be
 * swapped or a specific request routed to a stronger model without touching
 * `src/ai/parse.ts`.
 */
export interface AiProvider {
  parseTransactionText(request: AiParseRequest): Promise<unknown>;
}

/**
 * Distinguishes a permanent, non-retryable provider misconfiguration — the
 * account behind ANTHROPIC_API_KEY out of credit, or the key itself revoked/
 * invalid — from an ordinary transient failure (network blip, momentary 5xx,
 * a rate limit that clears on its own). Root-caused live in production
 * (2026-08-04 through 2026-08-09): a $0 credit balance made every single
 * AI-parse call fail the same way, but messageDispatcher.ts's
 * parseWithCircuitBreaker reported every one of them under the same generic
 * "AI provider call failed" incident title, which is exactly the class of
 * ordinary transient failure this codebase already expects the circuit
 * breaker to absorb — nothing distinguished "will recover on its own once
 * the breaker's resetTimeoutMs elapses" from "will keep failing forever
 * until a human tops up billing or rotates the key," so the 5-day outage
 * never stood out from routine noise.
 *
 * Deliberately lives here (not in messageDispatcher.ts) rather than
 * generalizing to a provider-agnostic shape: which HTTP status/body shape
 * means "this is a billing or auth problem" is inherently vendor-specific
 * (see this file's own AiProvider abstraction doc comment on why callers
 * otherwise never reference an Anthropic SDK type directly), and duplicating
 * that vendor knowledge into messageDispatcher.ts would be the one place
 * this abstraction boundary is supposed to prevent.
 */
export function isAiProviderConfigurationError(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false;

  // Revoked/rotated/mistyped API key — same "needs a human, not a retry" class as a billing failure.
  if (error.status === 401) return true;

  if (error.status === 400) {
    const body = error.error as { error?: { type?: string; message?: string } } | undefined;
    return body?.error?.type === "invalid_request_error" && /credit balance/i.test(body?.error?.message ?? "");
  }

  return false;
}

const SYSTEM_PROMPT = `You are a structured-data extractor for an informal-retail bookkeeping assistant used across Nigeria, Kenya, Sierra Leone, Ghana, Liberia, and Gambia. Given one WhatsApp message from a merchant, output ONLY a single JSON object (no prose, no markdown fences) matching one of these shapes, choosing the "intent" that best matches:

{"intent":"SALE","amountMinor":<integer minor units>,"paymentStatus":"PAID"|"CREDIT"|"PARTIAL","customerName"?:<string>,"items"?:[{"itemName":<string>,"quantity":<integer>,"unitPriceMinor":<integer>}],"confidence":<0..1>}
{"intent":"PURCHASE","amountMinor":<integer>,"supplierName"?:<string>,"items"?:[...],"confidence":<0..1>}
{"intent":"PAYMENT_RECEIVED","amountMinor":<integer>,"customerName":<string>,"confidence":<0..1>}
{"intent":"EXPENSE","amountMinor":<integer>,"description"?:<string>,"confidence":<0..1>}
{"intent":"DEBT_NOTE","amountMinor":<integer>,"customerName":<string>,"confidence":<0..1>}
{"intent":"STOCK_ADJUSTMENT","itemName":<string>,"quantityDelta":<integer, signed>,"confidence":<0..1>}
{"intent":"QUERY","confidence":<0..1>}
{"intent":"GREETING","confidence":<0..1>}
{"intent":"UNKNOWN","confidence":<0..1>}

Amounts are always integers in the currency's minor unit (e.g. kobo, cents) — never a decimal. "confidence" reflects your own certainty that the extraction is correct, not the message's clarity in general. If the message is ambiguous, incomplete, or you are not confident, prefer "UNKNOWN" with a low confidence rather than guessing at a transaction shape.`;

export class AnthropicAiProvider implements AiProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? "claude-haiku-4-5";
  }

  async parseTransactionText(request: AiParseRequest): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: request.languageHint
            ? `[language hint: ${request.languageHint}] ${request.text}`
            : request.text,
        },
      ],
    });

    const block = response.content[0];
    const text = block && block.type === "text" ? block.text : "";
    return JSON.parse(text);
  }
}
