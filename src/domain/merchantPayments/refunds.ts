import type { PaymentAttempt, PrismaClient, ProviderRefund } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import { CapabilityError, ProviderRejectedError, ProviderUnavailableError, requireCapability, type AdapterRegistry, type ProviderAdapter, type RefundResult } from "../../payments/adapter.js";
import { PaymentsError, raiseProviderException } from "./common.js";
import { issueStoreRefund } from "../store/refunds.js";
import { resolvePaymentException } from "../store/payments.js";

/**
 * Refunds through the provider that collected the money (expansion section 12). Rules:
 *  - bounded by what the attempt actually captured: the funds are RESERVED by a guarded UPDATE (`refunded + x <= captured`, plus a
 *    database CHECK) before anything is sent, so concurrent partial refunds can never exceed what was collected (scenario 12);
 *  - idempotent by key: the same request twice is one refund, at the provider and here;
 *  - a failed refund stays visible and unresolved: the reservation is released so it can be retried or settled another way, the refund
 *    row says FAILED, and an exception is raised for a person. It is never retried through a different provider;
 *  - the books move only when the provider confirms: a store order's refund bookkeeping runs on success, not on request.
 */
export interface RefundInput {
  businessId: string;
  attemptId: string;
  amountMinor: bigint;
  reason: string;
  idempotencyKey: string;
  /** Exactly one bookkeeping target, or none for a bare refund: an approved refund/return request, a cancelled paid order, or a held payment. */
  storeRefundRequestId?: string;
  storeOrderId?: string;
  storeExceptionId?: string;
  actor?: string;
  now?: Date;
}

export async function refundThroughProvider(prisma: PrismaClient, registry: AdapterRegistry, input: RefundInput): Promise<{ refund: ProviderRefund; replayed: boolean }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const prior = await scoped.providerRefund.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
  if (prior) return { refund: prior, replayed: true };
  if (input.amountMinor <= 0n) throw new PaymentsError("INVALID", "Say how much to refund.");
  if (input.reason.trim().length < 5) throw new PaymentsError("INVALID", "Give a reason for the refund.");

  const attempt = await scoped.paymentAttempt.findUnique({ where: { id: input.attemptId }, include: { intent: true } });
  if (!attempt || attempt.status !== "SUCCEEDED") throw new PaymentsError("NOT_REFUNDABLE", "There is no collected payment to refund.");
  const adapter = registry.get(attempt.provider);
  if (!adapter) throw new PaymentsError("NO_CONNECTION", "That provider is not available.");
  requireCapability(adapter, "refund"); // an explicit CapabilityError, before any money is reserved
  await validateBookkeeping(prisma, input, attempt);

  const reserved = await prisma.$executeRaw`UPDATE "PaymentAttempt" SET "refundedMinor" = "refundedMinor" + ${input.amountMinor}
    WHERE "id" = ${attempt.id} AND "businessId" = ${input.businessId} AND "status" = 'SUCCEEDED' AND "capturedMinor" >= "refundedMinor" + ${input.amountMinor}`;
  if (reserved !== 1) throw new PaymentsError("REFUND_LIMIT", "That is more than remains refundable on this payment.");
  await prisma.$executeRaw`UPDATE "PaymentIntent" SET "refundedMinor" = "refundedMinor" + ${input.amountMinor}
    WHERE "id" = ${attempt.intentId} AND "paidMinor" >= "refundedMinor" + ${input.amountMinor}`;

  const created = await scoped.providerRefund.createMany({
    data: [{
      businessId: input.businessId, attemptId: attempt.id, intentId: attempt.intentId, amountMinor: input.amountMinor, reason: input.reason.trim().slice(0, 300), idempotencyKey: input.idempotencyKey,
      ...(input.storeRefundRequestId ? { storeRefundRequestId: input.storeRefundRequestId } : {}), ...(input.storeOrderId ? { storeOrderId: input.storeOrderId } : {}),
      ...(input.storeExceptionId ? { storeExceptionId: input.storeExceptionId } : {}), ...(input.actor ? { createdBy: input.actor } : {}),
    }],
    skipDuplicates: true,
  });
  const refund = await scoped.providerRefund.findFirstOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  if (created.count !== 1) {
    // lost a race with the same key: our reservation was a duplicate, give it back
    await release(prisma, attempt, input.amountMinor);
    return { refund, replayed: true };
  }
  await sendRefund(prisma, adapter, attempt, refund, now);
  return { refund: await scoped.providerRefund.findUniqueOrThrow({ where: { id: refund.id } }), replayed: false };
}

