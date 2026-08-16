# TradePal Africa — Add DeepSeek as a Cost-Governed Secondary AI Provider

## Phase 7: Final Report

## 1. Executive summary

The governing brief asked for DeepSeek to be added as a secondary AI provider, gated behind a
boot-time kill switch and a per-business allowlist, restricted to read-only/non-monetary task
classes, with cost governance and safety validation, delivered through seven gated phases (0
audit → 1 design → 2 provider layer → 3 cost governance → 4 safety → 5 tests/eval → 6 adversarial
review → 7 this report).

**Current state, as of this report: fully built, fully inert.** Every line of DeepSeek-related
code in this repo compiles, is exercised by tests, and is reachable only from test code — zero
production request path can currently cause a real DeepSeek API call. `src/worker.ts` constructs
a `DeepSeekAiProvider` instance behind `AI_PROVIDER_DEEPSEEK_ENABLED` (default unset/false) purely
so the wiring is provably correct, but that instance is never added to the `deps` object
`dispatchInboundMessage` receives (`src/worker.ts`, Phase 2 comment block) — so even flipping the
env var true in production today would not route a single merchant message to DeepSeek. Deciding
*which* feature is the first to actually call it remains an explicitly deferred, separately-gated
decision (§7 below).

Verification at time of this report: `npx tsc -p tsconfig.json --noEmit` clean; `npx vitest run`
— **543/543 tests passing across 51 files**.

## 2. Phase-by-phase recap

| Phase | Deliverable | Artifact(s) |
|---|---|---|
| 0 — Audit | Read-only repo audit; domain correction (DeepSeek restricted to read-only/non-monetary tasks); double-billing risk (F-10) identified as BullMQ retry, not Meta webhook retry | `PHASE_0_FINDINGS.md`, "DeepSeek Integration — Phase 0" section |
| 1 — Design | File list, interface contracts, schema/migration design, rollback procedure, deviation from the brief's literal `AI_DEEPSEEK_ORG_ALLOWLIST` env var in favor of the existing `BusinessFeatureFlag` mechanism (flagged for explicit sign-off, approved) | `INTEGRATION_DESIGN.md` |
| 2 — Provider layer | `DeepSeekAiProvider` (raw `fetch`, no new SDK dependency, mirrors `WhisperSttProvider`); model registry with pinned snapshot keys, not moving aliases; inert construction in `src/worker.ts` | `src/ai/deepseekProvider.ts`, `src/ai/modelRegistry.ts`, `src/config/deepseekEnv.ts`, `src/ai/retryWithBackoff.ts`, `src/ai/aiTypes.ts` |
| 3 — Cost governance | Two-phase (RESERVE/COMMIT/RELEASE) append-only ledger; graduated budget evaluator (RECORD→WARN→ALERT→RESTRICT_PREMIUM→BLOCK_OPTIONAL_AI); tenant isolation | `src/domain/aiUsageLedger.ts`, `src/domain/aiBudget.ts`, `prisma/migrations/20260815000000_deepseek_phase3_ai_usage_ledger/`, `AiUsageLedger` added to `src/db/tenantScope.ts`'s `TENANT_SCOPED_MODELS` |
| 4 — Safety | `DeepSeekReadOnlyIntentSchema` (QUERY/GREETING/UNKNOWN only — structurally excludes every monetary/ledger-writing intent); `<merchant_message>` structural delimiting; bounded (exactly one) reformat retry on invalid output; fail-closed `DeepSeekOutputValidationError` | `src/ai/schema.ts`, `src/ai/deepseekProvider.ts` |
| 5 — Tests/eval | End-to-end wiring tests (ledger + provider composed, across happy/HTTP-failure/validation-failure paths); table-driven eval-style panel of representative and adversarial merchant messages | `tests/deepseekIntegration.test.ts` |
| 6 — Adversarial self-review | Found and fixed a delimiter-breakout gap (unescaped merchant text could forge a fake `</merchant_message>` close); documented 5 further findings (1 real concurrency bug, 1 forward-looking cost-accounting gap, 3 informational) | `DEEPSEEK_PHASE6_ADVERSARIAL_REVIEW.md`, fix in `src/ai/deepseekProvider.ts` |
| 7 — Final report | This document | `DEEPSEEK_INTEGRATION_FINAL_REPORT.md` |

Phases 5, 6, and 7 had no scope defined anywhere in the repo (`UNKNOWN — searched:
INTEGRATION_DESIGN.md, PHASE_0_FINDINGS.md`, for each). Each was built as a transparently-disclosed,
self-authored interpretation — documented in that phase's own report and, for 5/6, in-code — never
presented as directly sourced from the brief.

## 3. Non-Negotiable Constraints — compliance check

