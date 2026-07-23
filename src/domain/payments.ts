import crypto from "node:crypto";
import type { PrismaClient, Subscription } from "@prisma/client";
import { recordAuditLog } from "./auditLog.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { formatMoney } from "./money.js";
import { sendWithRetry } from "./outboundSendRetry.js";
import {
  sendWhatsAppTemplateMessage,
  sendWhatsAppTextMessage,
  type OutboundGatewayDeps,
} from "../whatsapp/outboundGateway.js";
import {
  createFlutterwavePaymentLink,
  verifyFlutterwaveTransaction,
  type FlutterwaveDeps,
} from "../flutterwave/client.js";

/**
 * Phase 22: closes the gap billing.ts's Phase 4 doc comment explicitly left
 * open — "charging a merchant or picking a payment gateway needs human input
 * first". Flutterwave hosted checkout was chosen for the reasons recorded in
 * PHASE_0_FINDINGS.md's Phase 22 section (local-currency settlement across
 * NG/KE/GH/SL, PCI scope kept off TradePal entirely, `PaymentProvider.code`
 * already anticipating FLUTTERWAVE as a value).
 *
 * Off by default (Non-Negotiable Standard #7) like every other new/risky
 * behavior — this one more than most, since it's the first feature in the
 * codebase that moves real money.
 *
 * Phase-one design, both simplifications disclosed rather than hidden:
 *   - A fixed 30-day period is granted for every plan on successful payment.
 *     `Plan` has no interval/billing-cycle field of its own yet; a true
 *     per-plan cycle is future work, not something this phase invents a
 *     schema field for pre-emptively.
 *   - This is a payment-*link* model, not recurring billing: nothing here
 *     auto-charges a merchant when a period ends. subscriptionExpiry.ts's
 *     existing hourly sweep still lapses an unrenewed subscription to
 *     PAST_DUE exactly as it does today; the merchant has to run /upgrade
 *     again and complete a new checkout to renew.
 */
export const PAYMENT_COLLECTION_FEATURE_FLAG_KEY = "paymentCollection";

const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * actorId convention for AuditLog rows written from the webhook path, mirroring
 * subscriptionExpiry.ts's SUBSCRIPTION_EXPIRY_JOB_NAME (a "job name", not a real
 * Merchant/AdminUser). Exported (Phase 24) so paymentRequests.ts's own webhook-triggered
 * confirmation path uses the same actor identity instead of a duplicate literal.
 */
export const FLUTTERWAVE_WEBHOOK_ACTOR_ID = "flutterwave-webhook";

export class PlanNotFoundError extends Error {}
export class MerchantNotFoundError extends Error {}
export class InvoiceNotFoundError extends Error {}

/**
 * Optional outbound-send configuration for the payment-confirmation
 * notification, following the exact template/text-fallback shape as every
 * other proactive send in this codebase (subscriptionExpiry.ts,
 * businessDigest.ts, deletion.ts, merchantIdentity.ts). The template is
 * assumed to have exactly one body placeholder ({{1}}), filled with the
 * plan's code, mirroring subscriptionExpiry.ts's own lapse-notification
 * template shape.
 */
export type PaymentsOutboundGateway = Omit<OutboundGatewayDeps, "prisma"> & {
  paymentConfirmedTemplate?: { name: string; languageCode: string };
};

export interface InitiateSubscriptionCheckoutInput {
  businessId: string;
  planCode: string;
  initiatedByMerchantId: string;
  redirectUrl: string;
}

export interface InitiateSubscriptionCheckoutResult {
  checkoutUrl: string;
  invoiceId: string;
  subscriptionId: string;
}

/**
 * Creates a PENDING Subscription + PENDING Invoice pair and requests a
 * Flutterwave-hosted checkout link for it. The Subscription is not entitled
 * to anything while PENDING (billing.ts's getEffectivePlan only ever
 * considers status "ACTIVE") — it only becomes ACTIVE once
 * confirmSubscriptionPayment verifies the resulting payment.
 *
 * `currentPeriodStart`/`currentPeriodEnd` are both set to `now` here as a
 * placeholder: neither field means anything until payment is confirmed
 * (which overwrites both with the real, payment-confirmed period), and
 * Prisma's schema requires non-null values on create.
 *
 * Flutterwave's Standard Checkout requires `customer.email`, which neither
 * Business nor Merchant has anywhere in this schema. This uses a synthetic
 * placeholder (`<phone>@invoice.tradepal.africa`) built from the initiating
 * merchant's own WhatsApp number — a disclosed, real gap: it's never shown
 * to the merchant and never validated as deliverable, but it satisfies
 * Flutterwave's API contract without this phase inventing an email
 * field/collection flow it has no other need for.
 */
