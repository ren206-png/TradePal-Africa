import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, type Seller } from "./helpers/store.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { processInbox } from "../src/domain/callbackInbox.js";
import { buildTradeCallbackHandlers } from "../src/domain/trade/handlers.js";
import { completeStoreOrder, confirmStoreOrder, dispatchStoreOrder, loadStoreOrder } from "../src/domain/store/orders.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { addPriceRule } from "../src/domain/pricing.js";
import { receiveStock } from "../src/domain/stock.js";
import { listVariant } from "../src/domain/store/storefront.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let k = 0;
const SECRET = "sim-secret-for-tests-only";

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  app = express();
  app.use(createStorefrontRouter(prisma, { simulatorSecret: SECRET }));
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

const shop = (opts: NonNullable<Parameters<typeof makeSeller>[2]> = {}) => makeSeller(prisma, `Web Shop ${++k}`, { slug: `web-shop-${k}`, ...opts });
const slugOf = async (s: Seller) => (await prisma.storefront.findFirstOrThrow({ where: { businessId: s.businessId } })).slug;

/** A shopper's browser: keeps cookies between requests. */
function shopper() {
  const agent = request.agent(app);
  return agent;
}

async function addCan(agent: ReturnType<typeof shopper>, s: Seller, quantity = 3, unit = "can") {
  return agent.post(`/shop/${await slugOf(s)}/add`).type("form").send({ variantId: s.variant.id, unit, quantity: String(quantity) });
}

async function checkout(agent: ReturnType<typeof shopper>, s: Seller, extra: Record<string, string> = {}) {
  const zone = await s.scoped.deliveryZone.findFirst({ where: {} });
  return agent.post("/basket/checkout").type("form").send({
    buyerName: "Amaka Obi", buyerPhone: "08031234567", consent: "yes", seller: s.businessId,
    [`fulfil_${s.businessId}`]: "PICKUP", [`pay_${s.businessId}`]: "PAY_ON_COLLECTION", [`zone_${s.businessId}`]: zone!.id, ...extra,
  });
}

const orderLink = (html: string) => /href="(\/order\/[0-9a-f]{48})"/.exec(html)?.[1];

describe("public catalog (scenario 18: nothing private leaks)", () => {
  it("shows prices and an availability label, never cost, stock numbers or tenant ids", async () => {
    const s = await shop();
    const res = await request(app).get(`/shop/${await slugOf(s)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Cola");
    expect(res.text).toContain("In stock");
    expect(res.text).toContain("100.00");
    expect(res.text).not.toContain("40.00"); // the private unit cost
    expect(res.text).not.toContain(s.businessId);
    expect(res.text).not.toMatch(/\b50\b.*in stock/i);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("noindex");
  });

  it("escapes everything a seller or shopper controls (no script injection)", async () => {
    const s = await shop();
    await prisma.storefront.update({ where: { businessId: s.businessId }, data: { title: `<script>alert(1)</script>Evil "Shop"`, about: `<img src=x onerror=alert(2)>` } });
    const res = await request(app).get(`/shop/${await slugOf(s)}?q=${encodeURIComponent(`"><script>alert(3)</script>`)}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>");
    expect(res.text).not.toContain("<img src=x");
    expect(res.text).toContain("&lt;script&gt;");
  });

  it("an unknown or closed shop is a plain not-found, the same for both", async () => {
    const s = await shop();
    await prisma.storefront.update({ where: { businessId: s.businessId }, data: { enabled: false } });
    const closed = await request(app).get(`/shop/${await slugOf(s)}`);
    const unknown = await request(app).get("/shop/no-such-shop");
    expect(closed.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(closed.text).toBe(unknown.text);
  });

  it("stays small on a slow connection: a 30-item shop page is under 30 KB and uses no script", async () => {
    const s = await shop();
    for (let i = 0; i < 29; i++) {
      const p = await createProduct(s.scoped, { businessId: s.businessId, name: `Item number ${i + 1}` });
      const v = await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku: `ITEM-${i + 1}`, name: "Standard", baseUnit: "each" });
      await receiveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: v.id, quantity: 10, unitCostMinor: 1_000n, currencyCode: "NGN" });
      await addPriceRule(s.scoped, { businessId: s.businessId, priceListId: s.list.id, variantId: v.id, unitPriceMinor: 5_000n });
      await listVariant(prisma, s.businessId, v.id);
    }
    const res = await request(app).get(`/shop/${await slugOf(s)}`);
    expect(res.text.match(/Add to basket/g)!.length).toBe(30);
    expect(Buffer.byteLength(res.text)).toBeLessThan(30_000);
    expect(res.text).not.toMatch(/<script/i);
  });
});

