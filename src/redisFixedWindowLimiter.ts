export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * The narrow slice of ioredis's `Redis` client this limiter actually calls —
 * accepting this instead of ioredis's full `Redis` type keeps this module
 * (and its tests) decoupled from ioredis's own, fairly elaborate,
 * TypeScript overloads, and lets tests exercise the real fixed-window
 * algorithm against a small hand-written in-memory fake (mirroring how
 * `outboundGateway.ts`'s tests inject a fake `fetchImpl` instead of hitting
 * Meta's real API) rather than requiring a live Redis connection just to
 * run `npx vitest run`.
 */
export interface RedisPipelineLike {
  incr(key: string): RedisPipelineLike;
  pexpire(key: string, milliseconds: number, flag: "NX"): RedisPipelineLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisLike {
  multi(): RedisPipelineLike;
  pttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

/**
 * Redis-backed counterpart to `InMemoryLoginRateLimiter` /
 * `InMemoryInboundMessageRateLimiter`'s shared fixed-window-bucket
 * algorithm — the escape hatch both of those classes' own doc comments have
 * named since Phase 2/19 ("swap this for a Redis-backed implementation...
 * behind the same interface") but never built until now. Extracted once
 * here, rather than duplicated per feature, for the same reason
 * `outboundSendRetry.ts` extracted the retry logic previously duplicated
 * between `subscriptionExpiry.ts` and `businessDigest.ts`: two near-
 * identical copies already existed (the two in-memory classes) before this
 * was written, so there was no reason to let a third (and fourth) copy of
 * the *Redis* version happen too. `RedisLoginRateLimiter` and
 * `RedisInboundMessageRateLimiter` each wrap one instance of this with
 * their own key prefix (so a login-attempt key and a phone-number key can
 * never collide in the same Redis keyspace) and their own default
 * max/window, exactly like their in-memory counterparts.
 *
 * Algorithm per `consume(key)` call, one Redis round trip in the common
 * (allowed) case:
 *  - `INCR` the bucket key and, only if this was the key's first increment
 *    (`PEXPIRE ... NX`, Redis 7+), set it to expire after `windowMs` — both
 *    issued in one `MULTI`/`EXEC` so a process crash between the two
 *    commands can't happen. `NX` (rather than always calling `PEXPIRE`) is
 *    what makes this a *fixed*, not sliding, window: only the request that
 *    creates the key sets its expiry, so every request within the window
 *    shares the same reset time instead of each one pushing it further out.
 *  - if the post-increment count exceeds `maxCount`, a second call
 *    (`PTTL`) reads the remaining window time to compute `retryAfterSeconds`
 *    — only paid on the (rarer) blocked path, mirroring the in-memory
 *    classes' own "only compute this when actually blocking" shape.
 *
 * `docker-compose.yml`'s `redis:7-alpine` image supports the `NX` flag
 * (added in Redis 7.0); an older Redis server would silently always reset
 * the TTL on every increment instead (turning this into a sliding window
 * that never fully empties under sustained traffic) — not a concern for
 * this project's own deployment, but worth knowing if this class is ever
 * pointed at a different Redis version.
 */
export class RedisFixedWindowLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly keyPrefix: string,
    private readonly maxCount: number,
    private readonly windowMs: number,
  ) {}

  private buildKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  async consume(key: string): Promise<RateLimitResult> {
    const redisKey = this.buildKey(key);
    const results = await this.redis.multi().incr(redisKey).pexpire(redisKey, this.windowMs, "NX").exec();

    if (!results) {
      throw new Error(`Redis MULTI/EXEC returned null for key '${redisKey}' — transaction was aborted.`);
    }
    const [incrResult] = results;
    const [incrError, countRaw] = incrResult as [Error | null, number];
    if (incrError) throw incrError;

    if (countRaw > this.maxCount) {
      const ttlMs = await this.redis.pttl(redisKey);
      // A missing/expired TTL (pttl returns -1/-2) shouldn't be reported as
      // "retry immediately" — fall back to the full window in that
      // (theoretically unreachable, since INCR always creates/refreshes the
      // key) edge case.
      const retryAfterSeconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : this.windowMs) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.buildKey(key));
  }
}
