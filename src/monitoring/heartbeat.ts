import type { PrismaClient } from "@prisma/client";

/**
 * Process heartbeats (expansion Phase 1). Each long-running process writes "I'm alive" to SystemHeartbeat; the admin
 * health view reads it, and the public GET /heartbeat turns it into a single ok/stale answer an external monitor
 * (one that does not depend on Railway) can poll as a dead-man's switch. Writing is OFF unless HEARTBEAT_ENABLED=true.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_AFTER_SECONDS = 120;

export function heartbeatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["HEARTBEAT_ENABLED"] === "true";
}

/** Comma-separated service names that must be fresh for /heartbeat to report ok (default: worker). */
export function requiredHeartbeatServices(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env["HEARTBEAT_REQUIRED_SERVICES"] ?? "worker").split(",").map((s) => s.trim()).filter(Boolean);
}

export async function recordHeartbeat(prisma: PrismaClient, service: string, now: Date = new Date()): Promise<void> {
  await prisma.systemHeartbeat.upsert({
    where: { service },
    create: { service, lastSeenAt: now },
    update: { lastSeenAt: now },
  });
}

export function startHeartbeat(prisma: PrismaClient, service: string, intervalMs: number = HEARTBEAT_INTERVAL_MS): { stop(): void } {
  const beat = () => void recordHeartbeat(prisma, service).catch((error) => console.error(`heartbeat write failed (${service}):`, error));
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

export interface HeartbeatStatus {
  service: string;
  lastSeenAt: Date | null;
  ageSeconds: number | null;
  stale: boolean;
}

/** A required service with no row at all counts as stale (never seen). */
export async function evaluateHeartbeats(
  prisma: PrismaClient,
  required: readonly string[],
  now: Date = new Date(),
  staleAfterSeconds: number = HEARTBEAT_STALE_AFTER_SECONDS,
): Promise<HeartbeatStatus[]> {
  const rows = await prisma.systemHeartbeat.findMany();
  const names = Array.from(new Set([...required, ...rows.map((r) => r.service)]));
  return names.sort().map((service) => {
    const row = rows.find((r) => r.service === service);
    const ageSeconds = row ? Math.max(0, Math.round((now.getTime() - row.lastSeenAt.getTime()) / 1000)) : null;
    return { service, lastSeenAt: row?.lastSeenAt ?? null, ageSeconds, stale: ageSeconds === null || ageSeconds > staleAfterSeconds };
  });
}