describe("basket and checkout through the web", () => {
  it("a shopper adds items, sees the live basket, and places a pickup order with only a cookie and a secret link", async () => {
    const s = await shop();
    const agent = shopper();
    const added = await addCan(agent, s, 3);
    expect(added.status).toBe(303);
    const cookie = String(added.headers["set-cookie"]);
    expect(cookie).toMatch(/tp_basket=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const basket = await agent.get("/basket");
    expect(basket.status).toBe(200);
    expect(basket.headers["cache-control"]).toContain("no-store");
    expect(basket.headers["x-robots-tag"]).toContain("noindex");
    expect(basket.text).toContain("300.00");

    const placed = await checkout(agent, s);
    expect(placed.status).toBe(200);
    const link = orderLink(placed.text);
    expect(link).toBeTruthy();
    expect(placed.text).toContain("ORD-000001");

    const page = await request(app).get(link!); // no cookies at all: the link alone is the credential
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.text).toContain("Opposite the market gate");
    expect(page.text).not.toContain("40.00");
    expect(page.text).not.toContain("08031234567"); // the shopper's own phone is not echoed back either

    const list = await agent.get("/orders");
    expect(list.text).toContain("ORD-000001");
    const stranger = await request(app).get("/orders");
    expect(stranger.text).not.toContain("ORD-000001");
  });

  it("orders cannot be reached by id, reference, phone or a guessed token (scenario 18)", async () => {
    const s = await shop();
    const agent = shopper();
    await addCan(agent, s, 1);
    const placed = await checkout(agent, s);
    const link = orderLink(placed.text)!;
    const order = await s.scoped.storeOrder.findFirstOrThrow({ where: {} });
    for (const guess of [order.id, order.reference, "08031234567", "0".repeat(48), link.split("/").pop()!.toUpperCase().replace(/[0-9a-f]$/i, "z")]) {
      const res = await request(app).get(`/order/${encodeURIComponent(guess)}`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain("Amaka");
    }
    const bad = await request(app).get(`/order/${"f".repeat(48)}/receipt`);
    expect(bad.status).toBe(404);
  });

  it("a double submit of the checkout places the order once", async () => {
    const s = await shop();
    const agent = shopper();
    await addCan(agent, s, 2);
    const first = await checkout(agent, s);
    const second = await checkout(agent, s);
    expect(first.status).toBe(200);
    expect([200, 303, 400]).toContain(second.status);
    expect(await s.scoped.storeOrder.count()).toBe(1);
  });

  it("refuses a form post that comes from another site", async () => {
    const s = await shop();
    const res = await request(app).post(`/shop/${await slugOf(s)}/add`).set("Origin", "https://evil.example").type("form").send({ variantId: s.variant.id, unit: "can", quantity: "1" });
    expect(res.status).toBe(403);
    expect(await prisma.basket.count()).toBeGreaterThanOrEqual(0);
    const same = await request(app).post(`/shop/${await slugOf(s)}/add`).set("Origin", "http://127.0.0.1").set("Host", "127.0.0.1").type("form").send({ variantId: s.variant.id, unit: "can", quantity: "1" });
    expect(same.status).toBe(303);
  });

  it("rejects bad input politely: zero or huge quantities, wrong unit, oversized bodies", async () => {
    const s = await shop();
    const agent = shopper();
    expect((await addCan(agent, s, 0)).status).toBe(422);
    expect((await addCan(agent, s, 100000)).status).toBe(422);
    expect((await addCan(agent, s, 1, "pallet")).status).toBe(422);
    const big = await request(app).post(`/shop/${await slugOf(s)}/add`).type("form").send({ variantId: s.variant.id, unit: "can", quantity: "1", junk: "x".repeat(30_000) });
    expect(big.status).toBe(413);
  });

  it("rate limits repeated checkouts from one address", async () => {
    const limited = express();
    limited.use(createStorefrontRouter(prisma, { limiters: { order: new InMemoryLoginRateLimiter(2, 60_000) } }));
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await request(limited).post("/basket/checkout").type("form").send({})).status);
    expect(codes.slice(0, 2).every((c) => c === 400)).toBe(true);
    expect(codes.slice(2)).toEqual([429, 429]);
  });
});

