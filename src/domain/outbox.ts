import { Prisma, type OutboxEvent, type PrismaClient } from "@prisma/client";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, isRetryExhausted, type RetryPolicy } from "./retryPolicy.js";

/**
 * Transactional outbox (expansion Phase 1, decision P6).
 *
 * `enqueueOutboxEvent` takes a Prisma client OR a transaction client. Calling it with the transaction client of the
 * business change that causes the event commits both or neither: a crash cannot lose the event, and a rollback cannot
 * leave an event for a change that never happened. `processOutbox` then delivers events asynchronously with
 * at-least-once semantics: handlers must be idempotent, and the per-event dedupe key makes the producer side idempotent.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface EnqueueOutboxEventInput {
  businessId?: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
  /** Identifies the business effect. Enqueueing the same key again is a no-op returning the existing event. */
  dedupeKey: string;
  /** Do not deliver before this time (default: now). */
  availableAt?: Date;
}

export async function enqueueOutboxEvent(db: Db, input: EnqueueOutboxEventInput): Promise<OutboxEvent> {
  return db.outboxEvent.upsert({
    where: { dedupeKey: input.dedupeKey },
    update: {},
    create: {
      businessId: input.businessId ?? null,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    },
  });
}

export interface ClaimOptions {
  limit?: number;
  now?: Date;
  /** A PROCESSING event whose claim is older than this is assumed orphaned by a crashed worker and becomes claimable again. */
  visibilityTimeoutMs?: number;
  /** Only events of these types are claimed; types nobody handles yet stay PENDING untouched. */
  eventTypes: readonly string[];
}

/** Atomically claims due events (SKIP LOCKED, so concurrent sweepers never take the same row). */
export async function claimDueOutboxEvents(prisma: PrismaClient, options: ClaimOptions): Promise<OutboxEvent[]> {
  if (options.eventTypes.length === 0) return [];
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (options.visibilityTimeoutMs ?? 5 * 60_000));
  const limit = options.limit ?? 25;
  return prisma.$queryRaw<OutboxEvent[]>`
    WITH due AS (
      SELECT id FROM "OutboxEvent"
       WHERE "eventType" IN (${Prisma.join([...options.eventTypes])})
         AND (("status" = 'PENDING' AND "availableAt" <= ${now})
              OR ("status" = 'PROCESSING' AND "claimedAt" <= ${staleBefore}))
       ORDER BY "availableAt", "createdAt"
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE "OutboxEvent" o
       SET "status" = 'PROCESSING', "claimedAt" = ${now}, "attempts" = o."attempts" + 1
      FROM due WHERE o.id = due.id
    RETURNING o.*`;
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface ProcessOutboxResult {
  claimed: number;
  published: number;
  retried: number;
  dead: number;
}

/**
 * One sweep: claim due events for the registered handlers, run each, then mark it PUBLISHED, schedule a backoff retry, or
 * (when the retry budget is spent) mark it DEAD. A failing event never blocks the others.
 */
export async function processOutbox(
  prisma: PrismaClient,
  handlers: Readonly<Record<string, OutboxHandler>>,
  options: { limit?: number; now?: Date; visibilityTimeoutMs?: number; retry?: RetryPolicy } = {},
): Promise<ProcessOutboxResult> {
  const now = options.now ?? new Date();
  const retry = options.retry ?? DEFAULT_RETRY_POLICY;
  const events = await claimDueOutboxEvents(prisma, {
    eventTypes: Object.keys(handlers),
    now,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.visibilityTimeoutMs ? { visibilityTimeoutMs: options.visibilityTimeoutMs } : {}),
  });

  const result: ProcessOutboxResult = { claimed: events.length, published: 0, retried: 0, dead: 0 };
  for (const event of events) {
    const handler = handlers[event.eventType];
    try {
      if (!handler) throw new Error(`No handler registered for event type '${event.eventType}'.`);
      await handler(event);
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: "PUBLISHED", publishedAt: now, lastError: null } });
      result.published++;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      if (isRetryExhausted(event.attempts, retry)) {
        await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: "DEAD", lastError: message } });
        result.dead++;
      } else {
        const availableAt = new Date(now.getTime() + backoffDelayMs(event.attempts, retry));
        await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: "PENDING", availableAt, lastError: message, claimedAt: null } });
        result.retried++;
      }
    }
  }
  return result;
}

/** Dead-letter replay (an audited admin action): gives a DEAD event a fresh retry budget. */
export async function replayDeadOutboxEvent(prisma: PrismaClient, id: string, now: Date = new Date()): Promise<OutboxEvent> {
  const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
  if (event.status !== "DEAD") throw new Error(`Only a DEAD outbox event can be replayed (this one is ${event.status}).`);
  return prisma.outboxEvent.update({ where: { id }, data: { status: "PENDING", attempts: 0, availableAt: now, claimedAt: null } });
}

export interface OutboxStats {
  pending: number;
  processing: number;
  published: number;
  dead: number;
  /** Age in seconds of the oldest event still waiting to be delivered (null when none). */
  oldestPendingAgeSeconds: number | null;
}

export async function getOutboxStats(prisma: PrismaClient, now: Date = new Date()): Promise<OutboxStats> {
  const grouped = await prisma.outboxEvent.groupBy({ by: ["status"], _count: { _all: true } });
  const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const oldest = await prisma.outboxEvent.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  return {
    pending: count("PENDING"),
    processing: count("PROCESSING"),
    published: count("PUBLISHED"),
    dead: count("DEAD"),
    oldestPendingAgeSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000)) : null,
  };
}
