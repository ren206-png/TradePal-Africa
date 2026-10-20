import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { PHONE, billingWorld, makeSlBusiness, publishedPlan, seedSierraLeone } from "./helpers/billing.js";
import type { PawaPayFake } from "./helpers/pawapayFake.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { STEP_UP_HEADER } from "../src/admin/platformGuards.js";
import { setBillingConfig, type BillingConfig } from "../src/domain/subscriptions/common.js";
import { startRenewal } from "../src/domain/subscriptions/renewal.js";
import { applyBillingDeposit, applyBillingRefund } from "../src/domain/subscriptions/collection.js";

vi.setConfig({ testTimeout: 60_000 });

const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let fake: PawaPayFake;
let cfg: BillingConfig;
const reminders: { to: string; body: string }[] = [];

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginAs = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
const setFlag = (key: string, on: boolean) => prisma.featureFlag.update({ where: { key }, data: { enabledByDefault: on } });

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  await seedSierraLeone(prisma);
  ({ fake, cfg } = await billingWorld(prisma));
  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, SECRET, { platform: { sendRenewalReminder: async (to, body) => { reminders.push({ to, body }); } } }));
}, 90_000);
afterAll(async () => {
  setBillingConfig(null);
  await testDb.teardown();
});
beforeEach(async () => {
  await setFlag("adminStepUp", false);
  await setFlag("adminSupportAccessRequired", false);
});

async function paid(name?: string) {
  await publishedPlan(prisma, "STARTER");
  const b = await makeSlBusiness(prisma, { ...(name ? { name } : {}) });
  const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" });
  fake.complete(s.depositId);
  await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", new Date());
  const sub = await b.scoped.subscription.findFirstOrThrow({ where: {} });
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { reference: s.invoiceReference } });
  return { b, s, sub, invoice };
}

