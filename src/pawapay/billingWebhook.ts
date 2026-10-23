import { rejectNulBytes } from "../http/rejectNul.js";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Router, type Request } from "express";
import { asyncHandler } from "../admin/asyncHandler.js";
import { BILLING_CALLBACK_PATH, getBillingConfig, raiseBillingException } from "../domain/subscriptions/common.js";
import { createKeyResolver, storeBillingCallback } from "../domain/subscriptions/collection.js";
import { verifyPawaPayCallback } from "./signature.js";

/**
 * `POST /webhooks/pawapay/billing`: pawaPay's callbacks about TradePal SUBSCRIPTION charges and refunds (not the quarantined merchant
 * `/webhooks/pawapay` route). Authenticate, persist, answer 200 immediately; processing is asynchronous from the durable inbox and the
 * handler re-checks everything with an authenticated status lookup, so a callback is at most a hint to go and look.
 *
 *  - A callback that CARRIES a signature must verify (RFC 9421 + Content-Digest, see pawapay/signature.ts) or it is refused with 401 and
 *    recorded as a callback-auth failure.
 *  - An unsigned callback is refused when PAWAPAY_REQUIRE_SIGNED_CALLBACKS is on (the default and the activation requirement: signed
 *    callbacks must be enabled in the pawaPay dashboard). With it off, an unsigned callback is stored as an unverified hint only.
 *  - This route works with every billing FLAG off: finishing attempts that already exist must never depend on new charges being allowed.
 */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function createPawaPayBillingWebhookRouter(prisma: PrismaClient, now: () => number = () => Date.now()): Router {
  const router = Router();
  router.use(rejectNulBytes);
  router.post(
    BILLING_CALLBACK_PATH,
    asyncHandler(async (req: RawBodyRequest, res) => {
      const cfgResult = getBillingConfig();
      if (!cfgResult.ok) return void res.sendStatus(process.env["PAWAPAY_API_TOKEN"] ? 503 : 404);
      const cfg = cfgResult.config;
      const raw = req.rawBody;
      const body = req.body as Record<string, unknown> | undefined;
      if (!raw || !body || typeof body !== "object") return void res.sendStatus(400);
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;

      const fail = async (reason: string) => {
        const hour = Math.floor(now() / 3_600_000);
        await raiseBillingException(prisma, { type: "CALLBACK_AUTH_FAILED", fingerprint: `auth:${reason}:${hour}`, details: { reason, hourBucket: hour } });
        res.sendStatus(401);
      };

      let verified = false;
      if (headers["signature"] || headers["signature-input"]) {
        const v = await verifyPawaPayCallback({
          method: "POST", authority: cfg.callbackAuthority, path: cfg.callbackPath, headers, rawBody: raw, now: Math.floor(now() / 1000), resolveKey: createKeyResolver(prisma, cfg),
        });
        if (!v.ok) return void (await fail(v.reason));
        verified = true;
      } else if (cfg.requireSignedCallbacks) {
        return void (await fail("UNSIGNED"));
      }
      const stored = await storeBillingCallback(prisma, body, createHash("sha256").update(raw).digest("hex"), verified);
      if (!stored) return void res.sendStatus(400);
      res.sendStatus(200);
    }),
  );
  return router;
}
