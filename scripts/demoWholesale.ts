/**
 * Demo: wholesaler -> retailer purchase, goods receipt, payment through the SIMULATOR, and a synthetic merchant's shadow
 * forecast scores. Runs entirely on an in-process test database with synthetic data: no network, no real money, no provider.
 *
 *   npx tsx scripts/demoWholesale.ts
 *
 * (The consumer order and the separate pawaPay subscription renewal belong to later phases.)
 */
import { createTestDb } from "../tests/helpers/db.js";
import { seedReference, makeBusiness, enableFlag } from "../tests/helpers/phase2.js";
import { tradeWorld } from "../tests/helpers/trade.js";
import { accountNet } from "../src/domain/accounting.js";
import { addPackConversion, createProduct, createVariant } from "../src/domain/catalog.js";
import { fulfilSale, getStockLevel, receiveStock } from "../src/domain/stock.js";
import { formatMoney } from "../src/domain/money.js";
import { forecastScoreSummary, runForecastsForBusiness, scoreForecasts } from "../src/domain/forecast.js";
import { acceptSuggestion, generateReorderSuggestions, listOpenSuggestions, setReorderRule } from "../src/domain/reorder.js";
import { receiveShipment, shipOrder } from "../src/domain/trade/fulfilment.js";
import { deliverTradeEvents } from "../src/domain/trade/handlers.js";
import { acceptSalesOrder, submitPurchaseOrder } from "../src/domain/trade/orders.js";
import { receiveSimulatorCallback, simulateSuccessfulPayment } from "../src/payments/simulator.js";

export interface DemoResult {
  suggestion: { method: string; suggestedBaseQty: number; arithmetic: string };
  order: { reference: string; totalMinor: bigint; acceptance: string };
  wholesaler: { revenueMinor: bigint; cogsMinor: bigint; grossMarginMinor: bigint; receivableMinor: bigint; providerClearingMinor: bigint; stock: number };
  retailer: { stock: number; inventoryMinor: bigint; payableMinor: bigint };
  invoicePaid: boolean;
  forecast: { scoredWeeks: number; modelMapeBps: number | null; baselineMapeBps: number | null; improvementBps: number | null };
}

