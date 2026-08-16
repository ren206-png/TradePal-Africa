import crypto from "node:crypto";
import type { AIProviderId } from "../ai/aiTypes.js";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { getMonthBoundsInTimezone } from "./dailySummary.js";

/**
 * DeepSeek Integration Phase 3 (INTEGRATION_DESIGN.md §3, §1): two-phase,
 * append-only cost accounting for `AiUsageLedger`, mirroring
 * `src/domain/billing.ts`'s file structure/error-class conventions. Every
 * write here is a plain `create` — never an `update` — by construction: a
 * reservation is one RESERVE row, and its outcome is always a *second*,
 * separate row (COMMIT on success, RELEASE on abort/timeout/error) sharing
 * the same `requestId`. This is why `AiUsageLedger` is deliberately not in
 * `src/db/tenantScope.ts`'s `APPEND_ONLY_MODELS` — there is no update path
 * to block in the first place (see that file's own comment on this model).
 *
 * Nothing in this file is wired to a live call path yet — no `AIFeature` is
 * actually routed to DeepSeek in this increment (see `aiTypes.ts`'s own doc
 * comment). This module is cost-governance infrastructure a later routing
 * phase will call into.
 */

export class AiUsageReservationNotFoundError extends Error {}
export class AiUsageAlreadyTerminalError extends Error {}

/**
 * PHASE_0_FINDINGS.md's "DeepSeek Integration — Phase 0" §0.3 identifies the
 * real double-billing risk in this codebase: not Meta's webhook retry (the
 * AI call doesn't sit inside that request/response cycle), but BullMQ
 * re-running the same job after a mid-flight process crash. Guarding
 * against that means refusing to open a *second* reservation for an
 * idempotencyKey/provider pair that has already been billed (COMMIT'd) —
 * thrown rather than silently ignored, so a caller that hits this can
 * decide how to react (e.g. skip the vendor call and reuse whatever the
 * original job already produced) instead of unknowingly double-charging.
 */
export class AiUsageAlreadyCommittedError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly provider: AIProviderId,
  ) {
    super(
      `AI usage for idempotencyKey '${idempotencyKey}' / provider '${provider}' was already committed — refusing to open a second reservation (no double-charge).`,
    );
  }
}

export interface ReserveAiUsageParams {
  businessId: string;
  /** Validated against the AIFeature TS union at the call site (aiTypes.ts) — kept as `string` here so this table needs no migration when that union grows. */
  feature: string;
  provider: AIProviderId;
  requestedModel: string;
  resolvedModel: string;
  /** Integer micro-USD, never a float — matches src/domain/money.ts. */
  estimatedCostMicroUsd: bigint;
  /** sha256 hex of the prompt text; never the prompt itself (Constraint #5). */
  promptHash: string;
  /** The same waMessageId already used for BullMQ-level dedupe (src/queue/inboundMessageQueue.ts:18) — no new concept. */
  idempotencyKey: string;
}

export interface ReserveAiUsageResult {
  requestId: string;
}

/**
 * Opens a budget hold before a vendor call is made. Throws
 * `AiUsageAlreadyCommittedError` if this idempotencyKey/provider pair has
 * already been billed — see that class's doc comment for why this check
 * happens here, at reservation time, rather than only at commit time (a
 * second reservation must never be allowed to open in the first place, not
 * merely be prevented from later charging).
 *
 * DeepSeek Integration Phase 8, F-2 closure (DEEPSEEK_PHASE6_ADVERSARIAL_REVIEW.md):
 * the "already committed" check above and the RESERVE insert below are not
 * atomic on their own — `(idempotencyKey, provider)` is only a plain
 * `@@index`, not `@@unique` (prisma/schema.prisma), so two concurrent
 * `reserveAiUsage` calls for the same key could both read "no COMMIT yet"
 * before either inserts, opening two live reservations for what must be a
 * single billable operation (the TOCTOU race Phase 6's review flagged as a
 * prerequisite to close before any phase wires live routing — this is that
 * phase). Both the check and the insert now run inside one
 * `scopedPrisma.$transaction`, preceded by a Postgres advisory transaction
 * lock keyed on the same `(idempotencyKey, provider)` pair the uniqueness
 * check itself uses (`pg_advisory_xact_lock`, auto-released at transaction
 * end) — concurrent callers for the *same* key serialize on that lock, so
 * only one can observe the not-yet-committed state and proceed. A
 * `hashtext()` collision between two *different* keys only serializes those
 * two unrelated callers against each other; it can never let two racing
 * calls for the *same* key both through, so it is inconsequential here.
 */
