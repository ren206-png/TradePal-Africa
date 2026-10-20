import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { deliverCallback, drainInbox, simulatorWorld, startPayment } from "./helpers/payments.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { STEP_UP_HEADER } from "../src/admin/platformGuards.js";
import { setAdapterRegistry } from "../src/payments/registry.js";
import type { SimulatorAdapter } from "../src/payments/simulatorAdapter.js";
import type { AdapterRegistry } from "../src/payments/adapter.js";
import { createPaymentIntent, ensureSimulatorConnection, startPaymentAttempt } from "../src/domain/merchantPayments/intents.js";
import { refundThroughProvider } from "../src/domain/merchantPayments/refunds.js";
import { cancelStoreOrderBySeller } from "../src/domain/store/orders.js";

vi.setConfig({ testTimeout: 60_000 });

const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let sim: SimulatorAdapter;
let registry: AdapterRegistry;
let s: Seller;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginAs = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
const setFlag = (key: string, on: boolean) => prisma.featureFlag.update({ where: { key }, data: { enabledByDefault: on } });

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  ({ sim, registry } = simulatorWorld(prisma));
  s = await makeSeller(prisma, "Admin Pay Shop", { slug: "admin-pay-shop" });
  await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, SECRET));
}, 90_000);
afterAll(async () => {
  delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
  setAdapterRegistry(null);
  await testDb.teardown();
});
beforeEach(async () => {
  await setFlag("adminStepUp", false);
  await setFlag("adminSupportAccessRequired", false);
});

