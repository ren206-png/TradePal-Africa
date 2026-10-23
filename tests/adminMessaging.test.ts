import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, type Seller } from "./helpers/store.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { STEP_UP_HEADER } from "../src/admin/platformGuards.js";
import { applyStop } from "../src/messaging/consent.js";
import { recordVerifiedConsent as recordOrderUpdatesConsent } from "./helpers/consent.js";
import { MESSAGE_CLASSES } from "../src/messaging/registry.js";
import { sendMessage } from "../src/messaging/send.js";
import { resetAlertDedupeForTests, setAlertDeliveryRecorder } from "../src/monitoring/alerts.js";
import { installAlertDeliveryRecorder } from "../src/monitoring/alertRecorder.js";

vi.setConfig({ testTimeout: 60_000 });

const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let s: Seller;
let replay: ReturnType<typeof vi.fn>;
let alertFetch: ReturnType<typeof vi.fn>;
const PHONE = "2348031234567";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginAs = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
const setFlag = (key: string, on: boolean) => prisma.featureFlag.update({ where: { key }, data: { enabledByDefault: on } });
const REASON = "Verified in the provider dashboard today";

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  installAlertDeliveryRecorder(prisma);
  s = await makeSeller(prisma, "Msg Admin Shop", { slug: "msg-admin-shop", flags: ["consumerMessaging"] });
  await recordOrderUpdatesConsent(prisma, { businessId: s.businessId, phone: PHONE });
  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  replay = vi.fn().mockResolvedValue("QUEUED");
  alertFetch = vi.fn();
  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, SECRET, { platform: { alertDeps: { apiKey: "k", from: "a@t.test", to: ["o@t.test"], fetchImpl: alertFetch }, replayInbound: replay } }));
}, 90_000);
afterAll(async () => {
  setAlertDeliveryRecorder(null);
  await testDb.teardown();
});
beforeEach(async () => {
  resetAlertDedupeForTests();
  await setFlag("adminStepUp", false);
  await setFlag("adminSupportAccessRequired", false);
  replay.mockClear();
  alertFetch.mockReset();
});

describe("who can see and change what", () => {
  it("reads: owner, operator and support yes (numbers masked); analyst no; writes: operator no for approvals", async () => {
    for (const email of ["super@t.test", "op@t.test", "support@t.test"]) {
      const t = await loginAs(email);
      for (const path of ["overview", "templates", "consents", "blocks", "outbound", "inbound/stuck", "alert-channel"]) {
        expect((await request(app).get(`/admin/messaging/${path}`).set(auth(t))).status, `${email} ${path}`).toBe(200);
      }
    }
    expect((await request(app).get("/admin/messaging/overview").set(auth(await loginAs("analyst@t.test")))).status).toBe(403);
    // support cannot write; operator can manage but cannot approve templates
    const support = await loginAs("support@t.test");
    expect((await request(app).post("/admin/messaging/blocks").set(auth(support)).send({ phone: "2348000000001", reason: REASON })).status).toBe(403);
    const op = await loginAs("op@t.test");
    expect((await request(app).put("/admin/messaging/templates/CONSUMER_ORDER_CONFIRMED").set(auth(op)).send({ status: "SUBMITTED", reason: REASON })).status).toBe(403);
  });

  it("requires a fresh step-up for every write when it is switched on", async () => {
    await setFlag("adminStepUp", true);
    const tok = await loginAs("super@t.test");
    const r = await request(app).post("/admin/messaging/blocks").set(auth(tok)).send({ phone: "2348000000002", reason: REASON });
    expect(r.status).toBe(403);
    const step = await request(app).post("/admin/step-up").set(auth(tok)).send({ password: PW });
    const ok = await request(app).post("/admin/messaging/blocks").set(auth(tok)).set(STEP_UP_HEADER, step.body.stepUpToken).send({ phone: "2348000000002", reason: REASON });
    expect(ok.status).toBe(201);
  });
});

