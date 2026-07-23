import type { RedisLike, RedisPipelineLike } from "../../src/redisFixedWindowLimiter.js";

/**
 * A small, hand-written in-memory double for the narrow `RedisLike` slice
 * `RedisFixedWindowLimiter` actually calls (INCR/PEXPIRE via a MULTI
 * pipeline, plus standalone PTTL/DEL) — mirrors how `tests/*.test.ts`
 * already fake `fetch` for WhatsApp sends rather than hitting a real
 * network dependency. Faithfully reproduces the real Redis semantics this
 * limiter depends on:
 *  - `INCR` on a missing key starts it at 1 (real Redis: missing key reads
 *    as integer 0, then INCR makes it 1).
 *  - `PEXPIRE key ms NX` only sets an expiry if the key doesn't already
 *    have one — the exact behavior `RedisFixedWindowLimiter` relies on to
 *    make this a *fixed*, not sliding, window.
 *  - `PTTL` returns -2 for a missing key, -1 for a key with no expiry, and
 *    the real remaining milliseconds otherwise.
 *  - Keys past their expiry are treated as absent on any subsequent read,
 *    exactly like Redis's own lazy/active expiry.
 */
interface FakeEntry {
  count: number;
  expiresAt: number | null;
}

export class FakeRedis implements RedisLike {
  private readonly store = new Map<string, FakeEntry>();

  private getLive(key: string): FakeEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  multi(): RedisPipelineLike {
    const ops: Array<() => [Error | null, unknown]> = [];

    const pipeline: RedisPipelineLike = {
      incr: (key: string) => {
        ops.push((): [Error | null, unknown] => {
          const existing = this.getLive(key);
          const count = (existing?.count ?? 0) + 1;
          this.store.set(key, { count, expiresAt: existing?.expiresAt ?? null });
          return [null, count];
        });
        return pipeline;
      },
      pexpire: (key: string, milliseconds: number, flag: "NX") => {
        ops.push((): [Error | null, unknown] => {
          const existing = this.getLive(key);
          if (!existing) return [null, 0];
          if (flag === "NX" && existing.expiresAt !== null) return [null, 0];
          existing.expiresAt = Date.now() + milliseconds;
          return [null, 1];
        });
        return pipeline;
      },
      exec: (): Promise<Array<[Error | null, unknown]> | null> => Promise.resolve(ops.map((op) => op())),
    };

    return pipeline;
  }

  pttl(key: string): Promise<number> {
    const entry = this.getLive(key);
    if (!entry) return Promise.resolve(-2);
    if (entry.expiresAt === null) return Promise.resolve(-1);
    return Promise.resolve(Math.max(0, entry.expiresAt - Date.now()));
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }
}
