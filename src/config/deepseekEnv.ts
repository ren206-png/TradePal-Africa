import { DEFAULT_DEEPSEEK_MODEL_KEY, resolveAiModel, type AiModelRegistryKey } from "../ai/modelRegistry.js";

/**
 * The `apiKey`/`model` bundle `src/worker.ts` needs to construct a
 * `DeepSeekAiProvider` — mirrors `FlutterwaveDeps`/`AlertEmailDeps`'s own
 * plain-object shape (`config/paymentsEnv.ts`, `config/monitoringEnv.ts`).
 */
export interface DeepSeekDeps {
  apiKey: string;
  modelKey: AiModelRegistryKey;
}

/**
 * `build*DepsFromEnv()` pattern, exactly as `buildAlertEmailDepsFromEnv`
 * (`config/monitoringEnv.ts:15-28`) and `buildFlutterwaveDepsFromEnv`
 * (`config/paymentsEnv.ts:16-20`) already establish: optional, all-or-
 * nothing, validated here at call time rather than via `requireEnv`-style
 * boot-time hard failure — a deployment that hasn't provisioned DeepSeek
 * yet must still boot `src/worker.ts` exactly as it does today (Phase 2's
 * own instruction: default-off, additive-only).
 *
 * `AI_DEEPSEEK_MODEL` is a `modelRegistry.ts` **registry key**, never a raw
 * vendor model string (D-3, PHASE_0_FINDINGS.md's DeepSeek Integration —
 * Phase 0 §0.6) — so an operator cannot point this at a moving alias just
 * by editing the env var. An unset value defaults to
 * `DEFAULT_DEEPSEEK_MODEL_KEY`; a set-but-unrecognized value is treated the
 * same as "not configured" (returns `undefined` from this function) rather
 * than silently falling through to the default the operator was presumably
 * trying to override — `resolveAiModel` returning `undefined` here is a
 * config error, not a hint to guess.
 *
 * Deliberately does **not** read `AI_PROVIDER_DEEPSEEK_ENABLED`: that
 * master switch is read directly in `src/worker.ts`, following the exact
 * `openAiApiKey`/`sttProvider` conditional-construction pattern
 * (`src/worker.ts:78-82`), per INTEGRATION_DESIGN.md §4 point 1 — keeping
 * the boot-time kill switch a plain, greppable env-var check at the one
 * call site that matters, rather than folding it into this bundle where a
 * future caller could construct a `DeepSeekDeps` and forget the switch is
 * separately gated.
 *
 * Also deliberately does **not** yet read `AI_FALLBACK_ENABLED`,
 * `AI_BUDGET_ENFORCEMENT_ENABLED`, or `AI_DEBUG_PROMPT_SAMPLING`
 * (INTEGRATION_DESIGN.md §4's remaining Appendix B vars): nothing in this
 * increment consumes any of the three yet — `aiBudget.ts` (fallback/budget
 * enforcement) and the debug-sampling path are Phase 3/4 work. Adding
 * unread fields to this bundle now would be dead configuration an operator
 * could set with zero effect, which is worse than the alternative of adding
 * them here in the phase that actually reads them.
 */
export function buildDeepSeekDepsFromEnv(): DeepSeekDeps | undefined {
  const apiKey = process.env["DEEPSEEK_API_KEY"];
  if (!apiKey) return undefined;

  const modelKeyRaw = process.env["AI_DEEPSEEK_MODEL"];
  if (!modelKeyRaw) {
    return { apiKey, modelKey: DEFAULT_DEEPSEEK_MODEL_KEY };
  }

  const resolved = resolveAiModel(modelKeyRaw);
  if (!resolved) return undefined;

  return { apiKey, modelKey: modelKeyRaw as AiModelRegistryKey };
}
