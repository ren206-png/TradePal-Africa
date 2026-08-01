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