describe("the template register", () => {
  it("lists every registered class with its real state, and nothing is approved by default", async () => {
    const t = await loginAs("super@t.test");
    const r = await request(app).get("/admin/messaging/templates").set(auth(t));
    expect(r.body.templates).toHaveLength(MESSAGE_CLASSES.length);
    const confirmed = r.body.templates.find((x: { messageClass: string }) => x.messageClass === "CONSUMER_ORDER_CONFIRMED");
    expect(confirmed).toMatchObject({ needsTemplate: true, status: "NOT_SUBMITTED", providerTemplateName: null });
    expect(confirmed.body).toContain("{seller}");
    expect(r.body.templates.filter((x: { status: string }) => x.status === "APPROVED")).toEqual([]);
    expect(r.body.templates.find((x: { messageClass: string }) => x.messageClass === "MERCHANT_WEEKLY_DIGEST").status).toBe("LEGACY");
  });

  it("an approval needs the provider name and a reference, makes the class sendable, and disabling stops it at once", async () => {
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    const owner = await loginAs("super@t.test");
    const put = (body: object) => request(app).put("/admin/messaging/templates/CONSUMER_ORDER_READY").set(auth(owner)).send({ reason: REASON, ...body });
    expect((await put({ status: "APPROVED" })).status).toBe(400);
    expect((await put({ status: "APPROVED", providerTemplateName: "Bad Name!", approvalReference: "meta:1" })).status).toBe(400);
    expect((await request(app).put("/admin/messaging/templates/MERCHANT_REPLY").set(auth(owner)).send({ status: "SUBMITTED", reason: REASON })).status).toBe(404);
    expect((await put({ status: "APPROVED", providerTemplateName: "order_ready_v1", approvalReference: "meta:tpl:123" })).body.status).toBe("APPROVED");

    const sent: string[] = [];
    const transport = { sendText: vi.fn(), sendTemplate: vi.fn(async (_to: string, name: string) => { sent.push(name); return { providerMessageId: "w1" }; }) };
    const send = (key: string) => sendMessage(prisma, transport, { classId: "CONSUMER_ORDER_READY", toPhone: PHONE, businessId: s.businessId, params: { seller: "S", reference: "R" }, idempotencyKey: key });
    expect((await send("adm:1")).decision).toBe("SENT");

    const op = await loginAs("op@t.test");
    const off = await request(app).post("/admin/messaging/templates/CONSUMER_ORDER_READY/disable").set(auth(op)).send({ reason: REASON });
    expect(off.body.status).toBe("DISABLED");
    expect((await send("adm:2")).reason).toBe("TEMPLATE_NOT_APPROVED");
    expect((await request(app).post("/admin/messaging/templates/CONSUMER_ORDER_READY/disable").set(auth(op)).send({ reason: REASON })).status).toBe(409);
    expect(sent).toEqual(["order_ready_v1"]);
    delete process.env["CONSUMER_MESSAGING_ENABLED"];
  });

  it("audits every write with the admin, the target and the reason", async () => {
    const owner = await loginAs("super@t.test");
    await request(app).put("/admin/messaging/templates/CONSUMER_ORDER_CANCELLED").set(auth(owner)).send({ status: "SUBMITTED", reason: REASON });
    const row = await prisma.auditLog.findFirst({ where: { entityType: "Messaging" }, orderBy: { createdAt: "desc" } });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).toContain(REASON);
  });
});

describe("consent, opt-out and the block list", () => {
  it("shows consent records with masked numbers, searchable by the last four or the whole number", async () => {
    const t = await loginAs("support@t.test");
    const all = await request(app).get("/admin/messaging/consents").set(auth(t));
    expect(JSON.stringify(all.body)).not.toContain(PHONE);
    const row = all.body.consents.find((c: { business: string }) => c.business === "Msg Admin Shop");
    expect(row).toMatchObject({ phone: "••••4567", purpose: "ORDER_UPDATES", status: "OPTED_IN", textVersion: "order-updates-v2" });
    expect((await request(app).get("/admin/messaging/consents?phone=4567").set(auth(t))).body.consents.length).toBeGreaterThan(0);
    expect((await request(app).get(`/admin/messaging/consents?phone=${PHONE}`).set(auth(t))).body.consents.length).toBeGreaterThan(0);
    expect((await request(app).get("/admin/messaging/consents?phone=9999").set(auth(t))).body.consents).toEqual([]);
  });

  it("blocks and unblocks a number with a reason, never exposing it, and an unblock does not re-opt anyone in", async () => {
    const owner = await loginAs("super@t.test");
    const phone = "2348066667777";
    await recordOrderUpdatesConsent(prisma, { businessId: s.businessId, phone });
    await applyStop(prisma, phone);
    const blocked = await request(app).post("/admin/messaging/blocks").set(auth(owner)).send({ phone: `+${phone}`, reason: REASON });
    expect(blocked.status).toBe(201);
    expect(JSON.stringify(blocked.body)).not.toContain(phone);
    expect((await request(app).post("/admin/messaging/blocks").set(auth(owner)).send({ phone: "12", reason: REASON })).status).toBe(400);
    const list = await request(app).get("/admin/messaging/blocks").set(auth(owner));
    expect(list.body.blocks.find((b: { phone: string; source: string }) => b.phone === "••••7777")).toMatchObject({ source: "ADMIN", active: true });
    expect((await request(app).post("/admin/messaging/blocks/unblock").set(auth(owner)).send({ phone, reason: REASON })).body).toMatchObject({ blocked: false, consentsRestored: 0 });
    expect((await prisma.contactConsent.findFirstOrThrow({ where: { phone } })).status).toBe("OPTED_OUT");
    expect((await request(app).post("/admin/messaging/blocks/unblock").set(auth(owner)).send({ phone, reason: REASON })).status).toBe(404);
  });

  it("shows the outbound log (masked) and the overview counts", async () => {
    const t = await loginAs("operator@t.test".replace("operator", "op"));
    const ov = await request(app).get("/admin/messaging/overview").set(auth(t));
    expect(ov.body.consumerMessaging.platformSwitchOn).toBe(false);
    expect(ov.body.localization.find((l: { code: string }) => l.code === "kri")).toMatchObject({ status: "MISSING", keysServed: 0 });
    expect(ov.body).toHaveProperty("aiParse7d");
    const out = await request(app).get("/admin/messaging/outbound?decision=SENT").set(auth(t));
    expect(JSON.stringify(out.body)).not.toContain(PHONE);
    expect(out.body.messages.every((m: { to: string }) => m.to.startsWith("••••"))).toBe(true);
  });
});

