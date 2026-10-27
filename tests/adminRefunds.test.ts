import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { PHONE, billingWorld, makeSlBusiness, publishedPlan, seedSierraLeone } from "./helpers/billing.js";
import type { PawaPayFake } from "./helpers/pawapayFake.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { setBillingConfig, type BillingConfig } from "../src/domain/subscriptions/common.js";
import { startRenewal } from "../src/domain/subscriptions/renewal.js";
import { applyBillingDeposit } from "../src/domain/subscriptions/collection.js";
import { buildHarness, secretFor, PW, type Harness } from "./helpers/adminConsole.js";
import { hashPayload } from "../src/admin/refundRequests.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Refunds under the two-person rule (admin-console Phase 3). pawaPay is the repository's fake; the executor that would call it is a recorder,
 * so most tests prove what would have been sent without sending anything. One test runs the real billing code against the fake provider.
 */
let testDb: TestDb;
let prisma: PrismaClient;
let fake: PawaPayFake;
let cfg: BillingConfig;
let h: Harness;
const calls: { kind: string; input: Record<string, unknown> }[] = [];
let executionOn = false;

async function paidInvoice(name: string) {
  await publishedPlan(prisma, "STARTER");
  const b = await makeSlBusiness(prisma, { name });
  const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" });
  fake.complete(s.depositId);
  await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", new Date());
  return prisma.invoice.findFirstOrThrow({ where: { reference: s.invoiceReference } });
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  await seedSierraLeone(prisma);
  ({ fake, cfg } = await billingWorld(prisma));
  for (const [email, role] of [["owner@t.test", "SUPER_ADMIN"], ["ops@t.test", "OPERATOR"], ["fin1@t.test", "FINANCE_ADMIN"], ["fin2@t.test", "FINANCE_ADMIN"], ["support@t.test", "SUPPORT"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  h = buildHarness(prisma, {
    enforceMfa: false,
    refunds: {
      env: () => ({ ADMIN_CONSOLE_ENABLED: "true", ADMIN_MODULE_REFUNDS: "true", ...(executionOn ? { ADMIN_REFUND_EXECUTION_ENABLED: "true" } : {}) }) as NodeJS.ProcessEnv,
      executors: {
        refundSubscriptionCharge: (async (_p: unknown, input: Record<string, unknown>) => { calls.push({ kind: "charge", input }); return { id: "refund-1", status: "REQUESTED" }; }) as never,
        refundHeldBillingPayment: (async (_p: unknown, input: Record<string, unknown>) => { calls.push({ kind: "held", input }); return { id: "refund-2", status: "REQUESTED" }; }) as never,
      },
    },
  });
}, 90_000);
afterAll(async () => {
  h.close();
  setBillingConfig(null);
  await testDb.teardown();
});

async function fresh(email: string) {
  const s = await h.signedIn(email);
  return s.token;
}

describe("requesting", () => {
  it("freezes the action and amount with a hash, needs a reason, and is bounded by what was paid", async () => {
    const inv = await paidInvoice("Req One");
    const t = await fresh("fin1@t.test");
    const short = await h.http().post("/admin/refund-requests").set(h.auth(t)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, reason: "short" });
    expect(short.status).toBe(400);
    const tooMuch = await h.http().post("/admin/refund-requests").set(h.auth(t)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, amountMinor: String(inv.paidMinor + 1n), reason: "customer was charged twice" });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([409, "REFUND_LIMIT"]);
    const ok = await h.http().post("/admin/refund-requests").set(h.auth(t)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, amountMinor: "100000", reason: "customer was charged twice" });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("PENDING");
    expect(ok.body.payloadHash).toBe(hashPayload(ok.body.payload));
    expect(ok.body.payload).toMatchObject({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, amountMinor: "100000", currency: expect.any(String) });
    // a second open request for the same payment is refused
    const dup = await h.http().post("/admin/refund-requests").set(h.auth(t)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, reason: "second try for the same one" });
    expect(dup.body.code).toBe("REQUEST_OPEN");
    // the audit row records who, why and the hash, and nothing was sent anywhere
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "admin.refund.requested", entityId: ok.body.id } });
    expect([audit.reason, audit.actorId]).toEqual(["customer was charged twice", (await prisma.adminUser.findUniqueOrThrow({ where: { email: "fin1@t.test" } })).id]);
    expect(calls).toHaveLength(0);
  });

  it("is refused for roles without the permission", async () => {
    const inv = await paidInvoice("Req Two");
    for (const email of ["support@t.test"]) {
      const t = await fresh(email);
      expect((await h.http().post("/admin/refund-requests").set(h.auth(t)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, reason: "customer was charged twice" })).status).toBe(403);
    }
    expect((await h.http().post("/admin/refund-requests").send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, reason: "customer was charged twice" })).status).toBe(401);
  });
});

