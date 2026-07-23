import { describe, expect, it } from "vitest";
import { InMemoryLoginRateLimiter, RedisLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { FakeRedis } from "./helpers/fakeRedis.js";

describe("InMemoryLoginRateLimiter", () => {
  it("allows attempts under the max, then blocks with a positive retryAfterSeconds", async () => {
    const limiter = new InMemoryLoginRateLimiter(3, 60_000);

    expect(await limiter.consume("a@b.com")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("a@b.com")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("a@b.com")).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const blocked = await limiter.consume("a@b.com");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks each key's window independently", async () => {
    const limiter = new InMemoryLoginRateLimiter(1, 60_000);

    expect((await limiter.consume("first@b.com")).allowed).toBe(true);
    expect((await limiter.consume("first@b.com")).allowed).toBe(false);
    // A different key has its own, unaffected bucket.
    expect((await limiter.consume("second@b.com")).allowed).toBe(true);
  });

  it("reset() clears a key's bucket so it can immediately consume again", async () => {
    const limiter = new InMemoryLoginRateLimiter(1, 60_000);

    expect((await limiter.consume("a@b.com")).allowed).toBe(true);
    expect((await limiter.consume("a@b.com")).allowed).toBe(false);

    await limiter.reset("a@b.com");
    expect((await limiter.consume("a@b.com")).allowed).toBe(true);
  });
});

/**
 * Phase 20: same three behaviors as InMemoryLoginRateLimiter above, proving
 * RedisLoginRateLimiter is a drop-in-compatible implementation of the same
 * LoginRateLimiter interface (against a fake Redis — see FakeRedis's own
 * doc comment for why a live Redis connection isn't required here; the
 * underlying algorithm itself is covered more thoroughly, including window
 * rollover, in tests/redisFixedWindowLimiter.test.ts).
 */
describe("RedisLoginRateLimiter", () => {
  it("allows attempts under the max, then blocks with a positive retryAfterSeconds", async () => {
    const limiter = new RedisLoginRateLimiter(new FakeRedis(), 3, 60_000);

    expect(await limiter.consume("a@b.com")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("a@b.com")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("a@b.com")).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const blocked = await limiter.consume("a@b.com");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks each key's window independently", async () => {
    const limiter = new RedisLoginRateLimiter(new FakeRedis(), 1, 60_000);

    expect((await limiter.consume("first@b.com")).allowed).toBe(true);
    expect((await limiter.consume("first@b.com")).allowed).toBe(false);
    expect((await limiter.consume("second@b.com")).allowed).toBe(true);
  });

  it("reset() clears a key's bucket so it can immediately consume again", async () => {
    const limiter = new RedisLoginRateLimiter(new FakeRedis(), 1, 60_000);

    expect((await limiter.consume("a@b.com")).allowed).toBe(true);
    expect((await limiter.consume("a@b.com")).allowed).toBe(false);

    await limiter.reset("a@b.com");
    expect((await limiter.consume("a@b.com")).allowed).toBe(true);
  });
});