export async function initiateSubscriptionCheckout(
  prisma: PrismaClient,
  input: InitiateSubscriptionCheckoutInput,
  flutterwave: FlutterwaveDeps,
): Promise<InitiateSubscriptionCheckoutResult> {
  const scoped = getTenantScopedClient(prisma, input.businessId);

  const plan = await prisma.plan.findUnique({ where: { code: input.planCode } });
  if (!plan) throw new PlanNotFoundError(`Plan '${input.planCode}' does not exist.`);

  const merchant = await scoped.merchant.findUnique({ where: { id: input.initiatedByMerchantId } });
  if (!merchant) throw new MerchantNotFoundError(`Merchant '${input.initiatedByMerchantId}' not found.`);

  const currency = await prisma.currency.findUniqueOrThrow({ where: { code: plan.currencyCode } });
  const txRef = `tp_${crypto.randomUUID()}`;
  const now = new Date();

  const subscription = await scoped.subscription.create({
    data: {
      businessId: input.businessId,
      planCode: plan.code,
      status: "PENDING",
      currentPeriodStart: now,
      currentPeriodEnd: now,
    },
  });

  // Invoice has no businessId column (it hangs off Subscription instead), so
  // it isn't in tenantScope.ts's TENANT_SCOPED_MODELS and is written via the
  // raw client, same as Plan/PaymentProvider elsewhere in this codebase.
  const invoice = await prisma.invoice.create({
    data: {
      subscriptionId: subscription.id,
      amountMinor: plan.priceMinor,
      currencyCode: plan.currencyCode,
      status: "PENDING",
      dueDate: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
      providerCode: "FLUTTERWAVE",
      providerReference: txRef,
    },
  });

  const { checkoutUrl } = await createFlutterwavePaymentLink(flutterwave, {
    txRef,
    amount: formatMoney(plan.priceMinor, currency.minorUnitExp),
    currency: plan.currencyCode,
    customerEmail: `${merchant.phoneNumber}@invoice.tradepal.africa`,
    customerPhoneNumber: merchant.phoneNumber,
    redirectUrl: input.redirectUrl,
    title: `TradePal ${plan.name} plan`,
  });

  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "MERCHANT",
    actorId: input.initiatedByMerchantId,
    action: "SUBSCRIPTION_CHECKOUT_INITIATED",
    entityType: "Invoice",
    entityId: invoice.id,
    metadata: { planCode: plan.code, amountMinor: plan.priceMinor.toString(), currencyCode: plan.currencyCode, txRef },
  });

  return { checkoutUrl, invoiceId: invoice.id, subscriptionId: subscription.id };
}

export type ConfirmSubscriptionPaymentOutcome = "activated" | "already_processed" | "verification_failed";

export interface ConfirmSubscriptionPaymentInput {
  txRef: string;
  flutterwaveTransactionId: string;
}

export interface ConfirmSubscriptionPaymentResult {
  outcome: ConfirmSubscriptionPaymentOutcome;
  subscription?: Subscription;
}

export class PaymentNotificationSendFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
  }
}

function sendPaymentConfirmedWithRetry(sendFn: () => Promise<void>): Promise<number> {
  return sendWithRetry(sendFn, (message, attempts) => new PaymentNotificationSendFailedError(message, attempts));
}

function buildPaymentConfirmedMessage(planCode: string, periodEnd: Date): string {
  return (
    `Payment received — your TradePal subscription (plan: ${planCode}) is now active until ` +
    `${periodEnd.toISOString().slice(0, 10)}. Thank you!`
  );
}

/**
 * Called from the Flutterwave webhook route after its shared-secret header
 * has already been checked (flutterwave/signature.ts). That header only
 * proves the caller knows the shared secret, not that the payload wasn't
 * tampered with (see flutterwave/client.ts's doc comment) — so this always
 * re-verifies the transaction server-to-server via Flutterwave's Verify
 * Transaction API before trusting its status, amount, or currency.
 *
 * Idempotent by construction: `Invoice.providerReference` is @unique, and an
 * Invoice already in status "PAID" short-circuits to "already_processed"
 * without re-verifying or re-extending the period — a Flutterwave webhook
 * retry (or a malicious replay) for a tx_ref already processed is a safe
 * no-op rather than a double-extended subscription period.
 *
 * Throws InvoiceNotFoundError for an unrecognized tx_ref (the webhook route
 * catches and logs this, same as webhookRoute.ts does for WhatsApp) — this
 * function otherwise never throws for an ordinary "payment didn't verify"
 * outcome, which is reported via the returned outcome instead.
 */