export async function reserveAiUsage(
  scopedPrisma: TenantScopedClient,
  params: ReserveAiUsageParams,
): Promise<ReserveAiUsageResult> {
  const requestId = crypto.randomUUID();

  await scopedPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.idempotencyKey} || ${params.provider}))`;

    const existingCommit = await tx.aiUsageLedger.findFirst({
      where: { idempotencyKey: params.idempotencyKey, provider: params.provider, phase: "COMMIT" },
    });
    if (existingCommit) {
      throw new AiUsageAlreadyCommittedError(params.idempotencyKey, params.provider);
    }

    await tx.aiUsageLedger.create({
      data: {
        requestId,
        phase: "RESERVE",
        businessId: params.businessId,
        feature: params.feature,
        provider: params.provider,
        requestedModel: params.requestedModel,
        resolvedModel: params.resolvedModel,
        estimatedCostMicroUsd: params.estimatedCostMicroUsd,
        promptHash: params.promptHash,
        idempotencyKey: params.idempotencyKey,
      },
    });
  });

  return { requestId };
}

/**
 * Looks up the RESERVE row a COMMIT/RELEASE must be paired with, and refuses a second terminal row for the
 * same requestId — a requestId's outcome is decided exactly once.
 *
 * Generic over the client type (rather than fixed to `TenantScopedClient`) so `commitAiUsage`'s F-2 fix can
 * call this with the interactive-transaction client `$transaction`'s callback hands back — that client has
 * the same model delegates as `TenantScopedClient` but omits the top-level `$transaction`/`$connect`/etc.
 * methods, so it isn't itself assignable to the `TenantScopedClient` type.
 */
async function loadReserveForTerminalWrite<TClient extends { aiUsageLedger: TenantScopedClient["aiUsageLedger"] }>(
  scopedPrisma: TClient,
  requestId: string,
) {
  const reserve = await scopedPrisma.aiUsageLedger.findFirst({ where: { requestId, phase: "RESERVE" } });
  if (!reserve) {
    throw new AiUsageReservationNotFoundError(`No RESERVE row found for requestId '${requestId}'.`);
  }

  const terminal = await scopedPrisma.aiUsageLedger.findFirst({
    where: { requestId, phase: { in: ["COMMIT", "RELEASE"] } },
  });
  if (terminal) {
    throw new AiUsageAlreadyTerminalError(`requestId '${requestId}' already has a terminal (${terminal.phase}) row.`);
  }

  return reserve;
}

export interface CommitAiUsageParams {
  /** Integer micro-USD, never a float — matches src/domain/money.ts. */
  actualCostMicroUsd: bigint;
  httpStatus?: number;
}

/**
 * Records a successful vendor call's actual cost. The rest of the row (businessId/feature/provider/model
 * names/promptHash/idempotencyKey) is copied from the RESERVE row, never re-supplied — a COMMIT can only
 * ever agree with the reservation it closes out.
 *
 * DeepSeek Integration Phase 8, F-2 closure (continued — DEEPSEEK_PHASE6_ADVERSARIAL_REVIEW.md): the
 * advisory lock added to `reserveAiUsage` above is not sufficient on its own. Two concurrent
 * `reserveAiUsage` calls for the *same* idempotencyKey never race each other on the "already committed"
 * check, because neither one writes a COMMIT row — the actual double-billing scenario is a
 * `reserveAiUsage` call for a key racing a `commitAiUsage` call for a *different* RESERVE row that shares
 * the same key (e.g. a BullMQ job retried after a crash: the first attempt's RESERVE is still open when a
 * second attempt reserves-and-commits, and then the first attempt's own commit lands too). Closing that
 * requires `commitAiUsage` to serialize on the identical `pg_advisory_xact_lock(hashtext(idempotencyKey ||
 * provider))` `reserveAiUsage` uses, and to check for an existing COMMIT row under that
 * `(idempotencyKey, provider)` pair from ANY requestId — not just re-check this requestId's own terminal
 * state, which `loadReserveForTerminalWrite` already guarantees is exactly-once per requestId but says
 * nothing about a *different* requestId for the same logical operation having already committed.
 */
export async function commitAiUsage(
  scopedPrisma: TenantScopedClient,
  requestId: string,
  params: CommitAiUsageParams,
): Promise<void> {
  await scopedPrisma.$transaction(async (tx) => {
    const reserve = await loadReserveForTerminalWrite(tx, requestId);

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reserve.idempotencyKey} || ${reserve.provider}))`;

    const existingCommit = await tx.aiUsageLedger.findFirst({
      where: {
        idempotencyKey: reserve.idempotencyKey,
        provider: reserve.provider,
        phase: "COMMIT",
        requestId: { not: requestId },
      },
    });
    if (existingCommit) {
      throw new AiUsageAlreadyCommittedError(reserve.idempotencyKey, reserve.provider);
    }

    await tx.aiUsageLedger.create({
      data: {
        requestId,
        phase: "COMMIT",
        businessId: reserve.businessId,
        feature: reserve.feature,
        provider: reserve.provider,
        requestedModel: reserve.requestedModel,
        resolvedModel: reserve.resolvedModel,
        actualCostMicroUsd: params.actualCostMicroUsd,
        promptHash: reserve.promptHash,
        idempotencyKey: reserve.idempotencyKey,
        httpStatus: params.httpStatus ?? null,
      },
    });
  });
}

