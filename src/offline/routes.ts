import { gzipSelected } from "../http/gzip.js";
import { rejectNulBytes } from "../http/rejectNul.js";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../admin/asyncHandler.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "../admin/rateLimiter.js";
import { OFFLINE_PAGE, OFFLINE_SCRIPT, OFFLINE_SERVICE_WORKER } from "./clientAssets.js";
import { FLAG_CATALOG_WEB, FLAG_OFFLINE_DRAFTS, FLAG_REPORTS_WEB, authenticateDevice, catalogWebSwitchOn, exchangeConnectCode, offlineSwitchOn, reportsWebSwitchOn, revokeSession, type AuthedDevice } from "./devices.js";
import { canMerchant, membershipRoleForLegacyMerchantRole } from "../auth/permissions.js";
import { BulkError, MAX_BULK_ROWS, applyBulkChanges, catalogToCsv, exportCatalog, previewBulkChanges, rowsFromCsv, type BulkContext, type BulkRow } from "../domain/bulkCatalog.js";
import { ImageError, MAX_IMAGE_BYTES, addProductImage, listProductImages, makeMainImage, removeProductImage } from "../domain/productImages.js";
import { REPORT_NAMES, ReportError, canExportReports, canRunReport, canViewReports, isReportName, parseRange, reportToCsv, runReport } from "../reports/index.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { DraftError, confirmDraft, discardDraft, listDrafts, syncDrafts } from "./drafts.js";

/**
 * `/m`: the offline-drafts page and its API (expansion Phase 7). Mounted only when OFFLINE_DRAFTS_ENABLED=true; every request is then
 * checked against the per-business `offlineDrafts` flag as well. API responses are never cacheable; the page's CSP allows only its own
 * script.
 */
