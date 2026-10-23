import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder } from "./helpers/store.js";
import { drainInbox, simulatorWorld, startPayment } from "./helpers/payments.js";
import { createMerchantPaymentWebhookRouter, type RawBodyRequest } from "../src/payments/webhookRoute.js";
import { AdapterRegistry } from "../src/payments/adapter.js";
import { setAdapterRegistry } from "../src/payments/registry.js";
import { loadStoreOrder } from "../src/domain/store/orders.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let emptyApp: express.Express;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  const { registry } = simulatorWorld(prisma);
  const build = (r: AdapterRegistry) => {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as RawBodyRequest).rawBody = Buffer.from(buf); } }));
    a.use(createMerchantPaymentWebhookRouter(prisma, () => r));
    return a;
  };
  app = build(registry);
  emptyApp = build(new AdapterRegistry()); // what production looks like until a real adapter exists
}, 60_000);
afterAll(async () => {
  delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
  setAdapterRegistry(null);
  await testDb.teardown();
});

describe("POST /webhooks/merchant-payments/:provider", () => {
  it("authenticates, stores before answering, acknowledges duplicates, and applies the payment once from the inbox", async () => {
    const { sim, registry } = simulatorWorld(prisma);
    const s = await makeSeller(prisma, "Webhook Shop", { slug: "webhook-shop" });
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    const { order } = await placeStoreOrder(prisma, s, { qty: 1, online: true });
    const { attempt } = await startPayment(prisma, registry, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
    const cb = await sim.completePayment(attempt.externalRef!);
    const send = (body: string, headers: Record<string, string>) => request(app).post("/webhooks/merchant-payments/simulator").set("content-type", "application/json").set(headers).send(body);

    expect((await send(cb.body, { "x-simulator-signature": "00".repeat(32) })).status).toBe(401);
    expect((await send(cb.body, {})).status).toBe(401);
    expect(await prisma.callbackInbox.count({ where: { provider: "simulator" } })).toBe(0); // nothing stored for an unauthenticated call
    const ok = await send(cb.body, cb.headers);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("recorded");
    expect((await send(cb.body, cb.headers)).body.status).toBe("duplicate");
    expect(await loadStoreOrder(s.scoped, order.id)).toMatchObject({ paidMinor: 0n }); // acknowledged, not yet applied: processing is asynchronous
    await drainInbox(prisma);
    expect(await loadStoreOrder(s.scoped, order.id)).toMatchObject({ paidMinor: 10_000n, status: "CONFIRMED" });
    expect((await send("not json at all", { "x-simulator-signature": "ab" })).status).toBe(400); // the body parser refuses it before it reaches us
    const forged = sim.signedEvent({ event: "payment.updated", eventId: "evt-webhook-forged", purpose: "PLATFORM_SUBSCRIPTION", externalRef: "sim_x1234567", merchantReference: "x", status: "SUCCEEDED", amountMinor: "100", currencyCode: "NGN", destinationKey: "d" });
    expect((await send(forged.body, forged.headers)).status).toBe(403);
    const malformed = sim.signedEvent({ event: "nonsense" });
    expect((await send(malformed.body, malformed.headers)).status).toBe(400);
  });

  it("answers 404 for every provider when none is registered (production today), and for an unknown provider", async () => {
    expect((await request(emptyApp).post("/webhooks/merchant-payments/simulator").set("content-type", "application/json").send("{}")).status).toBe(404);
    expect((await request(emptyApp).post("/webhooks/merchant-payments/pawapay").set("content-type", "application/json").send("{}")).status).toBe(404);
    expect((await request(app).post("/webhooks/merchant-payments/pawapay").set("content-type", "application/json").send("{}")).status).toBe(404);
    expect((await request(app).get("/webhooks/merchant-payments/simulator")).status).toBe(404);
  });
});
