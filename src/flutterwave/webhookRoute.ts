import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { isValidFlutterwaveWebhookSignature } from "./signature.js";
import type { FlutterwaveDeps } from "./client.js";
import { confirmSubscriptionPayment, InvoiceNotFoundError, type PaymentsOutboundGateway } from "../domain/payments.js";
import {
  confirmPaymentRequestPayment,
  PaymentRequestNotFoundError,
  type PaymentRequestOutboundGateway,
} from "../domain/paymentRequests.js";

export interface FlutterwaveWebhookHandlerDeps {
  prisma: PrismaClient;
  flutterwave: FlutterwaveDeps;
  outboundGateway?: PaymentsOutboundGateway;
  /** Phase 24: separate from `outboundGateway` since the two flows notify different recipients about different things (merchant paid TradePal vs merchant's customer paid the merchant). */
  paymentRequestOutboundGateway?: PaymentRequestOutboundGateway;
}

interface FlutterwaveWebhookPayload {
  event?: string;
  data?: { id?: number | string; tx_ref?: string };
}

/**
 * Unlike whatsapp/webhookRoute.ts, this needs no raw-body capture: the
 * `verif-hash` header is a static shared secret, not an HMAC over the
 * payload (flutterwave/signature.ts), so express.json()'s already-parsed
 * body is fine to read directly.
 *
 * Always responds 200 once the signature check passes, regardless of what
 * confirmSubscriptionPayment/confirmPaymentRequestPayment do — an
 * unrecognized tx_ref, a failed verification, or any other processing error
 * is caught and logged (or, for an unrecognized tx_ref, silently ignored —
 * see below) rather than turned into a Flutterwave-side retry storm,
 * mirroring whatsapp/webhookRoute.ts's createWebhookPostHandler exactly.
 * Only `charge.completed` events with both a tx_ref and a transaction id
 * attempt confirmation at all; every other event Flutterwave might send this
 * endpoint (this integration doesn't narrow its dashboard event
 * subscription) is a no-op 200.
 *
 * Phase 24: two tx_ref namespaces now share this one endpoint —
 * subscription checkouts ("tp_" prefix, payments.ts) and customer payment
 * requests ("tpr_" prefix, paymentRequests.ts). confirmSubscriptionPayment is
 * tried first; only when it reports the tx_ref unrecognized
 * (InvoiceNotFoundError) does this fall through to
 * confirmPaymentRequestPayment. Since the two prefixes are disjoint, the
 * second lookup only ever meaningfully matches when the first legitimately
 * didn't.
 */
export function createFlutterwaveWebhookPostHandler(deps: FlutterwaveWebhookHandlerDeps, secretHash: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const providedHash = req.headers["verif-hash"];
    if (typeof providedHash !== "string" || !isValidFlutterwaveWebhookSignature(providedHash, secretHash)) {
      res.sendStatus(401);
      return;
    }

    const payload = req.body as FlutterwaveWebhookPayload;
    const txRef = payload.data?.tx_ref;
    const transactionId = payload.data?.id;

    if (payload.event === "charge.completed" && txRef && transactionId !== undefined) {
      try {
        await confirmSubscriptionPayment(
          deps.prisma,
          { txRef, flutterwaveTransactionId: String(transactionId) },
          deps.flutterwave,
          deps.outboundGateway,
        );
      } catch (error) {
        if (error instanceof InvoiceNotFoundError) {
          try {
            await confirmPaymentRequestPayment(
              deps.prisma,
              { txRef, flutterwaveTransactionId: String(transactionId) },
              deps.flutterwave,
              deps.paymentRequestOutboundGateway,
            );
          } catch (innerError) {
            // Same "expected foreign traffic" reasoning as InvoiceNotFoundError above —
            // this endpoint receives webhook traffic for every account/integration
            // sharing the same Flutterwave endpoint config, not just TradePal's own.
            if (!(innerError instanceof PaymentRequestNotFoundError)) {
              console.error("Flutterwave webhook processing failed", innerError);
            }
          }
        } else {
          console.error("Flutterwave webhook processing failed", error);
        }
      }
    }

    res.sendStatus(200);
  };
}
