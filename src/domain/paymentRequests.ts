import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { recordAuditLog } from "./auditLog.js";
import { recordTransaction } from "./ledger.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { formatMoney } from "./money.js";
import { sendWithRetry } from "./outboundSendRetry.js";
import { sendWhatsAppTemplateMessage, sendWhatsAppTextMessage, type OutboundGatewayDeps } from "../whatsapp/outboundGateway.js";
import { createFlutterwavePaymentLink, verifyFlutterwaveTransaction, type FlutterwaveDeps } from "../flutterwave/client.js";
import { FLUTTERWAVE_WEBHOOK_ACTOR_ID, MerchantNotFoundError } from "./payments.js";

/**
 * Phase 24: lets a merchant collect payment from their own customer via
 * Flutterwave (`/paylink`), as opposed to payments.ts which collects a
 * merchant's own TradePal subscription payment. Deliberately structured as a
 * near-mirror of payments.ts's initiateSubscriptionCheckout/
 * confirmSubscriptionPayment pair — same idempotency, re-verification, and
 * audit-log shape — rather than a shared abstraction, since the two flows
 * write to different tables (PaymentRequest vs Invoice/Subscription) with
 * different post-confirmation side effects (recordTransaction vs
 * activating a Subscription).
 *
 * Standard #9: TradePal never stores or resolves a customer's WhatsApp
 * number and never messages a customer directly. The checkout link is
 * returned as plain text for the merchant to forward themselves (mirroring
 * `/remind`) — nothing here ever attempts to send it anywhere.
 */
const PAYMENT_REQUEST_TX_REF_PREFIX = "tpr_";

export class PaymentRequestNotFoundError extends Error {}

export type PaymentRequestOutboundGateway = Omit<OutboundGatewayDeps, "prisma"> & {
  paymentReceivedTemplate?: { name: string; languageCode: string };
};

export interface InitiatePaymentRequestInput {
  businessId: string;
  customerId?: string;
  description: string;
  amountMinor: bigint;
  currencyCode: string;
  initiatedByMerchantId: string;
  redirectUrl: string;
}

export interface InitiatePaymentRequestResult {
  checkoutUrl: string;
  paymentRequestId: string;
}

/**
 * Creates a PENDING PaymentRequest and requests a Flutterwave-hosted
 * checkout link for it. Flutterwave's Standard Checkout requires
 * `customer.email`/`customer.phonenumber`, which the actual customer never
 * supplies (Standard #9) — like initiateSubscriptionCheckout, this uses a
 * synthetic placeholder built from the *merchant's* own WhatsApp number,
 * since the merchant is who's initiating and forwarding the link, not the
 * customer who eventually opens it.
 */
export async function initiatePaymentRequest(
  prisma: PrismaClient,
  input: InitiatePaymentRequestInput,
  flutterwave: FlutterwaveDeps,
): Promise<InitiatePaymentRequestResult> {
  const scoped = getTenantScopedClient(prisma, input.businessId);

  const merchant = await scoped.merchant.findUnique({ where: { id: input.initiatedByMerchantId } });
  if (!merchant) throw new MerchantNotFoundError(`Merchant '${input.initiatedByMerchantId}' not found.`);

  const currency = await prisma.currency.findUniqueOrThrow({ where: { code: input.currencyCode } });
  const txRef = `${PAYMENT_REQUEST_TX_REF_PREFIX}${crypto.randomUUID()}`;

  const paymentRequest = await scoped.paymentRequest.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId ?? null,
      description: input.description,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      status: "PENDING",
      providerCode: "FLUTTERWAVE",
      providerReference: txRef,
    },
  });

  const { checkoutUrl } = await createFlutterwavePaymentLink(flutterwave, {
    txRef,
    amount: formatMoney(input.amountMinor, currency.minorUnitExp),
    currency: input.currencyCode,
    customerEmail: `${merchant.phoneNumber}@invoice.tradepal.africa`,
    customerPhoneNumber: merchant.phoneNumber,
    redirectUrl: input.redirectUrl,
    title: input.description,
  });

  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "MERCHANT",
    actorId: input.initiatedByMerchantId,
    action: "PAYMENT_REQUEST_INITIATED",
    entityType: "PaymentRequest",
    entityId: paymentRequest.id,
    metadata: { amountMinor: input.amountMinor.toString(), currencyCode: input.currencyCode, txRef },
  });

  return { checkoutUrl, paymentRequestId: paymentRequest.id };
}

export type ConfirmPaymentRequestPaymentOutcome = "recorded" | "already_processed" | "verification_failed";

export interface ConfirmPaymentRequestPaymentInput {
  txRef: string;
  flutterwaveTransactionId: string;
}

export interface ConfirmPaymentRequestPaymentResult {
  outcome: ConfirmPaymentRequestPaymentOutcome;
  transactionId?: string;
}

export class PaymentRequestNotificationSendFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
  }
}

function sendPaymentRequestConfirmedWithRetry(sendFn: () => Promise<void>): Promise<number> {
  return sendWithRetry(sendFn, (message, attempts) => new PaymentRequestNotificationSendFailedError(message, attempts));
}

function buildPaymentReceivedMessage(description: string, amountMinor: bigint, minorUnitExp: number): string {
  return `Payment received: ${formatMoney(amountMinor, minorUnitExp)} for "${description}". It's been logged to your ledger.`;
}

