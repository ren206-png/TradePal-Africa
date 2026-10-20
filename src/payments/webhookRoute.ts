import type { PrismaClient } from "@prisma/client";
import { Router, type Request } from "express";
import { asyncHandler } from "../admin/asyncHandler.js";
import { receiveProviderCallback } from "../domain/merchantPayments/outcomes.js";
import type { AdapterRegistry } from "./adapter.js";

/**
 * The HTTP edge for merchant-payment provider callbacks: `POST /webhooks/merchant-payments/:provider`.
 * Authenticate per that provider's scheme, persist in the durable inbox, answer. Nothing is applied here (the inbox handler does that,
 * asynchronously, once per event). Only providers in the registry exist: in production the registry is empty until a real adapter is
 * added, so every call is a 404. The raw body (captured by the server's JSON parser) is what is authenticated.
 */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function createMerchantPaymentWebhookRouter(prisma: PrismaClient, registry: () => AdapterRegistry): Router {
  const router = Router();
  router.post(
    "/webhooks/merchant-payments/:provider",
    asyncHandler(async (req: RawBodyRequest, res) => {
      const raw = req.rawBody?.toString("utf8");
      if (raw === undefined) return void res.status(400).json({ error: "Missing body." });
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const r = await receiveProviderCallback(prisma, registry(), req.params["provider"] as string, raw, headers);
      if (r.status !== "rejected") return void res.status(200).json({ status: r.status });
      if (r.reason === "UNKNOWN_PROVIDER") return void res.status(404).json({ error: "Unknown provider." });
      if (r.reason === "BAD_SIGNATURE") return void res.status(401).json({ error: "Authentication failed." });
      if (r.reason === "PURPOSE_FORBIDDEN") return void res.status(403).json({ error: "Not accepted." });
      res.status(400).json({ error: "Malformed callback." });
    }),
  );
  return router;
}