export interface ReleaseAiUsageParams {
  /** Mirrors AIResult's own "kind" union (src/ai/aiTypes.ts) — populated on RELEASE only. */
  errorClass: string;
  httpStatus?: number;
}

/** Records that a reservation was abandoned (timeout/error/abort) with no charge — releases the held budget back to the business. */
export async function releaseAiUsage(
  scopedPrisma: TenantScopedClient,
  requestId: string,
  params: ReleaseAiUsageParams,
): Promise<void> {
  const reserve = await loadReserveForTerminalWrite(scopedPrisma, requestId);

  await scopedPrisma.aiUsageLedger.create({
    data: {
      requestId,
      phase: "RELEASE",
      businessId: reserve.businessId,
      feature: reserve.feature,
      provider: reserve.provider,
      requestedModel: reserve.requestedModel,
      resolvedModel: reserve.resolvedModel,
      promptHash: reserve.promptHash,
      idempotencyKey: reserve.idempotencyKey,
      errorClass: params.errorClass,
      httpStatus: params.httpStatus ?? null,
    },
  });
}

/**
 * "Current open budget" for a business, per INTEGRATION_DESIGN.md §3's own
 * formula: SUM(estimatedCostMicroUsd of RESERVE rows with no terminal
 * COMMIT/RELEASE row yet — i.e. still "in flight", including any leaked
 * reservation from a crashed process) + SUM(actualCostMicroUsd of COMMIT
 * rows created within the current calendar month, in the business's own
 * timezone, mirroring billing.ts's getQuotaStatus). A RESERVE row that never
 * gets a terminal row (a leaked reservation, e.g. the process died between
 * the vendor call and recording its outcome) is counted here forever by
 * design — directly queryable rather than needing a separate leak-tracking
 * mechanism, per the schema's own doc comment.
 */
export async function getOpenBudgetMicroUsdForBusiness(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<bigint> {
  const { start, end } = getMonthBoundsInTimezone(now, timezone);

  const [reserveRows, terminalRows, committedRows] = await Promise.all([
    scopedPrisma.aiUsageLedger.findMany({
      where: { businessId, phase: "RESERVE" },
      select: { requestId: true, estimatedCostMicroUsd: true },
    }),
    scopedPrisma.aiUsageLedger.findMany({
      where: { businessId, phase: { in: ["COMMIT", "RELEASE"] } },
      select: { requestId: true },
    }),
    scopedPrisma.aiUsageLedger.findMany({
      where: { businessId, phase: "COMMIT", createdAt: { gte: start, lt: end } },
      select: { actualCostMicroUsd: true },
    }),
  ]);

  const terminalRequestIds = new Set(terminalRows.map((row) => row.requestId));
  const openReservedMicroUsd = reserveRows
    .filter((row) => !terminalRequestIds.has(row.requestId))
    .reduce((total, row) => total + (row.estimatedCostMicroUsd ?? 0n), 0n);

  const committedMicroUsd = committedRows.reduce((total, row) => total + (row.actualCostMicroUsd ?? 0n), 0n);

  return openReservedMicroUsd + committedMicroUsd;
}
