import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/monitoring/circuitBreaker.js";

describe("CircuitBreaker", () => {
  it("starts closed and stays closed on successes", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

    expect(breaker.getState()).toBe("closed");
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("trips open once consecutive failures reach the threshold, and calls onOpen with the failure count", () => {
    const onOpen = vi.fn();
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, onOpen });

    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    expect(onOpen).not.toHaveBeenCalled();

    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");

    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  it("a success resets the consecutive-failure count, so it never trips from unrelated scattered failures", () => {
    const onOpen = vi.fn();
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, onOpen });

    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    expect(onOpen).not.toHaveBeenCalled();
  });

  describe("open state / reset timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("refuses attempts while open, then allows exactly one half-open probe once resetTimeoutMs elapses", () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });

      breaker.canAttempt();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
      expect(breaker.canAttempt()).toBe(false);

      vi.advanceTimersByTime(4999);
      expect(breaker.canAttempt()).toBe(false);

      vi.advanceTimersByTime(1);
      expect(breaker.canAttempt()).toBe(true);
      expect(breaker.getState()).toBe("half-open");
      // A second concurrent caller must not pile onto the same in-flight probe.
      expect(breaker.canAttempt()).toBe(false);
    });

    it("closes on a successful half-open probe and calls onClose", () => {
      const onClose = vi.fn();
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000, onClose });

      breaker.canAttempt();
      breaker.recordFailure();
      vi.advanceTimersByTime(5000);
      expect(breaker.canAttempt()).toBe(true);

      breaker.recordSuccess();
      expect(breaker.getState()).toBe("closed");
      expect(onClose).toHaveBeenCalledOnce();

      // Fully recovered: back to normal, no timeout needed for the next attempt.
      expect(breaker.canAttempt()).toBe(true);
    });

    it("a failed half-open probe goes back to open and waits out the full timeout again", () => {
      const onOpen = vi.fn();
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000, onOpen });

      breaker.canAttempt();
      breaker.recordFailure();
      expect(onOpen).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      expect(breaker.canAttempt()).toBe(true);
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
      expect(onOpen).toHaveBeenCalledTimes(2);

      expect(breaker.canAttempt()).toBe(false);
      vi.advanceTimersByTime(4999);
      expect(breaker.canAttempt()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(breaker.canAttempt()).toBe(true);
    });
  });
});
