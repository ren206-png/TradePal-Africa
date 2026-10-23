import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MerchantRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import type { Biz } from "./helpers/trade.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { addPackConversion, createProduct, createVariant } from "../src/domain/catalog.js";
import { receiveStock, getStockLevel } from "../src/domain/stock.js";
import { buildTradeOutboxHandlers } from "../src/domain/trade/handlers.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

const ctxFor = (b: Biz, role: MerchantRole = "OWNER"): CommandContext => ({
  prisma, scopedPrisma: b.scoped, businessId: b.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m-1", merchantRole: role,
});

/** Two businesses with NO trade setup: everything (partners, link, prices, publishing) is done through commands. */
async function bareWorld() {
  const W = await makeBusiness(prisma, "Alpha Wholesale");
  const R = await makeBusiness(prisma, "Retail Corner");
  for (const b of [W, R]) for (const f of ["tradeOrders", "stockV2", "accountingJournals", "catalogV2"]) await enableFlag(prisma, b.businessId, f);
  await enableFlag(prisma, R.businessId, "reorderRules");
  const wp = await createProduct(W.scoped, { businessId: W.businessId, name: "Cola" });
  const wv = await createVariant(W.scoped, { businessId: W.businessId, productId: wp.id, sku: "COLA-330", name: "330 ml can", baseUnit: "piece" });
  await addPackConversion(W.scoped, W.businessId, wv.id, "carton", 24);
  await receiveStock(W.scoped, { businessId: W.businessId, shopId: W.shopId, variantId: wv.id, quantity: 200, unitCostMinor: 8_000n, currencyCode: "NGN" });
  const rp = await createProduct(R.scoped, { businessId: R.businessId, name: "Cola" });
  const rv = await createVariant(R.scoped, { businessId: R.businessId, productId: rp.id, sku: "COLA", name: "330 ml can", baseUnit: "piece" });
  await addPackConversion(R.scoped, R.businessId, rv.id, "carton", 24);
  return { W, R, wv, rv };
}

