import { RedisFixedWindowLimiter, type RedisLike } from "../redisFixedWindowLimiter.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Phase 20: `consume` became `Promise`-returning here (previously
 * synchronous), for the same reason as `LoginRateLimiter` (src/admin/
 * rateLimiter.ts) — a real Redis-backed implementation is unavoidably
 * asynchronous. `processIncomingWebhook` (webhookHandler.ts) now `await`s
 * this call; existing test doubles that implement this interface directly
 * were updated to return a `Promise<RateLimitResult>`.
 */
export interface InboundMessageRateLimiter {
  /** Records one inbound message for `key` (the sender's WhatsApp phone number) and reports whether it's allowed. */
  consume(key: string): Promise<RateLimitResult>;
}

interface Bucket {
  count: number;
  windowStartMs: number;
}

/**
 * Fixed-window, per-process, per-sender-phone-number limiter for the
 * inbound WhatsApp webhook (see `src/whatsapp/webhookHandler.ts`). Mirrors
 * `src/admin/rateLimiter.ts`'s `InMemoryLoginRateLimiter` shape exactly —
 * same fixed-window bucket algorithm, same disclosed limitation: this is
 * per-process state, so if the API server is ever scaled to multiple
 * instances, counts won't be shared across them and the effective limit
 * becomes (maxMessages × instance count). At that point, swap this for
 * `RedisInboundMessageRateLimiter` below, which implements this same
 * interface — built in Phase 20, closing the gap this comment used to only
 * describe.
 *
 * The default of 30 messages / 60s per phone number is deliberately
 * generous: a legitimate merchant dictating a batch of the day's sales in
 * quick succession should never be throttled. This exists to blunt a
 * flood/abuse case — a single number (or a script) hammering the public,
 * signature-verified-but-otherwise-unauthenticated webhook endpoint — not
 * to police normal usage. Unlike the login limiter, there's no `reset()`:
 * a successful message doesn't need to forgive earlier ones the way a
 * successful login forgives earlier typos.
 */
export class InMemoryInboundMessageRateLimiter implements InboundMessageRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxMessages = 30,
    private readonly windowMs = 60 * 1000,
  ) {}

  async consume(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStartMs: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (bucket.count >= this.maxMessages) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStartMs + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * Phase 20: the Redis-backed `InboundMessageRateLimiter` this file's own
 * (and Phase 19's) doc comments have pointed to without it existing. A thin
 * wrapper over `RedisFixedWindowLimiter` — see that class's doc comment
 * (src/redisFixedWindowLimiter.ts) for the actual algorithm. Keyed with a
 * distinct prefix (`inbound-wa-rate-limit`) so a phone-number key here can
 * never collide with an email-address key in `RedisLoginRateLimiter`'s own
 * keyspace, even when both share one Redis connection (see server.ts's
 * `RATE_LIMIT_BACKEND` env var).
 */
export class RedisInboundMessageRateLimiter implements InboundMessageRateLimiter {
  private readonly core: RedisFixedWindowLimiter;

  constructor(redis: RedisLike, maxMessages = 30, windowMs = 60 * 1000) {
    this.core = new RedisFixedWindowLimiter(redis, "inbound-wa-rate-limit", maxMessages, windowMs);
  }

  consume(key: string): Promise<RateLimitResult> {
    return this.core.consume(key);
  }
}
