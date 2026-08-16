# TradePal Africa — DeepSeek Integration Design (Phase 1)

Governed by the DeepSeek brief v2.0 (hardened). This is the design deliverable for Phase 1: smallest safe design, exact file list, migration SQL, interface contracts, flag topology, rollback procedure, diff-size estimate. **No code is written in this phase** — every file below is a plan, not a diff. Grounded entirely in the citations gathered in `PHASE_0_FINDINGS.md`'s "DeepSeek Integration — Phase 0" section; nothing here contradicts a Phase 0 finding without saying so explicitly.

Terminology correction carried forward from Phase 0: every `organizationId` in the brief's own Appendix A is `businessId` in this design — this repo has no `Organization` model, and introducing one now would violate the "smallest reversible increment" instruction for no benefit.

## 1. File List

### New files — Phase 2 (provider layer)
- `src/ai/aiTypes.ts` — Appendix A contracts (`AIProviderId`, `AIFeature`, `AIRequest`, `AIUsage`, `AIResponse<T>`, `AIResult<T>`), adapted to this repo's `businessId`/`bigint` conventions. No existing file owns this shape today; `src/ai/provider.ts`'s `AiProvider`/`AiParseRequest` predate it and are extended, not replaced (see §6).
- `src/ai/deepseekProvider.ts` — `DeepSeekAiProvider implements AiProvider`, raw `fetch` against `https://api.deepseek.com`, mirroring `WhisperSttProvider`'s (`src/stt/provider.ts:33-64`) shape exactly per Phase 0 §0.5's recommendation: no new SDK dependency.
- `src/ai/modelRegistry.ts` — `AI_MODEL_REGISTRY`, a typed map from a registry key (not a bare string literal) to `{ provider, apiModelName, inputCostMicroUsdPer1kTokens: bigint, outputCostMicroUsdPer1kTokens: bigint }`. Replaces the string-literal pattern both existing providers use today (`src/ai/provider.ts:75`, `src/stt/provider.ts:40`) for DeepSeek only — the two existing providers are left untouched (Appendix C: no rebuild of working features).
- `src/ai/retryWithBackoff.ts` — shared exponential-backoff-with-full-jitter helper, max 2 attempts, retries only on timeout/429/5xx/connection-reset, hard cap 3 combined attempts (1 initial + 2 retries). Provider-agnostic so it could later wrap the Anthropic call too, but only `DeepSeekAiProvider` calls it in this increment (Appendix C: no changes to the incumbent's working call path).
- `src/config/deepseekEnv.ts` — `buildDeepSeekDepsFromEnv()`, following the exact `build*DepsFromEnv()` optional-bundle pattern already established in `src/config/monitoringEnv.ts` and `src/config/paymentsEnv.ts`: returns `{ apiKey, model, ... } | undefined`, validated at call time inside `worker.ts`'s existing conditional-construction style (mirrors the `openAiApiKey`/`sttProvider` pattern at `src/worker.ts:75-82`), not at `requireEnv`-style boot-time hard failure.

### New files — Phase 3 (cost governance)
- `src/domain/aiUsageLedger.ts` — `reserveAiUsage`, `commitAiUsage`, `releaseAiUsage` (two-phase accounting per Constraint on money), `getOpenBudgetMicroUsdForBusiness` (sum of live reservations + committed spend in the current window), mirroring the file-structure convention of `src/domain/billing.ts`.
- `src/domain/aiBudget.ts` — the graduated `record → warn → alert → restrict-premium → block-optional-AI` threshold evaluator (Phase 3.6), consuming `Plan.aiDeepseekMonthlyBudgetMicroUsd` (new nullable column, §3) the same way `assertWithinQuota` consumes `Plan.entryCapPerMonth` today (`src/domain/billing.ts`), but graduated rather than binary.
- `prisma/migrations/<timestamp>_deepseek_phase3_ai_usage_ledger/migration.sql` — additive-only (§3).

### New files — Phase 4 (safety)
- No new files strictly required — Zod validation reuses `src/ai/schema.ts`'s existing pattern (a second discriminated union scoped to whichever read-only task classes DeepSeek actually handles, added to that same file rather than a new one, since it's the established single home for AI output schemas). Prompt-injection structural delimiting is a change inside `deepseekProvider.ts`'s request-construction, not a new file.