describe("setting up trade through WhatsApp commands", () => {
  it("partners, invitation, joining, wholesale prices, publishing and sharing; then a full order and invoice payment", async () => {
    const { W, R, rv } = await bareWorld();
    const w = ctxFor(W);
    const r = ctxFor(R);

    // the wholesaler prices and publishes its item
    expect(await handleCommand(w, "/wholesale COLA-330 2200 per carton from 1")).toContain("Wholesale price saved: COLA-330 at 2200.00 NGN per carton from 1. It is not visible to partners until you publish it");
    expect(await handleCommand(w, "/wholesale COLA-330 2100 per carton from 5")).toContain("from 5");
    expect(await handleCommand(w, "/wholesale COLA-330 abc")).toMatch(/amount/i);
    expect(await handleCommand(w, "/wholesale NOPE 5")).toContain("can't find a product");
    expect(await handleCommand(w, "/publish COLA-330")).toContain("now published");

    // the retailer adds the wholesaler and invites it
    expect(await handleCommand(r, "/partners")).toContain("No trade partners yet");
    expect(await handleCommand(r, "/partner add supplier Alpha Wholesale")).toContain("Added Alpha Wholesale as a supplier");
    expect(await handleCommand(r, "/partner add supplier alpha  wholesale")).toContain("already have a partner");
    const invite = await handleCommand(r, "/partner invite Alpha Wholesale");
    const token = /\/join (\S+)/.exec(invite)![1]!;
    expect(invite).toContain("TradePal does not message them");
    expect(await handleCommand(r, "/partners")).toContain("Alpha Wholesale (supplier): invitation sent");

    // the wholesaler joins with the code; a second use fails; a wrong code fails
    expect(await handleCommand(w, "/join nonsense")).toContain("not valid");
    expect(await handleCommand(w, `/join ${token}`)).toContain("You are now linked with Retail Corner");
    expect(await handleCommand(w, `/join ${token}`)).toContain("This invitation is active");
    expect(await handleCommand(r, "/partners")).toContain("Alpha Wholesale (supplier): on TradePal, linked");

    // terms and sharing
    expect(await handleCommand(w, "/partner terms Retail Corner days 14 limit 10000 overdue 7")).toContain("14-day payment terms, credit limit 10000.00 NGN, block new orders when 7 days overdue");
    expect(await handleCommand(w, "/partner terms Retail Corner days x")).toContain("not a number of days");
    expect(await handleCommand(w, "/partner share Retail Corner")).toContain("can now see the items you have published");
    expect(await handleCommand(w, "/partner share Nobody")).toContain("not linked");

    // the retailer orders through the reorder flow, naming the supplier's code once
    await handleCommand(r, "/reorder rule COLA fixed 10 60");
    await handleCommand(r, "/reorder");
    expect(await handleCommand(r, "/reorder accept 1 Alpha Wholesale sku COLA-330")).toContain("3 carton of COLA-330");
    expect(await handleCommand(r, "/sendorder PO-000001")).toContain("Sent PO-000001");
    expect(await handleCommand(w, "/acceptorder SO-000001")).toContain("Accepted SO-000001");
    expect(await handleCommand(w, "/shiporder SO-000001")).toContain("Invoice INV-000001: 6600.00 NGN, due");
    expect(await handleCommand(r, "/receiveorder PO-000001")).toContain("Received 72 unit(s)");
    expect((await getStockLevel(R.scoped, R.shopId, rv.id)).onHand).toBe(72);

    // invoices and payments: the buyer reports, the seller confirms
    expect(await handleCommand(r, "/invoices")).toContain("BILL-000001 (supplier INV-000001) you owe: total 6600.00 NGN, outstanding 6600.00 NGN, unpaid");
    expect(await handleCommand(r, "/payinvoice BILL-000001 2000 cash")).toContain("only your record");
    expect(await handleCommand(r, "/payinvoice BILL-000001 99999 cash")).toContain("more than remains owing");
    expect(await handleCommand(r, "/payinvoice BILL-999999 5 cash")).toContain("can't find that invoice");
    expect(await handleCommand(w, "/invoices")).toContain("1 payment(s) reported by the other business are waiting for you");
    const waiting = await handleCommand(w, "/confirmpayment");
    expect(waiting).toContain("1. 2000.00 NGN on INV-000001 via cash");
    expect(await handleCommand(w, "/confirmpayment 7")).toContain("no waiting payment number 7");
    expect(await handleCommand(w, "/confirmpayment 1")).toContain("Confirmed 2000.00 NGN");
    expect(await handleCommand(w, "/invoices")).toContain("outstanding 4600.00 NGN, partially paid");
    expect(await handleCommand(w, "/confirmpayment")).toContain("No payments are waiting");

    // a second report that the seller disputes
    await handleCommand(r, "/payinvoice BILL-000001 1000 momo");
    expect(await handleCommand(w, "/rejectpayment 1 nothing arrived on our wallet")).toContain("Rejected");
    const disputed = await R.scoped.tradePayment.findFirstOrThrow({ where: { reason: { not: null } } });
    expect(disputed.state).toBe("HELD");
    expect(disputed.reason).toContain("nothing arrived");

    // unlinking ends new orders, keeps agreed ones
    expect(await handleCommand(r, "/partner unlink Alpha Wholesale")).toContain("Link with Alpha Wholesale ended");
    expect(await handleCommand(r, "/partners")).toContain("link ended");
  });

  it("checks permissions and feature flags on every setup command", async () => {
    const { W, R } = await bareWorld();
    for (const cmd of ["/partner add supplier X", "/partner invite X", "/join abc", "/wholesale A 5", "/publish A", "/payinvoice B 5", "/confirmpayment", "/rejectpayment 1 x"]) {
      expect(await handleCommand(ctxFor(W, "STAFF"), cmd), cmd).toBe("Only the owner or a manager can do that.");
    }
    expect(await handleCommand(ctxFor(W), "/partner")).toContain("Usage:");
    expect(await handleCommand(ctxFor(W), "/partner invite Ghost")).toContain("don't know a partner");
    expect(await handleCommand(ctxFor(W), "/invoices")).toBe("No trade invoices yet.");
    // with the flags off the commands do not exist
    await enableFlag(prisma, R.businessId, "tradeOrders", false);
    await enableFlag(prisma, R.businessId, "catalogV2", false);
    for (const cmd of ["/partners", "/partner add supplier X", "/join abc", "/invoices", "/payinvoice B 5", "/confirmpayment", "/wholesale A 5", "/publish A"]) {
      expect(await handleCommand(ctxFor(R), cmd), cmd).toContain("Unrecognized command");
    }
  });
});

