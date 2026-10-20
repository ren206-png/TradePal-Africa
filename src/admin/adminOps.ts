import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";
import { JOB_CLASSES, isJobClass, setJobPaused } from "../ops/jobControl.js";
import { reportIncident, type AlertEmailDeps } from "../monitoring/alerts.js";
import { randomUUID } from "node:crypto";

/**
 * Admin: operational controls on System health (Phase 9). Pause or resume a background job class; send a clearly labelled synthetic incident
 * through the real alert path to prove it works end to end; sign every phone out of a business. All are step-up, reasoned and audited.
 * Pausing never touches inbound messages or payment callbacks.
 */
const reason = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500);

export interface AdminOpsOptions {
  alertDeps?: AlertEmailDeps | undefined;
}

export function createAdminOpsRouter(prisma: PrismaClient, jwtSecret: string, options: AdminOpsOptions = {}): Router {
  const router = Router();
  const adminId = (req: unknown) => (req as AuthenticatedAdminRequest).adminUser!.adminUserId;
  const pauseGuard = [requirePlatformPermission("admin:pause_job_class"), requireStepUp(prisma, jwtSecret, "admin:pause_job_class")];
  const revokeGuard = [requirePlatformPermission("admin:revoke_staff"), requireStepUp(prisma, jwtSecret, "admin:revoke_staff")];

  router.get("/system/jobs", requirePlatformPermission("admin:view_system_health"), asyncHandler(async (_req, res) => {
    const rows = await prisma.jobControl.findMany();
    res.json({
      jobs: JOB_CLASSES.map((j) => {
        const r = rows.find((x) => x.jobClass === j.id);
        return { id: j.id, label: j.label, paused: r?.paused ?? false, reason: r?.paused ? r.reason : null, changedBy: r?.changedBy ?? null, changedAt: r?.changedAt ?? null };
      }),
      note: "A paused class skips its scheduled runs. Inbound WhatsApp messages and payment callbacks are never paused.",
    });
  }));

  for (const action of ["pause", "resume"] as const) {
    router.post(`/system/jobs/:jobClass/${action}`, ...pauseGuard, asyncHandler(async (req, res) => {
      const parsed = z.object({ reason }).safeParse(req.body);
      const jobClass = String(req.params["jobClass"] ?? "");
      if (!isJobClass(jobClass)) return void res.status(404).json({ error: "No such job class." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
      const current = await prisma.jobControl.findUnique({ where: { jobClass } });
      if ((current?.paused ?? false) === (action === "pause")) return void res.status(409).json({ error: `It is already ${action === "pause" ? "paused" : "running"}.` });
      await setJobPaused(prisma, jobClass, action === "pause", adminId(req), parsed.data.reason);
      res.json({ jobClass, paused: action === "pause" });
    }));
  }

  router.post("/system/synthetic-incident", ...pauseGuard, asyncHandler(async (req, res) => {
    const parsed = z.object({ reason }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    // a unique title per press, so the alert path's 15-minute de-duplication never swallows a test
    const title = `Synthetic incident (test of the alert path) ${randomUUID().slice(0, 8)}`;
    await reportIncident(options.alertDeps, { service: "admin-console", title, detail: `Sent on purpose by an admin to test alerting. Nothing is wrong. Reason given: ${parsed.data.reason}` });
    const delivery = await prisma.alertDelivery.findFirst({ where: { title }, orderBy: { createdAt: "desc" } });
    res.status(delivery?.status === "DELIVERED" ? 200 : 502).json({
      title, recorded: !!delivery, delivered: delivery?.status === "DELIVERED", error: delivery?.error ?? (delivery ? null : "No delivery was recorded (the recorder is not installed in this process)."),
      note: delivery?.status === "DELIVERED" ? "The email service accepted the incident. Check the inbox to be sure it arrived." : "The synthetic incident was not accepted by any channel.",
    });
  }));

  router.post("/businesses/:id/revoke-device-sessions", ...revokeGuard, asyncHandler(async (req, res) => {
    const parsed = z.object({ reason }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const business = await prisma.business.findUnique({ where: { id: String(req.params["id"]) }, select: { id: true } });
    if (!business) return void res.status(404).json({ error: "Business not found." });
    const r = await prisma.deviceSession.updateMany({ where: { businessId: business.id, revokedAt: null }, data: { revokedAt: new Date() } });
    res.json({ businessId: business.id, sessionsRevoked: r.count });
  }));

  return router;
}
