/**
 * Exponential backoff shared by the outbox and the callback inbox. Deterministic by default (no random jitter) so
 * behaviour is testable and reproducible; callers that fan out many retries can pass a jitter function.
 */
export interface RetryPolicy {
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Upper bound on any single delay. */
  maxDelayMs: number;
  /** Attempts (including the first) before an item is declared dead. */
  maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseDelayMs: 30_000, maxDelayMs: 60 * 60_000, maxAttempts: 8 };

/** Delay before attempt number `attempts + 1`, given that `attempts` attempts have already failed (attempts >= 1). */
export function backoffDelayMs(attempts: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, jitter: (ms: number) => number = (ms) => ms): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  return Math.max(0, Math.round(jitter(raw)));
}

export function isRetryExhausted(attempts: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): boolean {
  return attempts >= policy.maxAttempts;
}