async function validateBookkeeping(prisma: PrismaClient, input: RefundInput, attempt: PaymentAttempt): Promise<void> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  if (input.storeRefundRequestId) {
    const req = await scoped.storeRefundRequest.findUnique({ where: { id: input.storeRefundRequestId } });
    if (!req || !input.storeOrderId || req.orderId !== input.storeOrderId) throw new PaymentsError("INVALID", "That refund request does not belong to this order.");
    const ready = req.kind === "RETURN" ? req.status === "GOODS_RECEIVED" : req.status === "APPROVED";
    if (!ready || req.approvedAmountMinor === null) throw new PaymentsError("NOT_REFUNDABLE", req.kind === "RETURN" ? "Receive the returned goods before refunding." : "Approve the request before refunding.");
    if (req.approvedAmountMinor !== input.amountMinor) throw new PaymentsError("REFUND_LIMIT", "A request is refunded exactly as approved.");
  } else if (input.storeExceptionId) {
    const ex = await scoped.paymentException.findUnique({ where: { id: input.storeExceptionId } });
    const held = ex?.paymentId ? await scoped.storePayment.findUnique({ where: { id: ex.paymentId } }) : null;
    if (!ex || ex.status !== "OPEN" || !held || held.state !== "HELD") throw new PaymentsError("NOT_REFUNDABLE", "There is no held payment to refund.");
    if (held.externalId !== attempt.externalRef || held.amountMinor !== input.amountMinor) throw new PaymentsError("INVALID", "That held payment does not match this refund.");
  } else if (input.storeOrderId) {
    const order = await scoped.storeOrder.findUnique({ where: { id: input.storeOrderId } });
    if (!order || (order.status !== "CANCELLED" && order.status !== "EXPIRED")) throw new PaymentsError("NOT_REFUNDABLE", "Refund a completed order through a return or refund request.");
    if (input.amountMinor > order.paidMinor - order.refundedMinor) throw new PaymentsError("REFUND_LIMIT", "That would refund more than was paid.");
  }
}

async function release(prisma: PrismaClient, attempt: Pick<PaymentAttempt, "id" | "intentId">, amount: bigint): Promise<void> {
  await prisma.$executeRaw`UPDATE "PaymentAttempt" SET "refundedMinor" = "refundedMinor" - ${amount} WHERE "id" = ${attempt.id} AND "refundedMinor" >= ${amount}`;
  await prisma.$executeRaw`UPDATE "PaymentIntent" SET "refundedMinor" = "refundedMinor" - ${amount} WHERE "id" = ${attempt.intentId} AND "refundedMinor" >= ${amount}`;
}

/** Calls the provider (idempotent by key) and applies the answer. Also used to re-send a refund whose outcome we never heard. */
async function sendRefund(prisma: PrismaClient, adapter: ProviderAdapter, attempt: PaymentAttempt, refund: ProviderRefund, now: Date): Promise<void> {
  let result: RefundResult;
  try {
    result = await adapter.refund({ externalRef: attempt.externalRef!, merchantReference: attempt.id, amountMinor: refund.amountMinor, currencyCode: attempt.currencyCode, idempotencyKey: refund.idempotencyKey, reason: refund.reason });
  } catch (error) {
    if (error instanceof ProviderRejectedError) {
      await failRefund(prisma, attempt, refund, error.message);
      return;
    }
    if (error instanceof ProviderUnavailableError) {
      // we cannot tell whether it went through: keep the reservation, mark PENDING and let the sweep ask again (same key, so safe)
      await getTenantScopedClient(prisma, attempt.businessId).providerRefund.updateMany({ where: { id: refund.id, status: "REQUESTED" }, data: { status: "PENDING" } });
      return;
    }
    if (error instanceof CapabilityError) {
      await failRefund(prisma, attempt, refund, error.message);
      return;
    }
    throw error;
  }
  await applyRefundResult(prisma, attempt, refund, result, now);
}

