import type { Prisma, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { paginate, parsePaginationParams } from "./pagination.js";
import { requirePlatformPermission, requireStepUp } from "./platformGuards.js";
import { CATALOG, localeCoverage } from "../i18n/index.js";
import { alertChannelStatus } from "../monitoring/alertRecorder.js";
import { verifyAlertChannel, type AlertEmailDeps } from "../monitoring/alerts.js";
import { adminBlock, adminUnblock, digitsOnly, maskPhone } from "../messaging/consent.js";
import { MESSAGE_CLASSES, messageClass } from "../messaging/registry.js";
import { FLAG_CONSUMER_MESSAGING, consumerMessagingSwitchOn } from "../messaging/send.js";
import { REDRIVE_GRACE_MS, REDRIVE_MAX_AGE_MS } from "../whatsapp/redrive.js";
import { extractInboundMessages, parseWhatsAppWebhookPayload } from "../whatsapp/webhookPayload.js";
import type { InboundMessageJob } from "../whatsapp/webhookHandler.js";

/**
 * Admin: messaging and consent (expansion Phase 7). Reads need `admin:view_messaging` and never show a full phone number (last four
 * digits only). Writes need `admin:manage_messaging` (record that a template is disabled, block / unblock a number, replay a stuck
 * inbound message, check the alert channel) or `admin:approve_templates` (owner only: it is what lets a class of message go out). All
 * are step-up, reasoned and audited. Nothing here sends a message to a shopper, edits a consent, or deletes anything: a person's consent
 * can only be changed by that person (checkout tick, STOP, START).
 */
const reason = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500);
const DAY_MS = 86_400_000;

export interface AdminMessagingOptions {
  /** Alert email settings, for the channel check. Omitted when none are configured (the check then reports that). */
  alertDeps?: AlertEmailDeps | undefined;
  /** Puts a stuck inbound message back on the queue. Omitted where the queue is not reachable (the API then says so). */
  replayInbound?: (job: InboundMessageJob) => Promise<"QUEUED" | "IN_FLIGHT">;
  now?: () => Date;
}