export async function confirmSubscriptionPayment(
  prisma: PrismaClient,
  input: ConfirmSubscriptionPaymentInput,
  flutterwave: FlutterwaveDeps,
  outboundGateway?: PaymentsOutboundGateway,
): Promise<ConfirmSubscriptionPaymentResult> {
  const invoice = await prisma.invoice.findUnique({
    where: { providerReference: input.txRef },
    include: { subscription: true },
  });
  if (!invoice) throw new InvoiceNotFoundError(`No invoice found for Flutterwave tx_ref '${input.txRef}'.`);

  if (invoice.status === "PAID") {
    return { outcome: "already_processed" };
  }

  const scoped = getTenantScopedClient(prisma, invoice.subscription.businessId);
  const verified = await verifyFlutterwaveTransaction(flutterwave, input.flutterwaveTransactionId);

  const currency = await prisma.currency.findUniqueOrThrow({ where: { code: invoice.currencyCode } });
  const expectedAmount = Number(formatMoney(invoice.amountMinor, currency.minorUnitExp));
  const verifiedOk =
    verified.status === "successful" &&
    verified.txRef === input.txRef &&
    verified.currency === invoice.currencyCode &&
    verified.amount === expectedAmount;

  if (!verifiedOk) {
    await recordAuditLog(scoped, {
      businessId: invoice.subscription.businessId,
      actorType: "SYSTEM",
      actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
      action: "SUBSCRIPTION_PAYMENT_VERIFICATION_FAILED",
      entityType: "Invoice",
      entityId: invoice.id,
      metadata: {
        txRef: input.txRef,
        verifiedStatus: verified.status,
        verifiedAmount: verified.amount,
        verifiedCurrency: verified.currency,
      },
    });
    return { outcome: "verification_failed" };
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + BILLING_PERIOD_MS);

  await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: now } });

  const subscription = await scoped.subscription.update({
    where: { id: invoice.subscriptionId },
    data: { status: "ACTIVE", currentPeriodStart: now, currentPeriodEnd: periodEnd },
  });

  await recordAuditLog(scoped, {
    businessId: invoice.subscription.businessId,
    actorType: "SYSTEM",
    actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
    action: "SUBSCRIPTION_PAYMENT_CONFIRMED",
    entityType: "Subscription",
    entityId: subscription.id,
    metadata: {
      invoiceId: invoice.id,
      txRef: input.txRef,
      planCode: subscription.planCode,
      currentPeriodEnd: periodEnd.toISOString(),
    },
  });

  if (outboundGateway) {
    const merchants = await scoped.merchant.findMany({
      where: { businessId: invoice.subscription.businessId, removedAt: null },
    });
    const gatewayDeps = { prisma, ...outboundGateway };
    const template = outboundGateway.paymentConfirmedTemplate;
    const sendMethod = template ? "template" : "text";

    for (const merchant of merchants) {
      try {
        const attempts = await sendPaymentConfirmedWithRetry(() =>
          template
            ? sendWhatsAppTemplateMessage(gatewayDeps, {
                toPhoneNumber: merchant.phoneNumber,
                templateName: template.name,
                templateLanguageCode: template.languageCode,
                bodyParams: [subscription.planCode],
              })
            : sendWhatsAppTextMessage(gatewayDeps, {
                toPhoneNumber: merchant.phoneNumber,
                body: buildPaymentConfirmedMessage(subscription.planCode, periodEnd),
              }),
        );
        await recordAuditLog(scoped, {
          businessId: invoice.subscription.businessId,
          actorType: "SYSTEM",
          actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
          action: "SUBSCRIPTION_PAYMENT_NOTIFICATION_SENT",
          entityType: "Merchant",
          entityId: merchant.id,
          metadata: { subscriptionId: subscription.id, sendMethod, attempts },
        });
      } catch (error) {
        const attempts = error instanceof PaymentNotificationSendFailedError ? error.attempts : 1;
        await recordAuditLog(scoped, {
          businessId: invoice.subscription.businessId,
          actorType: "SYSTEM",
          actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
          action: "SUBSCRIPTION_PAYMENT_NOTIFICATION_FAILED",
          entityType: "Merchant",
          entityId: merchant.id,
          metadata: { subscriptionId: subscription.id, sendMethod, attempts, error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }

  return { outcome: "activated", subscription };
}