async function applyRefundResult(prisma: PrismaClient, attempt: PaymentAttempt, refund: ProviderRefund, result: RefundResult, now: Date): Promise<void> {
  const scoped = getTenantScopedClient(prisma, attempt.businessId);
  if (result.status === "PENDING") {
    await scoped.providerRefund.updateMany({ where: { id: refund.id, status: { in: ["REQUESTED", "PENDING"] } }, data: { status: "PENDING", ...(result.externalRef ? { externalRef: result.externalRef } : {}) } });
    return;
  }
  if (result.status === "FAILED") {
    await failRefund(prisma, attempt, refund, result.failureReason ?? "The provider could not send the refund.");
    return;
  }
  const moved = await scoped.providerRefund.updateMany({ where: { id: refund.id, status: { in: ["REQUESTED", "PENDING"] } }, data: { status: "SUCCEEDED", ...(result.externalRef ? { externalRef: result.externalRef } : {}) } });
  if (moved.count === 1) await bookRefund(prisma, attempt, refund, now);
}

async function failRefund(prisma: PrismaClient, attempt: PaymentAttempt, refund: ProviderRefund, why: string): Promise<void> {
  const scoped = getTenantScopedClient(prisma, attempt.businessId);
  const moved = await scoped.providerRefund.updateMany({ where: { id: refund.id, status: { in: ["REQUESTED", "PENDING"] } }, data: { status: "FAILED", failureReason: why.slice(0, 200) } });
  if (moved.count !== 1) return;
  await release(prisma, attempt, refund.amountMinor);
  await raiseProviderException(prisma, {
    type: "REFUND_FAILED", fingerprint: `refund-failed:${refund.id}`, businessId: attempt.businessId, provider: attempt.provider, attemptId: attempt.id, intentId: attempt.intentId, amountMinor: refund.amountMinor, currencyCode: attempt.currencyCode,
    details: { refundId: refund.id, why, stage: "PROVIDER" },
  });
}

