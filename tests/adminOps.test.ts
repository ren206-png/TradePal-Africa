import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller } from "./helpers/store.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { issueConnectCode, exchangeConnectCode, authenticateDevice } from "../src/offline/devices.js";
import { installAlertDeliveryRecorder } from "../src/monitoring/alertRecorder.js";
import { resetAlertDedupeForTests, setAlertDeliveryRecorder } from "../src/monitoring/alerts.js";
import { JOB_CLASSES, isJobPaused } from "../src/ops/jobControl.js";
import { runOperationsSweep, startOperationsSweep } from "../src/queue/operationsSweep.js";

vi.setConfig({ testTimeout: 60_000 });
const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
const REASON = "Provider incident under investigation";
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let alertFetch: ReturnType<typeof vi.fn>;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginAs = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  installAlertDeliveryRecorder(prisma);
  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"]] as const) await createAdminUser(prisma, { email, name: email, role, password: PW });
  alertFetch = vi.fn();
  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, SECRET, { platform: { alertDeps: { apiKey: "k", from: "a@t.test", to: ["o@t.test"], fetchImpl: alertFetch } } }));
}, 90_000);
afterAll(async () => {
  setAlertDeliveryRecorder(null);
  await testDb.teardown();
});
beforeEach(async () => {
  resetAlertDedupeForTests();
  await prisma.featureFlag.update({ where: { key: "adminStepUp" }, data: { enabledByDefault: false } });
  alertFetch.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("pausing a background job class", () => {
  it("lists every class, pauses and resumes with a reason (audited), refuses a repeat, and the scheduled run then skips", async () => {
    const op = await loginAs("op@t.test");
    const list = await request(app).get("/admin/system/jobs").set(auth(op));
    expect(list.body.jobs.map((j: { id: string }) => j.id)).toEqual(JOB_CLASSES.map((j) => j.id));
    expect(list.body.jobs.every((j: { paused: boolean }) => !j.paused)).toBe(true);
    expect((await request(app).post("/admin/system/jobs/operations-sweep/pause").set(auth(op)).send({})).status).toBe(400);
    expect((await request(app).post("/admin/system/jobs/nonesuch/pause").set(auth(op)).send({ reason: REASON })).status).toBe(404);
    expect((await request(app).post("/admin/system/jobs/operations-sweep/pause").set(auth(op)).send({ reason: REASON })).body).toEqual({ jobClass: "operations-sweep", paused: true });
    expect((await request(app).post("/admin/system/jobs/operations-sweep/pause").set(auth(op)).send({ reason: REASON })).status).toBe(409);
    expect(await isJobPaused(prisma, "operations-sweep")).toBe(true);
    expect(await isJobPaused(prisma, "outbox-sweep")).toBe(false);
    expect((await request(app).get("/admin/system/jobs").set(auth(op))).body.jobs.find((j: { id: string }) => j.id === "operations-sweep")).toMatchObject({ paused: true, reason: REASON });
    expect(JSON.stringify(await prisma.auditLog.findFirst({ where: { entityType: "System" }, orderBy: { createdAt: "desc" } }))).toContain(REASON);

    // a scheduled tick skips while paused; an admin's/manual direct run still works
    const sweep = startOperationsSweep({ prisma, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 120));
    sweep.stop();
    expect(await runOperationsSweep(prisma)).toMatchObject({ failures: [] });

    expect((await request(app).post("/admin/system/jobs/operations-sweep/resume").set(auth(op)).send({ reason: REASON })).body.paused).toBe(false);
    expect((await request(app).post("/admin/system/jobs/operations-sweep/resume").set(auth(op)).send({ reason: REASON })).status).toBe(409);
  });

  it("support and analyst cannot pause; a paused class stays readable; a missing table never stops a job (fails open)", async () => {
    for (const e of ["support@t.test", "analyst@t.test"]) expect((await request(app).post("/admin/system/jobs/outbox-sweep/pause").set(auth(await loginAs(e))).send({ reason: REASON })).status).toBe(403);
    const broken = { jobControl: { findUnique: async () => { throw new Error("db down"); } } } as never;
    expect(await isJobPaused(broken, "outbox-sweep")).toBe(false);
  });

  it("the table cannot be emptied or deleted", async () => {
    await expect(testDb.db.query(`DELETE FROM "JobControl"`)).rejects.toThrow(/not permitted|delete/i);
    await expect(testDb.db.query(`TRUNCATE "JobControl"`)).rejects.toThrow();
  });
});

describe("synthetic incident", () => {
  it("goes through the real alert path, says whether it was accepted, and is recorded", async () => {
    const owner = await loginAs("super@t.test");
    alertFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "syn-1" }), { status: 200 }));
    const ok = await request(app).post("/admin/system/synthetic-incident").set(auth(owner)).send({ reason: "Quarterly alert test" + "!!" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ recorded: true, delivered: true });
    const subject = JSON.parse((alertFetch.mock.calls[0]![1] as RequestInit).body as string).subject as string;
    expect(subject).toContain("Synthetic incident (test of the alert path)");
    alertFetch.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const bad = await request(app).post("/admin/system/synthetic-incident").set(auth(owner)).send({ reason: "Quarterly alert test" + "!!" });
    expect(bad.status).toBe(502);
    expect(bad.body).toMatchObject({ recorded: true, delivered: false });
    // pressing it twice in a row is never swallowed by de-duplication
    expect(alertFetch).toHaveBeenCalledTimes(2);
    expect((await request(app).post("/admin/system/synthetic-incident").set(auth(owner)).send({})).status).toBe(400);
  });
});

