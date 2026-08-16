# DeepSeek Integration — Phase 6: Adversarial Self-Review

## Scope note (disclosed, per this project's own anti-fabrication discipline)

`INTEGRATION_DESIGN.md` §1/§6 tabulate deliverables only for Phases 2–4; nothing in this
repo defines what "Phase 6" concretely contains (`UNKNOWN — searched: INTEGRATION_DESIGN.md,
PHASE_0_FINDINGS.md, for "Phase 6"`). Same treatment as Phase 5's own scope note
(`tests/deepseekIntegration.test.ts`): this document is a self-authored interpretation of
"adversarial self-review" as a systematic re-examination of every file touched in Phases 2–5
(`src/ai/deepseekProvider.ts`, `src/ai/schema.ts`, `src/domain/aiUsageLedger.ts`,
`src/domain/aiBudget.ts`, `src/ai/modelRegistry.ts`, `src/config/deepseekEnv.ts`, `src/worker.ts`'s
DeepSeek block, and the `AiUsageLedger` migration/schema), adopting an attacker's and a
future-maintainer's posture rather than the original implementer's — looking specifically for
gaps the earlier phases' own build-then-verify rhythm would not surface, since `npx vitest run`
passing only proves the code does what its own tests assert, not that the tests asked the right
adversarial questions.

Two findings below were judged safe, additive, and narrow enough to fix within this phase
(no schema change, no behavior change for any legitimate input, fully covered by new tests).
The rest are documented with severity and recommendation, left for explicit decision rather than
silently patched, because they involve either a schema/migration change or a design trade-off
that Phase 3/4's own approved work didn't anticipate.

---

## Findings

### F-1 (FIXED this phase) — Delimiter breakout via unescaped merchant text

**Where:** `src/ai/deepseekProvider.ts`, `parseTransactionText` (the `delimitedUserContent` line).

Phase 4 wraps the merchant's WhatsApp text in `<merchant_message>...</merchant_message>` tags
and instructs the model to treat everything inside as data only. The merchant's raw text was
interpolated verbatim — no escaping. Because these are plain textual markers, not a real parser
enforced on the model's side, a message containing the literal substring `</merchant_message>`
could attempt to forge an early close of the delimiter (and a message containing
`<merchant_message>` could attempt to forge a second, spoofed block), making the "structural"
defense no stronger than the prompt-wording ask alone for that specific message.

**Why it was lower-impact than it sounds:** `DeepSeekReadOnlyIntentSchema` (Phase 4) means even a
fully successful breakout still cannot exfiltrate anything today — `QUERY`/`GREETING`/`UNKNOWN`
(`src/ai/schema.ts`) carry no free-text output field for attacker-controlled content to ride back
through. But that is an incidental property of today's schema, not a designed invariant, and it
stops protecting the moment a future DeepSeek-eligible feature adds a free-text field — which
`schema.ts`'s own Phase 4 doc comment already flags as coming: `CATALOG_SUMMARY_DRAFT`
(`aiTypes.ts`) "has no concrete output shape yet," and a summary is exactly the kind of feature
that would need one.

**Fix applied:** `escapeAngleBrackets()` (new, `deepseekProvider.ts`) replaces every literal `<`
and `>` in `request.text` with `&lt;`/`&gt;` before interpolation — closing the gap generally
(any tag-like construct, not just the two known delimiter strings) rather than special-casing two
literal substrings. Angle brackets are not meaningful characters in this domain's bookkeeping
messages, so legitimate merchant text is unaffected.

**Tests added:** `tests/deepseekProvider.test.ts`, new describe block "Phase 6 adversarial
self-review: delimiter-breakout escaping" (3 tests) — a forged-close attempt, a forged-open
attempt, and a regression check that ordinary angle-bracket-free text is byte-for-byte unchanged.

### F-2 (documented, not fixed) — TOCTOU race in `reserveAiUsage`'s idempotency guard

**Where:** `src/domain/aiUsageLedger.ts:76-99` (`reserveAiUsage`); `prisma/schema.prisma:606-625`
(`AiUsageLedger` model).

