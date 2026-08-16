import { afterEach, describe, expect, it, vi } from "vitest";
import { computeFullJitterDelayMs, retryWithBackoff, type RetryBudget } from "../src/ai/retryWithBackoff.js";

const FAST_BUDGET: RetryBudget = {
  maxAttempts: 3,
  perAttemptTimeoutMs: 200,
  totalBudgetMs: 2000,
  baseDelayMs: 1,
  maxDelayMs: 2,
};

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

describe("computeFullJitterDelayMs", () => {
  it("returns a value in [0, min(maxDelayMs, baseDelayMs * 2^attemptIndex))", () => {
    const budget = { baseDelayMs: 100, maxDelayMs: 1000 };
    for (const attemptIndex of [0, 1, 2, 3, 10]) {
      const delay = computeFullJitterDelayMs(attemptIndex, budget);
      const cap = Math.min(budget.maxDelayMs, budget.baseDelayMs * 2 ** attemptIndex);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(cap || 1); // cap is 0 only if baseDelayMs is 0, not the case here
    }
  });
});

describe("retryWithBackoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the result on the first successful attempt without retrying", async () => {
    const attemptFn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(attemptFn, { isRetryable: () => true, budget: FAST_BUDGET });
    expect(result).toBe("ok");
    expect(attemptFn).toHaveBeenCalledTimes(1);
  });

  it("retries on a retryable error and returns the eventual success", async () => {
    const attemptFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValueOnce("ok");

    const result = await retryWithBackoff(attemptFn, { isRetryable: () => true, budget: FAST_BUDGET });
    expect(result).toBe("ok");
    expect(attemptFn).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-retryable error — fails on the very first attempt", async () => {
    const nonRetryable = new Error("400 bad request");
    const attemptFn = vi.fn().mockRejectedValue(nonRetryable);

    await expect(retryWithBackoff(attemptFn, { isRetryable: () => false, budget: FAST_BUDGET })).rejects.toBe(nonRetryable);
    expect(attemptFn).toHaveBeenCalledTimes(1);
  });

  it("stops at the hard cap of maxAttempts even if every failure is retryable, and surfaces the last error", async () => {
    const errors = [new Error("e1"), new Error("e2"), new Error("e3")];
    const attemptFn = vi
      .fn()
      .mockRejectedValueOnce(errors[0])
      .mockRejectedValueOnce(errors[1])
      .mockRejectedValueOnce(errors[2]);

    await expect(retryWithBackoff(attemptFn, { isRetryable: () => true, budget: FAST_BUDGET })).rejects.toBe(errors[2]);
    expect(attemptFn).toHaveBeenCalledTimes(3); // FAST_BUDGET.maxAttempts, never more
  });

  it("gives up before exhausting maxAttempts once the total wall-clock budget would be blown, surfacing the last real error rather than hanging", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // deterministic: full-jitter delay always equals the cap

    const tightBudget: RetryBudget = {
      maxAttempts: 5,
      perAttemptTimeoutMs: 1000,
      totalBudgetMs: 30,
      baseDelayMs: 50, // cap(attempt 0) = min(maxDelayMs, 50*2^0) = 50ms, already >= the 30ms total budget
      maxDelayMs: 50,
    };
    const firstFailure = new Error("only failure");
    const attemptFn = vi.fn().mockRejectedValue(firstFailure);

    await expect(retryWithBackoff(attemptFn, { isRetryable: () => true, budget: tightBudget })).rejects.toBe(firstFailure);
    expect(attemptFn).toHaveBeenCalledTimes(1); // backing off would already exceed the budget, so it never gets a second attempt
  });

  it("passes an AbortSignal that fires once the per-attempt timeout elapses, and treats that as a retryable timeout", async () => {
    let sawAbort = false;
    const attemptFn = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("too slow"), 10_000);
          signal.addEventListener("abort", () => {
            sawAbort = true;
            clearTimeout(timer);
            reject(abortError());
          });
        }),
    );

    const budget: RetryBudget = { maxAttempts: 1, perAttemptTimeoutMs: 10, totalBudgetMs: 5000, baseDelayMs: 1, maxDelayMs: 1 };
    await expect(retryWithBackoff(attemptFn, { isRetryable: () => true, budget })).rejects.toThrow("aborted");
    expect(sawAbort).toBe(true);
  });
});
