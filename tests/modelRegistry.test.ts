import { describe, expect, it } from "vitest";
import {
  AI_MODEL_REGISTRY,
  DEFAULT_DEEPSEEK_MODEL_KEY,
  estimateCostMicroUsd,
  resolveAiModel,
} from "../src/ai/modelRegistry.js";

describe("modelRegistry", () => {
  it("resolves the default DeepSeek registry key to a pinned snapshot entry, not a moving alias", () => {
    const entry = resolveAiModel(DEFAULT_DEEPSEEK_MODEL_KEY);
    expect(entry).toBeDefined();
    expect(entry?.provider).toBe("DEEPSEEK");
    // D-3: pin an exact dated snapshot, never a bare alias like "deepseek-v4-flash".
    expect(entry?.apiModelName).toBe("deepseek-v4-flash-2026-06-snapshot");
    expect(entry?.apiModelName).not.toBe("deepseek-v4-flash");
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
