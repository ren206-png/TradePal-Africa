/**
 * Release demo (expansion Phase 9). One synthetic world, one in-process database, no network, no credentials, no real money:
 *
 *   wholesaler purchase -> retailer receipt -> consumer order -> external merchant payment (SIMULATOR) -> fulfilment -> reports
 *   + a separate pawaPay subscription renewal (an IN-MEMORY FAKE of pawaPay, because no sandbox token exists)
 *   + a synthetic merchant's shadow-forecast scores
 *   + every admin panel of section 18 read through the real admin API, to show it is populated.
 *
 *   npx tsx scripts/demoRelease.ts
 *
 * What it proves: that the pieces work TOGETHER on one database. What it does not prove: anything about a real provider, a real network,
 * a real Postgres server or real merchants. The simulator and the fake are ours; they are not recordings of anyone else's service.
 */
import express from "express";
import request from "supertest";
import { createTestDb } from "../tests/helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "../tests/helpers/phase2.js";
import { tradeWorld } from "../tests/helpers/trade.js";
import { drainInbox, simulatorWorld } from "../tests/helpers/payments.js";
import { AUTHORITY, PHONE, billingWorld, makeSlBusiness, publishedPlan, seedSierraLeone } from "../tests/helpers/billing.js";
import { accountNet } from "../src/domain/accounting.js";
import { addPackConversion, createProduct, createVariant } from "../src/domain/catalog.js";
import { createPriceList, addPriceRule } from "../src/domain/pricing.js";
import { fulfilSale, getStockLevel, receiveStock } from "../src/domain/stock.js";
import { formatMoney } from "../src/domain/money.js";
import { forecastScoreSummary, runForecastsForBusiness, scoreForecasts } from "../src/domain/forecast.js";
import { acceptSuggestion, generateReorderSuggestions, listOpenSuggestions, setReorderRule } from "../src/domain/reorder.js";
import { receiveShipment, shipOrder } from "../src/domain/trade/fulfilment.js";
import { deliverTradeEvents } from "../src/domain/trade/handlers.js";
import { acceptSalesOrder, submitPurchaseOrder } from "../src/domain/trade/orders.js";
import { addToBasket } from "../src/domain/store/basket.js";
import { cancelStoreOrderByBuyer, checkoutBasket, completeStoreOrder, markStoreOrderReady } from "../src/domain/store/orders.js";
import { addDeliveryZone, listVariant, updateStorefront } from "../src/domain/store/storefront.js";
import { openSupportCase } from "../src/domain/store/cases.js";
import { enableMarketplace, fileReport, publishMarketplaceListing } from "../src/domain/marketplace.js";
import { createPaymentIntent, ensureSimulatorConnection, startPaymentAttempt } from "../src/domain/merchantPayments/intents.js";
import { receiveProviderCallback } from "../src/domain/merchantPayments/outcomes.js";
import { startRenewal } from "../src/domain/subscriptions/renewal.js";
import { billingCallbackHandler } from "../src/domain/subscriptions/collection.js";
import { getEntitlement } from "../src/domain/subscriptions/entitlements.js";
import { processInbox } from "../src/domain/callbackInbox.js";
import { BILLING_CALLBACK_PATH, setBillingConfig } from "../src/domain/subscriptions/common.js";
import { createPawaPayBillingWebhookRouter, type RawBodyRequest } from "../src/pawapay/billingWebhook.js";
import { recordOrderUpdatesConsent } from "../src/messaging/consent.js";
import { sendMessage } from "../src/messaging/send.js";
import { runReport, reportText, reportToCsv, type ReportName } from "../src/reports/index.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { installAlertDeliveryRecorder } from "../src/monitoring/alertRecorder.js";
import { setAlertDeliveryRecorder } from "../src/monitoring/alerts.js";

