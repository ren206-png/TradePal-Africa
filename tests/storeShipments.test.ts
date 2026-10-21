import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { CourierRegistry } from "../src/couriers/adapter.js";
import { SimulatorCourier, COURIER_SIMULATOR_ID } from "../src/couriers/simulatorCourier.js";
import { buildCourierRegistry, setCourierRegistry } from "../src/couriers/registry.js";
import { createCourierWebhookRouter } from "../src/couriers/webhook.js";
import { completeStoreOrder, confirmStoreOrder, publicOrderView } from "../src/domain/store/orders.js";
import { applyShipmentUpdate, buildCourierCallbackHandlers, cancelShipment, createShipment, pollQuietShipments, publicShipmentFor, receiveCourierCallback, shipmentForOrder } from "../src/domain/store/shipments.js";
import { escalateStuckDeliveries } from "../src/domain/store/escalation.js";
import { processInbox } from "../src/domain/callbackInbox.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";

vi.setConfig({ testTimeout: 60_000 });
const SECRET = "courier-simulator-secret-for-tests";
let testDb: TestDb;
let prisma: PrismaClient;
let sim: SimulatorCourier;
let registry: CourierRegistry;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  sim = new SimulatorCourier(SECRET);
  registry = new CourierRegistry().register(sim);
  setCourierRegistry(registry);
}, 60_000);
afterAll(async () => {
  setCourierRegistry(null);
  await testDb.teardown();
});
afterEach(() => {
  delete process.env["COURIERS_ENABLED"];
  sim.failNextBooking = false;
});

/** A seller with a CONFIRMED delivery order and courier tracking on. */
async function confirmedDelivery(opts: { flag?: boolean } = {}) {
  process.env["COURIERS_ENABLED"] = "true";
  const s = await makeSeller(prisma, `Courier Shop ${++k}`, { slug: `courier-shop-${k}` });
  if (opts.flag !== false) await enableFlag(prisma, s.businessId, "storeCourier");
  const { order, token } = await placeStoreOrder(prisma, s, { qty: 2, fulfilment: "DELIVERY" });
  await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
  return { s, order, token };
}
const orderRow = (s: Seller, id: string) => s.scoped.storeOrder.findUniqueOrThrow({ where: { id } });

