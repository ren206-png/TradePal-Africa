import { describe, expect, it } from "vitest";
import {
  AI_MODEL_REGISTRY,
  DEFAULT_DEEPSEEK_MODEL_KEY,
  estimateCostMicroUsd,
  resolveAiModel,
} from "../src/ai/modelRegistry.js";

describe("modelRegistry", () => {
  it("resolves the default DeepSeek registry key to a dated-snapshot registry key with a vendor-accepted apiModelName", () => {
    const entry = resolveAiModel(DEFAULT_DEEPSEEK_MODEL_KEY);
    expect(entry).toBeDefined();
    expect(entry?.provider).toBe("DEEPSEEK");
    // D-3's intent survives at the registry-key level: AI_DEEPSEEK_MODEL selects
    // this dated pseudo-snapshot key, not a raw vendor string, so an operator
    // can't accidentally repoint it at a bare alias via the env var alone.
    // But apiModelName — the literal string sent as `model` in the request
    // body — must be a name DeepSeek's API actually accepts. Confirmed live in
    // production (2026-08-20): "deepseek-v4-flash-2026-06-snapshot" as
    // apiModelName was rejected with DeepSeek 400 "The supported API model
    // names are deepseek-v4-pro or deepseek-v4-flash, ...". DeepSeek does not
    // support dated snapshot pinning at all, so the bare alias is correct here.
    expect(DEFAULT_DEEPSEEK_MODEL_KEY).toBe("deepseek-v4-flash-2026-06-snapshot");
    expect(entry?.apiModelName).toBe("deepseek-v4-flash");
  });

  it("returns undefined (never throws) for an unknown key", () => {
    expect(resolveAiModel("not-a-real-model")).toBeUndefined();
  });

  it("every registry entry's pricing fields are bigint, never a float", () => {
    for (const entry of Object.values(AI_MODEL_REGISTRY)) {
      expect(typeof entry.inputCostMicroUsdPer1kTokens).toBe("bigint");
      expect(typeof entry.outputCostMicroUsdPer1kTokens).toBe("bigint");
    }
  });

  describe("estimateCostMicroUsd", () => {
    const pricing = { inputCostMicroUsdPer1kTokens: 140n, outputCostMicroUsdPer1kTokens: 280n };

    it("computes integer micro-USD cost from token counts", () => {
      // 1000 input tokens * 140 micro-USD/1k = 140; 1000 output tokens * 280/1k = 280; total 420.
      expect(estimateCostMicroUsd(pricing, 1000, 1000)).toBe(420n);
    });

    it("truncates (rounds down) fractional micro-USD via BigInt division, never over-counting", () => {
      // 500 input tokens * 140 / 1000 = 70 exactly (no truncation here); use an amount that doesn't divide evenly.
      expect(estimateCostMicroUsd(pricing, 3, 0)).toBe(0n); // 3 * 140 / 1000 = 0.42 -> truncates to 0
    });

    it("clamps negative or fractional token counts to zero rather than producing a negative or fractional cost", () => {
      expect(estimateCostMicroUsd(pricing, -100, -50)).toBe(0n);
      expect(estimateCostMicroUsd(pricing, 1.9, 1.9)).toBe(0n);
    });

    it("returns zero cost for zero tokens", () => {
      expect(estimateCostMicroUsd(pricing, 0, 0)).toBe(0n);
    });
  });
});
