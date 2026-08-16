import type { AIProviderId } from "./aiTypes.js";

/**
 * Model registry (Phase 2 requirement): callers reference a registry key,
 * never a bare vendor string literal like the incumbent Anthropic/Whisper
 * providers still do (src/ai/provider.ts:75, src/stt/provider.ts:40 — left
 * unchanged, Appendix C: no rebuild of a working feature). This is
 * additive-only infrastructure for DeepSeek; it does not touch either
 * existing provider.
 *
 * D-3 resolution (PHASE_0_FINDINGS.md, DeepSeek Integration — Phase 0, §0.6):
 * pin an exact snapshot, never track a moving alias — the brief itself notes
 * "deepseek-v4-flash" is an alias with a signaled price increase. The
 * registry key below is deliberately a dated snapshot name, and
 * AI_DEEPSEEK_MODEL (deepseekEnv.ts) selects a registry key, not a raw
 * vendor model string, so an operator cannot accidentally point this at a
 * moving alias just by editing the env var.
 *
 * PRICING DISCLOSURE — not a verified fact, flagged rather than silently
 * assumed: the two cost figures below are PLACEHOLDER values, not sourced
 * from a live DeepSeek pricing page (`UNKNOWN — searched: this repo` for any
 * existing pricing citation; this is external vendor pricing, out of reach
 * of a repo-only audit, and DeepSeek's actual published rates change over
 * time — the brief's own D-3 explicitly anticipates a "signaled price
 * increase"). Per Appendix C ("no hardcoded commercial limits/prices"),
 * these numbers must be confirmed against DeepSeek's real, current pricing
 * page and updated here before Phase 3's budget/cost math is trusted for a
 * real merchant-facing decision — Phase 3 must not silently inherit an
 * unverified placeholder as if it were confirmed.
 */
export interface AiModelPricing {
  /** Integer micro-USD per 1,000 input tokens. Never a float. */
  inputCostMicroUsdPer1kTokens: bigint;
  /** Integer micro-USD per 1,000 output tokens. Never a float. */
  outputCostMicroUsdPer1kTokens: bigint;
}

export interface AiModelRegistryEntry extends AiModelPricing {
  provider: AIProviderId;
  /** The exact string sent as `model` in the vendor API request body. */
  apiModelName: string;
}

export const AI_MODEL_REGISTRY = {
  "deepseek-v4-flash-2026-06-snapshot": {
    provider: "DEEPSEEK",
    apiModelName: "deepseek-v4-flash-2026-06-snapshot",
    // PLACEHOLDER — see file doc comment. Not yet confirmed against a live DeepSeek pricing page.
    inputCostMicroUsdPer1kTokens: 140n,
    outputCostMicroUsdPer1kTokens: 280n,
  },
} as const satisfies Record<string, AiModelRegistryEntry>;

export type AiModelRegistryKey = keyof typeof AI_MODEL_REGISTRY;

export const DEFAULT_DEEPSEEK_MODEL_KEY: AiModelRegistryKey = "deepseek-v4-flash-2026-06-snapshot";

/** Returns undefined for an unknown key rather than throwing — callers decide how to treat a misconfigured AI_DEEPSEEK_MODEL. */
export function resolveAiModel(key: string): AiModelRegistryEntry | undefined {
  return (AI_MODEL_REGISTRY as Record<string, AiModelRegistryEntry>)[key];
}

/** Integer-only cost math: BigInt division truncates, so this slightly under-counts fractional micro-USD rather than over-counts — the safer rounding direction for a cost *estimate* that Phase 3 will still reconcile against an actual figure where the vendor provides one. */
export function estimateCostMicroUsd(pricing: AiModelPricing, inputTokens: number, outputTokens: number): bigint {
  const inputCost = (pricing.inputCostMicroUsdPer1kTokens * BigInt(Math.max(0, Math.trunc(inputTokens)))) / 1000n;
  const outputCost = (pricing.outputCostMicroUsdPer1kTokens * BigInt(Math.max(0, Math.trunc(outputTokens)))) / 1000n;
  return inputCost + outputCost;
}