export interface PanelCheck { panel: string; path: string; rows: number; populated: boolean; summary: string }
export interface ReleaseDemoResult {
  trade: { orderTotalMinor: bigint; retailerStock: number; wholesalerRevenueMinor: bigint };
  consumer: { onlineOrderStatus: string; onlineOrderPaidMinor: bigint; cashOrderStatus: string; lateOnlinePaymentHeld: boolean };
  retailerReports: Record<string, { text: string; warnings: string[]; csvBytes: number }>;
  retailerBooks: { salesMinor: bigint; cogsMinor: bigint; cashMinor: bigint; providerClearingMinor: bigint; stockUnits: number };
  subscription: { state: string; periodDays: number; invoiceStatus: string; paidMinor: bigint; billingExceptions: number };
  forecast: { scoredWeeks: number; improvementBps: number | null };
  panels: PanelCheck[];
}

export async function runReleaseDemo(log: (line: string) => void = () => undefined, options: { servePort?: number } = {}): Promise<ReleaseDemoResult> {
  const testDb = await createTestDb();
  const prisma = testDb.prisma;
  const previous = { sim: process.env["STOREFRONT_SIMULATOR_ENABLED"], cm: process.env["CONSUMER_MESSAGING_ENABLED"] };
  try {
    await seedReference(prisma);
    await seedSierraLeone(prisma);
    installAlertDeliveryRecorder(prisma);
    const ngn = (v: bigint) => `${formatMoney(v, 2)} NGN`;

    // ------------------------------------------------------------------------------------------------ 1. wholesaler -> retailer
    log("PART 1. Wholesaler purchase and retailer receipt");
    const w = await tradeWorld(prisma);
    await addPackConversion(w.R.scoped, w.R.businessId, w.rVariant.id, "carton", 24);
    await enableFlag(prisma, w.R.businessId, "reorderRules");
    await setReorderRule(w.R.scoped, { businessId: w.R.businessId, shopId: w.R.shopId, variantId: w.rVariant.id, mode: "FIXED", reorderPoint: 10, reorderQuantity: 60, preferredPartnerId: w.rPartner.id });
    await generateReorderSuggestions(prisma, { businessId: w.R.businessId });
    const [suggestion] = await listOpenSuggestions(w.R.scoped);
    log(`  Retail Corner's reorder rule fires: ${suggestion!.arithmetic}`);
    const draft = await acceptSuggestion(prisma, { businessId: w.R.businessId, suggestionId: suggestion!.id, counterpartVariantId: w.wVariant.id });
    await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: draft.id });
    await deliverTradeEvents(prisma);
    const buyerRow = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: draft.id } });
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: buyerRow.counterpartOrderId! });
    const so = await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: buyerRow.counterpartOrderId! }, include: { lines: true } });
    const shipped = await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: so.lines[0]!.baseQuantity }] });
    await deliverTradeEvents(prisma);
    const inbound = await w.R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY" }, include: { lines: true } });
    await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: inbound.lines[0]!.id, acceptedBase: inbound.lines[0]!.baseQuantity }] });
    await deliverTradeEvents(prisma);
    log(`  Order ${draft.reference} (${ngn(draft.totalMinor)}) accepted, shipped, invoiced as ${shipped.invoice.number}, received. Stock goes up only on the confirmed receipt.`);

    process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true"; // the simulator exists only outside production
    const { sim, registry } = simulatorWorld(prisma);
    await ensureSimulatorConnection(prisma, w.W.businessId);
    const tradeIntent = await createPaymentIntent(prisma, { businessId: w.W.businessId, subjectType: "TRADE_INVOICE", subjectId: shipped.invoice.id });
    const tradeAttempt = (await startPaymentAttempt(prisma, registry, { businessId: w.W.businessId, intentId: tradeIntent.id, provider: "simulator" })).attempt;
    const tradeCb = await sim.completePayment(tradeAttempt.externalRef!);
    await receiveProviderCallback(prisma, registry, "simulator", tradeCb.body, tradeCb.headers);
    await drainInbox(prisma);
    await deliverTradeEvents(prisma);
    log("  The retailer pays the invoice through the SIMULATED provider: a signed callback is stored, then applied once. No money moved.");

    // ------------------------------------------------------------------------------------------------ 2. consumer orders
    log("PART 2. Consumer orders at Retail Corner, paid through the simulator, then fulfilled");
    for (const f of ["storefront", "storefrontOnlinePayment", "marketplace", "reportsV2", "consumerMessaging"]) await enableFlag(prisma, w.R.businessId, f);
    const list = await createPriceList(w.R.scoped, { businessId: w.R.businessId, name: "Retail", kind: "RETAIL", currencyCode: "NGN" });
    await addPriceRule(w.R.scoped, { businessId: w.R.businessId, priceListId: list.id, variantId: w.rVariant.id, unitPriceMinor: 15_000n });
    await listVariant(prisma, w.R.businessId, w.rVariant.id);
    await addDeliveryZone(prisma, w.R.businessId, { name: "Ikeja", feeMinor: 50_000n });
    await updateStorefront(prisma, w.R.businessId, { slug: "retail-corner", title: "Retail Corner", supportPhone: "08030000001", pickupEnabled: true, pickupLocation: "12 Allen Avenue", deliveryEnabled: false, returnWindowDays: 7, termsText: "Goods are checked before they leave the shop.", enabled: true });
    await publishMarketplaceListing(prisma, w.R.businessId, w.rVariant.id, "Food and drink");
    await enableMarketplace(prisma, w.R.businessId);

    const place = async (qty: number, online: boolean, name: string) => {
      const t = await addToBasket(prisma, { token: null, businessId: w.R.businessId, variantId: w.rVariant.id, unit: "piece", quantity: qty });
      const r = await checkoutBasket(prisma, { basketToken: t.token, allowOnline: online, buyer: { name, phone: "08031234567", contactConsent: true, orderUpdatesConsent: true }, sellers: [{ businessId: w.R.businessId, fulfilment: "PICKUP", paymentMethod: online ? "ONLINE_SIMULATED" : "PAY_ON_COLLECTION" }] });
      const o = r.outcomes[0]!;
      if (!o.ok) throw new Error(o.error);
      return o.order;
    };
    await ensureSimulatorConnection(prisma, w.R.businessId);
    const payOnline = async (orderId: string) => {
      const intent = await createPaymentIntent(prisma, { businessId: w.R.businessId, subjectType: "STORE_ORDER", subjectId: orderId });
      const { attempt } = await startPaymentAttempt(prisma, registry, { businessId: w.R.businessId, intentId: intent.id, provider: "simulator" });
      return sim.completePayment(attempt.externalRef!);
    };

    const orderA = await place(5, true, "Amaka Obi");
    const cbA = await payOnline(orderA.id);
    await receiveProviderCallback(prisma, registry, "simulator", cbA.body, cbA.headers);
    await drainInbox(prisma);
    const afterPay = await w.R.scoped.storeOrder.findUniqueOrThrow({ where: { id: orderA.id } });
    log(`  Amaka orders 5 and pays online: order ${afterPay.reference} is ${afterPay.status}, paid ${ngn(afterPay.paidMinor)}. Revenue is NOT recognised yet.`);
    await markStoreOrderReady(prisma, { businessId: w.R.businessId, orderId: orderA.id });
    await completeStoreOrder(prisma, { businessId: w.R.businessId, orderId: orderA.id, code: orderA.pickupCode });
    log("  She collects it with her code: stock leaves, revenue and cost of goods are booked at hand-over.");

    const orderB = await place(2, false, "Chidi Eze");
    const { confirmStoreOrder } = await import("../src/domain/store/orders.js");
    await confirmStoreOrder(prisma, { businessId: w.R.businessId, orderId: orderB.id });
    await completeStoreOrder(prisma, { businessId: w.R.businessId, orderId: orderB.id, code: orderB.pickupCode, collect: { method: "CASH" } });
    log("  Chidi orders 2, pays cash at the counter: same hand-over rule.");

    const orderC = await place(1, true, "Late Payer");
    const cbC = await payOnline(orderC.id);
    await cancelStoreOrderByBuyer(prisma, { businessId: w.R.businessId, orderId: orderC.id, reason: "Changed my mind" });
    await receiveProviderCallback(prisma, registry, "simulator", cbC.body, cbC.headers);
    await drainInbox(prisma);
    const heldCount = await w.R.scoped.paymentException.count({ where: { orderId: orderC.id } });
    log(`  A third shopper cancels, but their payment still arrives: it is HELD as an exception (${heldCount}), never silently applied.`);
    const mkListing = await w.R.scoped.listing.findFirstOrThrow({ where: { variantId: w.rVariant.id, channel: "MARKETPLACE" } });
    await fileReport(prisma, { listingId: mkListing.id, reason: "MISLEADING_PRICE", details: "The shelf price in the shop was higher than on the listing.", contact: "reporter@example.test" });
    log("  A visitor reports the marketplace listing: it goes to the moderation queue. Nothing is taken down automatically.");
    await openSupportCase(prisma, { businessId: w.R.businessId, orderId: orderA.id, type: "OTHER", openedBy: "CONSUMER", summary: "Please confirm my pickup time next week", contactName: "Amaka Obi", contactPhone: "08031234567" });

    // consent and messaging: a recorded opt-in, and a refused message because no template is approved
    await recordOrderUpdatesConsent(prisma, { businessId: w.R.businessId, phone: "2348031234567", sourceRef: orderA.id });
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    const refused = await sendMessage(prisma, { sendText: async () => ({}), sendTemplate: async () => ({}) }, { classId: "CONSUMER_ORDER_CONFIRMED", toPhone: "2348031234567", businessId: w.R.businessId, params: { seller: "Retail Corner", reference: orderA.reference }, idempotencyKey: `demo:${orderA.id}:confirmed` });
    log(`  Consumer messaging: Amaka opted in at checkout, but no template is approved, so the update is ${refused.decision} (${refused.reason}). Nothing was sent.`);

    // ------------------------------------------------------------------------------------------------ 3. reports
    log("PART 3. Reports for Retail Corner (bookkeeping, never profit)");
    const rctx = { scoped: w.R.scoped, businessId: w.R.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos" };
    const range = { from: new Date(Date.now() - 7 * 86_400_000), to: new Date(Date.now() + 86_400_000) };
    const retailerReports: ReleaseDemoResult["retailerReports"] = {};
    for (const name of ["sales", "gross-margin", "cash-flow", "inventory-valuation", "ar-aging", "ap-aging", "payment-reconciliation", "stock-discrepancies"] as ReportName[]) {
      const rep = await runReport(rctx, name, range);
      retailerReports[name] = { text: reportText(rep), warnings: rep.meta.warnings.map((x) => x.code), csvBytes: reportToCsv(rep).length };
      log("  " + reportText(rep).split("\n").slice(0, 3).join("\n  "));
    }
    const net = (b: { scoped: typeof w.R.scoped }, k: Parameters<typeof accountNet>[1]) => accountNet(b.scoped, k, { currencyCode: "NGN" });
    const retailerBooks = { salesMinor: -(await net(w.R, "SALES_REVENUE")), cogsMinor: await net(w.R, "COGS"), cashMinor: await net(w.R, "CASH"), providerClearingMinor: await net(w.R, "PROVIDER_CLEARING"), stockUnits: (await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).onHand };

    // ------------------------------------------------------------------------------------------------ 4. subscription (FAKE pawaPay)
    log("PART 4. A SEPARATE subscription renewal through pawaPay (an in-memory FAKE: no sandbox exists yet)");
    const { fake, cfg } = await billingWorld(prisma);
    void cfg;
    await publishedPlan(prisma, "STARTER");
    const sl = await makeSlBusiness(prisma, { name: "Fatu Traders" });
    const started = await startRenewal(prisma, { businessId: sl.businessId, merchantId: sl.merchantId, payerPhone: PHONE, planCode: "STARTER" });
    fake.complete(started.depositId);
    const hook = express();
    hook.use(express.json({ verify: (req, _res, buf) => { (req as RawBodyRequest).rawBody = Buffer.from(buf); } }));
    hook.use(createPawaPayBillingWebhookRouter(prisma));
    const signed = fake.signedCallback({ depositId: started.depositId, status: "COMPLETED" }, { authority: AUTHORITY, path: BILLING_CALLBACK_PATH });
    const cbRes = await request(hook).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").set(signed.headers).send(signed.body.toString());
    await processInbox(prisma, { "pawapay-billing": billingCallbackHandler(prisma) }, { limit: 50 });
    const ent = await getEntitlement(sl.scoped, sl.businessId);
    const sub = await sl.scoped.subscription.findFirstOrThrow({ where: {} });
    const inv = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    log(`  Fatu Traders pays its renewal: the signed callback answered ${cbRes.status}, pawaPay's own record confirmed it, the plan is ${ent.state} for ${(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime()) / 86_400_000} days, invoice ${inv.status}.`);
    // a short payment from a second business: held as an exception, grants nothing
    const sl2 = await makeSlBusiness(prisma, { name: "Short Payer" });
    const short = await startRenewal(prisma, { businessId: sl2.businessId, merchantId: sl2.merchantId, payerPhone: PHONE, planCode: "STARTER" });
    fake.complete(short.depositId, { amount: "1.00" });
    const sig2 = fake.signedCallback({ depositId: short.depositId, status: "COMPLETED" }, { authority: AUTHORITY, path: BILLING_CALLBACK_PATH });
    await request(hook).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").set(sig2.headers).send(sig2.body.toString());
    await processInbox(prisma, { "pawapay-billing": billingCallbackHandler(prisma) }, { limit: 50 });
    const billingExceptions = await prisma.billingException.count();
    log(`  A payment of the wrong amount from another business grants nothing and becomes a billing exception (${billingExceptions}).`);
    setBillingConfig(null);

    // ------------------------------------------------------------------------------------------------ 5. forecast
    log("PART 5. A synthetic merchant's shadow forecast, scored against what really sold");
    const f = await makeBusiness(prisma, "Synthetic Forecast Merchant");
    for (const flag of ["reorderRules", "reorderForecastShadow", "stockV2"]) await enableFlag(prisma, f.businessId, flag);
    const p = await createProduct(f.scoped, { businessId: f.businessId, name: "Rice" });
    const v = await createVariant(f.scoped, { businessId: f.businessId, productId: p.id, sku: "RICE-DEMO", name: "bag", baseUnit: "bag" });
    const common = { businessId: f.businessId, shopId: f.shopId, variantId: v.id, currencyCode: "NGN" };
    const D0 = new Date("2026-08-03T09:00:00Z");
    const at = (days: number) => new Date(Date.UTC(2026, 7, 3 + days, 12));
    await receiveStock(f.scoped, { ...common, quantity: 100_000, unitCostMinor: 5_000n, occurredAt: at(-90) });
    for (let wk = -12; wk < 5; wk++) await fulfilSale(f.scoped, { ...common, quantity: Math.abs(wk) % 2 === 0 ? 6 : 14, occurredAt: at(wk * 7 + 3) });
    await setReorderRule(f.scoped, { businessId: f.businessId, shopId: f.shopId, variantId: v.id, mode: "DAYS_OF_COVER", targetCoverDays: 14, windowDays: 7 });
    for (const d of [0, 7, 14, 21]) await runForecastsForBusiness(prisma, f.businessId, new Date(D0.getTime() + d * 86_400_000));
    await scoreForecasts(prisma, new Date(D0.getTime() + 40 * 86_400_000));
    const fs = await forecastScoreSummary(prisma, { businessId: f.businessId });
    log(`  scored weeks ${fs.scoredWeeks}; forecast error ${(fs.modelMapeBps ?? 0) / 100}% vs the simple rule ${(fs.baselineMapeBps ?? 0) / 100}%. Visible only in the admin console; never shown to the merchant until a gate is passed.`);

    // ------------------------------------------------------------------------------------------------ 6. admin panels
    log("PART 6. Every admin panel of section 18, read through the real admin API");
    const pw = "correct-horse";
    for (const [email, role] of [["owner@demo.test", "SUPER_ADMIN"], ["support@demo.test", "SUPPORT"]] as const) await createAdminUser(prisma, { email, name: email, role, password: pw });
    const app = express();
    app.use(express.json());
    app.use("/admin", createAdminRouter(prisma, "demo-secret-not-a-real-secret"));
    const login = async (email: string) => (await request(app).post("/admin/login").send({ email, password: pw })).body.token as string;
    const owner = await login("owner@demo.test");
    const h = { Authorization: `Bearer ${owner}` };
    // an admin write, so the audit log has something to show
    await request(app).post(`/admin/businesses/${w.R.businessId}/feature-flags/dailyClose`).set(h).send({ enabled: false, reason: "Demo: keep the daily close off" });
    const biz = w.R.businessId;
    const rows = (body: any, key?: string): number => (key ? (Array.isArray(body[key]) ? body[key].length : 0) : Array.isArray(body) ? body.length : 0);
    const spec: { panel: string; path: string; count: (b: any) => number; summary: (b: any) => string }[] = [
      { panel: "Overview", path: "/overview", count: (b) => Object.keys(b).length, summary: (b) => `${b.businesses?.total ?? "?"} businesses` },
      { panel: "Organizations and users", path: "/businesses", count: (b) => rows(b, "businesses"), summary: (b) => `${rows(b, "businesses")} organizations` },
      { panel: "Feature flags", path: "/feature-flags", count: (b) => rows(b, "featureFlags"), summary: (b) => `${rows(b, "featureFlags")} flags, all default OFF` },
      { panel: "Transactions and orders (journals)", path: `/businesses/${biz}/journals`, count: (b) => rows(b, "journals") || rows(b, "entries"), summary: () => "journal entries with provenance" },
      { panel: "Transactions and orders (store orders)", path: `/businesses/${biz}/store-orders`, count: (b) => rows(b, "orders"), summary: () => "consumer orders" },
      { panel: "Transactions and orders (trade orders)", path: `/businesses/${w.W.businessId}/trade-orders`, count: (b) => rows(b, "orders"), summary: () => "wholesale orders" },
      { panel: "Payments", path: "/payments/attempts", count: (b) => rows(b, "attempts"), summary: () => "payment attempts" },
      { panel: "Payments (exception queue)", path: "/payments/exceptions", count: (b) => rows(b, "exceptions"), summary: () => "provider exceptions" },
      { panel: "Subscriptions", path: "/subscriptions", count: (b) => rows(b, "subscriptions"), summary: () => "subscriptions with state" },
      { panel: "Subscriptions (billing exceptions)", path: "/subscriptions/exceptions", count: (b) => rows(b, "exceptions"), summary: () => "billing exceptions" },
      { panel: "Listings and moderation (report queue)", path: "/moderation/queue", count: (b) => rows(b, "reports"), summary: () => "open reports awaiting a decision" },
      { panel: "Listings and moderation", path: "/moderation/listings", count: (b) => rows(b, "listings"), summary: () => "marketplace listings" },
      { panel: "Messaging and consent", path: "/messaging/consents", count: (b) => rows(b, "consents"), summary: () => "consent records, numbers masked" },
      { panel: "Messaging and consent (outbound log)", path: "/messaging/outbound", count: (b) => rows(b, "messages"), summary: () => "decisions incl. suppressed" },
      { panel: "Reorder and forecasting", path: `/businesses/${f.businessId}/forecasts`, count: (b) => rows(b, "forecasts") || rows(b, "scores") || Object.keys(b).length, summary: () => "shadow forecast scores" },
      { panel: "Support cases", path: "/support-cases", count: (b) => rows(b, "cases"), summary: () => "open cases" },
      { panel: "Audit log", path: "/audit-logs", count: (b) => rows(b, "auditLogs") || rows(b, "logs"), summary: () => "sensitive changes incl. admin actions" },
      { panel: "System health", path: "/system-health", count: (b) => (b.heartbeats ? 1 : 0), summary: (b) => `alert channel needs attention: ${b.alertChannel?.needsAttention}` },
    ];
    const panels: PanelCheck[] = [];
    for (const s of spec) {
      const res = await request(app).get(`/admin${s.path}`).set(h);
      const n = res.status === 200 ? s.count(res.body) : 0;
      panels.push({ panel: s.panel, path: s.path.replace(biz, ":id").replace(w.W.businessId, ":id").replace(f.businessId, ":id"), rows: n, populated: res.status === 200 && n > 0, summary: res.status === 200 ? s.summary(res.body) : `HTTP ${res.status}` });
      log(`  ${res.status === 200 && n > 0 ? "populated" : "EMPTY    "}  ${s.panel}: ${n}`);
    }

    if (options.servePort) {
      // Keep the synthetic world alive and serve the admin API so the admin console can be pointed at it (VITE_API_BASE_URL). Demo credentials only.
      const serve = express();
      serve.use((req, res, next) => {
        const origin = req.headers.origin ?? "";
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Headers", "authorization,content-type,x-admin-step-up,x-support-access");
          res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
        }
        if (req.method === "OPTIONS") return void res.sendStatus(204);
        next();
      });
      serve.use(express.json());
      serve.use("/admin", createAdminRouter(prisma, "demo-secret-not-a-real-secret"));
      const server = serve.listen(options.servePort, "127.0.0.1");
      log(`\nSERVING the synthetic admin API on http://127.0.0.1:${options.servePort}/admin  (login owner@demo.test / correct-horse; Ctrl-C to stop)`);
      await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
      server.close();
    }

    return {
      trade: { orderTotalMinor: draft.totalMinor, retailerStock: (await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).onHand, wholesalerRevenueMinor: -(await net(w.W, "SALES_REVENUE")) },
      consumer: {
        onlineOrderStatus: (await w.R.scoped.storeOrder.findUniqueOrThrow({ where: { id: orderA.id } })).status, onlineOrderPaidMinor: (await w.R.scoped.storeOrder.findUniqueOrThrow({ where: { id: orderA.id } })).paidMinor,
        cashOrderStatus: (await w.R.scoped.storeOrder.findUniqueOrThrow({ where: { id: orderB.id } })).status, lateOnlinePaymentHeld: heldCount > 0,
      },
      retailerReports, retailerBooks,
      subscription: { state: ent.state, periodDays: (sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime()) / 86_400_000, invoiceStatus: inv.status, paidMinor: inv.paidMinor, billingExceptions },
      forecast: { scoredWeeks: fs.scoredWeeks, improvementBps: fs.improvementBps },
      panels,
    };
  } finally {
    setAlertDeliveryRecorder(null);
    if (previous.sim === undefined) delete process.env["STOREFRONT_SIMULATOR_ENABLED"]; else process.env["STOREFRONT_SIMULATOR_ENABLED"] = previous.sim;
    if (previous.cm === undefined) delete process.env["CONSUMER_MESSAGING_ENABLED"]; else process.env["CONSUMER_MESSAGING_ENABLED"] = previous.cm;
    await testDb.teardown();
  }
}

if (process.argv[1]?.endsWith("demoRelease.ts")) {
  const serveAt = process.argv.indexOf("--serve");
  const servePort = serveAt >= 0 ? Number(process.argv[serveAt + 1] ?? 4180) || 4180 : undefined;
  runReleaseDemo((line) => console.log(line), servePort ? { servePort } : {}).then((r) => { console.log(`\nAdmin panels populated: ${r.panels.filter((p) => p.populated).length} of ${r.panels.length}`); process.exit(0); }, (error) => { console.error(error); process.exit(1); });
}