/** The provider confirmed the refund: now, and only now, the seller's books and the order's refund state move. */
async function bookRefund(prisma: PrismaClient, attempt: PaymentAttempt, refund: ProviderRefund, now: Date): Promise<void> {
  try {
    if (refund.storeRefundRequestId && refund.storeOrderId) {
      await issueStoreRefund(prisma, { businessId: refund.businessId, orderId: refund.storeOrderId, requestId: refund.storeRefundRequestId, method: "MOBILE_MONEY", ...(refund.createdBy ? { actor: refund.createdBy } : {}), now });
    } else if (refund.storeExceptionId) {
      await resolvePaymentException(prisma, { businessId: refund.businessId, exceptionId: refund.storeExceptionId, action: "REFUND", refundMethod: "MOBILE_MONEY", ...(refund.createdBy ? { actor: refund.createdBy } : {}), now });
      await getTenantScopedClient(prisma, refund.businessId).paymentAllocation.updateMany({ where: { attemptId: attempt.id, state: "HELD" }, data: { state: "REFUNDED" } });
    } else if (refund.storeOrderId) {
      await issueStoreRefund(prisma, { businessId: refund.businessId, orderId: refund.storeOrderId, amountMinor: refund.amountMinor, method: "MOBILE_MONEY", ...(refund.createdBy ? { actor: refund.createdBy } : {}), now });
    }
  } catch (error) {
    // The provider has already sent the money. A person must reconcile the books; this must never be silent.
    await raiseProviderException(prisma, {
      type: "REFUND_FAILED", fingerprint: `refund-booking:${refund.id}`, businessId: attempt.businessId, provider: attempt.provider, attemptId: attempt.id, intentId: attempt.intentId, amountMinor: refund.amountMinor, currencyCode: attempt.currencyCode,
      details: { refundId: refund.id, stage: "BOOKKEEPING", why: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** A refund event from the provider (a callback). Replays and out-of-order deliveries change nothing. */
export async function applyRefundOutcome(
  prisma: PrismaClient, registry: AdapterRegistry,
  input: { provider: string; paymentExternalRef: string; refundExternalRef: string; status: "SUCCEEDED" | "FAILED"; amountMinor: bigint; failureReason?: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const attempt = await prisma.paymentAttempt.findFirst({ where: { provider: input.provider, externalRef: input.paymentExternalRef } });
  const refund = attempt ? await prisma.providerRefund.findFirst({ where: { attemptId: attempt.id, externalRef: input.refundExternalRef } }) : null;
  if (!attempt || !refund) {
    await raiseProviderException(prisma, { type: "UNKNOWN_REFERENCE", fingerprint: `refund-unknown:${input.provider}:${input.refundExternalRef}`, provider: input.provider, amountMinor: input.amountMinor, details: { paymentExternalRef: input.paymentExternalRef, refundExternalRef: input.refundExternalRef } });
    return;
  }
  if (input.amountMinor !== refund.amountMinor) {
    await raiseProviderException(prisma, { type: "AMOUNT_MISMATCH", fingerprint: `refund-amount:${refund.id}:${input.status}`, businessId: attempt.businessId, provider: input.provider, attemptId: attempt.id, amountMinor: input.amountMinor, details: { expectedMinor: refund.amountMinor.toString(), refundId: refund.id } });
    return;
  }
  void registry;
  await applyRefundResult(prisma, attempt, refund, { externalRef: input.refundExternalRef, status: input.status, ...(input.failureReason ? { failureReason: input.failureReason } : {}) }, now);
}

/** The sweep for refunds whose outcome we have not heard: ask the provider again (same key) or look the refund up. */
export async function pollRefunds(prisma: PrismaClient, registry: AdapterRegistry, now: Date, limit = 25): Promise<number> {
  const open = await prisma.providerRefund.findMany({ where: { status: { in: ["REQUESTED", "PENDING"] }, updatedAt: { lte: new Date(now.getTime() - 30_000) } }, take: limit, orderBy: { createdAt: "asc" }, include: { attempt: true } });
  let handled = 0;
  for (const r of open) {
    const adapter = registry.get(r.attempt.provider);
    if (!adapter) continue;
    try {
      if (r.externalRef && adapter.capabilities.has("getRefundStatus")) {
        await applyRefundResult(prisma, r.attempt, r, await adapter.getRefundStatus({ externalRef: r.externalRef, paymentExternalRef: r.attempt.externalRef! }), now);
      } else {
        await sendRefund(prisma, adapter, r.attempt, r, now);
      }
      handled++;
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError || error instanceof ProviderRejectedError)) throw error;
    }
  }
  return handled;
}

/**
 * Admin or seller retries a FAILED refund. It is a NEW refund with its own key (the failed one stays in the history, unresolved until
 * a person closes its exception), sent to the same provider that collected the money and never to a different one.
 */
export async function retryFailedRefund(prisma: PrismaClient, registry: AdapterRegistry, input: { refundId: string; actor?: string; now?: Date }): Promise<{ refund: ProviderRefund; replayed: boolean }> {
  const failed = await prisma.providerRefund.findUnique({ where: { id: input.refundId } });
  if (!failed || failed.status !== "FAILED") throw new PaymentsError("WRONG_STATE", "Only a failed refund can be retried.");
  const tries = await prisma.providerRefund.count({ where: { idempotencyKey: { startsWith: `retry:${failed.id}:` } } });
  return refundThroughProvider(prisma, registry, {
    businessId: failed.businessId, attemptId: failed.attemptId, amountMinor: failed.amountMinor, reason: `Retry: ${failed.reason}`.slice(0, 300), idempotencyKey: `retry:${failed.id}:${tries + 1}`,
    ...(failed.storeRefundRequestId ? { storeRefundRequestId: failed.storeRefundRequestId } : {}), ...(failed.storeOrderId ? { storeOrderId: failed.storeOrderId } : {}),
    ...(failed.storeExceptionId ? { storeExceptionId: failed.storeExceptionId } : {}), ...(input.actor ?? failed.createdBy ? { actor: (input.actor ?? failed.createdBy)! } : {}), ...(input.now ? { now: input.now } : {}),
  });
}
