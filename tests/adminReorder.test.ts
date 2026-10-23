import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { tradeWorld } from "./helpers/trade.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { STEP_UP_HEADER } from "../src/admin/platformGuards.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { fulfilSale, receiveStock } from "../src/domain/stock.js";
import { runForecastsForBusiness, scoreForecasts } from "../src/domain/forecast.js";
import { generateReorderSuggestions, setReorderRule } from "../src/domain/reorder.js";
import { acceptSalesOrder, createPurchaseOrder, submitPurchaseOrder } from "../src/domain/trade/orders.js";
import { shipOrder } from "../src/domain/trade/fulfilment.js";
import { deliverTradeEvents } from "../src/domain/trade/handlers.js";

const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
const DAY = 86_400_000;
const D0 = new Date("2026-08-03T09:00:00Z");
const at = (days: number, hours = 12) => new Date(Date.UTC(2026, 7, 3 + days, hours));

let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let merchantId: string;
let variantId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginAs = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
const setFlag = (key: string, on: boolean) => prisma.featureFlag.update({ where: { key }, data: { enabledByDefault: on } });

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);

  const m = await makeBusiness(prisma, "Forecast Merchant");
  merchantId = m.businessId;
  for (const f of ["reorderRules", "reorderForecastShadow", "stockV2"]) await enableFlag(prisma, m.businessId, f);
  const p = await createProduct(m.scoped, { businessId: m.businessId, name: "Rice" });
  const v = await createVariant(m.scoped, { businessId: m.businessId, productId: p.id, sku: "RICE-1", name: "bag", baseUnit: "bag" });
  variantId = v.id;
  const common = { businessId: m.businessId, shopId: m.shopId, variantId: v.id, currencyCode: "NGN" };
  await receiveStock(m.scoped, { ...common, quantity: 100_000, unitCostMinor: 5_000n, occurredAt: at(-87) });
  for (let w = -12; w < 5; w++) await fulfilSale(m.scoped, { ...common, quantity: Math.abs(w) % 2 === 0 ? 6 : 14, occurredAt: at(w * 7 + 3) });
  await setReorderRule(m.scoped, { businessId: m.businessId, shopId: m.shopId, variantId: v.id, mode: "DAYS_OF_COVER", targetCoverDays: 14, windowDays: 7 });
  for (const day of [0, 7, 14, 21]) await runForecastsForBusiness(prisma, m.businessId, new Date(D0.getTime() + day * DAY));
  await scoreForecasts(prisma, new Date(D0.getTime() + 40 * DAY));
  await generateReorderSuggestions(prisma, { businessId: m.businessId, now: D0 });

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

