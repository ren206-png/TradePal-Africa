/**
 * Generic retry driver for a single flaky network call, built for
 * `deepseekProvider.ts` (Phase 2) but deliberately not DeepSeek-specific —
 * it knows nothing about HTTP status codes or fetch; callers supply an
 * `isRetryable(error)` predicate and get back a bounded number of attempts,
 * each on its own timeout, inside one overall wall-clock budget.
 *
 * Brief requirements this satisfies (see PHASE_0_FINDINGS.md's DeepSeek
 * Integration — Phase 0 §0.6 / the governing spec's Phase 2 section):
 *  - exponential backoff with full jitter between attempts
 *  - max 2 retries (3 attempts total, including the first) — a hard cap,
 *    not a default a caller can raise
 *  - only timeout / 429 / 5xx / connection-error classes are retryable;
 *    4xx other than 429 (esp. 400/401/403/422) must never be retried — that
 *    classification itself lives in the caller's `isRetryable` predicate
 *    (see deepseekProvider.ts's `isRetryableDeepSeekError`), not here
 *  - a total wall-clock budget across every attempt plus backoff sleep,
 *    not just a per-attempt timeout
 *
 * Wall-clock budget basis (D-4/§0.6 of PHASE_0_FINDINGS's DeepSeek section):
 * the brief's own template assumed this call sits inside Meta's WhatsApp
 * webhook-redelivery window. Phase 0 read src/worker.ts and
 * src/queue/inboundMessageQueue.ts directly and found that assumption does
 * not hold in this codebase — the AI call runs inside a BullMQ job
 * (src/worker.ts:134-140), decoupled from the webhook HTTP response, which
 * already returned 200 before the job is even processed. The one real
 * constraint on this call's total duration is BullMQ's own job lock: a
 * `Worker` whose handler runs past `lockDuration` risks the job being
 * treated as stalled and reassigned. That default, confirmed by direct grep
 * of `node_modules/bullmq/dist/cjs/classes/worker.js:34`, is 30000ms
 * (auto-renewed at half that interval while the handler is still running).
 * `DEFAULT_RETRY_BUDGET.totalBudgetMs` below (20000ms) is chosen to stay
 * comfortably under that 30000ms figure, leaving headroom for the rest of
 * dispatchInboundMessage's work (DB writes, reply send) in the same job.
 */

/** Full-jitter exponential backoff: `random(0, min(maxDelayMs, baseDelayMs * 2^(attemptIndex)))`. */
export interface RetryBudget {
  /** Hard cap: total attempts including the first (never raise above 3 — see file doc comment). */
  maxAttempts: number;
  /** Per-attempt timeout, enforced via the AbortSignal passed into `attemptFn`. */
  perAttemptTimeoutMs: number;
  /** Wall-clock budget across every attempt and every backoff sleep combined. */
  totalBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** See file doc comment for the 3/8000/20000 numbers' sourcing. */
export const DEFAULT_RETRY_BUDGET: RetryBudget = {
  maxAttempts: 3,
  perAttemptTimeoutMs: 8_000,
  totalBudgetMs: 20_000,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/** Exported so tests can assert the shape without relying on Math.random's actual output. */
export function computeFullJitterDelayMs(attemptIndex: number, budget: Pick<RetryBudget, "baseDelayMs" | "maxDelayMs">): number {
  const cap = Math.min(budget.maxDelayMs, budget.baseDelayMs * 2 ** attemptIndex);
  return Math.random() * cap;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `attemptFn` up to `budget.maxAttempts` times. Each call gets a fresh
 * `AbortController` whose signal fires after `min(perAttemptTimeoutMs,
 * <remaining total budget>)` — so a late attempt gets a shorter fuse than an
 * early one, never a longer one than the overall budget allows. Between
 * attempts, sleeps a full-jitter backoff delay, itself clipped to whatever
 * budget remains.
 *
 * Retries only when both hold: `isRetryable(error)` returns true, and this
 * wasn't the last permitted attempt. Any other failure — including running
 * out of total budget — propagates the most recent error to the caller
 * unchanged; this function never invents its own error type, so callers
 * keep seeing the exact vendor error (HTTP status, message) they'd get from
 * a single unretried call.
 */
export async function retryWithBackoff<T>(
  attemptFn: (signal: AbortSignal) => Promise<T>,
  options: { isRetryable: (error: unknown) => boolean; budget?: RetryBudget },
): Promise<T> {
  const budget = options.budget ?? DEFAULT_RETRY_BUDGET;
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < budget.maxAttempts; attempt++) {
    const remainingBudgetMs = budget.totalBudgetMs - (Date.now() - startedAt);
    if (remainingBudgetMs <= 0) {
      // Out of wall-clock budget before this attempt could even start — surface the last real failure, not a synthetic budget error.
      throw lastError ?? new Error("retryWithBackoff: total budget exhausted before any attempt ran");
    }

    const controller = new AbortController();
    const timeoutMs = Math.min(budget.perAttemptTimeoutMs, remainingBudgetMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await attemptFn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;

      const isLastAttempt = attempt === budget.maxAttempts - 1;
      if (isLastAttempt || !options.isRetryable(error)) {
        throw error;
      }

      const delayMs = computeFullJitterDelayMs(attempt, budget);
      const remainingAfterFailure = budget.totalBudgetMs - (Date.now() - startedAt);
      if (delayMs >= remainingAfterFailure) {
        // Backing off would already blow the budget — fail now with the real error instead of sleeping into a guaranteed timeout.
        throw error;
      }
      await sleep(delayMs);
    }
  }

  // Unreachable (the loop always returns or throws), kept only so TypeScript sees every path returns/throws.
  throw lastError ?? new Error("retryWithBackoff: exhausted attempts with no recorded error");
}
