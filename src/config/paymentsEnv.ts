import type { FlutterwaveDeps } from "../flutterwave/client.js";
import type { PaymentsOutboundGateway } from "../domain/payments.js";
import type { PaymentRequestOutboundGateway } from "../domain/paymentRequests.js";

/**
 * FLUTTERWAVE_SECRET_KEY is read by both src/worker.ts (creating a checkout
 * link for /upgrade) and src/server.ts (verifying a transaction when the
 * webhook fires) — the same secret key authorizes both calls, so there's
 * only one credential to configure, mirroring how WHATSAPP_ACCESS_TOKEN is
 * shared across every WhatsApp-sending process in this codebase. Optional,
 * not requireEnv: a deployment that hasn't set up Flutterwave yet should
 * still boot both processes with /upgrade (and the webhook route) simply
 * unavailable, not fail to start over an off-by-default feature.
 */
export function buildFlutterwaveDepsFromEnv(): FlutterwaveDeps | undefined {
  const secretKey = process.env["FLUTTERWAVE_SECRET_KEY"];
  if (!secretKey) return undefined;
  return { secretKey };
}

/**
 * Where Flutterwave's hosted checkout page redirects the merchant's browser
 * after they finish paying. /upgrade is initiated over WhatsApp, so this
 * page is never itself part of the bot conversation — the actual
 * subscription activation happens via the webhook (src/domain/payments.ts's
 * confirmSubscriptionPayment), independent of whether the merchant ever
 * lands on this page at all. Required alongside FLUTTERWAVE_SECRET_KEY for
 * /upgrade to work, since Flutterwave's payment-link API itself requires a
 * redirect_url.
 */
export function getFlutterwaveCheckoutRedirectUrl(): string | undefined {
  return process.env["FLUTTERWAVE_CHECKOUT_REDIRECT_URL"];
}

/**
 * Same WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID as every other
 * outbound-send builder in config/outboundGatewayEnv.ts, for the Phase 22
 * payment-confirmation notification instead of lapse/digest/deletion/staff-
 * added. WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_NAME/_LANGUAGE mirror those
 * modules' own both-or-neither-set template opt-in exactly — a successful
 * payment is itself a business-initiated event that can arrive well outside
 * the merchant's 24-hour WhatsApp service window (the merchant may complete
 * checkout on Flutterwave's page minutes or hours after last messaging the
 * bot), so this needs the same template fallback path as the other three
 * proactive sends. Kept in this file (not outboundGatewayEnv.ts) since it's
 * payments-specific and only ever read alongside the two builders above.
 */
export function buildPaymentsOutboundGatewayFromEnv(): PaymentsOutboundGateway | undefined {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!accessToken || !phoneNumberId) return undefined;

  const templateName = process.env["WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_NAME"];
  const templateLanguageCode = process.env["WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_LANGUAGE"];
  const paymentConfirmedTemplate =
    templateName && templateLanguageCode ? { name: templateName, languageCode: templateLanguageCode } : undefined;

  return {
    accessToken,
    phoneNumberId,
    ...(paymentConfirmedTemplate ? { paymentConfirmedTemplate } : {}),
  };
}

/**
 * Phase 24 counterpart to buildPaymentsOutboundGatewayFromEnv, above, for
 * notifying a merchant that their *customer's* /paylink payment landed
 * (confirmPaymentRequestPayment), using its own template env vars since it's
 * a different message/template than the subscription-payment-confirmed one.
 */
export function buildPaymentRequestOutboundGatewayFromEnv(): PaymentRequestOutboundGateway | undefined {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!accessToken || !phoneNumberId) return undefined;

  const templateName = process.env["WHATSAPP_PAYMENT_RECEIVED_TEMPLATE_NAME"];
  const templateLanguageCode = process.env["WHATSAPP_PAYMENT_RECEIVED_TEMPLATE_LANGUAGE"];
  const paymentReceivedTemplate =
    templateName && templateLanguageCode ? { name: templateName, languageCode: templateLanguageCode } : undefined;

  return {
    accessToken,
    phoneNumberId,
    ...(paymentReceivedTemplate ? { paymentReceivedTemplate } : {}),
  };
}