const pendingOrder = async (qty = 1) => {
  const { order } = await placeStoreOrder(prisma, s, { qty, online: true });
  const { attempt } = await startPayment(prisma, registry, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
  return { order, attempt };
};

describe("admin payments panel", () => {
  it("shows the overview, attempts and their history to owner and operator only", async () => {
    const { order, attempt } = await pendingOrder();
    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!));
    await drainInbox(prisma);
    for (const email of ["super@t.test", "op@t.test"]) {
      const ov = await request(app).get("/admin/payments/overview").set(auth(await loginAs(email)));
      expect(ov.status).toBe(200);
      expect(ov.body.attempts.SUCCEEDED).toBeGreaterThanOrEqual(1);
      expect(ov.body.providers).toEqual(["simulator"]);
      expect(ov.body.collectedNotSettled[0]).toMatchObject({ currencyCode: "NGN" });
    }
    for (const email of ["support@t.test", "analyst@t.test"]) expect((await request(app).get("/admin/payments/overview").set(auth(await loginAs(email)))).status).toBe(403);
    expect((await request(app).get("/admin/payments/overview")).status).toBe(401);

    const tok = await loginAs("op@t.test");
    const list = await request(app).get("/admin/payments/attempts").set(auth(tok));
    const row = list.body.attempts.find((a: { id: string }) => a.id === attempt.id);
    expect(row).toMatchObject({ status: "SUCCEEDED", reference: order.reference, capturedMinor: "10000", provider: "simulator" });
    const detail = await request(app).get(`/admin/payments/attempts/${attempt.id}`).set(auth(tok));
    expect(detail.body.history.map((h: { to: string }) => h.to)).toEqual(["CREATED", "PENDING", "SUCCEEDED"]);
    expect(detail.body.allocation).toMatchObject({ state: "APPLIED" });
    expect(JSON.stringify(detail.body)).not.toMatch(/cost|buyerPhone|accessToken/i);
    expect((await request(app).get("/admin/payments/attempts/nope").set(auth(tok))).status).toBe(404);
  });

  it("lists store and provider exceptions together and resolves a provider exception only with a documented outcome", async () => {
    const { order, attempt } = await pendingOrder();
    await cancelStoreOrderBySeller(prisma, { businessId: s.businessId, orderId: order.id, reason: "Out of stock" });
    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!)); // late success -> store exception
    const wrong = await pendingOrder();
    await deliverCallback(prisma, registry, await sim.completePayment(wrong.attempt.externalRef!, { currencyCode: "USD" })); // -> provider exception
    await drainInbox(prisma);

    const tok = await loginAs("op@t.test");
    const ex = await request(app).get("/admin/payments/exceptions").set(auth(tok));
    const types = ex.body.exceptions.map((e: { source: string; type: string }) => `${e.source}:${e.type}`);
    expect(types).toEqual(expect.arrayContaining(["STORE_ORDER:LATE_SUCCESS", "PROVIDER:CURRENCY_MISMATCH"]));
    const pe = ex.body.exceptions.find((e: { type: string }) => e.type === "CURRENCY_MISMATCH");

    expect((await request(app).post(`/admin/payments/exceptions/${pe.id}/resolve`).set(auth(tok)).send({ outcome: "INVENTED", note: "A real note here" })).status).toBe(400);
    expect((await request(app).post(`/admin/payments/exceptions/${pe.id}/resolve`).set(auth(tok)).send({ outcome: "CONTACTED_PARTIES", note: "short" })).status).toBe(400);
    expect((await request(app).post(`/admin/payments/exceptions/${pe.id}/resolve`).set(auth(await loginAs("support@t.test"))).send({ outcome: "CONTACTED_PARTIES", note: "Called the provider and the seller" })).status).toBe(403);
    const ok = await request(app).post(`/admin/payments/exceptions/${pe.id}/resolve`).set(auth(tok)).set("x-correlation-id", "corr-pay-resolve").send({ outcome: "CONTACTED_PARTIES", note: "Called the provider and the seller" });
    expect(ok.status).toBe(200);
    expect((await request(app).post(`/admin/payments/exceptions/${pe.id}/resolve`).set(auth(tok)).send({ outcome: "NO_ACTION_NEEDED", note: "Resolving it a second time" })).status).toBe(409);
    expect((await request(app).post(`/admin/payments/exceptions/nope/resolve`).set(auth(tok)).send({ outcome: "NO_ACTION_NEEDED", note: "Does not exist at all" })).status).toBe(404);
    const row = await prisma.providerException.findUniqueOrThrow({ where: { id: pe.id } });
    expect(row).toMatchObject({ status: "RESOLVED" });
    expect(row.resolution).toContain("CONTACTED_PARTIES");
    const audits = await prisma.auditLog.findMany({ where: { entityType: "Payment", entityId: pe.id } });
    expect(audits).toHaveLength(1);
    expect((audits[0]!.metadata as { correlationId?: string }).correlationId).toBe("corr-pay-resolve");
  });

  it("closes an attempt only after the provider confirms it never collected; refresh applies a payment whose callback was lost", async () => {
    const tok = await loginAs("op@t.test");
    const live = await pendingOrder();
    const stillPending = await request(app).post(`/admin/payments/attempts/${live.attempt.id}/close`).set(auth(tok)).send({ as: "FAILED", reason: "Customer abandoned it" });
    expect(stillPending.status).toBe(409);
    expect(stillPending.body.code).toBe("STILL_PENDING");
    await sim.completePayment(live.attempt.externalRef!); // paid at the provider, callback lost
    const closeRefused = await request(app).post(`/admin/payments/attempts/${live.attempt.id}/close`).set(auth(tok)).send({ as: "FAILED", reason: "Customer abandoned it" });
    expect(closeRefused.status).toBe(409);
    expect(closeRefused.body.providerSays).toBe("SUCCEEDED");
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: live.attempt.id } })).status).toBe("SUCCEEDED"); // applied instead of closed
    expect((await s.scoped.storeOrder.findUniqueOrThrow({ where: { id: live.order.id } })).paidMinor).toBe(10_000n);

    // refresh: the same recovery without closing
    const lost = await pendingOrder();
    await sim.completePayment(lost.attempt.externalRef!);
    const r = await request(app).post(`/admin/payments/attempts/${lost.attempt.id}/refresh`).set(auth(tok)).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: "APPLIED", providerStatus: "SUCCEEDED" });

    // an unknown attempt (the provider has no record) can be closed as failed, with a reason
    const { order } = await placeStoreOrder(prisma, s, { qty: 1, online: true });
    await ensureSimulatorConnection(prisma, s.businessId);
    const intent = await createPaymentIntent(prisma, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
    sim.dropNextCreate = true;
    await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent.id, provider: "simulator" }).catch(() => undefined);
    const unknown = await s.scoped.paymentAttempt.findFirstOrThrow({ where: { intentId: intent.id } });
    expect(unknown.status).toBe("UNKNOWN");
    expect((await request(app).post(`/admin/payments/attempts/${unknown.id}/close`).set(auth(tok)).send({ as: "FAILED", reason: "short" })).status).toBe(400);
    const closed = await request(app).post(`/admin/payments/attempts/${unknown.id}/close`).set(auth(tok)).send({ as: "FAILED", reason: "Provider confirmed it has no record" });
    expect(closed.status).toBe(200);
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe("FAILED");
    expect((await s.scoped.paymentAttemptEvent.findFirstOrThrow({ where: { attemptId: unknown.id, source: "ADMIN" } })).detail).toMatchObject({ adminUserId: expect.any(String), reason: expect.any(String) });
  });

  it("retries a failed refund through the same provider, and replays a dead callback; there is no delete or mark-paid route", async () => {
    const tok = await loginAs("super@t.test");
    const p = await pendingOrder(2);
    await deliverCallback(prisma, registry, await sim.completePayment(p.attempt.externalRef!));
    await drainInbox(prisma);
    await sim.setBehaviour(p.attempt.externalRef!, "REFUND_FAILS");
    const { refund } = await refundThroughProvider(prisma, registry, { businessId: s.businessId, attemptId: p.attempt.id, amountMinor: 5_000n, reason: "Customer returned goods", idempotencyKey: `adm-${p.attempt.id}` });
    expect(refund.status).toBe("FAILED");
    expect((await request(app).get("/admin/payments/refunds").set(auth(tok))).body.refunds.find((r: { id: string }) => r.id === refund.id)).toMatchObject({ status: "FAILED" });
    expect((await request(app).post(`/admin/payments/refunds/${refund.id}/retry`).set(auth(await loginAs("support@t.test"))).send({})).status).toBe(403);
    await sim.setBehaviour(p.attempt.externalRef!, "NORMAL");
    const retry = await request(app).post(`/admin/payments/refunds/${refund.id}/retry`).set(auth(tok)).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("SUCCEEDED");
    expect((await request(app).post(`/admin/payments/refunds/${retry.body.refundId}/retry`).set(auth(tok)).send({})).status).toBe(409); // only a failed refund can be retried

    const dead = await prisma.callbackInbox.create({ data: { provider: "simulator", externalId: "evt-dead-admin-1", payload: { event: {} }, signatureVerified: true, status: "DEAD", attempts: 9, lastError: "boom" } });
    expect((await request(app).get("/admin/payments/callbacks").set(auth(tok))).body.dead.map((d: { id: string }) => d.id)).toContain(dead.id);
    expect((await request(app).post(`/admin/payments/callbacks/${dead.id}/replay`).set(auth(tok)).send({})).status).toBe(200);
    expect((await prisma.callbackInbox.findUniqueOrThrow({ where: { id: dead.id } })).status).toBe("RECEIVED");
    expect((await request(app).post(`/admin/payments/callbacks/${dead.id}/replay`).set(auth(tok)).send({})).status).toBe(409);

    for (const [method, path] of [["delete", "/admin/payments/attempts/x"], ["put", `/admin/payments/attempts/${p.attempt.id}`], ["post", `/admin/payments/attempts/${p.attempt.id}/mark-paid`], ["delete", "/admin/payments/exceptions/x"]] as const) {
      expect((await request(app)[method](path).set(auth(tok))).status, `${method} ${path}`).toBe(404);
    }
  });

  it("connects a merchant to a provider only with the owner's step-up, never accepts a secret, and refuses subscription providers", async () => {
    const tok = await loginAs("super@t.test");
    const biz = await makeSeller(prisma, "Connect Shop", { slug: "connect-shop" });
    const body = { provider: "simulator", arrangementRef: "ARR-1", destinationKey: "dest-1", destinationLabel: "Wallet ***1234", reason: "Merchant onboarded on 20 Oct" };
    expect((await request(app).post(`/admin/businesses/${biz.businessId}/payment-connections`).set(auth(await loginAs("op@t.test"))).send(body)).status).toBe(403);
    expect((await request(app).post(`/admin/businesses/${biz.businessId}/payment-connections`).set(auth(tok)).send({ ...body, provider: "pawapay" })).status).toBe(409);
    expect((await request(app).post(`/admin/businesses/${biz.businessId}/payment-connections`).set(auth(tok)).send({ ...body, credentialRef: "sk_live_abcdef123456" })).status).toBe(400);
    expect((await request(app).post(`/admin/businesses/nope/payment-connections`).set(auth(tok)).send(body)).status).toBe(404);
    const ok = await request(app).post(`/admin/businesses/${biz.businessId}/payment-connections`).set(auth(tok)).send({ ...body, credentialRef: "SIMULATOR_KEY" });
    expect(ok.status).toBe(201);
    expect((await request(app).post(`/admin/businesses/${biz.businessId}/payment-connections`).set(auth(tok)).send(body)).status).toBe(409);
    const list = await request(app).get(`/admin/businesses/${biz.businessId}/payment-connections`).set(auth(tok));
    expect(list.body.connections[0]).toMatchObject({ provider: "simulator", credentialRef: "SIMULATOR_KEY", destinationLabel: "Wallet ***1234" });
    expect(JSON.stringify(list.body)).not.toContain("dest-1"); // the destination key itself is not echoed
    expect((await request(app).post(`/admin/payment-connections/${ok.body.id}/disable`).set(auth(tok)).send({ reason: "Merchant left the platform" })).status).toBe(200);
    expect((await request(app).post(`/admin/payment-connections/${ok.body.id}/disable`).set(auth(tok)).send({ reason: "Merchant left the platform" })).status).toBe(404);
  });

  it("every write needs step-up when it is enabled", async () => {
    await setFlag("adminStepUp", true);
    const tok = await loginAs("op@t.test");
    const p = await pendingOrder();
    const blocked = await request(app).post(`/admin/payments/attempts/${p.attempt.id}/refresh`).set(auth(tok)).send({});
    expect(blocked.body.code).toBe("STEP_UP_REQUIRED");
    const su = await request(app).post("/admin/step-up").set(auth(tok)).send({ password: PW });
    expect((await request(app).post(`/admin/payments/attempts/${p.attempt.id}/refresh`).set(auth(tok)).set(STEP_UP_HEADER, su.body.stepUpToken).send({})).status).toBe(200);
  });
});