describe("reorder and forecasting panel", () => {
  it("shows suggestions issued/accepted, forecast scores per merchant and variant, thresholds and gate state to owner and operator only", async () => {
    for (const email of ["super@t.test", "op@t.test"]) {
      const r = await request(app).get("/admin/reorder/overview").set(auth(await loginAs(email)));
      expect(r.status).toBe(200);
      const row = r.body.merchants.find((x: { businessId: string }) => x.businessId === merchantId);
      expect(row).toMatchObject({ name: "Forecast Merchant", rules: 1, flags: { tier1: true, shadow: true, live: false } });
      expect(row.forecast).toMatchObject({ scoredPredictions: 4, scoredWeeks: 4 });
      expect(row.forecast.improvementBps).toBeGreaterThan(2_000);
      expect(row.suggestions.issued).toBeGreaterThanOrEqual(0);
      expect(r.body.thresholds).toMatchObject({ minScoredWeeks: null, minImprovementBps: null }); // not set: no defaults
      expect(row.eligible).toBe(false);
    }
    for (const email of ["support@t.test", "analyst@t.test"]) {
      expect((await request(app).get("/admin/reorder/overview").set(auth(await loginAs(email)))).status).toBe(403);
    }
    expect((await request(app).get("/admin/reorder/overview")).status).toBe(401);
  });

  it("lists predictions with their scores, per-variant summaries and the gate history for one merchant", async () => {
    const r = await request(app).get(`/admin/businesses/${merchantId}/forecasts`).set(auth(await loginAs("op@t.test")));
    expect(r.status).toBe(200);
    expect(r.body.predictions).toHaveLength(4);
    const p = r.body.predictions[0];
    expect(p).toMatchObject({ sku: "RICE-1", method: "ses-v1" });
    expect(p.score).toMatchObject({ stockout: false });
    expect(p.score.tier1ApeBps).toBeGreaterThan(p.score.modelApeBps);
    expect(r.body.perVariant).toEqual([expect.objectContaining({ variantId, sku: "RICE-1" })]);
    expect(r.body.businessSummary.scoredWeeks).toBe(4);
    expect((await request(app).get(`/admin/businesses/nope/forecasts`).set(auth(await loginAs("op@t.test")))).status).toBe(404);
  });

  it("only the owner can set thresholds; operators cannot; values are validated; the change is audited", async () => {
    const op = await loginAs("op@t.test");
    expect((await request(app).put("/admin/forecast-gate-config").set(auth(op)).send({ minScoredWeeks: 3 })).status).toBe(403);
    const sup = await loginAs("super@t.test");
    expect((await request(app).put("/admin/forecast-gate-config").set(auth(sup)).send({})).status).toBe(400);
    expect((await request(app).put("/admin/forecast-gate-config").set(auth(sup)).send({ minScoredWeeks: 0 })).status).toBe(400);
    const ok = await request(app).put("/admin/forecast-gate-config").set(auth(sup)).set("x-correlation-id", "corr-thresholds-1").send({ minScoredWeeks: 3, minImprovementBps: 2_000 });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ minScoredWeeks: 3, minImprovementBps: 2_000 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "admin.forecast_gate.config_set" }, orderBy: { createdAt: "desc" } });
    expect(audit.metadata).toMatchObject({ after: { minScoredWeeks: 3, minImprovementBps: 2_000 } });
    expect((await request(app).get("/admin/forecast-gate-config").set(auth(op))).body).toMatchObject({ minScoredWeeks: 3, minImprovementBps: 2_000 });
  });

  it("the owner opens a merchant's gate only above the thresholds; a rejected attempt is recorded and shows its numbers", async () => {
    const sup = await loginAs("super@t.test");
    await request(app).put("/admin/forecast-gate-config").set(auth(sup)).send({ minScoredWeeks: 8, minImprovementBps: 2_000 });
    const rejected = await request(app).post(`/admin/businesses/${merchantId}/forecast-gate`).set(auth(sup)).send({ enabled: true, reason: "Early look at this merchant" });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ code: "BELOW_THRESHOLD", metrics: { scoredWeeks: 4 } });
    expect(await prisma.businessFeatureFlag.findFirst({ where: { businessId: merchantId, flagKey: "reorderForecastLive", enabled: true } })).toBeNull();

    await request(app).put("/admin/forecast-gate-config").set(auth(sup)).send({ minScoredWeeks: 3 });
    expect((await request(app).post(`/admin/businesses/${merchantId}/forecast-gate`).set(auth(await loginAs("op@t.test"))).send({ enabled: true, reason: "Operators may not do this" })).status).toBe(403);
    expect((await request(app).post(`/admin/businesses/${merchantId}/forecast-gate`).set(auth(sup)).send({ enabled: true, reason: "short" })).status).toBe(400);
    const ok = await request(app).post(`/admin/businesses/${merchantId}/forecast-gate`).set(auth(sup)).set("x-correlation-id", "corr-gate-open-1").send({ enabled: true, reason: "Four scored weeks, large improvement" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true });
    expect((await prisma.businessFeatureFlag.findFirstOrThrow({ where: { businessId: merchantId, flagKey: "reorderForecastLive" } })).enabled).toBe(true);
    const overview = await request(app).get("/admin/reorder/overview").set(auth(sup));
    expect(overview.body.merchants.find((x: { businessId: string }) => x.businessId === merchantId)).toMatchObject({ flags: { live: true }, eligible: true });
    const history = await request(app).get(`/admin/businesses/${merchantId}/forecasts`).set(auth(sup));
    expect(history.body.gateEvents.map((e: { action: string }) => e.action)).toEqual(["ENABLED", "REJECTED"]);
    expect(history.body.gateEvents[0]).toMatchObject({ correlationId: "corr-gate-open-1" });
    const rows = await prisma.auditLog.findMany({ where: { businessId: merchantId, action: { in: ["admin.forecast_gate.enabled", "admin.forecast_gate.rejected"] } } });
    expect(rows.map((r) => r.action).sort()).toEqual(["admin.forecast_gate.enabled", "admin.forecast_gate.rejected"]);

    // closing is always available
    expect((await request(app).post(`/admin/businesses/${merchantId}/forecast-gate`).set(auth(sup)).send({ enabled: false, reason: "Pausing for this merchant" })).status).toBe(200);
  });

  it("the generic flag routes cannot open the gate (409), but can close it, and step-up is demanded when enabled", async () => {
    const sup = await loginAs("super@t.test");
    const viaBusiness = await request(app).post(`/admin/businesses/${merchantId}/feature-flags/reorderForecastLive`).set(auth(sup)).send({ enabled: true, reason: "Bypass attempt" });
    expect(viaBusiness.status).toBe(409);
    expect(viaBusiness.body.code).toBe("PROTECTED_FLAG");
    const viaGlobal = await request(app).post("/admin/feature-flags/reorderForecastLive").set(auth(sup)).send({ enabledByDefault: true });
    expect(viaGlobal.status).toBe(409);
    expect(await prisma.featureFlag.findUniqueOrThrow({ where: { key: "reorderForecastLive" } })).toMatchObject({ enabledByDefault: false });

    await setFlag("adminStepUp", true);
    const noStepUp = await request(app).post(`/admin/businesses/${merchantId}/forecast-gate`).set(auth(sup)).send({ enabled: false, reason: "Needs step-up first" });
    expect(noStepUp.body.code).toBe("STEP_UP_REQUIRED");
    const su = await request(app).post("/admin/step-up").set(auth(sup)).send({ password: PW });
    expect((await request(app).post(`/admin/businesses/${merchantId}/forecast-gate`).set(auth(sup)).set(STEP_UP_HEADER, su.body.stepUpToken).send({ enabled: false, reason: "Step-up satisfied now" })).status).toBe(200);
  });
});

