/**
 * Appendix A contracts from the DeepSeek integration brief, adapted to this
 * repo's own conventions per INTEGRATION_DESIGN.md §2:
 *  - `organizationId` -> `businessId` (this codebase has no Organization
 *    model; the tenant unit everywhere else is Business/businessId).
 *  - `AIUsage.estimatedCostMicroUsd` -> `bigint`, not `number`, matching
 *    src/domain/money.ts's absolute no-float-money convention.
 *
 * These types are additive: `src/ai/provider.ts`'s existing `AiProvider`/
 * `AiParseRequest` are untouched, and `AnthropicAiProvider` keeps
 * implementing that narrower interface unchanged (Appendix C — no rebuild of
 * a working feature). `DeepSeekAiProvider` (deepseekProvider.ts) also
 * implements the narrower `AiProvider` interface for Phase 2, so it drops
 * into src/messageDispatcher.ts's existing call shape with zero changes
 * there if a later phase ever chooses to route to it. This file's richer
 * shapes are what Phase 3's cost-governance layer (aiUsageLedger.ts,
 * aiBudget.ts) will consume instead.
 */

/** Registry key, not a raw vendor string — see modelRegistry.ts. */
export type AIProviderId = "ANTHROPIC" | "DEEPSEEK";

/**
 * Fixed union, not an open string (Phase 3.5's own constraint: no
 * LLM-based classifier — every call site sets this explicitly and
 * deterministically). No task class is actually routed to DeepSeek by this
 * phase or by the file that defines this type; adding a real DeepSeek-bound
 * feature here is a distinct, later routing decision, not implied by this
 * type existing.
 */
export type AIFeature =
  | "TRANSACTION_PARSE" // existing Anthropic call, src/ai/parse.ts — unchanged, tagged for ledger completeness only
  | "VOICE_TRANSCRIPTION" // existing Whisper call — same note
  | "CATALOG_SUMMARY_DRAFT"; // placeholder read-only, non-monetary example class — not wired to any provider yet

export interface AIRequest {
  feature: AIFeature;
  businessId: string;
  text: string;
  languageHint?: string;
}

export interface AIUsage {
  resolvedModel: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Integer micro-USD, never a float — matches src/domain/money.ts. */
  estimatedCostMicroUsd: bigint;
}

export interface AIResponse<T> {
  data: T;
  usage: AIUsage;
  provider: AIProviderId;
}

/**
 * Never thrown across the provider boundary — every failure mode is a typed
 * member, not an exception, so a caller cannot forget a catch block for a
 * class of failure it didn't anticipate.
 */
export type AIResult<T> =
  | { ok: true; value: AIResponse<T> }
  | {
      ok: false;
      kind: "TIMEOUT" | "RATE_LIMITED" | "CONFIG_ERROR" | "VALIDATION_FAILED" | "PROVIDER_ERROR";
      message: string;
    };