export function createAdminMessagingRouter(prisma: PrismaClient, jwtSecret: string, options: AdminMessagingOptions = {}): Router {
  const router = Router();
  const clock = options.now ?? (() => new Date());
  const adminId = (req: unknown) => (req as AuthenticatedAdminRequest).adminUser!.adminUserId;
  const view = requirePlatformPermission("admin:view_messaging");
  const manage = [requirePlatformPermission("admin:manage_messaging"), requireStepUp(prisma, jwtSecret, "admin:manage_messaging")];
  const approve = [requirePlatformPermission("admin:approve_templates"), requireStepUp(prisma, jwtSecret, "admin:approve_templates")];

  // ------------------------------------------------------------------------------------ reads

  router.get("/messaging/overview", view, asyncHandler(async (_req, res) => {
    const now = clock();
    const d30 = new Date(now.getTime() - 30 * DAY_MS);
    const d7 = new Date(now.getTime() - 7 * DAY_MS);
    const d1 = new Date(now.getTime() - DAY_MS);
    // Sequential on purpose: thirteen simultaneous queries need thirteen connections, and this is an occasional operator page, not a hot path.
    const templates = await prisma.messageTemplate.groupBy({ by: ["status"], _count: { _all: true } });
    const consents = await prisma.contactConsent.groupBy({ by: ["purpose", "status"], _count: { _all: true } });
    const blocked = await prisma.blockedNumber.count({ where: { liftedAt: null } });
    const outbound = await prisma.outboundMessageLog.groupBy({ by: ["decision"], where: { createdAt: { gte: d30 } }, _count: { _all: true } });
    const reasons = await prisma.outboundMessageLog.groupBy({ by: ["reason"], where: { decision: "SUPPRESSED", createdAt: { gte: d30 } }, _count: { _all: true }, orderBy: { _count: { reason: "desc" } }, take: 8 });
    const in1 = await prisma.whatsAppMessage.count({ where: { direction: "INBOUND", createdAt: { gte: d1 } } });
    const in7 = await prisma.whatsAppMessage.count({ where: { direction: "INBOUND", createdAt: { gte: d7 } } });
    const out1 = await prisma.whatsAppMessage.count({ where: { direction: "OUTBOUND", createdAt: { gte: d1 } } });
    const out7 = await prisma.whatsAppMessage.count({ where: { direction: "OUTBOUND", createdAt: { gte: d7 } } });
    const parses = await prisma.aiParseLog.groupBy({ by: ["validationPassed"], where: { createdAt: { gte: d7 } }, _count: { _all: true } });
    const stuck = await prisma.webhookEvent.count({ where: { status: "PENDING", receivedAt: { lt: new Date(now.getTime() - REDRIVE_GRACE_MS) } } });
    const channel = await alertChannelStatus(prisma, now);
    const flagDefault = await prisma.featureFlag.findUnique({ where: { key: FLAG_CONSUMER_MESSAGING } });

    const passed = parses.find((p) => p.validationPassed)?._count._all ?? 0;
    const failed = parses.find((p) => !p.validationPassed)?._count._all ?? 0;
    res.json({
      consumerMessaging: { platformSwitchOn: consumerMessagingSwitchOn(), globalDefault: flagDefault?.enabledByDefault ?? false },
      templatesByStatus: Object.fromEntries(templates.map((t) => [t.status, t._count._all])),
      consents: consents.map((c) => ({ purpose: c.purpose, status: c.status, count: c._count._all })),
      blockedNumbers: blocked,
      outbound30d: Object.fromEntries(outbound.map((o) => [o.decision, o._count._all])),
      suppressionReasons30d: reasons.map((r) => ({ reason: r.reason ?? "(none)", count: r._count._all })),
      volumes: { inbound24h: in1, inbound7d: in7, outbound24h: out1, outbound7d: out7 },
      // Only parses where a model was asked: a validation pass means the model's reply satisfied the schema, NOT that it was right.
      aiParse7d: { total: passed + failed, validationPassed: passed, validationFailed: failed, successRate: passed + failed > 0 ? Math.round((passed / (passed + failed)) * 1000) / 10 : null },
      stuckInbound: stuck,
      alertChannel: channel,
      localization: localeCoverage(),
      generatedAt: now,
    });
  }));

  router.get("/messaging/templates", view, asyncHandler(async (_req, res) => {
    const rows = await prisma.messageTemplate.findMany();
    res.json({
      templates: MESSAGE_CLASSES.map((c) => {
        const row = rows.find((r) => r.messageClass === c.id && r.language === "en");
        const needsTemplate = c.pipeline === "ENFORCED" && c.windowRule !== "SESSION_ONLY";
        return {
          messageClass: c.id, audience: c.audience, category: c.category, pipeline: c.pipeline, trigger: c.trigger, consentBasis: c.consentBasis, windowRule: c.windowRule,
          body: c.bodyKey ? CATALOG[c.bodyKey].en : null, needsTemplate,
          status: needsTemplate ? (row?.status ?? "NOT_SUBMITTED") : c.pipeline === "ENFORCED" || c.pipeline === "REPLY" ? "NOT_NEEDED" : "LEGACY",
          providerTemplateName: row?.providerTemplateName ?? null, approvalReference: row?.approvalReference ?? null, disabledReason: row?.disabledReason ?? null, updatedAt: row?.updatedAt ?? null,
        };
      }),
    });
  }));

  router.get("/messaging/consents", view, asyncHandler(async (req, res) => {
    const page = parsePaginationParams(req.query);
    const q = typeof req.query["phone"] === "string" ? digitsOnly(req.query["phone"]) : "";
    const status = req.query["status"] === "OPTED_IN" || req.query["status"] === "OPTED_OUT" ? req.query["status"] : undefined;
    const rows = await prisma.contactConsent.findMany({
      where: { ...(q.length >= 4 ? { phone: q.length >= 8 ? q : { endsWith: q } } : {}), ...(status ? { status } : {}) },
      include: { business: { select: { name: true } } }, orderBy: { updatedAt: "desc" }, take: page.take + 1, skip: page.skip,
    });
    const { items, pagination } = paginate(rows, page);
    res.json({ consents: items.map((c) => ({ id: c.id, phone: maskPhone(c.phone), business: c.business.name, purpose: c.purpose, status: c.status, basis: c.basis, textVersion: c.textVersion, updatedAt: c.updatedAt })), pagination });
  }));

  router.get("/messaging/blocks", view, asyncHandler(async (req, res) => {
    const page = parsePaginationParams(req.query);
    const rows = await prisma.blockedNumber.findMany({ orderBy: { createdAt: "desc" }, take: page.take + 1, skip: page.skip });
    const { items, pagination } = paginate(rows, page);
    res.json({ blocks: items.map((b) => ({ id: b.id, phone: maskPhone(b.phone), source: b.source, reason: b.reason, active: b.liftedAt === null, createdAt: b.createdAt, liftedAt: b.liftedAt, liftReason: b.liftReason })), pagination });
  }));

  router.get("/messaging/outbound", view, asyncHandler(async (req, res) => {
    const page = parsePaginationParams(req.query);
    const decision = ["SENT", "SUPPRESSED", "FAILED"].includes(String(req.query["decision"])) ? (String(req.query["decision"]) as "SENT" | "SUPPRESSED" | "FAILED") : undefined;
    const cls = typeof req.query["messageClass"] === "string" && messageClass(req.query["messageClass"]) ? req.query["messageClass"] : undefined;
    const rows = await prisma.outboundMessageLog.findMany({ where: { ...(decision ? { decision } : {}), ...(cls ? { messageClass: cls } : {}) }, orderBy: { createdAt: "desc" }, take: page.take + 1, skip: page.skip });
    const { items, pagination } = paginate(rows, page);
    res.json({ messages: items.map((m) => ({ id: m.id, messageClass: m.messageClass, audience: m.audience, to: `••••${m.toPhoneLast4}`, decision: m.decision, reason: m.reason, templateKey: m.templateKey, relatedType: m.relatedType, createdAt: m.createdAt })), pagination });
  }));

  router.get("/messaging/inbound/stuck", view, asyncHandler(async (_req, res) => {
    const now = clock();
    const rows = await prisma.webhookEvent.findMany({ where: { status: "PENDING", receivedAt: { lt: new Date(now.getTime() - REDRIVE_GRACE_MS) } }, orderBy: { receivedAt: "asc" }, take: 50 });
    res.json({
      events: rows.map((e) => {
        const parsed = parseWhatsAppWebhookPayload(e.payload);
        const msg = parsed.success ? extractInboundMessages(parsed.data).find((m) => m.message.id === e.waMessageId) : undefined;
        const ageMs = now.getTime() - e.receivedAt.getTime();
        return { id: e.id, waMessageId: e.waMessageId, receivedAt: e.receivedAt, from: msg ? maskPhone(msg.message.from) : null, messageType: msg?.message.type ?? null, replayable: !!msg && ageMs <= REDRIVE_MAX_AGE_MS, tooOld: ageMs > REDRIVE_MAX_AGE_MS };
      }),
    });
  }));

  router.get("/messaging/alert-channel", view, asyncHandler(async (req, res) => {
    const page = parsePaginationParams(req.query);
    const rows = await prisma.alertDelivery.findMany({ orderBy: { createdAt: "desc" }, take: page.take + 1, skip: page.skip });
    const { items, pagination } = paginate(rows, page);
    res.json({ status: await alertChannelStatus(prisma, clock()), deliveries: items, pagination });
  }));

  // ------------------------------------------------------------------------------------ writes

  const templateBody = z.object({
    status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"]),
    providerTemplateName: z.string().trim().min(3).max(120).regex(/^[a-z0-9_]+$/, "Lower-case letters, digits and underscores only.").optional(),
    approvalReference: z.string().trim().min(3).max(200).optional(),
    reason,
  });
  const findClass = (id: string) => {
    const def = messageClass(id);
    return def && def.pipeline === "ENFORCED" && def.windowRule !== "SESSION_ONLY" && def.bodyKey ? def : null;
  };

  // Recording an approval (or submission) is the only way a template can ever become sendable. It records a fact about the provider's
  // dashboard; nothing here talks to Meta.
  router.put("/messaging/templates/:messageClass", ...approve, asyncHandler(async (req, res) => {
    const parsed = templateBody.safeParse(req.body);
    const def = findClass(String(req.params["messageClass"]));
    if (!def) return void res.status(404).json({ error: "That message class does not use a template." });
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const b = parsed.data;
    if (b.status === "APPROVED" && (!b.providerTemplateName || !b.approvalReference)) return void res.status(400).json({ error: "An approval needs the provider template name and where the approval can be checked." });
    const data = { category: def.category, status: b.status, providerTemplateName: b.providerTemplateName ?? null, approvalReference: b.approvalReference ?? null, bodyPreview: CATALOG[def.bodyKey!].en, paramCount: def.paramCount, disabledReason: null, updatedBy: adminId(req) };
    const row = await prisma.messageTemplate.upsert({ where: { messageClass_language: { messageClass: def.id, language: "en" } }, create: { messageClass: def.id, language: "en", ...data }, update: data });
    res.json({ messageClass: row.messageClass, status: row.status });
  }));

  router.post("/messaging/templates/:messageClass/disable", ...manage, asyncHandler(async (req, res) => {
    const parsed = z.object({ reason }).safeParse(req.body);
    const def = findClass(String(req.params["messageClass"]));
    if (!def) return void res.status(404).json({ error: "That message class does not use a template." });
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const row = await prisma.messageTemplate.findUnique({ where: { messageClass_language: { messageClass: def.id, language: "en" } } });
    if (!row) return void res.status(409).json({ error: "This template was never submitted, so there is nothing to disable." });
    const changed = await prisma.messageTemplate.updateMany({ where: { id: row.id, status: { not: "DISABLED" } }, data: { status: "DISABLED", disabledReason: parsed.data.reason, updatedBy: adminId(req) } });
    if (changed.count !== 1) return void res.status(409).json({ error: "It is already disabled." });
    res.json({ messageClass: def.id, status: "DISABLED" });
  }));

  const blockBody = z.object({ phone: z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/), reason });
  router.post("/messaging/blocks", ...manage, asyncHandler(async (req, res) => {
    const parsed = blockBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const phone = digitsOnly(parsed.data.phone);
    if (!/^[0-9]{8,15}$/.test(phone)) return void res.status(400).json({ error: "That is not a valid phone number." });
    await adminBlock(prisma, { phone, reason: parsed.data.reason, adminUserId: adminId(req) });
    res.status(201).json({ phone: maskPhone(phone), blocked: true });
  }));

  router.post("/messaging/blocks/unblock", ...manage, asyncHandler(async (req, res) => {
    const parsed = blockBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    const lifted = await adminUnblock(prisma, { phone: digitsOnly(parsed.data.phone), reason: parsed.data.reason, adminUserId: adminId(req) });
    if (!lifted) return void res.status(404).json({ error: "That number is not blocked." });
    // Unblocking never re-opts anyone in: any consent the person withdrew stays withdrawn until they opt in again themselves.
    res.json({ phone: maskPhone(digitsOnly(parsed.data.phone)), blocked: false, consentsRestored: 0 });
  }));

  router.post("/messaging/inbound/:id/replay", ...manage, asyncHandler(async (req, res) => {
    const parsedBody = z.object({ reason }).safeParse(req.body);
    if (!parsedBody.success) return void res.status(400).json({ error: "Invalid request body.", details: parsedBody.error.issues });
    if (!options.replayInbound) return void res.status(501).json({ error: "Replay is not available on this server (the message queue is not connected)." });
    const now = clock();
    const event = await prisma.webhookEvent.findUnique({ where: { id: String(req.params["id"]) } });
    if (!event) return void res.status(404).json({ error: "Message not found." });
    if (event.status !== "PENDING") return void res.status(409).json({ error: "That message was already processed." });
    const age = now.getTime() - event.receivedAt.getTime();
    if (age < REDRIVE_GRACE_MS) return void res.status(409).json({ error: "That message is still being processed normally; wait a few minutes." });
    // Older than WhatsApp's 24-hour window: re-running it would record its effect but could not answer it.
    if (age > REDRIVE_MAX_AGE_MS) return void res.status(409).json({ error: "That message is too old to replay: WhatsApp would not let TradePal answer it." });
    const parsed = parseWhatsAppWebhookPayload(event.payload);
    const found = parsed.success ? extractInboundMessages(parsed.data).find((m) => m.message.id === event.waMessageId) : undefined;
    if (!found) return void res.status(409).json({ error: "The stored message can no longer be read." });
    const outcome = await options.replayInbound({ webhookEventId: event.id, waMessageId: event.waMessageId, fromNumber: found.message.from, toNumber: found.toNumber, messageType: found.message.type });
    res.json({ id: event.id, outcome });
  }));

  router.post("/messaging/alert-channel/check", ...manage, asyncHandler(async (_req, res) => {
    const outcome = await verifyAlertChannel(options.alertDeps, clock());
    res.status(outcome.delivered ? 200 : 502).json({ delivered: outcome.delivered, httpStatus: outcome.httpStatus ?? null, error: outcome.error ?? null, note: outcome.delivered ? "The email service accepted the test message. Check the inbox to be sure it arrived." : "The test message was not accepted. See the error." });
  }));

  return router;
}
