import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../admin/asyncHandler.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "../admin/rateLimiter.js";
import { OFFLINE_PAGE, OFFLINE_SCRIPT, OFFLINE_SERVICE_WORKER } from "./clientAssets.js";
import { authenticateDevice, exchangeConnectCode, revokeSession, type AuthedDevice } from "./devices.js";
import { DraftError, confirmDraft, discardDraft, listDrafts, syncDrafts } from "./drafts.js";

/**
 * `/m`: the offline-drafts page and its API (expansion Phase 7). Mounted only when OFFLINE_DRAFTS_ENABLED=true; every request is then
 * checked against the per-business `offlineDrafts` flag as well. API responses are never cacheable; the page's CSP allows only its own
 * script.
 */
export interface OfflineRouterOptions {
  limiters?: { exchange?: LoginRateLimiter; api?: LoginRateLimiter };
  now?: () => Date;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createOfflineRouter(prisma: PrismaClient, opts: OfflineRouterOptions = {}): Router {
  const router = Router();
  const clock = opts.now ?? (() => new Date());
  const exchangeLimiter = opts.limiters?.exchange ?? new InMemoryLoginRateLimiter(10, 15 * 60_000);
  const apiLimiter = opts.limiters?.api ?? new InMemoryLoginRateLimiter(300, 60_000);

  router.get(/^\/m$/, (_req, res) => res.redirect(301, "/m/"));
  router.get("/m/", (_req, res) => {
    res.set({ "Content-Security-Policy": CSP, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" }).type("html").send(OFFLINE_PAGE);
  });
  router.get("/m/app.js", (_req, res) => {
    res.set({ "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }).type("application/javascript").send(OFFLINE_SCRIPT);
  });
  router.get("/m/sw.js", (_req, res) => {
    res.set({ "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Service-Worker-Allowed": "/m/" }).type("application/javascript").send(OFFLINE_SERVICE_WORKER);
  });

  const api = Router();
  api.use(express.json({ limit: "100kb" }));
  api.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  api.use(asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const r = await apiLimiter.consume(`m:${req.ip ?? "?"}`);
    if (!r.allowed) { res.status(429).set("Retry-After", String(r.retryAfterSeconds)).json({ error: "Too many requests. Please wait a moment." }); return; }
    next();
  }));

  api.post("/session", asyncHandler(async (req, res) => {
    const r = await exchangeLimiter.consume(`m-code:${req.ip ?? "?"}`);
    if (!r.allowed) { res.status(429).set("Retry-After", String(r.retryAfterSeconds)).json({ error: "Too many tries. Wait a few minutes." }); return; }
    const parsed = z.object({ code: z.string().regex(/^\d{8}$/) }).safeParse(req.body);
    const claimed = parsed.success ? await exchangeConnectCode(prisma, parsed.data.code, clock()) : null;
    if (!claimed) { res.status(401).json({ error: "That code did not work. Ask for a new one with /connect." }); return; }
    const dev = await authenticateDevice(prisma, claimed.token, clock());
    if (!dev) { res.status(403).json({ error: "Offline drafts are not available for this business." }); return; }
    res.json({ token: claimed.token, shared: claimed.session.shared, expiresAt: claimed.session.expiresAt, businessName: dev.business.name, currencyCode: dev.business.currencyCode, minorUnitExp: dev.business.currency.minorUnitExp });
  }));

  const authed = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const dev = header.startsWith("Bearer ") ? await authenticateDevice(prisma, header.slice(7).trim(), clock()) : null;
    if (!dev) { res.status(401).json({ error: "Please connect this phone again." }); return; }
    (req as Request & { device: AuthedDevice }).device = dev;
    next();
  });
  const device = (req: Request): AuthedDevice => (req as Request & { device: AuthedDevice }).device;
  const fail = (res: Response, error: unknown): void => {
    if (error instanceof DraftError) {
      res.status(error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" || error.code === "WRONG_STATE" ? 409 : error.code === "NOT_ALLOWED" ? 403 : 400).json({ error: error.message, code: error.code, conflicts: error.conflicts ?? [] });
      return;
    }
    throw error;
  };

  api.post("/logout", authed, asyncHandler(async (req, res) => {
    await revokeSession(prisma, device(req).session.id, clock());
    res.json({ ok: true });
  }));

  api.post("/drafts/sync", authed, asyncHandler(async (req, res) => {
    const drafts = (req.body as { drafts?: unknown })?.drafts;
    if (!Array.isArray(drafts)) { res.status(400).json({ error: "Send a list of drafts." }); return; }
    try {
      res.json({ results: await syncDrafts(prisma, device(req), drafts, clock()) });
    } catch (error) {
      fail(res, error);
    }
  }));

  api.get("/drafts", authed, asyncHandler(async (req, res) => {
    const rows = await listDrafts(prisma, device(req));
    res.json({ drafts: rows.map((r) => ({ id: r.id, clientId: r.clientId, kind: r.kind, status: r.status, payload: r.payload, conflicts: r.conflicts ?? [], capturedAt: r.capturedAt, transactionId: r.transactionId })) });
  }));

  api.post("/drafts/:id/confirm", authed, asyncHandler(async (req, res) => {
    try {
      const accept = (req.body as { acceptConflicts?: unknown })?.acceptConflicts === true;
      const r = await confirmDraft(prisma, device(req), String(req.params["id"]), { acceptConflicts: accept, now: clock() });
      res.json({ ok: true, transactionId: r.transactionId, reply: r.reply });
    } catch (error) {
      fail(res, error);
    }
  }));

  api.post("/drafts/:id/discard", authed, asyncHandler(async (req, res) => {
    try {
      await discardDraft(prisma, device(req), String(req.params["id"]), clock());
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  }));

  router.use("/m/api", api);
  return router;
}