describe("stuck inbound messages", () => {
  async function stuckEvent(ageMs: number, status: "PENDING" | "PROCESSED" = "PENDING") {
    const id = `wamid.stuck.${Math.random().toString(16).slice(2)}`;
    const payload = { object: "whatsapp_business_account", entry: [{ id: "e", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: "p" }, messages: [{ id, from: "2348055551111", timestamp: "1700000000", type: "text", text: { body: "sold bread 500" } }] } }] }] };
    return prisma.webhookEvent.create({ data: { waMessageId: id, payload, status, receivedAt: new Date(Date.now() - ageMs) } });
  }

  it("lists what is stuck (masked) and replays it once, with a reason", async () => {
    const e = await stuckEvent(10 * 60_000);
    const owner = await loginAs("super@t.test");
    const list = await request(app).get("/admin/messaging/inbound/stuck").set(auth(owner));
    const item = list.body.events.find((x: { id: string }) => x.id === e.id);
    expect(item).toMatchObject({ from: "••••1111", replayable: true, tooOld: false });
    expect((await request(app).post(`/admin/messaging/inbound/${e.id}/replay`).set(auth(owner)).send({})).status).toBe(400);
    const r = await request(app).post(`/admin/messaging/inbound/${e.id}/replay`).set(auth(owner)).send({ reason: REASON });
    expect(r.body.outcome).toBe("QUEUED");
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ webhookEventId: e.id, waMessageId: e.waMessageId, fromNumber: "2348055551111" }));
  });

  it("refuses to replay a message that is fresh, already processed, or too old to answer", async () => {
    const owner = await loginAs("super@t.test");
    const go = (id: string) => request(app).post(`/admin/messaging/inbound/${id}/replay`).set(auth(owner)).send({ reason: REASON });
    expect((await go((await stuckEvent(60_000)).id)).status).toBe(409);
    expect((await go((await stuckEvent(10 * 60_000, "PROCESSED")).id)).status).toBe(409);
    expect((await go((await stuckEvent(30 * 3_600_000)).id)).status).toBe(409);
    expect((await go("nope")).status).toBe(404);
    expect(replay).not.toHaveBeenCalled();
  });
});

describe("the alert channel (scenario 26)", () => {
  it("a check reports whether the email service accepted it, and the overview and system health show the last proven delivery", async () => {
    const owner = await loginAs("super@t.test");
    alertFetch.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const bad = await request(app).post("/admin/messaging/alert-channel/check").set(auth(owner)).send({});
    expect(bad.status).toBe(502);
    expect(bad.body).toMatchObject({ delivered: false, httpStatus: 403 });
    let health = await request(app).get("/admin/system-health").set(auth(owner));
    expect(health.body.alertChannel.needsAttention).toBe(true);
    expect(health.body.alertChannel.lastFailedAt).not.toBeNull();

    alertFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "chk-9" }), { status: 200 }));
    const good = await request(app).post("/admin/messaging/alert-channel/check").set(auth(owner)).send({});
    expect(good.status).toBe(200);
    expect(good.body.delivered).toBe(true);
    health = await request(app).get("/admin/system-health").set(auth(owner));
    expect(health.body.alertChannel).toMatchObject({ needsAttention: false, lastChannelCheckStatus: "DELIVERED" });
    const log = await request(app).get("/admin/messaging/alert-channel").set(auth(owner));
    expect(log.body.deliveries[0]).toMatchObject({ kind: "CHANNEL_CHECK", status: "DELIVERED", providerMessageId: "chk-9" });
  });
});