describe("admin subscriptions panel: reading", () => {
  it("shows the overview, list, detail and invoices to owner, operator and support only", async () => {
    const { b, sub, invoice } = await paid("=HYPERLINK(evil) Shop");
    for (const email of ["super@t.test", "op@t.test", "support@t.test"]) {
      const ov = await request(app).get("/admin/subscriptions/overview").set(auth(await loginAs(email)));
      expect(ov.status, email).toBe(200);
      expect(ov.body.states.ACTIVE).toBeGreaterThanOrEqual(1);
      expect(ov.body.configuration).toMatchObject({ configured: true, environment: "SANDBOX", requireSignedCallbacks: true, productionActivated: false });
      expect(ov.body.switches[0]).toMatchObject({ provider: "pawapay", countryCode: "SL", purpose: "PLATFORM_SUBSCRIPTION", newAttemptsEnabled: true });
    }
    expect((await request(app).get("/admin/subscriptions/overview").set(auth(await loginAs("analyst@t.test")))).status).toBe(403);
    expect((await request(app).get("/admin/subscriptions/overview")).status).toBe(401);

    const tok = await loginAs("support@t.test");
    const list = await request(app).get("/admin/subscriptions?state=ACTIVE").set(auth(tok));
    expect(list.body.subscriptions.find((x: { id: string }) => x.id === sub.id)).toMatchObject({ planCode: "STARTER", planVersion: 1, state: "ACTIVE", status: "ACTIVE", country: "SL" });
    expect((await request(app).get("/admin/subscriptions?state=EXPIRED").set(auth(tok))).body.subscriptions.find((x: { id: string }) => x.id === sub.id)).toBeUndefined();
    const detail = await request(app).get(`/admin/subscriptions/${sub.id}`).set(auth(tok));
    expect(detail.body.history.map((h: { kind: string }) => h.kind)).toContain("GRANTED");
    expect(detail.body.invoices[0]).toMatchObject({ reference: invoice.reference, status: "PAID", amountMinor: "500000" });
    expect(detail.body.attempts[0]).toMatchObject({ status: "COMPLETED", environment: "SANDBOX", payerPhoneLast4: "3456" });
    expect(JSON.stringify(detail.body)).not.toContain(PHONE); // the payer's number is not stored, so it cannot be shown
    expect((await request(app).get("/admin/subscriptions/nope").set(auth(tok))).status).toBe(404);
    expect((await request(app).get(`/admin/subscriptions/invoices?businessId=${b.businessId}`).set(auth(tok))).body.invoices).toHaveLength(1);

    const csv = await request(app).get("/admin/subscriptions/invoices.csv").set(auth(tok));
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain(`'=HYPERLINK(evil) Shop`); // formula-safe
    expect(csv.text).not.toMatch(/(^|,)"=HYPERLINK/m);
    expect(await prisma.auditLog.count({ where: { action: "admin.subscriptions.exported" } })).toBe(1);
  });
});

describe("admin subscriptions panel: plan versions", () => {
  it("only the owner can create, price, publish and retire a version; a published one is frozen; nothing is priced by default", async () => {
    const op = await loginAs("op@t.test");
    const owner = await loginAs("super@t.test");
    const body = { features: ["trade", "marketplace"], graceDays: 5, billingPeriodDays: 30, note: "Test version", reason: "Creating a test plan version" };
    expect((await request(app).post("/admin/plan-versions/PRO").set(auth(op)).send(body)).status).toBe(403);
    expect((await request(app).post("/admin/plan-versions/PRO").set(auth(owner)).send({ ...body, features: ["telepathy"] })).status).toBe(400);
    expect((await request(app).post("/admin/plan-versions/PRO").set(auth(owner)).send({ ...body, reason: "short" })).status).toBe(400);
    expect((await request(app).post("/admin/plan-versions/NOPE").set(auth(owner)).send(body)).status).toBe(404);
    const created = await request(app).post("/admin/plan-versions/PRO").set(auth(owner)).set("x-correlation-id", "corr-planver-1").send(body);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await request(app).post(`/admin/plan-versions/${id}/publish`).set(auth(owner)).send({ reason: "Publishing without a price" })).status).toBe(400);
    const price = { countryCode: "SL", priceMinor: "900000", reason: "Setting the Sierra Leone test price" };
    expect((await request(app).put(`/admin/plan-versions/${id}/prices`).set(auth(op)).send(price)).status).toBe(403);
    expect((await request(app).put(`/admin/plan-versions/${id}/prices`).set(auth(owner)).send({ ...price, priceMinor: "0" })).status).toBe(400);
    const priced = await request(app).put(`/admin/plan-versions/${id}/prices`).set(auth(owner)).send(price);
    expect(priced.body).toMatchObject({ countryCode: "SL", currencyCode: "SLE", priceMinor: "900000" });
    expect((await request(app).post(`/admin/plan-versions/${id}/publish`).set(auth(owner)).send({ reason: "Ready to sell in Sierra Leone" })).body.status).toBe("PUBLISHED");
    expect((await request(app).put(`/admin/plan-versions/${id}/prices`).set(auth(owner)).send(price)).body.code).toBe("FROZEN");
    expect((await request(app).post(`/admin/plan-versions/${id}/publish`).set(auth(owner)).send({ reason: "Publishing a second time" })).status).toBe(409);
    const list = await request(app).get("/admin/plan-versions").set(auth(await loginAs("support@t.test")));
    expect(list.body.versions.find((v: { id: string }) => v.id === id)).toMatchObject({ planCode: "PRO", version: 1, status: "PUBLISHED", graceDays: 5, features: ["trade", "marketplace"], prices: [{ countryCode: "SL", priceMinor: "900000" }] });
    expect(list.body.knownFeatures).toContain("marketplace");
    expect((await request(app).post(`/admin/plan-versions/${id}/retire`).set(auth(owner)).send({ reason: "Replaced by a newer version" })).body.status).toBe("RETIRED");
    expect((await request(app).delete(`/admin/plan-versions/${id}`).set(auth(owner))).status).toBe(404);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "PlanVersion" } });
    expect(audits.some((a) => (a.metadata as { correlationId?: string })?.correlationId === "corr-planver-1")).toBe(true);
  });
});