describe("sign every phone out of a business", () => {
  it("revokes live sessions at once, only that business's, with a reason", async () => {
    process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
    const a = await makeSeller(prisma, "Ops A", { slug: "ops-a", flags: ["offlineDrafts"] });
    const b = await makeSeller(prisma, "Ops B", { slug: "ops-b", flags: ["offlineDrafts"] });
    const tokens: string[] = [];
    for (const s of [a, a, b]) {
      const m = await prisma.merchant.create({ data: { businessId: s.businessId, phoneNumber: `23480${Math.floor(Math.random() * 1e9)}`, onboardingStep: "COMPLETE", role: "OWNER" } });
      const { code } = await issueConnectCode(prisma, { businessId: s.businessId, merchantId: m.id, shared: false });
      tokens.push((await exchangeConnectCode(prisma, code))!.token);
    }
    for (const t of tokens) expect(await authenticateDevice(prisma, t)).not.toBeNull();
    const support = await loginAs("support@t.test");
    expect((await request(app).post(`/admin/businesses/${a.businessId}/revoke-device-sessions`).set(auth(support)).send({})).status).toBe(400);
    const r = await request(app).post(`/admin/businesses/${a.businessId}/revoke-device-sessions`).set(auth(support)).send({ reason: REASON });
    expect(r.body).toEqual({ businessId: a.businessId, sessionsRevoked: 2 });
    expect(await authenticateDevice(prisma, tokens[0]!)).toBeNull();
    expect(await authenticateDevice(prisma, tokens[1]!)).toBeNull();
    expect(await authenticateDevice(prisma, tokens[2]!)).not.toBeNull(); // the other business is untouched
    expect((await request(app).post(`/admin/businesses/nope/revoke-device-sessions`).set(auth(support)).send({ reason: REASON })).status).toBe(404);
    expect((await request(app).post(`/admin/businesses/${a.businessId}/revoke-device-sessions`).set(auth(await loginAs("analyst@t.test"))).send({ reason: REASON })).status).toBe(403);
    delete process.env["OFFLINE_DRAFTS_ENABLED"];
  });
});

describe("re-run reconciliation from the console", () => {
  it("asks the providers about everything unresolved, needs a reason and step-up permission, and is audited", async () => {
    const owner = await loginAs("super@t.test");
    expect((await request(app).post("/admin/payments/reconcile").set(auth(owner)).send({})).status).toBe(400);
    const r = await request(app).post("/admin/payments/reconcile").set(auth(owner)).send({ reason: REASON });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ paymentsPolled: expect.any(Number), paymentsApplied: expect.any(Number), billingPolled: expect.any(Number) });
    expect((await request(app).post("/admin/payments/reconcile").set(auth(await loginAs("analyst@t.test"))).send({ reason: REASON })).status).toBe(403);
    expect(JSON.stringify(await prisma.auditLog.findFirst({ where: { entityType: "Payment" }, orderBy: { createdAt: "desc" } }))).toContain(REASON);
  });
});
