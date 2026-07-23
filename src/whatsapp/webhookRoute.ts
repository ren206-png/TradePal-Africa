import type { Request, Response } from "express";
import { InMemoryInboundMessageRateLimiter } from "./inboundRateLimiter.js";
import { isValidWebhookSignature } from "./signature.js";
import { processIncomingWebhook, type WebhookHandlerDeps } from "./webhookHandler.js";

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

/** Meta calls this once, at webhook configuration time, to confirm ownership of the endpoint. */
export function verifyWebhookSubscription(req: Request, res: Response, verifyToken: string): void {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken && typeof challenge === "string") {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
}

/**
 * Responds 200 as soon as processing completes (success or failure) so Meta
 * doesn't retry a delivery we've already durably recorded — dedupe on
 * WebhookEvent.waMessageId means a genuine retry is a cheap no-op, but a
 * processing error here shouldn't turn into a retry storm on top of
 * whatever's already failing downstream.
 */
export function createWebhookPostHandler(deps: WebhookHandlerDeps, appSecret: string) {
  // Constructed once, here, at handler-creation time (server startup) rather
  // than per-request — its in-memory counters need to persist across
  // requests to actually rate-limit anything. `deps.rateLimiter` still wins
  // if the caller supplied one (e.g. a test double).
  const rateLimiter = deps.rateLimiter ?? new InMemoryInboundMessageRateLimiter();

  return async (req: RequestWithRawBody, res: Response): Promise<void> => {
    const signature = req.headers["x-hub-signature-256"];

    if (!req.rawBody || typeof signature !== "string" || !isValidWebhookSignature(req.rawBody, signature, appSecret)) {
      res.sendStatus(401);
      return;
    }

    try {
      await processIncomingWebhook({ ...deps, rateLimiter }, req.body);
    } catch (error) {
      console.error("webhook processing failed", error);
    }

    res.sendStatus(200);
  };
}