describe("booking a courier", () => {
  it("the manual courier records who is delivering, dispatches the order and shows it to the shopper", async () => {
    const { s, order } = await confirmedDelivery();
    const r = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual", courierName: "Gokada", trackingRef: "GK-4411", trackingUrl: "https://gokada.example/t/GK-4411", riderName: "Tunde", riderPhone: "08031112222", actor: "m-1" });
    expect(r.dispatched).toBe(true);
    expect(r.shipment).toMatchObject({ courier: "manual", courierName: "Gokada", status: "BOOKED", trackingRef: "GK-4411", riderPhone: "2348031112222", externalId: null, feeMinor: null });
    expect(await orderRow(s, order.id)).toMatchObject({ status: "OUT_FOR_DELIVERY", carrier: "Gokada", deliveryRef: "GK-4411" });
    const view = await publicOrderView(prisma, s.businessId, order.id);
    expect(view.delivery!.shipment).toMatchObject({ courierName: "Gokada", status: "BOOKED", statusLabel: "Booked", trackingUrl: "https://gokada.example/t/GK-4411", riderName: "Tunde", riderPhone: "2348031112222" });
    expect(JSON.stringify(view.delivery!.shipment)).not.toMatch(/fee|idempotency|externalId/i);
  });

  it("a registered courier takes the booking; its fee is recorded for the seller and never added to the shopper's total", async () => {
    const { s, order } = await confirmedDelivery();
    const before = await orderRow(s, order.id);
    const r = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID });
    expect(r.shipment).toMatchObject({ courier: COURIER_SIMULATOR_ID, courierName: "Simulator courier (testing only)", externalId: expect.stringMatching(/^sc_/), feeMinor: 150_000n, currencyCode: "NGN", riderName: "Test Rider" });
    const after = await orderRow(s, order.id);
    expect(after.totalMinor).toBe(before.totalMinor);
    expect(after.deliveryFeeMinor).toBe(before.deliveryFeeMinor);
    expect(after.status).toBe("OUT_FOR_DELIVERY");
    expect(JSON.stringify(await publicShipmentFor(s.scoped, order.id))).not.toContain("150000");
  });

  it("a courier that refuses the job changes nothing", async () => {
    const { s, order } = await confirmedDelivery();
    sim.failNextBooking = true;
    await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID })).rejects.toThrow(/could not take this job.*Nothing was changed/);
    expect(await orderRow(s, order.id)).toMatchObject({ status: "CONFIRMED" });
    expect(await s.scoped.deliveryShipment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("is switched off without the platform switch or the seller's flag, and refuses a pickup order, an unconfirmed order and an unknown courier", async () => {
    const off = await confirmedDelivery({ flag: false });
    await expect(createShipment(prisma, registry, { businessId: off.s.businessId, orderId: off.order.id, courier: "manual" })).rejects.toThrow(/not switched on/);
    const { s, order } = await confirmedDelivery();
    delete process.env["COURIERS_ENABLED"];
    await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual" })).rejects.toThrow(/not switched on/);
    process.env["COURIERS_ENABLED"] = "true";
    await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "swift-riders" })).rejects.toThrow(/don't know the courier/);
    const pickup = await placeStoreOrder(prisma, s, { qty: 1, fulfilment: "PICKUP" });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: pickup.order.id });
    await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: pickup.order.id, courier: "manual" })).rejects.toThrow(/Only a delivery order/);
    const unconfirmed = await placeStoreOrder(prisma, s, { qty: 1, fulfilment: "DELIVERY" });
    await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: unconfirmed.order.id, courier: "manual" })).rejects.toThrow(/confirm it first/);
  });

  it("one live job per order; a second courier needs the first called off; an already-dispatched order can get a courier attached", async () => {
    const { s, order } = await confirmedDelivery();
    await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual" });
    await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID })).rejects.toThrow(/already has a delivery job/);
    await cancelShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, reason: "rider fell ill" });
    const second = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID });
    expect(second.dispatched).toBe(false); // already out for delivery: only the courier is attached
    expect((await orderRow(s, order.id)).status).toBe("OUT_FOR_DELIVERY");
    expect(await s.scoped.deliveryShipment.count({ where: { orderId: order.id } })).toBe(2);
    // the database also refuses two live jobs for one order
    await expect(testDb.db.query(`INSERT INTO "DeliveryShipment" (id, "businessId", "orderId", courier, "courierName", "idempotencyKey", status, "updatedAt") VALUES ('x1', '${s.businessId}', '${order.id}', 'manual', 'x', 'dup-live', 'BOOKED', now())`)).rejects.toThrow(/one_live_per_order|duplicate key/);
  });

  it("only an https tracking link without credentials is accepted, and a bad rider number is refused", async () => {
    const { s, order } = await confirmedDelivery();
    for (const bad of ["http://insecure.example/t", "javascript:alert(1)", "https://user:pw@evil.example/t", "not a link", `https://x.example/${"a".repeat(300)}`]) {
      await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual", trackingUrl: bad }), bad).rejects.toThrow(/tracking link/);
    }
    await expect(createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual", riderPhone: "123" })).rejects.toThrow(/rider phone/);
    expect(await s.scoped.deliveryShipment.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("how a job moves", () => {
  it("only forward: a late or out-of-order report is kept in the history and changes nothing; a repeated event id is ignored", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual" });
    const up = (status: Parameters<typeof applyShipmentUpdate>[1]["status"], extra: Partial<Parameters<typeof applyShipmentUpdate>[1]> = {}) => applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status, source: "COURIER", ...extra });
    expect((await up("IN_TRANSIT", { externalEventId: "e1" })).applied).toBe(true); // skipping PICKED_UP is fine
    expect((await up("PICKED_UP", { externalEventId: "e2" })).applied).toBe(false); // late
    expect((await up("IN_TRANSIT", { externalEventId: "e1" }))).toMatchObject({ applied: false, duplicate: true });
    expect((await up("DELIVERED", { externalEventId: "e3" })).applied).toBe(true);
    expect((await up("IN_TRANSIT", { externalEventId: "e4" })).applied).toBe(false); // finished jobs stay finished
    const view = (await shipmentForOrder(s.scoped, order.id))!;
    expect(view.status).toBe("DELIVERED");
    expect(view.history.map((h) => h.status)).toEqual(["BOOKED", "IN_TRANSIT", "PICKED_UP", "DELIVERED", "IN_TRANSIT"]);
    expect(view.history[2]!.detail).toMatch(/not applied/);
  });

  it("a courier saying delivered does NOT complete the order: only the shopper's hand-over code does", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual" });
    await applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status: "DELIVERED", source: "COURIER" });
    expect((await orderRow(s, order.id)).status).toBe("OUT_FOR_DELIVERY");
    expect(await s.scoped.journalEntry.count({ where: { kind: "SALE" } })).toBe(0); // no sale booked
    const { pickupCode } = await orderRow(s, order.id);
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: pickupCode, collect: { method: "CASH" } });
    expect((await orderRow(s, order.id)).status).toBe("COMPLETED");
  });

  it("a failed job needs a reason and leaves the order for the seller to decide; a failed job can still be marked returned", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual" });
    await expect(applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status: "FAILED", source: "SELLER" })).rejects.toThrow(/Say why/);
    const r = await applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status: "FAILED", source: "COURIER", reason: "Nobody at the address" });
    expect(r.shipment).toMatchObject({ status: "FAILED", failureReason: "Nobody at the address" });
    expect((await orderRow(s, order.id)).status).toBe("OUT_FOR_DELIVERY");
    expect((await applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status: "RETURNED", source: "SELLER" })).applied).toBe(true);
    expect((await applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status: "DELIVERED", source: "SELLER" })).applied).toBe(false);
  });

  it("can be called off only before pick-up", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID });
    await applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status: "PICKED_UP", source: "COURIER" });
    await expect(cancelShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, reason: "changed my mind" })).rejects.toThrow(/already has the parcel/);
  });

  it("the database refuses to take a finished job back, move it to another order, or delete it, and keeps its history append-only", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual" });
    await applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: shipment.id, status: "DELIVERED", source: "SELLER" });
    await expect(testDb.db.query(`UPDATE "DeliveryShipment" SET status = 'BOOKED' WHERE id = '${shipment.id}'`)).rejects.toThrow(/final/);
    await expect(testDb.db.query(`UPDATE "DeliveryShipment" SET "orderId" = '${order.id}x' WHERE id = '${shipment.id}'`)).rejects.toThrow();
    await expect(testDb.db.query(`DELETE FROM "DeliveryShipment" WHERE id = '${shipment.id}'`)).rejects.toThrow();
    await expect(testDb.db.query(`UPDATE "DeliveryShipmentEvent" SET detail = 'x' WHERE "shipmentId" = '${shipment.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`UPDATE "DeliveryShipment" SET "trackingUrl" = 'http://x' WHERE id = '${shipment.id}'`)).rejects.toThrow();
  });
});

describe("courier callbacks", () => {
  const app = () => {
    const a = express();
    a.use(createCourierWebhookRouter(prisma, () => registry, { limiter: new InMemoryLoginRateLimiter(1000, 60_000) }));
    return a;
  };

  it("a verified callback is stored, applied by the worker once, and a repeat is a duplicate", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID });
    const cb = sim.advance(shipment.externalId!, "IN_TRANSIT", { eventId: "ev-it-1" });
    const first = await request(app()).post(`/webhooks/courier/${COURIER_SIMULATOR_ID}`).set(cb.headers).send(cb.body.toString());
    expect([first.status, first.body]).toEqual([200, { status: "recorded" }]);
    expect((await request(app()).post(`/webhooks/courier/${COURIER_SIMULATOR_ID}`).set(cb.headers).send(cb.body.toString())).body).toEqual({ status: "duplicate" });
    const handlers = buildCourierCallbackHandlers(prisma, registry);
    const ran = await processInbox(prisma, handlers, { now: new Date(Date.now() + 1000) });
    expect(ran).toMatchObject({ claimed: 1, processed: 1 });
    expect((await shipmentForOrder(s.scoped, order.id))!.status).toBe("IN_TRANSIT");
    const done = sim.advance(shipment.externalId!, "DELIVERED", { eventId: "ev-dl-1" });
    await receiveCourierCallback(prisma, registry, COURIER_SIMULATOR_ID, done.body, done.headers);
    await processInbox(prisma, handlers, { now: new Date(Date.now() + 1000) });
    expect((await shipmentForOrder(s.scoped, order.id))).toMatchObject({ status: "DELIVERED", statusLabel: "Delivered (reported by the courier)" });
  });

  it("refuses a forged, tampered or replayed callback and stores nothing", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID });
    const before = await prisma.callbackInbox.count({ where: { provider: `courier:${COURIER_SIMULATOR_ID}` } });
    const ext = shipment.externalId!;
    for (const cb of [sim.advance(ext, "DELIVERED", { secret: "wrong" }), sim.advance(ext, "DELIVERED", { timestamp: Math.floor(Date.now() / 1000) - 3600 })]) {
      expect((await request(app()).post(`/webhooks/courier/${COURIER_SIMULATOR_ID}`).set(cb.headers).send(cb.body.toString())).status).toBe(401);
    }
    const ok = sim.advance(ext, "IN_TRANSIT", { eventId: "ev-t-1" });
    const tampered = Buffer.from(ok.body.toString().replace("IN_TRANSIT", "DELIVERED"));
    expect((await request(app()).post(`/webhooks/courier/${COURIER_SIMULATOR_ID}`).set(ok.headers).send(tampered.toString())).status).toBe(401);
    expect((await request(app()).post(`/webhooks/courier/${COURIER_SIMULATOR_ID}`).send(ok.body.toString())).status).toBe(401); // no signature
    expect((await request(app()).post(`/webhooks/courier/unknown-courier`).set(ok.headers).send(ok.body.toString())).status).toBe(404);
    expect(await prisma.callbackInbox.count({ where: { provider: `courier:${COURIER_SIMULATOR_ID}` } })).toBe(before);
    expect((await shipmentForOrder(s.scoped, order.id))!.status).toBe("BOOKED");
  });

  it("an event for a job we do not have fails the worker (and is retried, then dead-lettered) instead of vanishing", async () => {
    const cb = sim.advance("sc_999999", "DELIVERED", { eventId: "ev-ghost-1" });
    expect((await receiveCourierCallback(prisma, registry, COURIER_SIMULATOR_ID, cb.body, cb.headers)).status).toBe("recorded");
    const r = await processInbox(prisma, buildCourierCallbackHandlers(prisma, registry), { now: new Date(Date.now() + 1000) });
    expect(r.retried + r.dead).toBe(1);
  });

  it("a missed callback is caught by asking the courier about quiet jobs", async () => {
    const { s, order } = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: COURIER_SIMULATOR_ID });
    sim.advance(shipment.externalId!, "IN_TRANSIT"); // the courier moves on; no callback reaches us
    expect((await shipmentForOrder(s.scoped, order.id))!.status).toBe("BOOKED");
    const quiet = new Date(Date.now() + 2 * 3_600_000);
    const r = await pollQuietShipments(prisma, registry, quiet);
    expect(r.updated).toBeGreaterThanOrEqual(1);
    expect((await shipmentForOrder(s.scoped, order.id))!.status).toBe("IN_TRANSIT");
  });

  it("a production process never builds the simulator courier", () => {
    expect(buildCourierRegistry({ NODE_ENV: "production", COURIER_SIMULATOR_ENABLED: "true", COURIER_SIMULATOR_SECRET: "x" } as unknown as NodeJS.ProcessEnv).list()).toEqual([]);
    expect(buildCourierRegistry({ NODE_ENV: "development", COURIER_SIMULATOR_ENABLED: "true", COURIER_SIMULATOR_SECRET: "x" } as unknown as NodeJS.ProcessEnv).list().map((a) => a.id)).toEqual([COURIER_SIMULATOR_ID]);
    expect(buildCourierRegistry({ NODE_ENV: "development", COURIER_SIMULATOR_ENABLED: "true" } as unknown as NodeJS.ProcessEnv).list()).toEqual([]); // no secret
  });
});

describe("what the shopper sees, and the safety net", () => {
  it("the order page shows the courier, its status and a safe tracking link; never the fee", async () => {
    const { s, order, token } = await confirmedDelivery();
    const app = express();
    app.use(createStorefrontRouter(prisma, { limiters: { read: new InMemoryLoginRateLimiter(1000, 60_000) } }));
    await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual", courierName: "Gokada <b>", trackingUrl: "https://gokada.example/t/1?a=1&b=2", riderName: "Tunde", riderPhone: "08031112222" });
    const page = await request(app).get(`/order/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Gokada &lt;b&gt;");
    expect(page.text).not.toContain("Gokada <b>");
    expect(page.text).toMatch(/<a href="https:\/\/gokada\.example\/t\/1\?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">Track this delivery<\/a>/);
    expect(page.text).toContain("Rider: Tunde (2348031112222)");
    const sh = (await shipmentForOrder(s.scoped, order.id))!;
    await applyShipmentUpdate(prisma, { businessId: s.businessId, shipmentId: sh.id, status: "DELIVERED", source: "COURIER" });
    expect((await request(app).get(`/order/${token}`)).text).toContain("The seller will ask for your 6-digit code");
  });

  it("an order out for delivery for a week with no word is escalated once to a support case", async () => {
    const { s, order } = await confirmedDelivery();
    await createShipment(prisma, registry, { businessId: s.businessId, orderId: order.id, courier: "manual" });
    expect((await escalateStuckDeliveries(prisma, new Date(Date.now() + 3 * 86_400_000))).escalated).toBe(0);
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect((await escalateStuckDeliveries(prisma, later)).escalated).toBeGreaterThanOrEqual(1);
    expect((await escalateStuckDeliveries(prisma, later)).escalated).toBe(0); // once
    const c = await s.scoped.supportCase.findFirstOrThrow({ where: { orderId: order.id } });
    expect(c).toMatchObject({ type: "DELIVERY", handledBy: "PLATFORM", openedBy: "ADMIN" });
    expect((await orderRow(s, order.id)).status).toBe("OUT_FOR_DELIVERY"); // nothing changed on the seller's behalf
  });

  it("one seller can never see or change another seller's delivery jobs", async () => {
    const a = await confirmedDelivery();
    const b = await confirmedDelivery();
    const { shipment } = await createShipment(prisma, registry, { businessId: a.s.businessId, orderId: a.order.id, courier: "manual" });
    expect(await b.s.scoped.deliveryShipment.count({ where: {} })).toBe(0);
    await expect(applyShipmentUpdate(prisma, { businessId: b.s.businessId, shipmentId: shipment.id, status: "DELIVERED", source: "SELLER" })).rejects.toThrow(/not found/);
    await expect(createShipment(prisma, registry, { businessId: b.s.businessId, orderId: a.order.id, courier: "manual" })).rejects.toThrow(/not found/);
  });
});
