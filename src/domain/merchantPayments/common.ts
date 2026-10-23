import type { PrismaClient, ProviderConnection, ProviderExceptionType } from "@prisma/client";
import { getTenantScopedClient, type TenantScopedClient } from "../../db/tenantScope.js";

export class PaymentsError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "PaymentsError";
  }
}

export const ACTIVE_ATTEMPT_STATUSES = ["CREATED", "PENDING", "UNKNOWN"] as const;
export type ActiveAttemptStatus = (typeof ACTIVE_ATTEMPT_STATUSES)[number];

/** Polling an unresolved attempt: bounded exponential backoff, then an exception for a person. */
export const MAX_POLLS = 8;
const POLL_BASE_MS = 30_000;
const POLL_CAP_MS = 30 * 60_000;
export const nextPollDelayMs = (pollCount: number): number => Math.min(POLL_BASE_MS * 2 ** Math.max(0, pollCount), POLL_CAP_MS);

/** After this many consecutive failures the connection refuses NEW attempts for a cooldown (existing attempts keep reconciling). */
export const CIRCUIT_FAILURES = 3;
export const CIRCUIT_COOLDOWN_MS = 60_000;

export const PROVIDER_UNAVAILABLE_MESSAGE = "Online payment is temporarily unavailable. Please try again in a few minutes, or pay the seller another way.";

export interface RaiseInput {
  type: ProviderExceptionType;
  fingerprint: string;
  businessId?: string | null;
  provider?: string | null;
  attemptId?: string | null;
  intentId?: string | null;
  amountMinor?: bigint | null;
  currencyCode?: string | null;
  details?: Record<string, unknown>;
}

/** Raises one exception per fingerprint: a replayed callback cannot flood the queue. `skipDuplicates` is ON CONFLICT DO NOTHING (no error). */
export async function raiseProviderException(prisma: PrismaClient, input: RaiseInput): Promise<void> {
  await prisma.providerException.createMany({
    data: [{
      type: input.type, fingerprint: input.fingerprint, businessId: input.businessId ?? null, provider: input.provider ?? null, attemptId: input.attemptId ?? null,
      intentId: input.intentId ?? null, amountMinor: input.amountMinor ?? null, currencyCode: input.currencyCode ?? null, details: (input.details ?? {}) as never,
    }],
    skipDuplicates: true,
  });
}

export async function recordAttemptEvent(
  scoped: TenantScopedClient, businessId: string, attemptId: string, from: string | null, to: string, source: "CREATE" | "CALLBACK" | "POLL" | "EXPIRY" | "ADMIN", detail?: Record<string, unknown>,
): Promise<void> {
  await scoped.paymentAttemptEvent.create({ data: { businessId, attemptId, fromStatus: from as never, toStatus: to as never, source, ...(detail ? { detail: detail as never } : {}) } });
}

export const circuitOpen = (c: Pick<ProviderConnection, "openUntil">, now: Date): boolean => c.openUntil !== null && c.openUntil > now;

export async function noteProviderFailure(prisma: PrismaClient, connection: ProviderConnection, now: Date): Promise<void> {
  const scoped = getTenantScopedClient(prisma, connection.businessId);
  const failures = connection.consecutiveFailures + 1;
  await scoped.providerConnection.updateMany({
    where: { id: connection.id },
    data: { consecutiveFailures: { increment: 1 }, lastFailureAt: now, ...(failures >= CIRCUIT_FAILURES ? { openUntil: new Date(now.getTime() + CIRCUIT_COOLDOWN_MS) } : {}) },
  });
}

export async function noteProviderSuccess(prisma: PrismaClient, connection: ProviderConnection, now: Date): Promise<void> {
  if (connection.consecutiveFailures === 0 && connection.openUntil === null) return;
  const scoped = getTenantScopedClient(prisma, connection.businessId);
  await scoped.providerConnection.updateMany({ where: { id: connection.id }, data: { consecutiveFailures: 0, openUntil: null, lastSuccessAt: now } });
}

/** JSON-safe form of a normalised provider event (bigint and Date survive the round trip through the inbox). */
export function serializeEvent(event: unknown): unknown {
  return JSON.parse(JSON.stringify(event, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v)));
}
export function reviveEvent<T>(json: unknown): T {
  return JSON.parse(JSON.stringify(json), (k, v) => {
    if (v && typeof v === "object" && typeof (v as { $bigint?: string }).$bigint === "string") return BigInt((v as { $bigint: string }).$bigint);
    if (k === "settledAt" && typeof v === "string") return new Date(v);
    return v;
  }) as T;
}