`reserveAiUsage`'s "no double-charge" guarantee (`AiUsageAlreadyCommittedError`'s own doc comment,
`aiUsageLedger.ts:33-40`) is enforced by a `findFirst` check followed by a separate `create` — not
atomic, and not backed by any database constraint. Confirmed directly against the schema: the only
index on `(idempotencyKey, provider)` is a plain `@@index`, not `@@unique`
(`prisma/schema.prisma:624`). Two concurrent `reserveAiUsage` calls for the same
`idempotencyKey`/`provider` pair — e.g. two BullMQ workers processing overlapping jobs, or a retry
racing an original call that hasn't committed yet — can both pass the "already committed" check
(since neither has committed), both insert separate `RESERVE` rows with different `requestId`s,
and both later `commitAiUsage` successfully, since `commitAiUsage` only checks that its own
`requestId` doesn't already have a terminal row (`loadReserveForTerminalWrite`,
`aiUsageLedger.ts:105-119`) — it has no awareness of a sibling reservation under the same
idempotency key. This is exactly the double-billing scenario the class's own doc comment names
(a crashed process's job being re-run) but the current check only closes the case where the
*first* attempt has already fully committed by the time the second one starts — not true
concurrency.

**Why not fixed in this phase:** a static uniqueness constraint doesn't cleanly express the
intended invariant ("at most one *open* reservation per idempotency key," not "at most one row
ever") — after a normal successful commit, a `RESERVE` row and a `COMMIT` row legitimately coexist
for the same `idempotencyKey`/`provider`, so a naive partial unique index would reject the happy
path. A correct fix needs either a serializable transaction or a Postgres advisory lock
(`pg_advisory_xact_lock(hashtext(idempotencyKey || provider))`) wrapped around the
check-then-insert in `reserveAiUsage` — a real behavioral change to already-approved Phase 3 code,
not a pure hardening, so it's surfaced here for an explicit decision rather than folded in
silently.

**Severity:** low *today* (nothing calls this path with live traffic — `src/worker.ts`'s Phase 2
comment confirms `deepseekProvider` is never reachable from `dispatchInboundMessage` yet), but
real and worth fixing before any phase wires live routing with concurrent workers.

**Recommendation:** add an advisory-lock (or `SERIALIZABLE` transaction) wrapper around
`reserveAiUsage`'s check + insert in the phase that first wires live routing, with a concurrency
test (two `Promise.all`'d `reserveAiUsage` calls for the same idempotency key, asserting exactly
one succeeds past a subsequent commit) added alongside it.

### F-3 (documented, forward-looking) — Vendor token usage discarded, so a retried request's true cost is unrecoverable

**Where:** `src/ai/deepseekProvider.ts`, `fetchCompletionContent`; `interface
DeepSeekChatCompletionResponse` (same file).

`DeepSeekChatCompletionResponse` only types `choices[].message.content` — any `usage`/token-count
field DeepSeek's response may carry is parsed away and discarded. Separately, Phase 4's bounded
reformat retry (`runChatCompletionAndValidate`) can cause **two** full, separately-billable chat
completions for one logical `parseTransactionText` call (the rejected first attempt, plus the
corrected second one) — confirmed by this phase's own and Phase 5's tests asserting
`fetchImpl` is called exactly twice on a validation failure. Nothing today sums cost/tokens across
both calls, and there is no field on the return value for a caller to learn what either call
actually cost.

**Severity:** low today (no live caller exists to be affected), but this is a real gap a future
routing phase must close: whichever phase first calls `commitAiUsage` with a `DeepSeekAiProvider`
result needs an accurate `actualCostMicroUsd` that reflects **both** completions when a reformat
retry occurred, not just the second one — otherwise Phase 3's entire budget-governance premise
(accurate cost accounting) silently under-counts exactly the requests that needed a retry.

**Recommendation:** extend `DeepSeekChatCompletionResponse` to capture `usage` (prompt/completion
token counts), have `fetchCompletionContent` return it alongside content, and have
`runChatCompletionAndValidate` sum usage across both attempts before returning — surfaced to the
eventual caller so it can compute `actualCostMicroUsd` from the true combined token count.

### F-4 (documented, low severity) — Reformat retry replays the model's own rejected output as an authoritative turn

**Where:** `src/ai/deepseekProvider.ts`, `runChatCompletionAndValidate`'s `retryMessages`
construction.

On a validation failure, the retry prompt replays the model's first (rejected) reply back as an
`assistant`-role message before asking it to correct itself. If an injection attempt partially
succeeded on the first call — producing text that reads as an authoritative "assistant" statement
(e.g. claiming new unrestricted instructions) — replaying it as a genuine prior assistant turn
could reinforce that framing on the second attempt, since models often weight their own prior
turns more heavily than a fresh user message.

**Why low severity:** identical mitigating factor to F-1 — `DeepSeekReadOnlyIntentSchema`
validates the second attempt too, and none of its three members carry a free-text field, so even
a reinforced jailbreak has no payload to smuggle through today. Same forward-looking caveat as F-1
and F-3: this stops being purely theoretical once a free-text output field exists.

**Recommendation:** no code change proposed now; re-evaluate together with F-1's caveat whenever a
free-text DeepSeek output shape is designed.

### F-5 (documented, informational) — Validation error text echoed back to the model

**Where:** `src/ai/deepseekProvider.ts`, `runChatCompletionAndValidate`'s reformat-request message
(`That reply did not match the required JSON shape (${firstResult.errorMessage})...`).

The Zod validation error (`result.error.message` from `DeepSeekReadOnlyIntentSchema.safeParse`)
is fed back verbatim to the model. This tells an adversarial merchant message, indirectly, which
`intent` literals and shapes the fail-closed schema accepts — useful for calibrating a future
injection attempt, though it grants no additional privilege since the schema check is fail-closed
regardless of what the attacker learns from it.

**Recommendation:** none proposed — informational only, no action needed unless a future review
finds a concrete exploitation path.

### F-6 (documented, forward-looking) — `languageHint` sits outside the delimiter, unescaped

**Where:** `src/ai/deepseekProvider.ts`, `languagePrefix` construction.

`languageHint` is concatenated directly into the trusted portion of the prompt, before the
`<merchant_message>` block even opens — no escaping, by design, since it's metadata the codebase
itself is expected to generate (language detection), not merchant-controlled text
(`deepseekProvider.ts`'s own comment: "metadata this codebase generates itself, not
merchant-controlled"). Confirmed nothing on any real call path sets it from user input today
(`grep` across `src/` for `languageHint` outside test files and the two provider files: only the
type declaration in `aiTypes.ts`). This is a non-issue today, purely by virtue of nothing wiring
it from user input yet.

**Recommendation:** whichever future phase first derives `languageHint` from anything
merchant-influenced (e.g. a per-conversation language preference the merchant can set) must apply
the same escaping treatment as F-1's fix, or move it inside the delimited block, before that
wiring goes live.

---

## Verification

- `npx tsc -p tsconfig.json --noEmit` — clean, after F-1's fix.
- `npx vitest run tests/deepseekProvider.test.ts` — 18/18 passed (15 pre-existing + 3 new Phase 6
  tests).
- `npx vitest run` (full suite) — **543/543 passed across 51 files** (540/51 Phase 5 baseline + 3
  new tests, 0 new files). Zero regressions.

## Summary

One structural gap in Phase 4's delimiting defense (F-1) was found and fixed, narrowly and
additively, with regression tests proving both the fix and that legitimate merchant text is
unaffected. Two forward-looking correctness gaps (F-2, a real concurrency bug in Phase 3's
idempotency guard; F-3, discarded token usage that will under-count cost once retries happen
live) are documented with concrete recommendations for whichever phase first wires live DeepSeek
routing — neither is exploitable today because nothing calls this code with live traffic yet
(`src/worker.ts`'s own Phase 2 inertness guarantee still holds). Two informational notes (F-4,
F-5) require no action now. No schema, migration, or billing/subscription/payment logic was
touched — F-1's fix is confined to `src/ai/deepseekProvider.ts`'s own request-construction, the
same file Phase 4 already owned.