describe("admin subscriptions panel: interventions", () => {
  it("adjusts an entitlement with an event naming the admin and the reason, within sane limits; never edits history", async () => {
    const { b, sub } = await paid();
    const owner = await loginAs("super@t.test");
    const target = new Date(sub.currentPeriodEnd.getTime() + 10 * 86_400_000).toISOString();
    expect((await request(app).post(`/admin/subscriptions/${sub.id}/adjust`).set(auth(await loginAs("op@t.test"))).send({ periodEnd: target, reason: "Goodwill extension after an outage" })).status).toBe(403);
    expect((await request(app).post(`/admin/subscriptions/${sub.id}/adjust`).set(auth(owner)).send({ periodEnd: target, reason: "short" })).status).toBe(400);
    expect((await request(app).post(`/admin/subscriptions/${sub.id}/adjust`).set(auth(owner)).send({ periodEnd: "2031-01-01T00:00:00Z", reason: "Far too long an extension" })).status).toBe(400);
    expect((await request(app).post(`/admin/subscriptions/${sub.id}/adjust`).set(auth(owner)).send({ periodEnd: target, planVersionId: "no-such-version", reason: "Wrong version on purpose" })).status).toBe(400);
    const ok = await request(app).post(`/admin/subscriptions/${sub.id}/adjust`).set(auth(owner)).send({ periodEnd: target, reason: "Goodwill extension after an outage" });
    expect(ok.status).toBe(200);
    expect((await b.scoped.subscription.findUniqueOrThrow({ where: { id: sub.id } })).currentPeriodEnd.toISOString()).toBe(target);
    const ev = await b.scoped.entitlementEvent.findFirstOrThrow({ where: { kind: "MANUAL_ADJUSTMENT" } });
    expect(ev).toMatchObject({ source: "ADMIN", reason: "Goodwill extension after an outage" });
    expect(ev.adminUserId).toBeTruthy();
    await expect(testDb.db.query(`UPDATE "EntitlementEvent" SET reason='edited' WHERE id='${ev.id}'`)).rejects.toThrow(/append-only/);
    expect((await request(app).post("/admin/subscriptions/nope/adjust").set(auth(owner)).send({ periodEnd: target, reason: "Goodwill extension after an outage" })).status).toBe(404);
  });

  it("refunds only subscription charges, through pawaPay, owner only; the invoice moves when pawaPay confirms", async () => {
    const { invoice } = await paid();
    const owner = await loginAs("super@t.test");
    const refund = (amount: string | undefined, tok = owner) => request(app).post(`/admin/invoices/${invoice.id}/refund`).set(auth(tok)).send({ ...(amount ? { amountMinor: amount } : {}), reason: "Charged by mistake, returning it" });
    expect((await refund("100000", await loginAs("op@t.test"))).status).toBe(403);
    expect((await refund("999999999")).status).toBe(400);
    const r = await refund("100000");
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("ACCEPTED");
    expect((await refund("50000")).status).toBe(409); // one refund at a time
    expect((await request(app).post("/admin/invoices/nope/refund").set(auth(owner)).send({ reason: "Does not exist at all" })).status).toBe(404);
    await applyBillingRefund(prisma, cfg, r.body.refundId, new Date());
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedMinor: 100_000n });
    expect(await prisma.auditLog.count({ where: { entityType: "Invoice", entityId: invoice.id, action: "SUBSCRIPTION_REFUND_REQUESTED" } })).toBe(1);
  });

  it("switches stop NEW charges for a country but never stop servicing existing ones", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" });
    const owner = await loginAs("super@t.test");
    const put = (enabled: boolean, extra: object = {}) => request(app).put("/admin/billing-switches").set(auth(owner)).send({ provider: "pawapay", countryCode: "SL", newAttemptsEnabled: enabled, reason: "Provider incident under investigation", ...extra });
    expect((await request(app).put("/admin/billing-switches").set(auth(await loginAs("op@t.test"))).send({ provider: "pawapay", countryCode: "SL", newAttemptsEnabled: false, reason: "Provider incident under investigation" })).status).toBe(403);
    expect((await put(false, { provider: "flutterwave" })).status).toBe(400);
    expect((await put(false, { countryCode: "ZZ" })).status).toBe(404);
    expect((await put(false)).body).toMatchObject({ newAttemptsEnabled: false, purpose: "PLATFORM_SUBSCRIPTION" });
    const other = await makeSlBusiness(prisma);
    await expect(startRenewal(prisma, { businessId: other.businessId, merchantId: other.merchantId, payerPhone: PHONE, planCode: "STARTER" })).rejects.toMatchObject({ code: "SWITCHED_OFF" });
    fake.complete(s.depositId);
    expect(await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", new Date())).toBe("GRANTED"); // the existing charge still completes
    const rec = await request(app).post("/admin/subscriptions/reconcile").set(auth(owner)).send({});
    expect(rec.status).toBe(200); // reconciliation is available while new charges are off
    expect((await put(true)).body.newAttemptsEnabled).toBe(true);
  });

  it("resolves billing exceptions with a documented outcome; asking pawaPay about a charge is the only way an admin can make money apply", async () => {
    const owner = await loginAs("super@t.test");
    const b = await makeSlBusiness(prisma);
    await publishedPlan(prisma, "STARTER");
    const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" });
    fake.complete(s.depositId, { amount: "1.00" });
    await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", new Date());
    const list = await request(app).get("/admin/subscriptions/exceptions").set(auth(await loginAs("support@t.test")));
    const ex = list.body.exceptions.find((e: { attemptId: string }) => e.attemptId === s.depositId);
    expect(ex).toMatchObject({ type: "AMOUNT_MISMATCH", status: "OPEN", business: b.business.name });
    const op = await loginAs("op@t.test");
    expect((await request(app).post(`/admin/subscriptions/exceptions/${ex.id}/resolve`).set(auth(await loginAs("support@t.test"))).send({ outcome: "REFUNDED", note: "Returned the short payment" })).status).toBe(403);
    expect((await request(app).post(`/admin/subscriptions/exceptions/${ex.id}/resolve`).set(auth(op)).send({ outcome: "MADE_UP", note: "Returned the short payment" })).status).toBe(400);
    expect((await request(app).post(`/admin/subscriptions/exceptions/${ex.id}/resolve`).set(auth(op)).send({ outcome: "REFUNDED", note: "Returned the short payment" })).status).toBe(200);
    expect((await request(app).post(`/admin/subscriptions/exceptions/${ex.id}/resolve`).set(auth(op)).send({ outcome: "REFUNDED", note: "Resolving it a second time" })).status).toBe(409);
    expect((await request(app).get("/admin/subscriptions/exceptions?status=RESOLVED").set(auth(op))).body.exceptions.map((e: { id: string }) => e.id)).toContain(ex.id);

    // a payment whose callback was lost: asking pawaPay applies it; there is no "mark paid"
    const lost = await makeSlBusiness(prisma);
    const l = await startRenewal(prisma, { businessId: lost.businessId, merchantId: lost.merchantId, payerPhone: PHONE, planCode: "STARTER" });
    expect((await request(app).post(`/admin/subscriptions/attempts/${l.depositId}/refresh`).set(auth(op)).send({})).body.outcome).toBe("PENDING");
    fake.complete(l.depositId);
    expect((await request(app).post(`/admin/subscriptions/attempts/${l.depositId}/refresh`).set(auth(op)).send({})).body.outcome).toBe("GRANTED");
    for (const [m, p] of [["post", "/admin/subscriptions/x/mark-paid"], ["delete", "/admin/subscriptions/x"], ["put", "/admin/subscriptions/x"], ["delete", "/admin/invoices/x"]] as const) {
      expect((await request(app)[m](p).set(auth(owner))).status, `${m} ${p}`).toBe(404);
    }
    void owner;
  });

  it("sends the owner a plain reminder about their own subscription (no link), only when messaging is configured", async () => {
    const { sub } = await paid();
    const owner = await loginAs("super@t.test");
    expect((await request(app).post(`/admin/subscriptions/${sub.id}/remind`).set(auth(owner)).send({ reason: "short" })).status).toBe(400);
    expect((await request(app).post(`/admin/subscriptions/${sub.id}/remind`).set(auth(await loginAs("op@t.test"))).send({ reason: "Reminder before the period ends" })).status).toBe(403);
    const r = await request(app).post(`/admin/subscriptions/${sub.id}/remind`).set(auth(owner)).send({ reason: "Reminder before the period ends" });
    expect(r.status).toBe(200);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.body).toContain("/renew");
    expect(reminders[0]!.body).not.toMatch(/https?:/);
    expect((await request(app).post("/admin/subscriptions/nope/remind").set(auth(owner)).send({ reason: "Reminder before the period ends" })).status).toBe(404);
  });

  it("every write needs step-up when it is enabled", async () => {
    const { sub } = await paid();
    await setFlag("adminStepUp", true);
    const owner = await loginAs("super@t.test");
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const blocked = await request(app).post(`/admin/subscriptions/${sub.id}/adjust`).set(auth(owner)).send({ periodEnd: target, reason: "Needs step-up before this works" });
    expect(blocked.body.code).toBe("STEP_UP_REQUIRED");
    const su = await request(app).post("/admin/step-up").set(auth(owner)).send({ password: PW });
    expect((await request(app).post(`/admin/subscriptions/${sub.id}/adjust`).set(auth(owner)).set(STEP_UP_HEADER, su.body.stepUpToken).send({ periodEnd: target, reason: "Step-up satisfied, now it works" })).status).toBe(200);
  });
});
