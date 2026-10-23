import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { paginate, parsePaginationParams } from "./pagination.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";
import { decideAppeal, reinstateListing, reinstateSeller, resolveReport, suspendSeller, unpublishListing } from "../domain/moderation.js";
import { StoreError } from "../domain/store/common.js";

/**
 * Admin: marketplace listings and moderation (expansion Phase 5, section 18). Reading needs `admin:view_moderation`; every decision needs
 * `admin:moderate_listings`, step-up when enabled, a stated reason, and is recorded append-only (who, what, why). Nothing is deleted: a
 * takedown is an unpublish or a suspension, both reversible. Suspending a seller never blocks servicing orders already placed.
 */
const reasonField = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500);

export function createAdminModerationRouter(prisma: PrismaClient, jwtSecret: string): Router {
  const router = Router();
  const adminId = (req: unknown) => (req as AuthenticatedAdminRequest).adminUser!.adminUserId;
  const view = requirePlatformPermission("admin:view_moderation");
  const writes = [requirePlatformPermission("admin:moderate_listings"), requireStepUp(prisma, jwtSecret, "admin:moderate_listings")];
  const fail = (res: import("express").Response, error: unknown) => {
    if (error instanceof StoreError) return void res.status(error.code === "NOT_FOUND" ? 404 : error.code === "INVALID" ? 400 : 409).json({ error: error.message, code: error.code });
    throw error;
  };

  router.get("/moderation/queue", view, asyncHandler(async (req, res) => {
    const status = (["OPEN", "ACTIONED", "DISMISSED"] as const).find((x) => x === req.query["status"]) ?? "OPEN";
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    const rows = await prisma.marketplaceReport.findMany({ where: { status }, orderBy: { createdAt: "asc" }, take: pagination.take + 1, skip: pagination.skip });
    const { items, pagination: meta } = paginate(rows, pagination);
    const businesses = new Map((await prisma.business.findMany({ where: { id: { in: items.map((r) => r.businessId) } }, select: { id: true, name: true, countryCode: true, storefronts: { select: { marketplaceStatus: true, slug: true } } } })).map((b) => [b.id, b]));
    const listings = new Map((await prisma.listing.findMany({ where: { id: { in: items.map((r) => r.listingId).filter((x): x is string => !!x) } }, select: { id: true, moderation: true, category: true, variant: { select: { sku: true, product: { select: { name: true } } } } } })).map((l) => [l.id, l]));
    const counts = await prisma.marketplaceReport.groupBy({ by: ["businessId"], where: { status: "OPEN" }, _count: { _all: true } });
    const openFor = new Map(counts.map((c) => [c.businessId, c._count._all]));
    res.json({
      reports: items.map((r) => {
        const b = businesses.get(r.businessId);
        const l = r.listingId ? listings.get(r.listingId) : undefined;
        return {
          id: r.id, reason: r.reason, details: r.details, contact: r.contact, status: r.status, createdAt: r.createdAt, resolutionNote: r.resolutionNote,
          seller: b ? { id: b.id, name: b.name, country: b.countryCode, marketplaceStatus: b.storefronts[0]?.marketplaceStatus ?? "OFF", slug: b.storefronts[0]?.slug ?? null } : null,
          listing: l ? { id: l.id, item: l.variant.product.name, sku: l.variant.sku, category: l.category, moderation: l.moderation } : null,
          openReportsAboutSeller: openFor.get(r.businessId) ?? 0,
        };
      }),
      pagination: meta,
    });
  }));

  router.get("/moderation/sellers", view, asyncHandler(async (_req, res) => {
    const rows = await prisma.storefront.findMany({ where: { marketplaceStatus: { not: "OFF" } }, orderBy: { updatedAt: "desc" }, take: 200, include: { business: { select: { name: true, countryCode: true } } } });
    res.json({ sellers: rows.map((s) => ({ businessId: s.businessId, name: s.business.name, country: s.business.countryCode, slug: s.slug, marketplaceStatus: s.marketplaceStatus, note: s.marketplaceNote })) });
  }));

  router.get("/moderation/listings", view, asyncHandler(async (req, res) => {
    const pagination = parsePaginationParams(req.query as Record<string, unknown>);
    const rows = await prisma.listing.findMany({
      where: { channel: "MARKETPLACE", ...(req.query["moderation"] === "UNPUBLISHED" ? { moderation: "UNPUBLISHED" as const } : {}), ...(typeof req.query["businessId"] === "string" ? { businessId: req.query["businessId"] } : {}) },
      orderBy: { updatedAt: "desc" }, take: pagination.take + 1, skip: pagination.skip, include: { business: { select: { name: true } }, variant: { select: { sku: true, product: { select: { name: true } } } } },
    });
    const { items, pagination: meta } = paginate(rows, pagination);
    res.json({ listings: items.map((l) => ({ id: l.id, seller: l.business.name, businessId: l.businessId, item: l.variant.product.name, sku: l.variant.sku, category: l.category, status: l.status, moderation: l.moderation, moderationReason: l.moderationReason })), pagination: meta });
  }));

  router.get("/moderation/appeals", view, asyncHandler(async (req, res) => {
    const status = (["OPEN", "UPHELD", "OVERTURNED"] as const).find((x) => x === req.query["status"]) ?? "OPEN";
    const rows = await prisma.appeal.findMany({ where: { status }, orderBy: { createdAt: "asc" }, take: 100, include: { business: { select: { name: true } }, action: true } });
    res.json({ appeals: rows.map((a) => ({ id: a.id, seller: a.business.name, businessId: a.businessId, text: a.text, status: a.status, createdAt: a.createdAt, decisionNote: a.decisionNote, action: { id: a.action.id, type: a.action.type, reason: a.action.reason, at: a.action.createdAt, adminUserId: a.action.adminUserId } })) });
  }));

  router.get("/moderation/actions", view, asyncHandler(async (req, res) => {
    const rows = await prisma.moderationAction.findMany({ where: typeof req.query["businessId"] === "string" ? { businessId: req.query["businessId"] } : {}, orderBy: { createdAt: "desc" }, take: 100 });
    res.json({ actions: rows });
  }));

  const withReason = z.object({ reason: reasonField, reportId: z.string().min(1).max(60).optional() });

  router.post("/moderation/listings/:id/unpublish", ...writes, asyncHandler(async (req, res) => {
    const p = withReason.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      const a = await unpublishListing(prisma, { listingId: req.params["id"] as string, adminUserId: adminId(req), reason: p.data.reason, ...(p.data.reportId ? { reportId: p.data.reportId } : {}) });
      res.json({ actionId: a.id });
    } catch (e) { fail(res, e); }
  }));

  router.post("/moderation/listings/:id/reinstate", ...writes, asyncHandler(async (req, res) => {
    const p = z.object({ reason: reasonField }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      res.json({ actionId: (await reinstateListing(prisma, { listingId: req.params["id"] as string, adminUserId: adminId(req), reason: p.data.reason })).id });
    } catch (e) { fail(res, e); }
  }));

  router.post("/moderation/sellers/:id/suspend", ...writes, asyncHandler(async (req, res) => {
    const p = withReason.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      const a = await suspendSeller(prisma, { businessId: req.params["id"] as string, adminUserId: adminId(req), reason: p.data.reason, ...(p.data.reportId ? { reportId: p.data.reportId } : {}) });
      res.json({ actionId: a.id });
    } catch (e) { fail(res, e); }
  }));

  router.post("/moderation/sellers/:id/reinstate", ...writes, asyncHandler(async (req, res) => {
    const p = z.object({ reason: reasonField }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      res.json({ actionId: (await reinstateSeller(prisma, { businessId: req.params["id"] as string, adminUserId: adminId(req), reason: p.data.reason })).id });
    } catch (e) { fail(res, e); }
  }));

  router.post("/moderation/reports/:id/dismiss", ...writes, asyncHandler(async (req, res) => {
    const p = z.object({ reason: z.string().trim().min(5).max(500) }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      await resolveReport(prisma, { reportId: req.params["id"] as string, adminUserId: adminId(req), outcome: "DISMISSED", note: p.data.reason });
      res.json({ dismissed: true });
    } catch (e) { fail(res, e); }
  }));

  router.post("/moderation/appeals/:id/decide", ...writes, asyncHandler(async (req, res) => {
    const p = z.object({ outcome: z.enum(["UPHELD", "OVERTURNED"]), reason: reasonField }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: "Invalid request body.", details: p.error.issues });
    try {
      const a = await decideAppeal(prisma, { appealId: req.params["id"] as string, adminUserId: adminId(req), outcome: p.data.outcome, note: p.data.reason });
      res.json({ status: a.status });
    } catch (e) { fail(res, e); }
  }));

  return router;
}