describe("trade orders and invoices in the admin panel", () => {
  it("shows each business its own documents, with payment evidence labels, behind the financial permission", async () => {
    const w = await tradeWorld(prisma);
    const po = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: w.rPartner.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, counterpartVariantId: w.wVariant.id, quantity: 2, unit: "carton" }] });
    await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: po.id });
    await deliverTradeEvents(prisma);
    const soId = (await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: po.id } })).counterpartOrderId!;
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: soId });
    const so = await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: soId }, include: { lines: true } });
    await shipOrder(prisma, { businessId: w.W.businessId, orderId: soId, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: 48 }] });
    await deliverTradeEvents(prisma);

    const sup = await loginAs("support@t.test");
    const orders = await request(app).get(`/admin/businesses/${w.W.businessId}/trade-orders`).set(auth(sup));
    expect(orders.status).toBe(200);
    expect(orders.body.orders).toHaveLength(1);
    expect(orders.body.orders[0]).toMatchObject({ reference: "SO-000001", side: "SELL", partner: "Retail Corner", linked: true, acceptance: "ACCEPTED", movement: "SHIPPED", totalMinor: "440000" });
    expect(orders.body.orders[0].lines[0]).toMatchObject({ sku: "COLA-330", baseQuantity: 48, shippedBase: 48 });
    const buyer = await request(app).get(`/admin/businesses/${w.R.businessId}/trade-orders`).set(auth(sup));
    expect(buyer.body.orders[0]).toMatchObject({ reference: "PO-000001", side: "BUY", partner: "Alpha Wholesale" });
    expect(JSON.stringify(buyer.body)).not.toContain(w.W.businessId); // the buyer's view never names the seller's business id

    const invoices = await request(app).get(`/admin/businesses/${w.W.businessId}/trade-invoices`).set(auth(sup));
    expect(invoices.body.invoices[0]).toMatchObject({ number: "INV-000001", side: "SELL", totalMinor: "440000", paidMinor: "0", outstandingMinor: "440000", paymentStatus: "UNPAID", overdue: false });
    expect((await request(app).get(`/admin/businesses/${w.W.businessId}/trade-orders`).set(auth(await loginAs("analyst@t.test")))).status).toBe(403);
    expect((await request(app).get(`/admin/businesses/nope/trade-orders`).set(auth(sup))).status).toBe(404);
  });
});
