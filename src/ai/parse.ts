import type { ConfidenceTier } from "@prisma/client";
import type { AiParseRequest, AiProvider } from "./provider.js";
import { ParsedIntentSchema, TRANSACTION_INTENTS, type ParsedIntent } from "./schema.js";

const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.5;

export function classifyConfidence(score: number): ConfidenceTier {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return "HIGH";
  if (score >= MEDIUM_CONFIDENCE_THRESHOLD) return "MEDIUM";
  return "LOW";
}

export interface AiParseResult {
  rawModelOutput: unknown;
  validationPassed: boolean;
  validationErrors?: unknown;
  parsed?: ParsedIntent;
  confidenceTier: ConfidenceTier;
  /**
   * True whenever the parse must not silently turn into a persisted
   * transaction: validation failure, UNKNOWN intent, or a transaction
   * intent below HIGH confidence. Mirrors the ASR rule in PHASE_0_FINDINGS
   * KQ4 — a low-confidence extraction is never silently persisted, the
   * merchant is asked to confirm or retype instead.
   */
  requiresClarification: boolean;
}

/**
 * Runs raw model output (already fetched from whichever provider) through
 * zod validation and confidence tiering. Extracted from `parseTransactionText`
 * below (Phase 8) so `src/messageDispatcher.ts`'s `parseWithProviderFallback`
 * can reuse this exact validation/confidence logic for DeepSeek's
 * `parseTransactionTextWithUsage` output too, instead of only for output
 * fetched via the `AiProvider.parseTransactionText` interface method. Never
 * touches the database or the ledger — it only classifies — so callers
 * decide, per their own conversation-flow logic, whether to auto-log, ask
 * for confirmation, or ask the merchant to retype.
 */
export function buildAiParseResult(rawModelOutput: unknown): AiParseResult {
  const result = ParsedIntentSchema.safeParse(rawModelOutput);

  if (!result.success) {
    return {
      rawModelOutput,
      validationPassed: false,
      validationErrors: result.error.flatten(),
      confidenceTier: "LOW",
      requiresClarification: true,
    };
  }

  const parsed = result.data;
  const confidenceTier = classifyConfidence(parsed.confidence);
  const isTransactionIntent = TRANSACTION_INTENTS.has(parsed.intent);

  const requiresClarification =
    parsed.intent === "UNKNOWN" || (isTransactionIntent && confidenceTier !== "HIGH");

  return {
    rawModelOutput,
    validationPassed: true,
    parsed,
    confidenceTier,
    requiresClarification,
  };
}

export async function parseTransactionText(
  provider: AiProvider,
  request: AiParseRequest,
): Promise<AiParseResult> {
  const rawModelOutput = await provider.parseTransactionText(request);
  return buildAiParseResult(rawModelOutput);
}