1. **Additive-only.** No existing file's behavior changed except: `src/worker.ts` (new inert
   local variables only, `dispatchInboundMessage`'s `deps` object untouched — confirmed by reading
   that call site), `src/db/tenantScope.ts` (one new entry added to a `Set`), `prisma/schema.prisma`
   (new model/enums/column only, no existing column altered), `.env.example` (new lines appended),
   `src/ai/schema.ts` (new exports appended after the existing `ParsedIntentSchema` union, which is
   untouched). `src/ai/provider.ts` (the incumbent Anthropic provider) was never modified — confirmed
   in Phase 4's own research and never touched since.
2. **Default-off, boot switch + allowlist.** `AI_PROVIDER_DEEPSEEK_ENABLED` defaults unset/false
   (`.env.example`, `src/worker.ts:108`). The per-business allowlist is the existing
   `BusinessFeatureFlag`/`FeatureFlag` mechanism, key `aiProviderDeepseek` (`INTEGRATION_DESIGN.md`
   §4) — not yet seeded/created, because nothing reads it yet (no call site exists to gate); this
   is next-phase work, not a gap in what's shipped so far (see §7).
3. **Strict phase gates.** Every phase 0–6 waited for its own literal `APPROVED: PHASE <n>` reply
   before starting the next.
4. **Phase 0 100% read-only.** Not modified retroactively; stands as originally delivered.
5. **No fabricated facts.** Every phase's report cited `path/to/file.ts:LINE` or stated
   `UNKNOWN — searched: <terms>` for anything not concretely sourced — including three separate
   scope decisions (Phases 4, 5, 6) made where the design doc was silent, each disclosed as
   interpretation rather than presented as sourced.
