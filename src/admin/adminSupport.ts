import type { PrismaClient, Prisma, SupportCaseStatus, SupportCaseType, SupportParty } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { paginate, parsePaginationParams } from "./pagination.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";

/**
 * Admin: consumer support cases and payment exceptions (expansion Phase 4, section 10/18). Reading needs
 * `admin:view_support_cases` (no merchant books are opened: a case carries a summary, the order's reference, status and totals).
 * Changing anything needs `admin:resolve_support_case` plus step-up, is audited, and never rewrites history: notes are
 * append-only and a closed case stays closed (a new problem is a new case). Every case names who is responsible; an admin can
 * reassign it with a reason.
 */
const TYPES = ["DELIVERY", "PRODUCT_COMPLAINT", "PAYMENT_DISPUTE", "REFUND", "OTHER"] as const;
const PARTIES = ["SELLER", "PLATFORM", "PROVIDER"] as const;
const STATUSES = ["OPEN", "ASSIGNED", "CLOSED"] as const;
const reasonText = z.string().trim().min(10, "Give at least 10 characters.").max(500);
const noteBody = z.object({ body: z.string().trim().min(3).max(1_000) });
const reassignBody = z.object({ party: z.enum(PARTIES), reason: reasonText });
const closeBody = z.object({ resolution: z.string().trim().min(10, "Say how it was resolved (at least 10 characters).").max(500) });

const maskPhone = (p: string | null) => (p && p.length > 4 ? `${"*".repeat(p.length - 4)}${p.slice(-4)}` : p);

