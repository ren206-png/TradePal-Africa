import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import type { PawaPayDeps, PawaPayDepositCallback } from "./client.js";
import { checkDepositStatus } from "./client.js";

export const PAWAPAY_WEBHOOK_ACTOR_ID = "pawapay-webhook";

export interface PawaPayWebhookHandlerDeps {
  prisma: PrismaClient;
  pawapay: PawaPayDeps;
}

/**
 * Handles inbound deposit-status callbacks from PawaPay.
 *
 * PawaPay POSTs a PawaPayDepositCallback to your configured callback URL
 * whenever a deposit reaches a terminal status (COMPLETED or FAILED), and
 * optionally during intermediate states (PROCESSING, ACCEPTED).
 *
 * Always responds 200 once the payload is validated — PawaPay retries on
 * non-200 responses, so errors are logged rather than surfaced as 5xx.
 *
 * For COMPLETED callbacks: re-verifies status via checkDepositStatus
 * before crediting funds (don't trust callback payload alone — same
 * server-to-server verification pattern as flutterwave/webhookRoute.ts).
 *
 * WIRING NOTE: This handler logs verified terminal statuses. To complete
 * the payment flow, look up the PaymentRequest (or Invoice) associated
 * with depositId and update its status — a PawaPayDeposit tracking table
 * is needed in Prisma to link depositIds to PaymentRequests. Add the
 * migration, then replace the TODO comment below with the domain call
 * (analogous to confirmPaymentRequestPayment in domain/paymentRequests.ts).
 */
export function createPawaPayWebhookPostHandler(deps: PawaPayWebhookHandlerDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const payload = req.body as Partial<PawaPayDepositCallback>;

    if (!payload.depositId || !payload.status) {
      res.sendStatus(400);
      return;
    }

    const { depositId, status } = payload;

    if (status === "COMPLETED" || status === "FAILED") {
      try {
        // Re-verify server-to-server before acting on terminal status.
        // Only trust not-found as a definitive "payment never happened" signal.
        const verified = await checkDepositStatus(deps.pawapay, depositId);

        if (!verified.found) {
          console.warn(`pawapay webhook: depositId ${depositId} not found in PawaPay — ignoring`);
          res.sendStatus(200);
          return;
        }

        const verifiedStatus = verified.data!.status;
        const logContext = {
          depositId,
          verifiedStatus,
          providerTransactionId: verified.data?.providerTransactionId,
          amount: verified.data?.amount,
          currency: verified.data?.currency,
          failureCode: verified.data?.failureReason?.failureCode,
        };

        if (verifiedStatus === "COMPLETED") {
          console.log("pawapay webhook: deposit COMPLETED", logContext);

          // TODO: look up the PaymentRequest linked to this depositId via a
          // PawaPayDeposit table (depositId → paymentRequestId), then call the
          // domain function that marks the PaymentRequest PAID and sends the
          // merchant a WhatsApp notification. Pattern: domain/paymentRequests.ts
          // confirmPaymentRequestPayment + outboundGateway notification.
          //
          // Migration needed:
          //   model PawaPayDeposit {
          //     id               String   @id // UUIDv4 == depositId
          //     paymentRequestId String   @unique
          //     status           String   // mirrors DepositStatus
          //     amountMinor      BigInt
          //     currencyCode     String
          //     provider         String
          //     phoneNumber      String
          //     providerTxId     String?
          //     createdAt        DateTime @default(now()) @db.Timestamptz()
          //     updatedAt        DateTime @updatedAt @db.Timestamptz()
          //     paymentRequest   PaymentRequest @relation(...)
          //   }

        } else if (verifiedStatus === "FAILED") {
          console.log("pawapay webhook: deposit FAILED", logContext);

          // TODO: mark the linked PaymentRequest FAILED and optionally notify
          // the merchant so they know to follow up with the customer.
        } else {
          // Callback claimed terminal but re-verification says otherwise —
          // log and leave for reconciliation to resolve.
          console.warn("pawapay webhook: callback status mismatch", {
            callbackStatus: status,
            ...logContext,
          });
        }
      } catch (error) {
        console.error(`pawapay webhook: error processing depositId ${depositId}`, error);
        // Still 200 — let PawaPay retry will compound the error.
      }
    } else {
      // ACCEPTED, PROCESSING — in-flight, nothing to act on yet
      console.log(`pawapay webhook: deposit ${depositId} status=${status} (in-flight)`);
    }

    res.sendStatus(200);
  };
}