export interface OfflineRouterOptions {
  limiters?: { exchange?: LoginRateLimiter; api?: LoginRateLimiter; upload?: LoginRateLimiter };
  now?: () => Date;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createOfflineRouter(prisma: PrismaClient, opts: OfflineRouterOptions = {}): Router {
  const router = Router();
  router.use(rejectNulBytes);
  router.use(gzipSelected((req) => req.method === "GET" && ["/m/", "/m/app.js", "/m/sw.js"].includes(req.path)));
  const clock = opts.now ?? (() => new Date());
  const exchangeLimiter = opts.limiters?.exchange ?? new InMemoryLoginRateLimiter(10, 15 * 60_000);
  const apiLimiter = opts.limiters?.api ?? new InMemoryLoginRateLimiter(300, 60_000);
  const uploadLimiter = opts.limiters?.upload ?? new InMemoryLoginRateLimiter(40, 10 * 60_000);

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
  const smallJson = express.json({ limit: "100kb" });
  api.use((req, res, next) => (req.path.startsWith("/catalog") ? next() : smallJson(req, res, next)));
  api.use(rejectNulBytes);
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
    const drafts = offlineSwitchOn() ? await authenticateDevice(prisma, claimed.token, clock(), FLAG_OFFLINE_DRAFTS) : null;
    const reports = reportsWebSwitchOn() ? await authenticateDevice(prisma, claimed.token, clock(), FLAG_REPORTS_WEB) : null;
    const catalog = catalogWebSwitchOn() ? await authenticateDevice(prisma, claimed.token, clock(), FLAG_CATALOG_WEB) : null;
    const dev = drafts ?? reports ?? catalog;
    if (!dev) { res.status(403).json({ error: "This is not available for this business." }); return; }
    res.json({ token: claimed.token, shared: claimed.session.shared, expiresAt: claimed.session.expiresAt, businessName: dev.business.name, currencyCode: dev.business.currencyCode, minorUnitExp: dev.business.currency.minorUnitExp, features: { drafts: !!drafts, reports: !!reports, catalog: !!catalog } });
  }));

  const authFor = (flag: string, switchOn: () => boolean) => asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const dev = switchOn() && header.startsWith("Bearer ") ? await authenticateDevice(prisma, header.slice(7).trim(), clock(), flag) : null;
    if (!dev) { res.status(401).json({ error: "Please connect this phone again." }); return; }
    (req as Request & { device: AuthedDevice }).device = dev;
    next();
  });
  const authed = authFor(FLAG_OFFLINE_DRAFTS, offlineSwitchOn);
  const authedReports = authFor(FLAG_REPORTS_WEB, reportsWebSwitchOn);
  const authedCatalog = authFor(FLAG_CATALOG_WEB, catalogWebSwitchOn);
  const device = (req: Request): AuthedDevice => (req as Request & { device: AuthedDevice }).device;
  const fail = (res: Response, error: unknown): void => {
    if (error instanceof DraftError) {
      res.status(error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" || error.code === "WRONG_STATE" ? 409 : error.code === "NOT_ALLOWED" ? 403 : 400).json({ error: error.message, code: error.code, conflicts: error.conflicts ?? [] });
      return;
    }
    throw error;
  };

  api.post("/logout", asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const dev = (await authenticateDevice(prisma, token, clock(), FLAG_OFFLINE_DRAFTS)) ?? (await authenticateDevice(prisma, token, clock(), FLAG_REPORTS_WEB)) ?? (await authenticateDevice(prisma, token, clock(), FLAG_CATALOG_WEB));
    if (!dev) { res.status(401).json({ error: "Please connect this phone again." }); return; }
    (req as Request & { device: AuthedDevice }).device = dev;
    next();
  }), asyncHandler(async (req, res) => {
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

  api.get("/reports/:name", authedReports, asyncHandler(async (req, res) => {
    const dev = device(req);
    const name = String(req.params["name"] ?? "").replace(/\.csv$/, "");
    const wantsCsv = String(req.params["name"] ?? "").endsWith(".csv") || req.query["format"] === "csv";
    if (!isReportName(name)) return void res.status(404).json({ error: "No such report.", reports: REPORT_NAMES });
    if (!canViewReports(dev.merchant.role) || (wantsCsv && !canExportReports(dev.merchant.role))) return void res.status(403).json({ error: wantsCsv ? "Only the owner or a manager can download reports." : "You do not have permission to see reports." });
    if (!canRunReport(dev.merchant.role, name)) return void res.status(403).json({ error: "That report shows costs and money balances. Ask the owner or a manager." });
    try {
      const args = [req.query["from"], req.query["to"]].filter((x): x is string => typeof x === "string");
      const range = parseRange(args.length === 2 ? args : typeof req.query["period"] === "string" ? [req.query["period"]] : [], dev.business.timezone, clock());
      const report = await runReport({ scoped: getTenantScopedClient(prisma, dev.business.id), businessId: dev.business.id, currencyCode: dev.business.currencyCode, minorUnitExp: dev.business.currency.minorUnitExp, timezone: dev.business.timezone, now: clock() }, name, range);
      if (wantsCsv) {
        res.set({ "Content-Disposition": `attachment; filename="tradepal-${name}-${clock().toISOString().slice(0, 10)}.csv"`, "Content-Type": "text/csv; charset=utf-8" }).send(reportToCsv(report));
        return;
      }
      res.json(report);
    } catch (error) {
      if (error instanceof ReportError) return void res.status(error.code === "UNSUPPORTED" ? 422 : 400).json({ error: error.message, code: error.code });
      throw error;
    }
  }));

  // ------------------------------------------------------------------------------------------------------ catalog (bulk edit, CSV, photos)
  const bulkCtx = (dev: AuthedDevice): BulkContext => ({
    businessId: dev.business.id, currencyCode: dev.business.currencyCode, minorUnitExp: dev.business.currency.minorUnitExp,
    role: membershipRoleForLegacyMerchantRole(dev.merchant.role), actorId: dev.merchant.id, now: clock(),
  });
  const bulkJson = express.json({ limit: "400kb" });
  const rowSchema = z.object({
    sku: z.string().max(80), rev: z.string().max(40).optional(), productName: z.string().max(200).optional(), variantName: z.string().max(200).optional(), baseUnit: z.string().max(40).optional(),
    category: z.string().max(100).nullable().optional(), description: z.string().max(2000).nullable().optional(), barcode: z.string().max(80).nullable().optional(),
    lowStockThreshold: z.number().int().nullable().optional(), status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(), retailPrice: z.string().max(30).nullable().optional(), listed: z.boolean().optional(),
  }).strict();
  const bodySchema = z.object({ batchId: z.string().max(80).optional(), rows: z.array(rowSchema).max(MAX_BULK_ROWS).optional(), csv: z.string().max(300_000).optional() }).strict();
  const failBulk = (res: Response, error: unknown): void => {
    if (error instanceof BulkError) { res.status(error.code === "TOO_MANY" ? 413 : error.code === "NOT_ALLOWED" ? 403 : 422).json({ error: error.message, code: error.code, plan: error.plan ?? null }); return; }
    if (error instanceof ImageError) { res.status(error.code === "NOT_FOUND" ? 404 : error.code === "TOO_BIG" ? 413 : error.code === "TOO_MANY" ? 409 : 422).json({ error: error.message, code: error.code }); return; }
    throw error;
  };
  const needs = (permission: Parameters<typeof canMerchant>[1]) => (req: Request, res: Response, next: NextFunction) => {
    if (!canMerchant(membershipRoleForLegacyMerchantRole(device(req).merchant.role), permission)) { res.status(403).json({ error: "Ask the owner or a manager to do this." }); return; }
    next();
  };
  const rowsOf = (body: z.infer<typeof bodySchema>): { rows: BulkRow[]; errors: string[] } => {
    if (body.csv !== undefined) return rowsFromCsv(body.csv);
    return { rows: (body.rows ?? []) as BulkRow[], errors: [] };
  };

  api.get("/catalog", authedCatalog, needs("inventory:view"), asyncHandler(async (req, res) => {
    const dev = device(req);
    const skip = Math.max(0, Number(req.query["skip"]) || 0);
    const out = await exportCatalog(getTenantScopedClient(prisma, dev.business.id), bulkCtx(dev), { skip });
    res.json({ rows: out.rows, total: out.total, truncated: out.truncated, currencyCode: dev.business.currencyCode, maxRows: MAX_BULK_ROWS, can: { edit: canMerchant(membershipRoleForLegacyMerchantRole(dev.merchant.role), "prices:manage"), list: canMerchant(membershipRoleForLegacyMerchantRole(dev.merchant.role), "store:manage") } });
  }));

  api.get("/catalog.csv", authedCatalog, needs("inventory:view"), asyncHandler(async (req, res) => {
    const dev = device(req);
    const out = await exportCatalog(getTenantScopedClient(prisma, dev.business.id), bulkCtx(dev));
    res.set({ "Content-Disposition": `attachment; filename="tradepal-products-${clock().toISOString().slice(0, 10)}.csv"`, "Content-Type": "text/csv; charset=utf-8" }).send(catalogToCsv(out.rows));
  }));

  api.post("/catalog/preview", authedCatalog, needs("prices:manage"), bulkJson, rejectNulBytes, asyncHandler(async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Send a list of rows, or a CSV." }); return; }
    const { rows, errors } = rowsOf(parsed.data);
    if (errors.length) { res.status(422).json({ error: errors.slice(0, 5).join(" "), parseErrors: errors.slice(0, 50), plan: null }); return; }
    try {
      res.json({ plan: await previewBulkChanges(prisma, bulkCtx(device(req)), rows) });
    } catch (error) {
      failBulk(res, error);
    }
  }));

  api.post("/catalog/apply", authedCatalog, needs("prices:manage"), bulkJson, rejectNulBytes, asyncHandler(async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.batchId) { res.status(400).json({ error: "Send a batch id and the rows (or a CSV)." }); return; }
    const { rows, errors } = rowsOf(parsed.data);
    if (errors.length) { res.status(422).json({ error: errors.slice(0, 5).join(" "), parseErrors: errors.slice(0, 50), plan: null }); return; }
    try {
      const r = await applyBulkChanges(prisma, bulkCtx(device(req)), { batchId: parsed.data.batchId, rows });
      res.json({ ok: true, replayed: r.replayed, created: r.created, updated: r.updated, unchanged: r.unchanged });
    } catch (error) {
      failBulk(res, error);
    }
  }));

  // photos: the list for one product, the bytes (for the seller's own screen, which can send its token), upload, make main, remove
  api.get("/catalog/photos/:productId", authedCatalog, needs("inventory:view"), asyncHandler(async (req, res) => {
    res.json({ photos: await listProductImages(getTenantScopedClient(prisma, device(req).business.id), String(req.params["productId"])) });
  }));
  api.get("/catalog/photo/:imageId", authedCatalog, needs("inventory:view"), asyncHandler(async (req, res) => {
    const img = await getTenantScopedClient(prisma, device(req).business.id).productImage.findFirst({ where: { id: String(req.params["imageId"]), removedAt: null } });
    if (!img) { res.status(404).json({ error: "Photo not found." }); return; }
    res.set({ "Content-Type": img.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(img.data));
  }));
  api.post("/catalog/photos/:productId", authedCatalog, needs("store:manage"), asyncHandler(async (req, res, next) => {
    const r = await uploadLimiter.consume(`m-photo:${device(req).session.id}`);
    if (!r.allowed) { res.status(429).set("Retry-After", String(r.retryAfterSeconds)).json({ error: "Too many photos just now. Wait a few minutes." }); return; }
    next();
  }), express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: MAX_IMAGE_BYTES + 1024 }), asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(415).json({ error: "Send the photo itself (JPEG, PNG or WebP)." }); return; }
    const dev = device(req);
    try {
      const img = await addProductImage(getTenantScopedClient(prisma, dev.business.id), { businessId: dev.business.id, productId: String(req.params["productId"]), data: req.body, createdBy: dev.merchant.id });
      res.status(img.duplicate ? 200 : 201).json({ photo: img });
    } catch (error) {
      failBulk(res, error);
    }
  }));
  api.post("/catalog/photo/:imageId/main", authedCatalog, needs("store:manage"), asyncHandler(async (req, res) => {
    try {
      await makeMainImage(getTenantScopedClient(prisma, device(req).business.id), String(req.params["imageId"]));
      res.json({ ok: true });
    } catch (error) {
      failBulk(res, error);
    }
  }));
  api.delete("/catalog/photo/:imageId", authedCatalog, needs("store:manage"), asyncHandler(async (req, res) => {
    try {
      await removeProductImage(getTenantScopedClient(prisma, device(req).business.id), String(req.params["imageId"]));
      res.json({ ok: true });
    } catch (error) {
      failBulk(res, error);
    }
  }));

  router.use("/m/api", api);
  return router;
}
