import { Prisma, type CallbackInbox, type PrismaClient } from "@prisma/client";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, isRetryExhausted, type RetryPolicy } from "./retryPolicy.js";

/**
 * Durable inbox for provider callbacks (expansion Phase 1, scenarios 7-8).
 *
 * The HTTP handler's whole job is: authenticate per the provider's documented scheme, `recordCallback`, answer 200.
 * Processing happens later in `processInbox`, with the claim being atomic so concurrent sweepers and duplicate
 * deliveries produce exactly one business effect. A callback is stored with `signatureVerified` so an unauthenticated
 * one can never be mistaken for evidence: handlers must check it.
 */
export interface RecordCallbackInput {
  provider: string;
  externalId: string;
  payload: Prisma.InputJsonValue;
  signatureVerified: boolean;
}

export interface RecordCallbackResult {
  id: string;
  /** False when this (provider, externalId) was already stored: a duplicate delivery, safe to acknowledge. */
  inserted: boolean;
}

export async function recordCallback(prisma: PrismaClient, input: RecordCallbackInput): Promise<RecordCallbackResult> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "CallbackInbox" ("id", "provider", "externalId", "payload", "signatureVerified")
    VALUES (gen_random_uuid()::text, ${input.provider}, ${input.externalId}, ${JSON.stringify(input.payload)}::jsonb, ${input.signatureVerified})
    ON CONFLICT ("provider", "externalId") DO NOTHING
    RETURNING "id"`;
  if (rows[0]) return { id: rows[0].id, inserted: true };
  const existing = await prisma.callbackInbox.findUniqueOrThrow({
    where: { provider_externalId: { provider: input.provider, externalId: input.externalId } },
    select: { id: true },
  });
  return { id: existing.id, inserted: false };
}

export async function claimDueCallbacks(
  prisma: PrismaClient,
  options: { providers: readonly string[]; limit?: number; now?: Date; visibilityTimeoutMs?: number },
): Promise<CallbackInbox[]> {
  if (options.providers.length === 0) return [];
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (options.visibilityTimeoutMs ?? 5 * 60_000));
  const limit = options.limit ?? 25;
  return prisma.$queryRaw<CallbackInbox[]>`
    WITH due AS (
      SELECT id FROM "CallbackInbox"
       WHERE "provider" IN (${Prisma.join([...options.providers])})
         AND (("status" = 'RECEIVED' AND "availableAt" <= ${now})
              OR ("status" = 'PROCESSING' AND "claimedAt" <= ${staleBefore}))
       ORDER BY "receivedAt"
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE "CallbackInbox" c
       SET "status" = 'PROCESSING', "claimedAt" = ${now}, "attempts" = c."attempts" + 1
      FROM due WHERE c.id = due.id
    RETURNING c.*`;
}

export type CallbackHandler = (callback: CallbackInbox) => Promise<void>;

export interface ProcessInboxResult {
  claimed: number;
  processed: number;
  retried: number;
  dead: number;
}

/** One sweep over the registered providers; same retry/dead-letter rules as the outbox. */
export async function processInbox(
  prisma: PrismaClient,
  handlers: Readonly<Record<string, CallbackHandler>>,
  options: { limit?: number; now?: Date; visibilityTimeoutMs?: number; retry?: RetryPolicy } = {},
): Promise<ProcessInboxResult> {
  const now = options.now ?? new Date();
  const retry = options.retry ?? DEFAULT_RETRY_POLICY;
  const callbacks = await claimDueCallbacks(prisma, {
    providers: Object.keys(handlers),
    now,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.visibilityTimeoutMs ? { visibilityTimeoutMs: options.visibilityTimeoutMs } : {}),
  });

  const result: ProcessInboxResult = { claimed: callbacks.length, processed: 0, retried: 0, dead: 0 };
  for (const callback of callbacks) {
    const handler = handlers[callback.provider];
    try {
      if (!handler) throw new Error(`No handler registered for provider '${callback.provider}'.`);
      await handler(callback);
      await prisma.callbackInbox.update({ where: { id: callback.id }, data: { status: "PROCESSED", processedAt: now, lastError: null } });
      result.processed++;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      if (isRetryExhausted(callback.attempts, retry)) {
        await prisma.callbackInbox.update({ where: { id: callback.id }, data: { status: "DEAD", lastError: message } });
        result.dead++;
      } else {
        const availableAt = new Date(now.getTime() + backoffDelayMs(callback.attempts, retry));
        await prisma.callbackInbox.update({ where: { id: callback.id }, data: { status: "RECEIVED", availableAt, lastError: message, claimedAt: null } });
        result.retried++;
      }
    }
  }
  return result;
}

export async function replayDeadCallback(prisma: PrismaClient, id: string, now: Date = new Date()): Promise<CallbackInbox> {
  const callback = await prisma.callbackInbox.findUniqueOrThrow({ where: { id } });
  if (callback.status !== "DEAD") throw new Error(`Only a DEAD callback can be replayed (this one is ${callback.status}).`);
  return prisma.callbackInbox.update({ where: { id }, data: { status: "RECEIVED", attempts: 0, availableAt: now, claimedAt: null } });
}

export interface InboxStats {
  received: number;
  processing: number;
  processed: number;
  dead: number;
  oldestWaitingAgeSeconds: number | null;
}

export async function getInboxStats(prisma: PrismaClient, now: Date = new Date()): Promise<InboxStats> {
  const grouped = await prisma.callbackInbox.groupBy({ by: ["status"], _count: { _all: true } });
  const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const oldest = await prisma.callbackInbox.findFirst({ where: { status: "RECEIVED" }, orderBy: { receivedAt: "asc" }, select: { receivedAt: true } });
  return {
    received: count("RECEIVED"),
    processing: count("PROCESSING"),
    processed: count("PROCESSED"),
    dead: count("DEAD"),
    oldestWaitingAgeSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.receivedAt.getTime()) / 1000)) : null,
  };
}
