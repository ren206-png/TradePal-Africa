/**
 * BullMQ bundles its own copy of ioredis, structurally incompatible (under
 * exactOptionalPropertyTypes) with a client built from our top-level ioredis
 * dependency. Handing BullMQ a plain options object instead of a live Redis
 * instance sidesteps the type clash entirely and lets BullMQ manage the
 * connection (including the maxRetriesPerRequest: null it requires).
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
}

export function getRedisConnectionOptions(): RedisConnectionOptions {
  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) throw new Error("REDIS_URL is not set");

  const parsed = new URL(redisUrl);

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