describe("every outbox handler is idempotent: replaying processed events changes nothing", () => {
  it("re-running each trade event handler leaves the same documents, payments and balances", async () => {
    const { W, R } = await bareWorld();
    const w = ctxFor(W);
    const r = ctxFor(R);
    await handleCommand(w, "/wholesale COLA-330 2200 per carton from 1");
    await handleCommand(w, "/publish COLA-330");
    const token = /\/join (\S+)/.exec((await handleCommand(r, "/partner add supplier Alpha Wholesale"), await handleCommand(r, "/partner invite Alpha Wholesale")))![1]!;
    await handleCommand(w, `/join ${token}`);
    await handleCommand(w, "/partner share Retail Corner");
    await handleCommand(r, "/reorder rule COLA fixed 10 24");
    await handleCommand(r, "/reorder");
    await handleCommand(r, "/reorder accept 1 Alpha Wholesale sku COLA-330");
    await handleCommand(r, "/sendorder PO-000001");
    await handleCommand(w, "/acceptorder SO-000001");
    await handleCommand(w, "/shiporder SO-000001");
    await handleCommand(r, "/receiveorder PO-000001");
    await handleCommand(r, "/payinvoice BILL-000001 1000 cash");
    await handleCommand(w, "/confirmpayment 1");
    const sellerInvoice = await W.scoped.tradeInvoice.findFirstOrThrow({ where: {} });
    const { issueShortDeliveryCredit } = await import("../src/domain/trade/fulfilment.js");
    const inbound = await R.scoped.shipment.findFirstOrThrow({ where: { side: "BUY" }, include: { lines: true } });
    expect(inbound.status).toBe("RECEIVED"); // fully accepted, so no credit is due:
    await expect(issueShortDeliveryCredit(prisma, { businessId: W.businessId, invoiceId: sellerInvoice.id })).rejects.toMatchObject({ code: "INVALID" });

    const snapshot = async () => ({
      orders: await prisma.tradeOrder.count(), lines: await prisma.tradeOrderLine.count(), shipments: await prisma.shipment.count(), invoices: await prisma.tradeInvoice.count(),
      payments: await prisma.tradePayment.count(), journals: await prisma.journalEntry.count(), stock: await prisma.stockMovement.count(),
      paid: (await prisma.tradeInvoice.findMany({ select: { id: true, paidMinor: true }, orderBy: { id: "asc" } })).map((i) => `${i.id}:${i.paidMinor}`),
    });
    const before = await snapshot();
    const events = await prisma.outboxEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(events.length).toBeGreaterThan(5);
    const handlers = buildTradeOutboxHandlers(prisma);
    for (let round = 0; round < 2; round++) for (const e of events) if (handlers[e.eventType]) await handlers[e.eventType]!(e);
    expect(await snapshot()).toEqual(before);
    expect(new Set(events.map((e) => e.eventType))).toEqual(new Set(["trade.order.requested", "trade.order.accepted", "trade.shipment.dispatched", "trade.receipt.recorded", "trade.payment.reported", "trade.payment.resolved"]));
  });
});