describe("approval", () => {
  async function pending(name: string, by = "fin1@t.test") {
    const inv = await paidInvoice(name);
    const t = await fresh(by);
    const r = await h.http().post("/admin/refund-requests").set(h.auth(t)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, amountMinor: "50000", reason: "customer was charged twice" });
    return { inv, requester: t, req: r.body as { id: string; payloadHash: string } };
  }

  it("never lets the requester approve or reject their own request", async () => {
    const { requester, req } = await pending("Self");
    const a = await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(requester)).send({ payloadHash: req.payloadHash });
    expect([a.status, a.body.code]).toEqual([403, "SELF_APPROVAL"]);
    const r = await h.http().post(`/admin/refund-requests/${req.id}/reject`).set(h.auth(requester)).send({ reason: "changed my mind" });
    expect([r.status, r.body.code]).toEqual([403, "SELF_APPROVAL"]);
  });

  it("binds the approval to exactly the hash the approver reviewed", async () => {
    const { req } = await pending("Bind");
    const t2 = await fresh("fin2@t.test");
    const wrong = await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(t2)).send({ payloadHash: "0".repeat(64) });
    expect([wrong.status, wrong.body.code]).toEqual([409, "PAYLOAD_CHANGED"]);
    const ok = await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(t2)).send({ payloadHash: req.payloadHash });
    expect([ok.status, ok.body.status]).toEqual([200, "APPROVED"]);
    // approving again, or after someone else decided, is refused
    expect((await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(t2)).send({ payloadHash: req.payloadHash })).body.code).toBe("NOT_PENDING");
  });

  it("refuses a roles without approve permission, and an expired request", async () => {
    const { req } = await pending("Perm");
    const ops = await fresh("ops@t.test"); // an operator may request but not approve
    expect((await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(ops)).send({ payloadHash: req.payloadHash })).status).toBe(403);
    h.clock.advance(49 * 60);
    const t2 = await fresh("fin2@t.test");
    const late = await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(t2)).send({ payloadHash: req.payloadHash });
    expect([late.status, late.body.code]).toEqual([410, "EXPIRED"]);
  });

  it("stops if the requester was disabled before the approval", async () => {
    const { req } = await pending("Gone", "fin1@t.test");
    await prisma.adminUser.update({ where: { email: "fin1@t.test" }, data: { disabledAt: new Date() } });
    const t2 = await fresh("fin2@t.test");
    const r = await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(t2)).send({ payloadHash: req.payloadHash });
    expect([r.status, r.body.code]).toEqual([409, "REQUESTER_INACTIVE"]);
    await prisma.adminUser.update({ where: { email: "fin1@t.test" }, data: { disabledAt: null } });
  });

  it("lets the requester cancel, and only the requester", async () => {
    const { requester, req } = await pending("Cancel");
    const t2 = await fresh("fin2@t.test");
    expect((await h.http().post(`/admin/refund-requests/${req.id}/cancel`).set(h.auth(t2)).send({})).body.code).toBe("NOT_YOURS");
    expect((await h.http().post(`/admin/refund-requests/${req.id}/cancel`).set(h.auth(requester)).send({})).body.status).toBe("CANCELLED");
  });
});

