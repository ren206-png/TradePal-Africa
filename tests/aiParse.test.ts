import { describe, expect, it } from "vitest";
import type { AiParseRequest, AiProvider } from "../src/ai/provider.js";
import { buildAiParseResult, classifyConfidence, parseTransactionText } from "../src/ai/parse.js";
import { extractJsonObjectText } from "../src/ai/provider.js";

function fakeProvider(response: unknown): AiProvider {
  return {
    parseTransactionText: async (_request: AiParseRequest) => response,
  };
}

describe("classifyConfidence", () => {
  it("tiers scores into HIGH/MEDIUM/LOW", () => {
    expect(classifyConfidence(0.95)).toBe("HIGH");
    expect(classifyConfidence(0.85)).toBe("HIGH");
    expect(classifyConfidence(0.6)).toBe("MEDIUM");
    expect(classifyConfidence(0.5)).toBe("MEDIUM");
    expect(classifyConfidence(0.2)).toBe("LOW");
  });
});

describe("parseTransactionText", () => {
  it("auto-accepts a high-confidence sale with no clarification needed", async () => {
    const provider = fakeProvider({
      intent: "SALE",
      amountMinor: 2000,
      paymentStatus: "PAID",
      items: [{ itemName: "bread", quantity: 2, unitPriceMinor: 1000 }],
      confidence: 0.95,
    });

    const result = await parseTransactionText(provider, { text: "sold 2 bread 1000 each" });

    expect(result.validationPassed).toBe(true);
    expect(result.confidenceTier).toBe("HIGH");
    expect(result.requiresClarification).toBe(false);
    expect(result.parsed?.intent).toBe("SALE");
  });

  it("flags a medium-confidence transaction for confirmation rather than auto-logging", async () => {
    const provider = fakeProvider({
      intent: "SALE",
      amountMinor: 2000,
      paymentStatus: "PAID",
      confidence: 0.6,
    });

    const result = await parseTransactionText(provider, { text: "sold something for 2000 maybe" });

    expect(result.validationPassed).toBe(true);
    expect(result.confidenceTier).toBe("MEDIUM");
    expect(result.requiresClarification).toBe(true);
  });

  it("never lets a validation failure through as a parsed transaction", async () => {
    const provider = fakeProvider({ intent: "SALE", amountMinor: "not-a-number", confidence: 0.99 });

    const result = await parseTransactionText(provider, { text: "garbled input" });

    expect(result.validationPassed).toBe(false);
    expect(result.parsed).toBeUndefined();
    expect(result.confidenceTier).toBe("LOW");
    expect(result.requiresClarification).toBe(true);
  });

  it("does not require clarification for a QUERY or GREETING intent", async () => {
    const queryResult = await parseTransactionText(fakeProvider({ intent: "QUERY", confidence: 0.9 }), {
      text: "how much did I make today?",
    });
    const greetingResult = await parseTransactionText(fakeProvider({ intent: "GREETING", confidence: 0.9 }), {
      text: "hi",
    });

    expect(queryResult.requiresClarification).toBe(false);
    expect(greetingResult.requiresClarification).toBe(false);
  });

  it("always requires clarification for an UNKNOWN intent, even at high confidence", async () => {
    const result = await parseTransactionText(fakeProvider({ intent: "UNKNOWN", confidence: 0.99 }), {
      text: "asdkjaskdj",
    });

    expect(result.requiresClarification).toBe(true);
  });
});

describe("auto-log confidence bar", () => {
  const sale = (confidence: number) => ({ intent: "SALE", amountMinor: 50000, paymentStatus: "PAID", confidence });

  it("logs a transaction at or above 0.7 without asking again, even though that is only MEDIUM tier", () => {
    const result = buildAiParseResult(sale(0.7));
    expect(result.confidenceTier).toBe("MEDIUM");
    expect(result.requiresClarification).toBe(false);
  });

  it("still asks again just below 0.7", () => {
    expect(buildAiParseResult(sale(0.69)).requiresClarification).toBe(true);
    expect(buildAiParseResult(sale(0.6)).requiresClarification).toBe(true);
  });
});

describe("extractJsonObjectText", () => {
  it("unwraps a ```json fence or surrounding prose so a correct parse isn't thrown away", () => {
    const json = '{"intent":"SALE","amountMinor":50000,"confidence":0.9}';
    expect(JSON.parse(extractJsonObjectText("```json\n" + json + "\n```"))).toEqual(JSON.parse(json));
    expect(JSON.parse(extractJsonObjectText("Here you go: " + json + " Hope that helps!"))).toEqual(JSON.parse(json));
    expect(extractJsonObjectText(json)).toBe(json);
  });

  it("leaves text with no object in it unchanged, so unusable output still fails loudly", () => {
    expect(extractJsonObjectText("sorry, I can't do that")).toBe("sorry, I can't do that");
  });
});
