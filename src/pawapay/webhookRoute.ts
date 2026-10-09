import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import type { PawaPayDeps, PawaPayDepositCallback } from "./client.js";
import type { PaymentRequestOutboundGateway } from "../domain/paymentRequests.js";
import { PawaPayDepositNotFoundError, settlePawaPayDeposit } from "../domain/pawapayCollection.js";

export interface PawaPayWebhookHandlerDeps {
  prisma: PrismaClient;
  pawapay: PawaPayDeps;
  /** Notifies the merchant when a customer's payment lands or fails; omitted when WhatsApp send credentials aren't configured. */
  outboundGateway?: PaymentRequestOutboundGateway;
}

/**
 * Handles PawaPay's deposit callbacks (configured as the callback URL in the PawaPay dashboard).
 *
 * The callback body is never trusted: for a terminal status (COMPLETED/FAILED) this hands the
 * depositId to settlePawaPayDeposit, which re-fetches the deposit from PawaPay's own API and acts
 * on THAT — the same server-to-server verification stance as flutterwave/webhookRoute.ts. A forged
 * callback can therefore at worst make us ask PawaPay about a deposit; it can't credit anything.
 *
 * Responses:
 *  - 400 for a payload without depositId/status (not a PawaPay callback);
 *  - 200 once handled, including a depositId TradePal never created (this endpoint may receive
 *    foreign traffic) and in-flight statuses (nothing to act on yet);
 *  - 500 for an unexpected failure (database down, PawaPay API unreachable...) so PawaPay retries —
 *    safe, because settlement is idempotent. reconcilePendingPawaPayDeposits is the second net.
 */
export function createPawaPayWebhookPostHandler(deps: PawaPayWebhookHandlerDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const payload = req.body as Partial<PawaPayDepositCallback> | undefined;

    if (!payload || typeof payload.depositId !== "string" || !payload.depositId || typeof payload.status !== "string") {
      res.sendStatus(400);
      return;
    }

    const { depositId, status } = payload;

    if (status !== "COMPLETED" && status !== "FAILED") {
      // ACCEPTED / PROCESSING — in flight, nothing to act on yet.
      res.sendStatus(200);
      return;
    }

    try {
      const result = await settlePawaPayDeposit(deps.prisma, depositId, deps.pawapay, deps.outboundGateway);
      if (result.outcome === "verification_failed") {
        console.warn(`pawapay webhook: deposit ${depositId} did not verify against PawaPay's own record — not credited`);
      }
      res.sendStatus(200);
    } catch (error) {
      if (error instanceof PawaPayDepositNotFoundError) {
        // Not a deposit TradePal created — ignore, same as the Flutterwave route's unknown tx_ref.
        res.sendStatus(200);
        return;
      }
      console.error(`pawapay webhook: error settling depositId ${depositId}`, error);
      res.sendStatus(500);
    }
  };
}