### Modified files
- `prisma/schema.prisma` — new `AiUsageLedger` model + `AIProviderId`/`AIUsagePhase` enums (§3); one new nullable column on `Plan` (`aiDeepseekMonthlyBudgetMicroUsd BigInt?`).
- `src/db/tenantScope.ts` — add `"AiUsageLedger"` to `TENANT_SCOPED_MODELS` (`src/db/tenantScope.ts`'s existing Set literal). Deliberately **not** added to `APPEND_ONLY_MODELS` — see §3's note on why the ledger's own design avoids needing row updates at all, making that question moot rather than requiring an exception to the append-only enforcement.
- `.env.example` — new vars appended after the existing WhatsApp-template block, following that file's own per-block explanatory-comment convention (§4).
- `src/worker.ts` — conditional `DeepSeekAiProvider` construction (Phase 2 only — the instance is built but **not yet passed anywhere `dispatchInboundMessage` would call it**; Phase 2's own constraint is "no live routing changes"). A second `CircuitBreaker` instance for DeepSeek, mirroring lines 45–64.
- `prisma/seed.ts` — no change required for Phase 2/3 (the two seeded plans, `FREE`/`STARTER`, both get `aiDeepseekMonthlyBudgetMicroUsd: null` implicitly via the column default — uncapped until explicitly set, matching `entryCapPerMonth`'s existing null-is-uncapped convention).

No file outside this list is touched. `src/messageDispatcher.ts` — where DeepSeek would actually get called for a real merchant request — is explicitly **not** in this list; wiring an actual task class to DeepSeek is a routing decision this design deliberately defers past Phase 4, since the brief's own Phase 2 constraint is "no live routing changes" and nothing here should quietly smuggle one in three phases early.

## 2. Interface Contracts (Appendix A, adapted)

```typescript
// src/ai/aiTypes.ts

/** Registry keys, not bare vendor model strings — see modelRegistry.ts. */
export type AIProviderId = "ANTHROPIC" | "DEEPSEEK";

/**
 * Fixed union, not an open string — Phase 3.5's own constraint ("no
 * LLM-based classifier"). Every call site sets this explicitly and
 * deterministically; it is never inferred from message content. Only
 * DEEPSEEK-eligible members are actually routed to DeepSeek anywhere in
 * this increment (none are, yet — see §1's note on messageDispatcher.ts) ;
 * the union exists now so Phase 3's ledger and Phase 4's Zod schemas have
 * a stable type to key off before any routing decision is made.
 */
export type AIFeature =
  | "TRANSACTION_PARSE"       // existing Anthropic call, src/ai/parse.ts — unchanged, tagged for completeness in the ledger's provider column, not newly billed
  | "VOICE_TRANSCRIPTION"     // existing Whisper call — same note
  | "CATALOG_SUMMARY_DRAFT";  // placeholder read-only, non-monetary DeepSeek-eligible class named as an example only — the actual first DeepSeek-routed feature is a Phase 5+ decision, not fixed by this design

export interface AIRequest {
  feature: AIFeature;
  businessId: string; // was organizationId in the brief; see terminology correction above
  text: string;
  languageHint?: string;
}

export interface AIUsage {
  resolvedModel: string;
  promptTokens?: number;
  completionTokens?: number;
  /** bigint, not number — matches src/domain/money.ts's absolute convention; the brief's own `number` typing is corrected here per Phase 0 §0.1's finding. */
  estimatedCostMicroUsd: bigint;
}

export interface AIResponse<T> {
  data: T;
  usage: AIUsage;
  provider: AIProviderId;
}

/** Never thrown across the provider boundary — every failure mode is a typed member, not an exception, so a caller cannot forget a catch block. */
export type AIResult<T> =
  | { ok: true; value: AIResponse<T> }
  | { ok: false; kind: "TIMEOUT" | "RATE_LIMITED" | "CONFIG_ERROR" | "VALIDATION_FAILED" | "PROVIDER_ERROR"; message: string };
```

`src/ai/provider.ts`'s existing `AiProvider`/`AiParseRequest`/`isAiProviderConfigurationError` are **not deleted or renamed** — `AnthropicAiProvider` keeps implementing the narrower existing interface unchanged (Appendix C: no rebuild of a working feature). `DeepSeekAiProvider` implements the *same* narrow `AiProvider` interface for Phase 2 (so it drops into `src/messageDispatcher.ts`'s existing call shape with zero changes there, later, if a routing phase chooses to), while `aiTypes.ts`'s richer `AIRequest`/`AIResult` shape is what `aiUsageLedger.ts` and `aiBudget.ts` consume in Phase 3 — the two coexist rather than forcing an immediate, riskier rewrite of the incumbent's call site.

## 3. Schema / Migration (additive-only)

```sql
-- prisma/migrations/<timestamp>_deepseek_phase3_ai_usage_ledger/migration.sql

CREATE TYPE "AIProviderId" AS ENUM ('ANTHROPIC', 'DEEPSEEK');
CREATE TYPE "AIUsagePhase" AS ENUM ('RESERVE', 'COMMIT', 'RELEASE');

CREATE TABLE "AiUsageLedger" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,       -- groups a RESERVE row with its terminal COMMIT/RELEASE row
    "phase" "AIUsagePhase" NOT NULL,
    "businessId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,         -- validated against the AIFeature TS union at the app layer, not a DB enum, so adding a feature tag needs no migration
    "provider" "AIProviderId" NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "resolvedModel" TEXT NOT NULL,
    "estimatedCostMicroUsd" BIGINT,  -- set on RESERVE rows only
    "actualCostMicroUsd" BIGINT,     -- set on COMMIT rows only
    "promptHash" TEXT NOT NULL,      -- sha256 hex of the prompt text; never the prompt itself (Constraint #5)
    "idempotencyKey" TEXT NOT NULL,  -- the same waMessageId already used for BullMQ-level dedupe (src/queue/inboundMessageQueue.ts:18) — no new concept, see Phase 0 §0.3
    "httpStatus" INTEGER,
    "errorClass" TEXT,               -- populated on RELEASE only: 'TIMEOUT' | 'RATE_LIMITED' | 'CONFIG_ERROR' | 'PROVIDER_ERROR' etc, mirrors AIResult's own kind union
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "AiUsageLedger_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AiUsageLedger" ADD CONSTRAINT "AiUsageLedger_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "AiUsageLedger_businessId_createdAt_idx" ON "AiUsageLedger"("businessId", "createdAt");
CREATE INDEX "AiUsageLedger_requestId_idx" ON "AiUsageLedger"("requestId");
CREATE INDEX "AiUsageLedger_idempotencyKey_provider_idx" ON "AiUsageLedger"("idempotencyKey", "provider");

ALTER TABLE "Plan" ADD COLUMN "aiDeepseekMonthlyBudgetMicroUsd" BIGINT;
-- NULL = uncapped, matching Plan.entryCapPerMonth's existing null-is-uncapped convention (prisma/schema.prisma, Phase 0 §0.4).
```

**Every row is an INSERT, never an UPDATE** — deliberately, extending this repo's existing `Transaction`-append-only precedent (`src/db/tenantScope.ts`'s `APPEND_ONLY_MODELS`) to the new ledger by *design* rather than by adding it to that enforcement set. A reservation is one `RESERVE` row; its outcome is a second row (`COMMIT` on success, `RELEASE` on abort/timeout/error) sharing the same `requestId`. This is why `AiUsageLedger` is **not** added to `APPEND_ONLY_MODELS` in §1 — there is no update to block; the enforcement would be a no-op, and adding it anyway would misleadingly suggest a mutation path exists that doesn't. Deriving "current open budget" for a business is `SUM(estimatedCostMicroUsd WHERE phase='RESERVE' AND requestId NOT IN (SELECT requestId FROM ... WHERE phase IN ('COMMIT','RELEASE'))) + SUM(actualCostMicroUsd WHERE phase='COMMIT' AND createdAt >= <window start>)` — a leaked reservation (F-10: a RESERVE row with no terminal row, forever) is exactly what Phase 3's "leaked-reservation test" needs to construct and assert against; the schema makes that state directly queryable rather than needing a separate leak-tracking mechanism.

`AiUsageLedger.businessId` is **required** (not nullable, unlike `AiParseLog.businessId`) — every DeepSeek-eligible task class in this increment is a post-onboarding, business-scoped read (Phase 0's own domain-correction: DeepSeek never touches PII/ledger/pre-onboarding flows), so there is no legitimate business-less row for this table, unlike `AiParseLog` which can pre-date business resolution.

## 4. Flag Topology

Two independent, both-must-pass gates before any DeepSeek call can happen — stronger than Appendix B's letter, and the reasoning is spelled out below rather than silently deviating from it.

1. **Boot-time master switch — `AI_PROVIDER_DEEPSEEK_ENABLED` (env var, default unset/false).** Read once in `src/worker.ts`, following the exact `openAiApiKey`/`sttProvider` conditional-construction pattern (`src/worker.ts:75-82`): if false or `DEEPSEEK_API_KEY` is unset, `DeepSeekAiProvider` is never constructed in that process at all — the code path is structurally absent, not just logically skipped. This is the "never accidentally live in a fresh deploy" backstop, and matches Appendix B's env var name exactly.
2. **Live, no-deploy operational switch — the existing `FeatureFlag`/`BusinessFeatureFlag` mechanism (`src/domain/featureFlags.ts`), key `aiProviderDeepseek`, global default `enabledByDefault: false` (Non-Negotiable Standard #7, same as every other flag).** Per-business enablement via `setFeatureFlagForBusiness` **is** the allowlist — a list of businesses with this flag enabled is definitionally identical in effect to a comma-separated allowlist, but is DB-backed, auditable through the existing admin routes with zero code changes, and — critically for the rollback procedure below — flips live in the running process with no restart, unlike an env var.

**Deviation from Appendix B's letter, flagged for explicit sign-off in this Phase 1 gate:** the brief names `AI_DEEPSEEK_ORG_ALLOWLIST` as a comma-separated env var. This design does **not** build that as a second, parallel allowlist mechanism. Reasoning: Appendix B itself says these flags go "through the existing config/validation layer" — and this repo's existing per-business config/validation layer *is* `BusinessFeatureFlag`, not an env var. Building a second allowlist mechanism (env var) alongside the first (DB flag) would mean two independent lists of "which businesses can use DeepSeek" that must be kept in sync, doubling the review surface Constraint #2 exists to shrink, and an env var change is a full Railway restart, defeating the "flip one flag, no deploy" rollback requirement for anything *narrower* than the global kill switch. If a comma-separated env var is specifically wanted despite this, it's a one-line addition to `deepseekEnv.ts`; flagging the decision now rather than building both and letting one silently rot unused.

Remaining Appendix B vars, unchanged from the brief and read via `deepseekEnv.ts`'s `buildDeepSeekDepsFromEnv()` (validated at invocation, not boot, per Phase 2's own instruction):
- `DEEPSEEK_API_KEY=` — required for the bundle to resolve to defined; never logged, never sent to the client (server-side worker process only, same boundary as `ANTHROPIC_API_KEY`).
- `AI_DEEPSEEK_MODEL=` — a registry key (§2), not a raw vendor string; empty defaults to a pinned snapshot constant in `modelRegistry.ts` (D-3's resolution — pin, don't track an alias).
- `AI_FALLBACK_ENABLED=false` — default off; per Phase 0 §0.6's D-4 answer, "enabled" means fall back to a degraded non-AI reply, never to the Anthropic provider, for this increment.
- `AI_BUDGET_ENFORCEMENT_ENABLED=false` — default off; while false, `aiBudget.ts`'s threshold evaluator runs in **record-only** mode (writes ledger rows, evaluates thresholds, logs what it *would* do) rather than actually blocking anything — lets Phase 3 ship and be observed before it can affect a live merchant.
- `AI_DEBUG_PROMPT_SAMPLING=false` — default off; even when true, samples only the `promptHash` and metadata already in the ledger, never raw prompt text (Constraint #5 has no carve-out for a debug flag).

## 5. Rollback Procedure

**Single action: flip the `aiProviderDeepseek` `FeatureFlag`'s global default back to `false`** (or, if only specific businesses were ever enabled, remove their `BusinessFeatureFlag` overrides) via the existing admin route — no deploy, no migration reversal, no restart. Confirmed directly (`src/domain/featureFlags.ts:15-27`): `isFeatureEnabled` runs a live, uncached Prisma query — `businessFeatureFlag.findUnique` then `featureFlag.findUnique` — on every single call, with no in-memory cache, memoization, or TTL anywhere in the file. A global-default flip via `setFeatureFlagGlobalDefault` (`src/domain/featureFlags.ts:145-154`) is visible to the very next inbound-message job the worker process picks up — there is no propagation delay to wait out.

The env var kill switch (`AI_PROVIDER_DEEPSEEK_ENABLED`) is the second, coarser rollback lever — flipping it requires a Railway restart, so it is *not* the primary rollback path, only the pre-deploy safety default and a last-resort full-process-level cutoff if the DB-backed flag mechanism itself were ever suspected compromised.

No migration reversal is ever needed for a rollback: `AiUsageLedger` and `Plan.aiDeepseekMonthlyBudgetMicroUsd` are additive and harmless to leave in place with zero new rows/nulls after a rollback — exactly the "additive/nullable/defaulted only, no destructive migrations" constraint's intended effect.

## 6. Diff-Size Estimate

| Phase | New files (est. lines) | Modified files (est. lines) | Tests (est. lines) | Total est. | Split needed? |
|---|---|---|---|---|---|
| 2 — Provider layer | `aiTypes.ts` ~50, `deepseekProvider.ts` ~110, `modelRegistry.ts` ~50, `retryWithBackoff.ts` ~70, `deepseekEnv.ts` ~45 | `worker.ts` +~25, `.env.example` +~20 | ~180 (provider unit tests, retry/backoff tests, env-bundle tests) | **~550** | No |
| 3 — Cost governance | `aiUsageLedger.ts` ~160, `aiBudget.ts` ~120 | `schema.prisma` +~35, `tenantScope.ts` +2 | ~260 (reserve/commit/release cycle, leaked-reservation test, idempotency-redelivery test, graduated-threshold tests, cross-tenant-read-fails test) | **~580** | Borderline — if implementation runs over, split into **3a** (ledger + two-phase accounting + idempotency) and **3b** (graduated budget thresholds + quota config points), since these are separable concerns and 3a is the one with a hard correctness requirement (money) while 3b is comparatively just policy plumbing |
| 4 — Safety | Zod additions to existing `src/ai/schema.ts` ~40, structural-delimiting changes inside `deepseekProvider.ts` ~30 | none beyond the above | ~90 (injection-override test, bounded-reformat-retry test) | **~160** | No |

Every estimate assumes Phase 2 ships before Phase 3 starts (each phase's own STOP gate applies regardless of this table). None of these is a hard commitment — Phase 2's actual PR is the first real check against the ~550 estimate above.

## 7. Explicit items needing this Phase 1 approval, beyond "proceed to Phase 2"

1. The allowlist-via-`BusinessFeatureFlag` decision in §4, in place of a second `AI_DEEPSEEK_ORG_ALLOWLIST` env-var mechanism.
2. The two-phase-accounting-via-paired-append-only-rows schema in §3, in place of a single mutable-status row (chosen to extend this repo's own `Transaction`-immutability precedent rather than introduce the one non-immutable ledger table in the codebase).
3. `AIFeature`'s only named member so far is a placeholder (`CATALOG_SUMMARY_DRAFT`) — no actual task class is committed to DeepSeek by this design; that routing decision is explicitly left for a later phase, not implied here.
4. (Resolved during this Phase 1 pass, not left open: `isFeatureEnabled` was confirmed uncached by direct read, so §5's rollback timing claim is verified, not assumed.)

Per Non-Negotiable Constraint #3: work stops here pending the literal reply `APPROVED: PHASE 1`.
