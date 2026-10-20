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
import { addToBasket } from "../src/domain/store/basket.js";
import { checkoutBasket } from "../src/domain/store/orders.js";
import { applyStoreProviderPayment } from "../src/domain/store/payments.js";
import { openSupportCase } from "../src/domain/store/cases.js";

vi.setConfig({ testTimeout: 60_000 });

const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let s: Seller;
let orderId: string;
let orderRef: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginAs = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
const setFlag = (key: string, on: boolean) => prisma.featureFlag.update({ where: { key }, data: { enabledByDefault: on } });

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  s = await makeSeller(prisma, "Support Shop", { slug: "support-shop" });
  await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
  process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
  const t = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: 2 });
  const r = await checkoutBasket(prisma, { basketToken: t.token, buyer: { name: "Amaka Obi", phone: "08031234567", contactConsent: true }, allowOnline: true, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP", paymentMethod: "ONLINE_SIMULATED" }] });
  delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
  const o = r.outcomes[0]!;
  if (!o.ok) throw new Error(o.error);
  orderId = o.order.id;
  orderRef = o.order.reference;
  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, SECRET));
}, 90_000);
afterAll(async () => {
  await testDb.teardown();
});
beforeEach(async () => {
  await setFlag("adminStepUp", false);
  await setFlag("adminSupportAccessRequired", false);
});

async function newCase(type: "DELIVERY" | "PAYMENT_DISPUTE" | "OTHER" = "DELIVERY") {
  return openSupportCase(prisma, { businessId: s.businessId, orderId, type, openedBy: "CONSUMER", summary: "The delivery never arrived at my gate", contactName: "Amaka Obi", contactPhone: "08031234567" });
}

describe("admin support cases", () => {
  it("lists and filters cases by type, party and status for support, operator and owner; analyst is refused", async () => {
    const delivery = await newCase("DELIVERY");
    const other = await newCase("OTHER");
    for (const email of ["super@t.test", "op@t.test", "support@t.test"]) {
      const r = await request(app).get("/admin/support-cases").set(auth(await loginAs(email)));
      expect(r.status).toBe(200);
      expect(r.body.cases.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([delivery.id, other.id]));
    }
    const tok = await loginAs("support@t.test");
    const platform = await request(app).get("/admin/support-cases?party=PLATFORM").set(auth(tok));
    expect(platform.body.cases.every((c: { handledBy: string }) => c.handledBy === "PLATFORM")).toBe(true);
    expect(platform.body.cases.map((c: { id: string }) => c.id)).toContain(other.id);
    expect(platform.body.cases.map((c: { id: string }) => c.id)).not.toContain(delivery.id);
    const byType = await request(app).get("/admin/support-cases?type=DELIVERY").set(auth(tok));
    expect(byType.body.cases.every((c: { type: string }) => c.type === "DELIVERY")).toBe(true);
    expect((await request(app).get("/admin/support-cases").set(auth(await loginAs("analyst@t.test")))).status).toBe(403);
    expect((await request(app).get("/admin/support-cases")).status).toBe(401);
  });

  it("names the responsible party, masks the consumer's phone unless the platform must act, and never shows cost", async () => {
    const delivery = await newCase("DELIVERY");
    const other = await newCase("OTHER");
    const tok = await loginAs("support@t.test");
    const d = await request(app).get(`/admin/support-cases/${delivery.id}`).set(auth(tok));
    expect(d.body).toMatchObject({ handledBy: "SELLER", status: "OPEN", business: "Support Shop", order: { reference: orderRef, status: "PLACED" } });
    expect(d.body.contactPhone).toBe("*******4567");
    expect(d.body.notes).toHaveLength(1);
    expect(JSON.stringify(d.body)).not.toMatch(/cost/i);
    const o = await request(app).get(`/admin/support-cases/${other.id}`).set(auth(tok));
    expect(o.body.handledBy).toBe("PLATFORM");
    expect(o.body.contactPhone).toBe("08031234567");
    expect((await request(app).get("/admin/support-cases/nope").set(auth(tok))).status).toBe(404);
  });

  it("assign, annotate, reassign and close are audited, append-only, and a closed case stays closed", async () => {
    const c = await newCase("DELIVERY");
    const tok = await loginAs("support@t.test");
    const assign = await request(app).post(`/admin/support-cases/${c.id}/assign`).set(auth(tok)).set("x-correlation-id", "corr-case-assign").send({});
    expect(assign.status).toBe(200);
    const note = await request(app).post(`/admin/support-cases/${c.id}/notes`).set(auth(tok)).send({ body: "Called the seller; courier is on the way." });
    expect(note.status).toBe(201);
    expect((await request(app).post(`/admin/support-cases/${c.id}/notes`).set(auth(tok)).send({ body: "" })).status).toBe(400);
    expect((await request(app).post(`/admin/support-cases/${c.id}/reassign`).set(auth(tok)).send({ party: "PLATFORM", reason: "short" })).status).toBe(400);
    const re = await request(app).post(`/admin/support-cases/${c.id}/reassign`).set(auth(tok)).send({ party: "PLATFORM", reason: "Seller is not responding to the shopper" });
    expect(re.body.handledBy).toBe("PLATFORM");
    expect((await request(app).post(`/admin/support-cases/${c.id}/reassign`).set(auth(tok)).send({ party: "PLATFORM", reason: "Already with the platform" })).status).toBe(409);
    expect((await request(app).post(`/admin/support-cases/${c.id}/close`).set(auth(tok)).send({ resolution: "ok" })).status).toBe(400);
    const closed = await request(app).post(`/admin/support-cases/${c.id}/close`).set(auth(tok)).send({ resolution: "Seller redelivered the goods on Tuesday." });
    expect(closed.status).toBe(200);
    expect((await request(app).post(`/admin/support-cases/${c.id}/close`).set(auth(tok)).send({ resolution: "Closing a second time" })).status).toBe(409);
    expect((await request(app).post(`/admin/support-cases/${c.id}/notes`).set(auth(tok)).send({ body: "Too late for notes" })).status).toBe(409);
    expect((await request(app).post(`/admin/support-cases/${c.id}/assign`).set(auth(tok)).send({})).status).toBe(409);

    const detail = await request(app).get(`/admin/support-cases/${c.id}`).set(auth(tok));
    expect(detail.body).toMatchObject({ status: "CLOSED", handledBy: "PLATFORM", resolution: "Seller redelivered the goods on Tuesday." });
    expect(detail.body.notes.map((n: { authorType: string }) => n.authorType)).toEqual(["CONSUMER", "ADMIN", "ADMIN", "ADMIN", "ADMIN"]);
    const first = detail.body.notes[0];
    await expect(testDb.db.query(`UPDATE "SupportCaseNote" SET body = 'x' WHERE id = '${first.id}'`)).rejects.toThrow(/append-only/);

    const audits = await prisma.auditLog.findMany({ where: { entityType: "SupportCase", entityId: c.id } });
    expect(audits.length).toBe(4); // assign, note, reassign, close; refused attempts leave none
    expect(audits.some((a) => (a.metadata as { correlationId?: string })?.correlationId === "corr-case-assign")).toBe(true);
  });

  it("writes need step-up when it is enabled, and the analyst cannot write at all", async () => {
    const c = await newCase("OTHER");
    await setFlag("adminStepUp", true);
    const tok = await loginAs("support@t.test");
    const blocked = await request(app).post(`/admin/support-cases/${c.id}/assign`).set(auth(tok)).send({});
    expect(blocked.body.code).toBe("STEP_UP_REQUIRED");
    const su = await request(app).post("/admin/step-up").set(auth(tok)).send({ password: PW });
    expect((await request(app).post(`/admin/support-cases/${c.id}/assign`).set(auth(tok)).set(STEP_UP_HEADER, su.body.stepUpToken).send({})).status).toBe(200);
    expect((await request(app).post(`/admin/support-cases/${c.id}/notes`).set(auth(await loginAs("analyst@t.test"))).send({ body: "nope nope" })).status).toBe(403);
  });
});

