import type { PrismaClient } from "@prisma/client";
import { recordAuditLog } from "./auditLog.js";
import { getTenantScopedClient } from "../db/tenantScope.js";

/**
 * Phase 26: closes the gap Phase 24's own findings disclosed — "no
 * auto-expiry sweep exists for a stale PENDING PaymentRequest that a
 * customer never completes." `PaymentRequest.status`'s own doc comment in
 * schema.prisma already anticipated this ("PENDING, PAID, FAILED, EXPIRED")
 * but nothing ever wrote EXPIRED. Directly mirrors subscriptionExpiry.ts's
 * shape (job name constant, raw-PrismaClient scan across every business,
 * per-row scoped update + audit log, idempotent via excluding non-PENDING
 * rows from the query) with one deliberate simplification: no notification
 * path. Unlike a lapsed subscription (the business's own paying account),
 * an expired payment *request* is the merchant's own /paylink attempt going
 * stale — the merchant already knows they sent the link, and Standard #9
 * means the customer who'd actually be waiting on it is never messaged by
 * TradePal at all. If a "notify the merchant their link expired" feature is
 * ever wanted, it should follow the same optional-outboundGateway shape
 * subscriptionExpiry.ts and paymentRequests.ts already established.
 */
export const PAYMENT_REQUEST_EXPIRY_JOB_NAME = "payment-request-expiry-sweep";

/**
 * How stale a PENDING PaymentRequest must be before this sweep considers it
 * abandoned. 24 hours mirrors a typical hosted-checkout-link shelf life
 * (and Flutterwave's own Standard Checkout links are not indefinitely
 * valid) — chosen as a reasonable default, not derived from any
 * Flutterwave-documented expiry, since TradePal never queries Flutterwave
 * for the link's own expiry state.
 */
export const PAYMENT_REQUEST_EXPIRY_HOURS = 24;

export interface ExpireStalePaymentRequestsResult {
  expiredCount: number;
  expiredPaymentRequestIds: string[];
}

/**
 * Finds every PENDING PaymentRequest created at least PAYMENT_REQUEST_EXPIRY_HOURS
 * before `now` and flips it to EXPIRED, with one AuditLog row per request
 * attributing the change to this job (actorType SYSTEM, actorId the job
 * name, same shape as expireLapsedSubscriptions's SUBSCRIPTION_EXPIRED row).
 * Idempotent: only PENDING rows are ever selected, so running this
 * repeatedly (as the periodic worker does) never re-expires or
 * double-audits the same row, and a row that goes on to PAID via
 * confirmPaymentRequestPayment before this sweep ever reaches it is
 * correctly left untouched.
 *
 * Uses the raw PrismaClient for the initial scan (PaymentRequest rows
 * across every business need to be found in one query), then updates/audits
 * each row through getTenantScopedClient for its own business, matching the
 * tenant-isolation convention every other write in this codebase follows.
 */
export async function expireStalePaymentRequests(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ExpireStalePaymentRequestsResult> {
  const cutoff = new Date(now.getTime() - PAYMENT_REQUEST_EXPIRY_HOURS * 60 * 60 * 1000);

  const stale = await prisma.paymentRequest.findMany({
    where: { status: "PENDING", createdAt: { lte: cutoff } },
    orderBy: { createdAt: "asc" },
  });

  const expiredPaymentRequestIds: string[] = [];
  for (const paymentRequest of stale) {
    const scoped = getTenantScopedClient(prisma, paymentRequest.businessId);
    await scoped.paymentRequest.update({
      where: { id: paymentRequest.id },
      data: { status: "EXPIRED" },
    });
    await recordAuditLog(scoped, {
      businessId: paymentRequest.businessId,
      actorType: "SYSTEM",
      actorId: PAYMENT_REQUEST_EXPIRY_JOB_NAME,
      action: "PAYMENT_REQUEST_EXPIRED",
      entityType: "PaymentRequest",
      entityId: paymentRequest.id,
      metadata: {
        createdAt: paymentRequest.createdAt.toISOString(),
        amountMinor: paymentRequest.amountMinor.toString(),
        currencyCode: paymentRequest.currencyCode,
      },
    });
    expiredPaymentRequestIds.push(paymentRequest.id);
  }

  return { expiredCount: expiredPaymentRequestIds.length, expiredPaymentRequestIds };
}