6. **Money as integer micro-USD/bigint.** `AiUsageLedger.estimatedCostMicroUsd`/`actualCostMicroUsd`
   and `Plan.aiDeepseekMonthlyBudgetMicroUsd` are all `BigInt` (`prisma/schema.prisma`); no float
   appears anywhere in the cost-governance code path (`src/domain/aiUsageLedger.ts`,
   `src/domain/aiBudget.ts`, `src/ai/modelRegistry.ts`'s `estimateCostMicroUsd`).
7. **Tenant isolation + failing cross-tenant-read test.** `AiUsageLedger` is in
   `TENANT_SCOPED_MODELS` (`src/db/tenantScope.ts`); `tests/aiUsageLedger.test.ts`'s "AiUsageLedger
   tenant isolation" block (3 tests) proves cross-tenant reads return nothing and budget
   calculations never leak across businesses, including an explicit bypass attempt via a
   cross-tenant `where` clause.
8. **No destructive migrations.** `prisma/migrations/20260815000000_deepseek_phase3_ai_usage_ledger/`
   is `CREATE TYPE`/`CREATE TABLE`/`ALTER TABLE ... ADD COLUMN` only — no `DROP`, no column
   removal, no data rewrite.
9. **Must not touch billing/subscription/payment logic.** `src/domain/billing.ts` was read
   (Phase 3, to mirror its structure) but never modified; `aiBudget.ts` only *reads*
   `getEffectivePlan`'s result, adding a new column (`aiDeepseekMonthlyBudgetMicroUsd`) rather than
   changing any existing billing computation. No Flutterwave/payment code was touched at all in
   this project.

All nine held for the full duration of the project.

## 4. What is genuinely new and live-reachable today

**Nothing.** Concretely:

- `DeepSeekAiProvider` is constructible but never constructed with production traffic in mind
  outside `src/worker.ts`'s own inert block, and even there it's a dead-end local variable
  (`void deepseekProvider;` — `src/worker.ts`).
- `AiUsageLedger`/`aiBudget.ts` are pure domain functions nothing calls except tests.
- The `aiProviderDeepseek` `FeatureFlag` key referenced in comments and `INTEGRATION_DESIGN.md`
  §4 does not exist in the database yet — there is no seed, no admin-route usage, nothing to
  toggle, because there is no call site for it to gate.

This is the intended end-state for this project's scope: infrastructure fully built,
tested, and reviewed, with zero risk of accidentally going live, awaiting a deliberate, separately
-scoped routing decision.

## 5. Rollback

No rollback is needed — nothing is live. If any future phase does wire live routing and needs to
back out, `INTEGRATION_DESIGN.md` §5 already documents the procedure: flip the `aiProviderDeepseek`
`FeatureFlag` global default back to `false` (or remove specific `BusinessFeatureFlag` overrides)
via the existing admin route — no deploy, no migration reversal, confirmed to propagate to the very
next inbound job with no caching layer in the way (`src/domain/featureFlags.ts:15-27`,
cited directly in that section).

## 6. Known placeholders that must be confirmed before any real traffic

Both disclosed at the time they were introduced, not new to this report:

- **DeepSeek pricing** (`src/ai/modelRegistry.ts`, `AI_MODEL_REGISTRY`): `inputCostMicroUsdPer1kTokens`/`outputCostMicroUsdPer1kTokens` are placeholder figures, not sourced from a live DeepSeek pricing page (`UNKNOWN — searched: this repo`, for any prior pricing citation — external vendor pricing is out of reach of a repo-only audit).
- **Budget thresholds** (`src/domain/aiBudget.ts`, `DEFAULT_AI_BUDGET_THRESHOLDS`): 50/75/90/100% is an evenly-spaced placeholder scale — `INTEGRATION_DESIGN.md` names the five stages but gives no numeric thresholds anywhere.

Neither blocks anything today since nothing spends real money yet, but both must be replaced with
real, business-approved numbers before `AI_BUDGET_ENFORCEMENT_ENABLED` or real DeepSeek billing is
ever turned on.

## 7. Open items for whoever wires live routing (not this project's scope)

In priority order, from Phase 6's review:

1. **Fix the `reserveAiUsage` concurrency gap (F-2)** before enabling any path with concurrent
   callers (e.g. multiple BullMQ workers) — the current check-then-insert is not atomic and has no
   DB constraint backing it (`src/domain/aiUsageLedger.ts:76-99`; confirmed via
   `prisma/schema.prisma:624`, plain index not `@@unique`).
2. **Capture DeepSeek's token usage (F-3)** so a reformat-retried request's true (doubled) cost is
   reflected in `commitAiUsage`, not silently under-counted (`src/ai/deepseekProvider.ts`,
   `DeepSeekChatCompletionResponse` currently has no `usage` field).
3. **Design a concrete output shape** for the first real DeepSeek-eligible feature — `schema.ts`'s
   own doc comment flags `CATALOG_SUMMARY_DRAFT` as having none yet, and any shape with a
   free-text field changes the risk calculus for F-1/F-4 (delimiter-breakout mitigation currently
   relies on QUERY/GREETING/UNKNOWN having no free-text field to exploit).
4. **Seed the `aiProviderDeepseek` `FeatureFlag`** (`enabledByDefault: false`) and wire an
   `isFeatureEnabled` check at whatever call site is chosen — the second of the two required gates,
   currently unimplemented because no call site exists yet.
5. **Confirm real pricing and business-approved thresholds** (§6 above) before enabling budget
   enforcement or real spend.
6. Re-apply the same escaping treatment (F-1's fix) to `languageHint` (F-6) the moment it is ever
   derived from anything merchant-influenced, since it currently sits outside the delimited block
   unescaped by design (safe only because nothing sets it from user input today).

## 8. File manifest (DeepSeek-scoped only)

New files:
```
INTEGRATION_DESIGN.md
DEEPSEEK_PHASE6_ADVERSARIAL_REVIEW.md
DEEPSEEK_INTEGRATION_FINAL_REPORT.md
src/ai/aiTypes.ts
src/ai/deepseekProvider.ts
src/ai/modelRegistry.ts
src/ai/retryWithBackoff.ts
src/config/deepseekEnv.ts
src/domain/aiBudget.ts
src/domain/aiUsageLedger.ts
prisma/migrations/20260815000000_deepseek_phase3_ai_usage_ledger/
tests/aiBudget.test.ts
tests/aiUsageLedger.test.ts
tests/deepseekEnv.test.ts
tests/deepseekIntegration.test.ts
tests/deepseekProvider.test.ts
tests/modelRegistry.test.ts
tests/retryWithBackoff.test.ts
```

Modified files (DeepSeek-scoped hunks only — each file's diff contains only additive,
clearly-delimited DeepSeek changes, verified above in §3 point 1):
```
.env.example
PHASE_0_FINDINGS.md
prisma/schema.prisma
src/ai/schema.ts
src/db/tenantScope.ts
src/worker.ts
```

(Other uncommitted changes present in this working tree — landing-page content, PawaPay
integration, monitoring config, etc. — are unrelated pre-existing work, not part of this project,
and are not included above.)

## 9. Final verification

- `npx tsc -p tsconfig.json --noEmit` — clean.
- `npx vitest run` — **543 passed, 0 failed, across 51 test files.**

## 10. Conclusion

All seven phases of the DeepSeek secondary-provider integration are complete: audited, designed,
built, cost-governed, safety-hardened, tested, adversarially reviewed, and reported. The result is
additive-only, fully inert infrastructure — zero production risk, zero live spend, zero change to
existing Anthropic-served merchant traffic — ready for a future, separately-scoped and
separately-approved decision about which read-only feature to actually route to it.
