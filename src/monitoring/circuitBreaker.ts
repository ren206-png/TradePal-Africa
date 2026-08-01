/**
 * A minimal in-process, three-state circuit breaker (closed -> open ->
 * half-open -> closed), built from scratch rather than pulling in a library:
 * the state machine below is small enough that a dependency would add more
 * review/audit surface than it saves. Protects a single flaky call (today:
 * the Anthropic AI-parse call in messageDispatcher.ts) from turning a
 * dependency outage into a pile of identical, slow, doomed retries on every
 * inbound message.
 *
 * Deliberately per-process/per-replica state, not shared via Redis or the
 * DB — same tradeoff every in-memory limiter in this codebase already made
 * before Phase 20's opt-in Redis-backed one (see admin/rateLimiter.ts's own
 * doc comment): one replica tripping open while another stays closed is an
 * acceptable, self-correcting cost for a first version, not a correctness
 * bug worth a shared-state dependency.
 */
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures (while closed) before the breaker trips open. */
  failureThreshold: number;
  /** Once open, how long to wait before allowing a single half-open probe attempt. */
  resetTimeoutMs: number;
  /** Called the instant the breaker transitions into "open" (including half-open's probe failing back to open). */
  onOpen?: ((consecutiveFailures: number) => void) | undefined;
  /** Called the instant a half-open probe succeeds and the breaker closes again. */
  onClose?: (() => void) | undefined;
}

/**
 * Usage: call `canAttempt()` before the guarded call; skip (short-circuit)
 * the call entirely if it returns false. Then report the outcome via
 * `recordSuccess()`/`recordFailure()` so the breaker can update its state.
 * Never throws — a misused breaker (e.g. recording a result without having
 * called canAttempt) just degrades to "always allow", which is the safe
 * default.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Returns false when the caller should skip the guarded operation instead
   * of attempting it: the breaker is open and `resetTimeoutMs` hasn't
   * elapsed yet, or exactly one half-open probe is already in flight (a
   * second concurrent caller must not pile onto the same probe attempt).
   */
  canAttempt(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.options.resetTimeoutMs) return false;
      this.state = "half-open";
      this.halfOpenProbeInFlight = false;
    }

    // half-open: allow exactly one probe through at a time.
    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.halfOpenProbeInFlight = false;
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.state = "closed";
      this.options.onClose?.();
    }
  }

  recordFailure(): void {
    this.halfOpenProbeInFlight = false;

    if (this.state === "half-open") {
      // The probe itself failed: back to open, wait out the full timeout again.
      this.trip();
      return;
    }

    this.consecutiveFailures++;
    if (this.state === "closed" && this.consecutiveFailures >= this.options.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.options.onOpen?.(this.consecutiveFailures);
  }
}
