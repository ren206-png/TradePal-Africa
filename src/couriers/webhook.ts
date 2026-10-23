import express, { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { asyncHandler } from "../admin/asyncHandler.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "../admin/rateLimiter.js";
import type { CourierRegistry } from "./adapter.js";
import { receiveCourierCallback } from "../domain/store/shipments.js";

/**
 * `POST /webhooks/courier/:courier` - where a courier tells us how a job is going. Mounted only when COURIERS_ENABLED=true. The body is read
 * as raw bytes (the signature is over exactly those bytes), capped at 20 KB, and nothing in it is believed until the courier's adapter has
 * verified the signature. A verified event is stored and applied by the worker; an unverifiable one is refused with 401 and stored nowhere.
 */
export function createCourierWebhookRouter(prisma: PrismaClient, registry: () => CourierRegistry, opts: { limiter?: LoginRateLimiter } = {}): Router {
  const router = Router();
  const limiter = opts.limiter ?? new InMemoryLoginRateLimiter(600, 60_000);
  router.post("/webhooks/courier/:courier", express.raw({ type: () => true, limit: "20kb" }), asyncHandler(async (req: Request, res: Response) => {
    const r = await limiter.consume(`courier-hook:${req.ip ?? "?"}`);
    if (!r.allowed) { res.status(429).set("Retry-After", String(r.retryAfterSeconds)).json({ error: "slow down" }); return; }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await receiveCourierCallback(prisma, registry(), String(req.params["courier"]), body, req.headers);
    if (out.status === "rejected") {
      res.status(out.reason === "BAD_SIGNATURE" ? 401 : 404).json({ error: out.reason === "BAD_SIGNATURE" ? "bad signature" : "not found" });
      return;
    }
    res.status(200).json({ status: out.status });
  }));
  return router;
}