/**
 * Called from the Flutterwave webhook route, after confirmSubscriptionPayment
 * has already been tried and thrown InvoiceNotFoundError for this tx_ref —
 * see webhookRoute.ts. Same re-verification and idempotency shape as
 * confirmSubscriptionPayment: never trusts the webhook payload directly,
 * short-circuits to "already_processed" for a PaymentRequest already PAID.
 *
 * On success, records the sale itself via recordTransaction (type
 * PAYMENT_RECEIVED) — this is the customer's payment actually landing in the
 * merchant's ledger, not just a billing-side status flip.
 *
 * Throws PaymentRequestNotFoundError for an unrecognized tx_ref (the webhook
 * route swallows this the same way it already swallows InvoiceNotFoundError).
 */
export async function confirmPaymentRequestPayment(
  prisma: PrismaClient,
  input: ConfirmPaymentRequestPaymentInput,
  flutterwave: FlutterwaveDeps,
  outboundGateway?: PaymentRequestOutboundGateway,
): Promise<ConfirmPaymentRequestPaymentResult> {
  const paymentRequest = await prisma.paymentRequest.findUnique({ where: { providerReference: input.txRef } });
  if (!paymentRequest) {
    throw new PaymentRequestNotFoundError(`No payment request found for Flutterwave tx_ref '${input.txRef}'.`);
  }

  if (paymentRequest.status === "PAID") {
    return paymentRequest.transactionId
      ? { outcome: "already_processed", transactionId: paymentRequest.transactionId }
      : { outcome: "already_processed" };
  }

  const scoped = getTenantScopedClient(prisma, paymentRequest.businessId);
  const verified = await verifyFlutterwaveTransaction(flutterwave, input.flutterwaveTransactionId);

  const currency = await prisma.currency.findUniqueOrThrow({ where: { code: paymentRequest.currencyCode } });
  const expectedAmount = Number(formatMoney(paymentRequest.amountMinor, currency.minorUnitExp));
  const verifiedOk =
    verified.status === "successful" &&
    verified.txRef === input.txRef &&
    verified.currency === paymentRequest.currencyCode &&
    verified.amount === expectedAmount;

  if (!verifiedOk) {
    await recordAuditLog(scoped, {
      businessId: paymentRequest.businessId,
      actorType: "SYSTEM",
      actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
      action: "PAYMENT_REQUEST_VERIFICATION_FAILED",
      entityType: "PaymentRequest",
      entityId: paymentRequest.id,
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

  const transaction = await recordTransaction(scoped, {
    businessId: paymentRequest.businessId,
    type: "PAYMENT_RECEIVED",
    amountMinor: paymentRequest.amountMinor,
    currencyCode: paymentRequest.currencyCode,
    paymentStatus: "PAID",
    description: paymentRequest.description,
    ...(paymentRequest.customerId ? { customerId: paymentRequest.customerId } : {}),
  });

  await prisma.paymentRequest.update({
    where: { id: paymentRequest.id },
    data: { status: "PAID", paidAt: now, transactionId: transaction.id },
  });

  await recordAuditLog(scoped, {
    businessId: paymentRequest.businessId,
    actorType: "SYSTEM",
    actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
    action: "PAYMENT_REQUEST_CONFIRMED",
    entityType: "PaymentRequest",
    entityId: paymentRequest.id,
    metadata: { txRef: input.txRef, transactionId: transaction.id },
  });

  if (outboundGateway) {
    const merchants = await scoped.merchant.findMany({
      where: { businessId: paymentRequest.businessId, removedAt: null },
    });
    const gatewayDeps = { prisma, ...outboundGateway };
    const template = outboundGateway.paymentReceivedTemplate;
    const sendMethod = template ? "template" : "text";

    for (const merchant of merchants) {
      try {
        const attempts = await sendPaymentRequestConfirmedWithRetry(() =>
          template
            ? sendWhatsAppTemplateMessage(gatewayDeps, {
                toPhoneNumber: merchant.phoneNumber,
                templateName: template.name,
                templateLanguageCode: template.languageCode,
                bodyParams: [paymentRequest.description],
              })
            : sendWhatsAppTextMessage(gatewayDeps, {
                toPhoneNumber: merchant.phoneNumber,
                body: buildPaymentReceivedMessage(paymentRequest.description, paymentRequest.amountMinor, currency.minorUnitExp),
              }),
        );
        await recordAuditLog(scoped, {
          businessId: paymentRequest.businessId,
          actorType: "SYSTEM",
          actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
          action: "PAYMENT_REQUEST_NOTIFICATION_SENT",
          entityType: "Merchant",
          entityId: merchant.id,
          metadata: { paymentRequestId: paymentRequest.id, sendMethod, attempts },
        });
      } catch (error) {
        const attempts = error instanceof PaymentRequestNotificationSendFailedError ? error.attempts : 1;
        await recordAuditLog(scoped, {
          businessId: paymentRequest.businessId,
          actorType: "SYSTEM",
          actorId: FLUTTERWAVE_WEBHOOK_ACTOR_ID,
          action: "PAYMENT_REQUEST_NOTIFICATION_FAILED",
          entityType: "Merchant",
          entityId: merchant.id,
          metadata: {
            paymentRequestId: paymentRequest.id,
            sendMethod,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  return { outcome: "recorded", transactionId: transaction.id };
}
