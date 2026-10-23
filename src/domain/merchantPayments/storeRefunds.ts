import type { PaymentAttempt, PrismaClient, ProviderRefund, StorePayment } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import type { AdapterRegistry } from "../../payments/adapter.js";
import { issueStoreRefund } from "../store/refunds.js";
import { resolvePaymentException } from "../store/payments.js";
import { PaymentsError } from "./common.js";
import { refundThroughProvider } from "./refunds.js";

/**
 * Where a consumer order's refund goes. Money the PROVIDER collected is refunded THROUGH the provider (the books move when the
 * provider confirms); money the seller took themselves (cash, their own mobile-money number) is a recorded manual refund, as before.
 * One decision in one place, so no flow can record a manual refund for money that is actually sitting with a provider.
 */
export async function providerAttemptForOrder(prisma: PrismaClient, businessId: string, orderId: string, minRefundable = 1n): Promise<PaymentAttempt | null> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const allocations = await scoped.paymentAllocation.findMany({ where: { subjectType: "STORE_ORDER", subjectId: orderId, state: "APPLIED" }, include: { attempt: true } });
  return allocations.map((a) => a.attempt).find((a) => a.status === "SUCCEEDED" && a.capturedMinor - a.refundedMinor >= minRefundable) ?? null;
}

export type PayoutResult = { via: "PROVIDER"; refund: ProviderRefund; replayed: boolean } | { via: "MANUAL"; payment: StorePayment };

/** Pays out an approved refund or return request. */
export async function payOutStoreRefund(
  prisma: PrismaClient, registry: AdapterRegistry, input: { businessId: string; orderId: string; requestId: string; manualMethod: "CASH" | "MOBILE_MONEY" | "BANK" | "OTHER"; actor?: string },
): Promise<PayoutResult> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const req = await scoped.storeRefundRequest.findUnique({ where: { id: input.requestId } });
  if (!req || req.orderId !== input.orderId) throw new PaymentsError("NOT_FOUND", "Request not found.");
  const amount = req.approvedAmountMinor;
  const attempt = amount !== null ? await providerAttemptForOrder(prisma, input.businessId, input.orderId, amount) : null;
  if (!attempt || amount === null) {
    const payment = await issueStoreRefund(prisma, { businessId: input.businessId, orderId: input.orderId, requestId: req.id, method: input.manualMethod, ...(input.actor ? { actor: input.actor } : {}) });
    return { via: "MANUAL", payment };
  }
  const { refund, replayed } = await refundThroughProvider(prisma, registry, {
    businessId: input.businessId, attemptId: attempt.id, amountMinor: amount, reason: `Refund request ${req.id}: ${req.reason}`.slice(0, 300), idempotencyKey: `store-request:${req.id}`,
    storeRefundRequestId: req.id, storeOrderId: input.orderId, ...(input.actor ? { actor: input.actor } : {}),
  });
  return { via: "PROVIDER", refund, replayed };
}

/** Refunds a payment that was held as an exception (late, over, under): through the provider if the provider collected it. */
export async function refundHeldPayment(
  prisma: PrismaClient, registry: AdapterRegistry, input: { businessId: string; exceptionId: string; actor?: string },
): Promise<{ via: "PROVIDER"; refund: ProviderRefund } | { via: "MANUAL"; orderReference: string }> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const ex = await scoped.paymentException.findUnique({ where: { id: input.exceptionId } });
  const held = ex?.paymentId ? await scoped.storePayment.findUnique({ where: { id: ex.paymentId } }) : null;
  if (!ex || ex.status !== "OPEN" || !held || held.state !== "HELD") throw new PaymentsError("NOT_REFUNDABLE", "There is no held payment to refund.");
  const attempt = held.provider && held.externalId ? await scoped.paymentAttempt.findFirst({ where: { provider: held.provider, externalRef: held.externalId, status: "SUCCEEDED" } }) : null;
  if (!attempt) {
    const r = await resolvePaymentException(prisma, { businessId: input.businessId, exceptionId: ex.id, action: "REFUND", refundMethod: "MOBILE_MONEY", ...(input.actor ? { actor: input.actor } : {}) });
    return { via: "MANUAL", orderReference: r.order.reference };
  }
  const { refund } = await refundThroughProvider(prisma, registry, {
    businessId: input.businessId, attemptId: attempt.id, amountMinor: held.amountMinor, reason: `Refund of a held ${ex.type.toLowerCase().replace(/_/g, " ")} payment`, idempotencyKey: `held:${ex.id}`, storeExceptionId: ex.id, ...(input.actor ? { actor: input.actor } : {}),
  });
  return { via: "PROVIDER", refund };
}