describe("execution", () => {
  async function approved(name: string) {
    const inv = await paidInvoice(name);
    const t1 = await fresh("fin1@t.test");
    const req = (await h.http().post("/admin/refund-requests").set(h.auth(t1)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, amountMinor: "50000", reason: "customer was charged twice" })).body;
    const t2 = await fresh("fin2@t.test");
    await h.http().post(`/admin/refund-requests/${req.id}/approve`).set(h.auth(t2)).send({ payloadHash: req.payloadHash });
    return { inv, req, t2, t1 };
  }

  it("is OFF by default: an approved request stays approved and nothing is sent to the provider", async () => {
    executionOn = false;
    calls.length = 0;
    const { req, t2 } = await approved("Off");
    const r = await h.http().post(`/admin/refund-requests/${req.id}/execute`).set(h.auth(t2)).send({});
    expect([r.status, r.body.code]).toEqual([409, "EXECUTION_DISABLED"]);
    expect(calls).toHaveLength(0);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
  });

  it("when switched on, sends exactly the approved parameters once, then marks it executed", async () => {
    executionOn = true;
    calls.length = 0;
    const { inv, req, t2 } = await approved("On");
    const r = await h.http().post(`/admin/refund-requests/${req.id}/execute`).set(h.auth(t2)).send({});
    expect([r.status, r.body.refundId]).toEqual([202, "refund-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ invoiceId: inv.id, amountMinor: 50_000n, adminUserId: expect.any(String), revokeEntitlement: false });
    expect(String(calls[0]!.input["reason"])).toContain(req.id);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("EXECUTED");
    // a repeat is refused before anything is sent
    const again = await h.http().post(`/admin/refund-requests/${req.id}/execute`).set(h.auth(t2)).send({});
    expect(again.body.code).toBe("NOT_APPROVED");
    expect(calls).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "admin.refund.executed", entityId: req.id } })).toBe(1);
  });

  it("re-checks the person at the moment of execution: a demoted or disabled executor cannot run it", async () => {
    executionOn = true;
    calls.length = 0;
    const { req, t2 } = await approved("Demoted");
    await prisma.adminUser.update({ where: { email: "fin2@t.test" }, data: { role: "SUPPORT" } });
    const r = await h.http().post(`/admin/refund-requests/${req.id}/execute`).set(h.auth(t2)).send({});
    expect(r.status).toBe(403); // the route guard already sees the new role; the database is the authority
    expect(calls).toHaveLength(0);
    await prisma.adminUser.update({ where: { email: "fin2@t.test" }, data: { role: "FINANCE_ADMIN" } });
  });

  it("refuses to run a request whose stored payload no longer matches its approved hash", async () => {
    executionOn = true;
    calls.length = 0;
    const { req, t2 } = await approved("Tamper");
    await prisma.$executeRawUnsafe(`ALTER TABLE "ApprovalRequest" DISABLE TRIGGER "ApprovalRequest_guard"`);
    await prisma.$executeRawUnsafe(`UPDATE "ApprovalRequest" SET "payload" = jsonb_set("payload", '{amountMinor}', '"9999999"') WHERE "id" = '${req.id}'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "ApprovalRequest" ENABLE TRIGGER "ApprovalRequest_guard"`);
    const r = await h.http().post(`/admin/refund-requests/${req.id}/execute`).set(h.auth(t2)).send({});
    expect([r.status, r.body.code]).toEqual([409, "PAYLOAD_CHANGED"]);
    expect(calls).toHaveLength(0);
  });

  it("needs a fresh confirmation (password + code) for each step; a stale session is asked to confirm", async () => {
    const { req, t1 } = await approved("Stale").then(async (a) => ({ ...a, t1: a.t2 }));
    h.clock.advance(11);
    const r = await h.http().post(`/admin/refund-requests/${req.id}/execute`).set(h.auth(t1)).send({});
    expect([r.status, r.body.code]).toEqual([403, "REAUTH_REQUIRED"]);
  });
});

describe("the older single-person routes", () => {
  it("refuse and point at the workflow while the Refunds module is on, and work as before when it is off", async () => {
    const inv = await paidInvoice("Direct");
    const on = buildHarness(prisma, { enforceMfa: false, modules: () => true });
    const off = buildHarness(prisma, { enforceMfa: false, modules: (m) => m !== "REFUNDS" });
    try {
      const a = await on.signedIn("owner@t.test");
      const blocked = await on.http().post(`/admin/invoices/${inv.id}/refund`).set(on.auth(a.token)).send({ reason: "customer was charged twice" });
      expect([blocked.status, blocked.body.code]).toEqual([409, "USE_REFUND_REQUESTS"]);
      const b = await off.signedIn("owner@t.test");
      const allowed = await off.http().post(`/admin/invoices/nope/refund`).set(off.auth(b.token)).send({ reason: "customer was charged twice" });
      expect(allowed.status).toBe(404); // reaches the old handler (unknown invoice), not the block
    } finally { on.close(); off.close(); }
  });
});

describe("a real run against the provider fake", () => {
  it("the approved request goes through the real billing code and creates exactly one refund", async () => {
    executionOn = true;
    const inv = await paidInvoice("Real");
    const real = buildHarness(prisma, {
      enforceMfa: false,
      refunds: { env: () => ({ ADMIN_CONSOLE_ENABLED: "true", ADMIN_MODULE_REFUNDS: "true", ADMIN_REFUND_EXECUTION_ENABLED: "true" }) as NodeJS.ProcessEnv },
    });
    try {
      const t1 = (await real.signedIn("fin1@t.test")).token;
      const req = (await real.http().post("/admin/refund-requests").set(real.auth(t1)).send({ action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, amountMinor: "100000", reason: "customer was charged twice" })).body;
      const t2 = (await real.signedIn("fin2@t.test")).token;
      expect((await real.http().post(`/admin/refund-requests/${req.id}/approve`).set(real.auth(t2)).send({ payloadHash: req.payloadHash })).status).toBe(200);
      const run = await real.http().post(`/admin/refund-requests/${req.id}/execute`).set(real.auth(t2)).send({});
      expect(run.status, JSON.stringify(run.body)).toBe(202);
      expect(await prisma.billingRefund.count({ where: { invoiceId: inv.id } })).toBe(1);
    } finally { real.close(); }
  });
});