export async function runDemo(log: (line: string) => void = () => undefined): Promise<DemoResult> {
  const testDb = await createTestDb();
  const prisma = testDb.prisma;
  try {
    await seedReference(prisma);
    const m = (v: bigint) => `${formatMoney(v, 2)} NGN`;
    const w = await tradeWorld(prisma);
    log("1. Alpha Wholesale (200 cans in stock) and Retail Corner are linked; the wholesaler shared its wholesale price list.");
    await addPackConversion(w.R.scoped, w.R.businessId, w.rVariant.id, "carton", 24);
    await enableFlag(prisma, w.R.businessId, "reorderRules");

    log("2. The retailer sets a reorder rule (reorder at 10, usually 60) and sees a suggestion with its working shown.");
    await setReorderRule(w.R.scoped, { businessId: w.R.businessId, shopId: w.R.shopId, variantId: w.rVariant.id, mode: "FIXED", reorderPoint: 10, reorderQuantity: 60, preferredPartnerId: w.rPartner.id });
    await generateReorderSuggestions(prisma, { businessId: w.R.businessId });
    const [s] = await listOpenSuggestions(w.R.scoped);
    log(`   ${s!.arithmetic}`);

    log("3. The retailer accepts it: a DRAFT order is made (60 cans rounds up to 3 cartons of 24), priced from the shared list. Nothing is sent yet.");
    const draft = await acceptSuggestion(prisma, { businessId: w.R.businessId, suggestionId: s!.id, counterpartVariantId: w.wVariant.id });
    log(`   ${draft.reference}: ${draft.lines[0]!.quantity} ${draft.lines[0]!.unit} = ${m(draft.totalMinor)} (${draft.acceptance})`);
    await submitPurchaseOrder(prisma, { businessId: w.R.businessId, orderId: draft.id });
    await deliverTradeEvents(prisma);
    const buyerRow = await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: draft.id } });

    log("4. The wholesaler accepts: stock is held and terms are frozen. It ships everything; the invoice equals what shipped.");
    await acceptSalesOrder(prisma, { businessId: w.W.businessId, orderId: buyerRow.counterpartOrderId! });
    const so = await w.W.scoped.tradeOrder.findUniqueOrThrow({ where: { id: buyerRow.counterpartOrderId! }, include: { lines: true } });
    const shipped = await shipOrder(prisma, { businessId: w.W.businessId, orderId: so.id, lines: [{ orderLineId: so.lines[0]!.id, baseQuantity: so.lines[0]!.baseQuantity }] });
    await deliverTradeEvents(prisma);
    log(`   Invoice ${shipped.invoice.number}: ${m(shipped.invoice.totalMinor)}`);

    log("5. The retailer confirms what arrived. Only now does its stock go up.");
    const inbound = await w.R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY" }, include: { lines: true } });
    await receiveShipment(prisma, { businessId: w.R.businessId, shipmentId: inbound.id, lines: [{ shipmentLineId: inbound.lines[0]!.id, acceptedBase: inbound.lines[0]!.baseQuantity }] });
    await deliverTradeEvents(prisma);

    log("6. The retailer pays through the SIMULATED provider (no money moves): a signed callback arrives, is stored, then applied once.");
    const secret = "demo-simulator-secret";
    const evt = simulateSuccessfulPayment({ secret, externalId: "demo-payment-0001", sellerBusinessId: w.W.businessId, invoiceId: shipped.invoice.id, amountMinor: shipped.invoice.totalMinor, currencyCode: "NGN" });
    log(`   callback: ${JSON.stringify(await receiveSimulatorCallback(prisma, evt.body, evt.signature, secret))}`);
    log(`   redelivered: ${JSON.stringify(await receiveSimulatorCallback(prisma, evt.body, evt.signature, secret))}`);
    await deliverTradeEvents(prisma);

    const net = (b: typeof w.W, k: Parameters<typeof accountNet>[1]) => accountNet(b.scoped, k, { currencyCode: "NGN" });
    const wholesaler = {
      revenueMinor: -(await net(w.W, "SALES_REVENUE")), cogsMinor: await net(w.W, "COGS"), receivableMinor: await net(w.W, "AR"),
      providerClearingMinor: await net(w.W, "PROVIDER_CLEARING"), stock: (await getStockLevel(w.W.scoped, w.W.shopId, w.wVariant.id)).onHand,
    };
    const retailer = { stock: (await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).onHand, inventoryMinor: await net(w.R, "INVENTORY"), payableMinor: -(await net(w.R, "AP")) };
    const paid = (await w.W.scoped.tradeInvoice.findUniqueOrThrow({ where: { id: shipped.invoice.id } })).paidMinor === shipped.invoice.totalMinor;
    log(`7. Wholesaler: revenue ${m(wholesaler.revenueMinor)}, cost of goods ${m(wholesaler.cogsMinor)}, margin ${m(wholesaler.revenueMinor - wholesaler.cogsMinor)}, still owed ${m(wholesaler.receivableMinor)}, collected by provider ${m(wholesaler.providerClearingMinor)}.`);
    log(`   Retailer: stock ${retailer.stock} cans, inventory ${m(retailer.inventoryMinor)}, owes ${m(retailer.payableMinor)}.`);

    log("8. A synthetic merchant with 12+ weeks of sales: shadow forecasts are written, then scored against what really sold and against the simple rule.");
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
    const summary = await forecastScoreSummary(prisma, { businessId: f.businessId });
    log(`   scored weeks ${summary.scoredWeeks}; forecast error ${(summary.modelMapeBps ?? 0) / 100}% vs simple rule ${(summary.baselineMapeBps ?? 0) / 100}% (improvement ${(summary.improvementBps ?? 0) / 100}%). These are visible only in the admin console.`);

    return {
      suggestion: { method: s!.method, suggestedBaseQty: s!.suggestedBaseQty, arithmetic: s!.arithmetic },
      order: { reference: draft.reference, totalMinor: draft.totalMinor, acceptance: (await w.R.scoped.tradeOrder.findUniqueOrThrow({ where: { id: draft.id } })).acceptance },
      wholesaler: { ...wholesaler, grossMarginMinor: wholesaler.revenueMinor - wholesaler.cogsMinor },
      retailer, invoicePaid: paid,
      forecast: { scoredWeeks: summary.scoredWeeks, modelMapeBps: summary.modelMapeBps, baselineMapeBps: summary.baselineMapeBps, improvementBps: summary.improvementBps },
    };
  } finally {
    await testDb.teardown();
  }
}

if (process.argv[1]?.endsWith("demoWholesale.ts")) {
  runDemo((line) => console.log(line)).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
}