export function createAdminSupportRouter(prisma: PrismaClient, jwtSecret: string): Router {
  const router = Router();
  const adminId = (req: unknown) => (req as AuthenticatedAdminRequest).adminUser!.adminUserId;

  router.get(
    "/support-cases",
    requirePlatformPermission("admin:view_support_cases"),
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const pick = <T extends string>(v: unknown, allowed: readonly T[]) => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);
      const status = pick<SupportCaseStatus>(q["status"], STATUSES);
      const party = pick<SupportParty>(q["party"], PARTIES);
      const type = pick<SupportCaseType>(q["type"], TYPES);
      const businessId = typeof q["businessId"] === "string" ? q["businessId"] : undefined;
      const where: Prisma.SupportCaseWhereInput = {
        ...(status ? { status } : q["status"] === "active" ? { status: { not: "CLOSED" } } : {}),
        ...(party ? { handledBy: party } : {}), ...(type ? { type } : {}), ...(businessId ? { businessId } : {}),
      };
      const pagination = parsePaginationParams(q);
      const rows = await prisma.supportCase.findMany({
        where, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip,
        include: { business: { select: { name: true } }, order: { select: { reference: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      const byStatus = await prisma.supportCase.groupBy({ by: ["status"], _count: { _all: true } });
      const byParty = await prisma.supportCase.groupBy({ by: ["handledBy"], where: { status: { not: "CLOSED" } }, _count: { _all: true } });
      res.json({
        cases: items.map((c) => ({
          id: c.id, businessId: c.businessId, business: c.business.name, orderReference: c.order?.reference ?? null, type: c.type, handledBy: c.handledBy, status: c.status,
          openedBy: c.openedBy, summary: c.summary.slice(0, 200), contactPhone: maskPhone(c.contactPhone), assignedAdminId: c.assignedAdminId, createdAt: c.createdAt, closedAt: c.closedAt,
        })),
        counts: { byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])), openByParty: Object.fromEntries(byParty.map((g) => [g.handledBy, g._count._all])) },
        pagination: meta,
      });
    }),
  );

  router.get(
    "/support-cases/:id",
    requirePlatformPermission("admin:view_support_cases"),
    asyncHandler(async (req, res) => {
      const c = await prisma.supportCase.findUnique({
        where: { id: req.params["id"] as string },
        include: { business: { select: { name: true } }, notes: { orderBy: { createdAt: "asc" } }, order: { select: { reference: true, status: true, fulfilment: true, totalMinor: true, paidMinor: true, refundedMinor: true, currencyCode: true, paymentMethod: true } } },
      });
      if (!c) {
        res.status(404).json({ error: "Case not found." });
        return;
      }
      // The consumer's full number is shown only where the platform itself has to act: platform-handled cases, or one assigned to this admin.
      const showPhone = c.handledBy === "PLATFORM" || c.assignedAdminId === adminId(req);
      res.json({
        id: c.id, businessId: c.businessId, business: c.business.name, type: c.type, handledBy: c.handledBy, status: c.status, openedBy: c.openedBy, summary: c.summary,
        contactName: c.contactName, contactPhone: showPhone ? c.contactPhone : maskPhone(c.contactPhone), assignedAdminId: c.assignedAdminId, resolution: c.resolution, createdAt: c.createdAt, closedAt: c.closedAt,
        order: c.order ? { reference: c.order.reference, status: c.order.status, fulfilment: c.order.fulfilment, paymentMethod: c.order.paymentMethod, totalMinor: c.order.totalMinor.toString(), paidMinor: c.order.paidMinor.toString(), refundedMinor: c.order.refundedMinor.toString(), currencyCode: c.order.currencyCode } : null,
        notes: c.notes.map((n) => ({ id: n.id, authorType: n.authorType, body: n.body, createdAt: n.createdAt })),
      });
    }),
  );

  const writable = [requirePlatformPermission("admin:resolve_support_case"), requireStepUp(prisma, jwtSecret, "admin:resolve_support_case")];

  async function openCase(id: string) {
    return prisma.supportCase.findUnique({ where: { id } });
  }
  const note = (businessId: string, caseId: string, admin: string, body: string) =>
    prisma.supportCaseNote.create({ data: { businessId, caseId, authorType: "ADMIN", authorId: admin, body } });

  router.post("/support-cases/:id/assign", ...writable, asyncHandler(async (req, res) => {
    const c = await openCase(req.params["id"] as string);
    if (!c) return void res.status(404).json({ error: "Case not found." });
    if (c.status === "CLOSED") return void res.status(409).json({ error: "This case is closed." });
    const updated = await prisma.supportCase.updateMany({ where: { id: c.id, status: { not: "CLOSED" } }, data: { status: "ASSIGNED", assignedAdminId: adminId(req) } });
    if (updated.count !== 1) return void res.status(409).json({ error: "This case is closed." });
    await note(c.businessId, c.id, adminId(req), "Assigned to a TradePal admin.");
    res.json({ id: c.id, status: "ASSIGNED", assignedAdminId: adminId(req) });
  }));

  router.post("/support-cases/:id/notes", ...writable, asyncHandler(async (req, res) => {
    const parsed = noteBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const c = await openCase(req.params["id"] as string);
    if (!c) return void res.status(404).json({ error: "Case not found." });
    if (c.status === "CLOSED") return void res.status(409).json({ error: "This case is closed." });
    const n = await note(c.businessId, c.id, adminId(req), parsed.data.body);
    res.status(201).json({ id: n.id });
  }));

  router.post("/support-cases/:id/reassign", ...writable, asyncHandler(async (req, res) => {
    const parsed = reassignBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const c = await openCase(req.params["id"] as string);
    if (!c) return void res.status(404).json({ error: "Case not found." });
    if (c.status === "CLOSED") return void res.status(409).json({ error: "This case is closed." });
    if (c.handledBy === parsed.data.party) return void res.status(409).json({ error: "It is already with that party." });
    await prisma.supportCase.update({ where: { id: c.id }, data: { handledBy: parsed.data.party } });
    await note(c.businessId, c.id, adminId(req), `Responsibility moved from ${c.handledBy} to ${parsed.data.party}: ${parsed.data.reason}`);
    res.json({ id: c.id, handledBy: parsed.data.party });
  }));

  router.post("/support-cases/:id/close", ...writable, asyncHandler(async (req, res) => {
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const c = await openCase(req.params["id"] as string);
    if (!c) return void res.status(404).json({ error: "Case not found." });
    const closed = await prisma.supportCase.updateMany({ where: { id: c.id, status: { not: "CLOSED" } }, data: { status: "CLOSED", resolution: parsed.data.resolution, closedAt: new Date() } });
    if (closed.count !== 1) return void res.status(409).json({ error: "This case is already closed." });
    await note(c.businessId, c.id, adminId(req), `Closed: ${parsed.data.resolution}`);
    res.json({ id: c.id, status: "CLOSED" });
  }));

  // Money that arrived and does not fit its order. Read-only here: the seller resolves it (refund, re-reserve or apply).
  router.get(
    "/payment-exceptions",
    requirePlatformPermission("admin:view_support_cases"),
    asyncHandler(async (req, res) => {
      const open = req.query["status"] !== "RESOLVED";
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.paymentException.findMany({
        where: { status: open ? "OPEN" : "RESOLVED" }, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip,
        include: { business: { select: { name: true, currencyCode: true } }, order: { select: { reference: true, status: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      res.json({
        exceptions: items.map((e) => ({
          id: e.id, businessId: e.businessId, business: e.business.name, orderReference: e.order.reference, orderStatus: e.order.status, type: e.type, status: e.status,
          amountMinor: e.amountMinor.toString(), currencyCode: e.business.currencyCode, createdAt: e.createdAt, resolution: e.resolution, resolvedAt: e.resolvedAt,
        })),
        pagination: meta,
      });
    }),
  );

  return router;
}