describe("payment exceptions and the overview", () => {
  it("shows a held payment, and the overview counts open cases, exceptions and refund requests", async () => {
    await applyStoreProviderPayment(prisma, { sellerBusinessId: s.businessId, orderId, provider: "simulator", externalId: "sim-over-0001", amountMinor: 99_000n, currencyCode: "NGN", evidence: "SIMULATOR_CONFIRMED" });
    const tok = await loginAs("support@t.test");
    const ex = await request(app).get("/admin/payment-exceptions").set(auth(tok));
    expect(ex.status).toBe(200);
    expect(ex.body.exceptions[0]).toMatchObject({ type: "OVERPAYMENT", status: "OPEN", orderReference: orderRef, business: "Support Shop", amountMinor: "99000", currencyCode: "NGN" });
    const ov = await request(app).get("/admin/overview").set(auth(tok));
    expect(ov.body.queues.openPaymentExceptions).toBeGreaterThanOrEqual(1);
    expect(ov.body.queues.openSupportCases).toBeGreaterThanOrEqual(1);
    expect(ov.body.queues.pendingRefundRequests).toBe(0);
    expect((await request(app).get("/admin/payment-exceptions").set(auth(await loginAs("analyst@t.test")))).status).toBe(403);
  });

  it("the admin store-orders view shows money and status but no buyer phone and no cost, and needs the financials permission", async () => {
    const tok = await loginAs("op@t.test");
    const r = await request(app).get(`/admin/businesses/${s.businessId}/store-orders`).set(auth(tok));
    expect(r.status).toBe(200);
    expect(r.body.orders[0]).toMatchObject({ reference: orderRef, status: "PLACED", totalMinor: "20000" });
    expect(JSON.stringify(r.body)).not.toMatch(/08031234567|cost|accessToken|pickupCode/i);
    expect((await request(app).get(`/admin/businesses/${s.businessId}/store-orders`).set(auth(await loginAs("analyst@t.test")))).status).toBe(403);
    expect((await request(app).get(`/admin/businesses/nope/store-orders`).set(auth(tok))).status).toBe(404);
  });
});
