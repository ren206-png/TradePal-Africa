import { describe, expect, it } from "vitest";
import { InMemoryInboundMessageRateLimiter, RedisInboundMessageRateLimiter } from "../src/whatsapp/inboundRateLimiter.js";
import { FakeRedis } from "./helpers/fakeRedis.js";

describe("InMemoryInboundMessageRateLimiter", () => {
  it("allows messages under the max, then blocks with a positive retryAfterSeconds", async () => {
    const limiter = new InMemoryInboundMessageRateLimiter(3, 60_000);

    expect(await limiter.consume("2348012345678")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("2348012345678")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("2348012345678")).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const blocked = await limiter.consume("2348012345678");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks each phone number's window independently", async () => {
    const limiter = new InMemoryInboundMessageRateLimiter(1, 60_000);

    expect((await limiter.consume("2348011111111")).allowed).toBe(true);
    expect((await limiter.consume("2348011111111")).allowed).toBe(false);
    // A different sender has its own, unaffected bucket.
    expect((await limiter.consume("2348022222222")).allowed).toBe(true);
  });

  it("defaults to a generous 30 messages per 60s window", async () => {
    const limiter = new InMemoryInboundMessageRateLimiter();

    for (let i = 0; i < 30; i += 1) {
      expect((await limiter.consume("2348033333333")).allowed).toBe(true);
    }
    expect((await limiter.consume("2348033333333")).allowed).toBe(false);
  });
});

/**
 * Phase 20: same behaviors as InMemoryInboundMessageRateLimiter above,
 * proving RedisInboundMessageRateLimiter is a drop-in-compatible
 * implementation of the same InboundMessageRateLimiter interface (against a
 * fake Redis — see tests/adminRateLimiter.test.ts's identical rationale for
 * RedisLoginRateLimiter, and tests/redisFixedWindowLimiter.test.ts for the
 * shared underlying algorithm's own, more thorough test coverage).
 */
describe("RedisInboundMessageRateLimiter", () => {
  it("allows messages under the max, then blocks with a positive retryAfterSeconds", async () => {
    const limiter = new RedisInboundMessageRateLimiter(new FakeRedis(), 3, 60_000);

    expect(await limiter.consume("2348012345678")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("2348012345678")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.consume("2348012345678")).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const blocked = await limiter.consume("2348012345678");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks each phone number's window independently", async () => {
    const limiter = new RedisInboundMessageRateLimiter(new FakeRedis(), 1, 60_000);

    expect((await limiter.consume("2348011111111")).allowed).toBe(true);
    expect((await limiter.consume("2348011111111")).allowed).toBe(false);
    expect((await limiter.consume("2348022222222")).allowed).toBe(true);
  });

  it("defaults to a generous 30 messages per 60s window", async () => {
    const limiter = new RedisInboundMessageRateLimiter(new FakeRedis());

    for (let i = 0; i < 30; i += 1) {
      expect((await limiter.consume("2348033333333")).allowed).toBe(true);
    }
    expect((await limiter.consume("2348033333333")).allowed).toBe(false);
  });
});
