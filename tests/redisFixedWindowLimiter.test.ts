import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisFixedWindowLimiter } from "../src/redisFixedWindowLimiter.js";
import { FakeRedis } from "./helpers/fakeRedis.js";

describe("RedisFixedWindowLimiter", () => {
  it("allows requests under the max, then blocks with a positive retryAfterSeconds", async () => {
    const limiter = new RedisFixedWindowLimiter(new FakeRedis(), "test-prefix", 3, 60_000);

    expect(await limiter.consume("a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("a")).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const blocked = await limiter.consume("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("tracks each key's window independently", async () => {
    const limiter = new RedisFixedWindowLimiter(new FakeRedis(), "test-prefix", 1, 60_000);

    expect((await limiter.consume("first")).allowed).toBe(true);
    expect((await limiter.consume("first")).allowed).toBe(false);
    // A different key has its own, unaffected bucket.
    expect((await limiter.consume("second")).allowed).toBe(true);
  });

  it("reset() clears a key's bucket so it can immediately consume again", async () => {
    const limiter = new RedisFixedWindowLimiter(new FakeRedis(), "test-prefix", 1, 60_000);

    expect((await limiter.consume("a")).allowed).toBe(true);
    expect((await limiter.consume("a")).allowed).toBe(false);

    await limiter.reset("a");
    expect((await limiter.consume("a")).allowed).toBe(true);
  });

  it("two different key prefixes never collide, even for the same raw key", async () => {
    const redis = new FakeRedis();
    const limiterA = new RedisFixedWindowLimiter(redis, "prefix-a", 1, 60_000);
    const limiterB = new RedisFixedWindowLimiter(redis, "prefix-b", 1, 60_000);

    expect((await limiterA.consume("shared-key")).allowed).toBe(true);
    expect((await limiterA.consume("shared-key")).allowed).toBe(false);
    // Same raw key, different limiter/prefix — an entirely separate Redis key underneath.
    expect((await limiterB.consume("shared-key")).allowed).toBe(true);
  });

  describe("window rollover", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("allows again once the fixed window elapses, without the TTL ever being pushed out further", async () => {
      const limiter = new RedisFixedWindowLimiter(new FakeRedis(), "test-prefix", 1, 60_000);

      expect((await limiter.consume("a")).allowed).toBe(true);
      expect((await limiter.consume("a")).allowed).toBe(false);

      // Still within the window a moment later — PEXPIRE's NX flag means the
      // earlier calls' TTL was never extended, so this stays blocked right
      // up until the window's original 60s expiry, not 60s from *this* call.
      vi.advanceTimersByTime(59_000);
      expect((await limiter.consume("a")).allowed).toBe(false);

      vi.advanceTimersByTime(2_000);
      expect((await limiter.consume("a")).allowed).toBe(true);
    });
  });
});
