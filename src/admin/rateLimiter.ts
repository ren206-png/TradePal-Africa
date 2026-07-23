import { RedisFixedWindowLimiter, type RedisLike } from "../redisFixedWindowLimiter.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Phase 20: both methods became `Promise`-returning here (previously
 * synchronous) so a real Redis-backed implementation — unavoidably
 * asynchronous, since it's a network call — can satisfy this interface.
 * `InMemoryLoginRateLimiter` below does no actual async work; it just wraps
 * its still-fully-synchronous logic in an `async` method so both
 * implementations are interchangeable behind this one interface. The two
 * call sites (`adminRoutes.ts`'s `/login` route) were updated to `await`
 * both calls; existing tests that called `consume`/`reset` directly were
 * updated to `await` them too.
 */
export interface LoginRateLimiter {
  /** Records one login attempt for `key` and reports whether it's allowed. */
  consume(key: string): Promise<RateLimitResult>;
  /** Clears any counter for `key` — called on a successful login so a few earlier typos don't lock out a legitimate admin. */
  reset(key: string): Promise<void>;
}

interface Bucket {
  count: number;
  windowStartMs: number;
}

/**
 * Fixed-window limiter, in-memory and per-process. Closes the "unlimited
 * password guesses against a known admin email" gap flagged in the Phase 2
 * self-check.
 *
 * Known limitation, disclosed rather than hidden: this is per-process state.
 * docker-compose.yml currently runs exactly one `server` replica, so this is
 * a real, effective limiter today — but if the admin API is ever scaled to
 * multiple instances, counts won't be shared across them and the effective
 * limit becomes (maxAttempts × instance count). At that point, swap this for
 * `RedisLoginRateLimiter` below, which implements this same interface —
 * built in Phase 20, closing the gap this comment used to only describe.
 */
export class InMemoryLoginRateLimiter implements LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  async consume(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStartMs: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (bucket.count >= this.maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStartMs + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }
}

/**
 * Phase 20: the Redis-backed `LoginRateLimiter` both this file's and
 * Phase 19's own doc comments have pointed to since Phase 2/19 without it
 * existing. A thin wrapper over `RedisFixedWindowLimiter` — see that class's
 * doc comment (src/redisFixedWindowLimiter.ts) for the actual algorithm.
 * Keyed with a distinct prefix (`admin-login-rate-limit`) so a login-attempt
 * key (an email address) can never collide with an inbound-WhatsApp-message
 * key (a phone number) in the same Redis keyspace, even though both classes
 * may share one Redis connection in a deployment that opts into this backend
 * (see server.ts's `RATE_LIMIT_BACKEND` env var).
 */
export class RedisLoginRateLimiter implements LoginRateLimiter {
  private readonly core: RedisFixedWindowLimiter;

  constructor(redis: RedisLike, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
    this.core = new RedisFixedWindowLimiter(redis, "admin-login-rate-limit", maxAttempts, windowMs);
  }

  consume(key: string): Promise<RateLimitResult> {
    return this.core.consume(key);
  }

  reset(key: string): Promise<void> {
    return this.core.reset(key);
  }
}