describe("delivery, cancellation and the handover code through the web (scenario 19)", () => {
  it("a delivery order shows its fee, its code, and the seller can finish it with that code", async () => {
    const s = await shop();
    const agent = shopper();
    await addCan(agent, s, 2);
    const placed = await checkout(agent, s, { [`fulfil_${s.businessId}`]: "DELIVERY", [`landmark_${s.businessId}`]: "Next to the blue gate" });
    const link = orderLink(placed.text)!;
    const order = await s.scoped.storeOrder.findFirstOrThrow({ where: {} });
    expect(order).toMatchObject({ fulfilment: "DELIVERY", totalMinor: 25_000n * 0n + 20_000n + 50_000n });

    const before = await request(app).get(link);
    expect(before.text).toContain("Delivery fee");
    expect(before.text).toContain("Next to the blue gate");
    expect(before.text).not.toContain("Your handover code"); // not until the seller confirms

    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    const after = await request(app).get(link);
    const code = /handover code: (\d{6})/.exec(after.text)?.[1];
    expect(code).toBeTruthy();
    expect(after.text).toContain("Ask to cancel");
    expect(after.text).not.toContain("Cancel my order");

    await dispatchStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, deliveryRef: "DLV-1" });
    const bad = await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: code === "000000" ? "111111" : "000000" }).catch((e) => e);
    expect(bad.code).toBe("BAD_CODE");
    const done = await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: code!, collect: { method: "CASH" } });
    expect(done.status).toBe("COMPLETED");
    expect((await request(app).get(link)).text).not.toContain("Your handover code");
  });

  it("an unconfirmed order can be cancelled by the shopper at once; the stock is released", async () => {
    const s = await shop();
    const agent = shopper();
    await addCan(agent, s, 4);
    const link = orderLink((await checkout(agent, s)).text)!;
    const res = await request(app).post(`${link}/cancel`).type("form").send({ reason: "changed my mind" });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers["location"] as string)).toContain("cancelled");
    const order = await s.scoped.storeOrder.findFirstOrThrow({ where: {} });
    expect((await loadStoreOrder(s.scoped, order.id)).status).toBe("CANCELLED");
    const page = await request(app).get(link);
    expect(page.text).toContain("cancelled");
  });

  it("a shopper can report a problem and is told who deals with it", async () => {
    const s = await shop();
    const agent = shopper();
    await addCan(agent, s, 1);
    const link = orderLink((await checkout(agent, s)).text)!;
    const res = await request(app).post(`${link}/problem`).type("form").send({ type: "DELIVERY", summary: "Nobody called me" });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers["location"] as string)).toMatch(/recorded your report/);
    expect(await s.scoped.supportCase.count()).toBe(1);
    const bad = await request(app).post(`${link}/problem`).type("form").send({ type: "NOPE", summary: "" });
    expect(decodeURIComponent(bad.headers["location"] as string)).toMatch(/describe/);
  });
});

describe("online test payment through the web (scenario 10)", () => {
  async function onlineOrder() {
    const s = await shop();
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
    const agent = shopper();
    await addCan(agent, s, 2);
    const placed = await checkout(agent, s, { [`pay_${s.businessId}`]: "ONLINE_SIMULATED" });
    const link = orderLink(placed.text)!;
    return { s, link };
  }

  it("pay -> signed callback -> inbox -> the order is confirmed; paying twice cannot double-apply", async () => {
    const { s, link } = await onlineOrder();
    try {
      expect((await request(app).get(link)).text).toContain("Pay now");
      const pay = await request(app).post(`${link}/pay`);
      expect(pay.status).toBe(303);
      await processInbox(prisma, buildTradeCallbackHandlers(prisma));
      const order = await s.scoped.storeOrder.findFirstOrThrow({ where: {} });
      expect(await loadStoreOrder(s.scoped, order.id)).toMatchObject({ status: "CONFIRMED", paidMinor: 20_000n });
      expect((await request(app).get(link)).text).not.toContain("Pay now");
      const again = await request(app).post(`${link}/pay`);
      expect(decodeURIComponent(again.headers["location"] as string)).toMatch(/Nothing to pay/);
    } finally {
      delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
    }
  });

  it("is refused outright in production, whatever else is switched on", async () => {
    const { s, link } = await onlineOrder();
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect((await request(app).get(link)).text).not.toContain("Pay now");
      const res = await request(app).post(`${link}/pay`);
      expect(decodeURIComponent(res.headers["location"] as string)).toMatch(/not available/);
      const order = await s.scoped.storeOrder.findFirstOrThrow({ where: {} });
      expect((await loadStoreOrder(s.scoped, order.id)).paidMinor).toBe(0n);
    } finally {
      process.env["NODE_ENV"] = prev;
      delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
    }
  });

  it("without the simulator switched on, online payment is not even offered at checkout", async () => {
    const s = await shop();
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    const agent = shopper();
    await addCan(agent, s, 1);
    expect((await agent.get("/basket")).text).not.toContain("Pay online");
    const placed = await checkout(agent, s, { [`pay_${s.businessId}`]: "ONLINE_SIMULATED" });
    expect(orderLink(placed.text)).toBeUndefined();
    expect(await s.scoped.storeOrder.count()).toBe(0);
  });
});
