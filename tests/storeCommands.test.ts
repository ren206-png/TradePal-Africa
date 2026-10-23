import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MerchantRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { makeSeller, type Seller } from "./helpers/store.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { addPriceRule, createPriceList } from "../src/domain/pricing.js";
import { receiveStock } from "../src/domain/stock.js";
import { addToBasket } from "../src/domain/store/basket.js";
import { cancelStoreOrderByBuyer, checkoutBasket, loadStoreOrder, publicOrderView } from "../src/domain/store/orders.js";
import { applyStoreProviderPayment } from "../src/domain/store/payments.js";
import { requestRefund } from "../src/domain/store/refunds.js";
import { openSupportCase } from "../src/domain/store/cases.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

const ctxFor = (b: { businessId: string; scoped: CommandContext["scopedPrisma"] }, role: MerchantRole = "OWNER"): CommandContext => ({
  prisma, scopedPrisma: b.scoped, businessId: b.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m-1", merchantRole: role,
});
const BUYER = { name: "Amaka Obi", phone: "08031234567", contactConsent: true };

async function place(s: Seller, qty = 3, fulfilment: "PICKUP" | "DELIVERY" = "PICKUP", online = false) {
  const t = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: qty });
  const zone = await s.scoped.deliveryZone.findFirst({ where: {} });
  if (online) process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
  const r = await checkoutBasket(prisma, {
    basketToken: t.token, buyer: BUYER, allowOnline: online,
    sellers: [{ businessId: s.businessId, fulfilment, paymentMethod: online ? "ONLINE_SIMULATED" : "PAY_ON_COLLECTION", ...(fulfilment === "DELIVERY" ? { zoneId: zone!.id, address: { landmark: "Near the blue gate" } } : {}) }],
  });
  delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
  const o = r.outcomes[0]!;
  if (!o.ok) throw new Error(o.error);
  return o.order;
}
const shop = (extra: object = {}) => makeSeller(prisma, `Cmd Shop ${++k}`, { slug: `cmd-shop-${k}`, ...extra });

describe("/store commands", () => {
  it("answer exactly as before (Unrecognized) while the storefront flag is off, and /help does not mention them", async () => {
    const b = await makeBusiness(prisma, "Plain Biz");
    const ctx = ctxFor(b);
    for (const text of ["/store", "/store orders", "/store open", "/store confirm ORD-000001"]) expect(await handleCommand(ctx, text), text).toContain('Unrecognized command "/store"');
    expect(await handleCommand(ctx, "/help")).not.toContain("/store");
    await enableFlag(prisma, b.businessId, "storefront");
    expect(await handleCommand(ctx, "/help")).toContain("/store - your online shop");
  });

  it("sets a shop up from nothing: name, phone, pickup, a delivery area, a product, then open", async () => {
    const b = await makeBusiness(prisma, "Ade Foods");
    for (const f of ["storefront", "stockV2", "catalogV2"]) await enableFlag(prisma, b.businessId, f);
    const ctx = ctxFor(b);
    expect(await handleCommand(ctx, "/store")).toContain("You have no online shop yet");
    expect(await handleCommand(ctx, "/store open")).toContain("Say where shoppers collect"); // cannot open yet: it asks for what is missing
    expect(await handleCommand(ctx, "/store name Ade Foods Ltd")).toContain('Shop name set to "Ade Foods Ltd"');
    expect(await handleCommand(ctx, "/store phone 08030000000")).toContain("08030000000");
    expect(await handleCommand(ctx, "/store slug ade-foods")).toContain("/shop/ade-foods");
    expect(await handleCommand(ctx, "/store pickup Shop 4, Allen Avenue")).toContain("Pickup is on");
    expect(await handleCommand(ctx, "/store returns 7")).toContain("7 day(s)");
    expect(await handleCommand(ctx, "/store zone add Ikeja 500 min 5000")).toContain('Delivery area "Ikeja" added: fee 500.00 NGN, minimum order 5000.00 NGN');
    expect(await handleCommand(ctx, "/store delivery on")).toContain("Delivery is on");

    const p = await createProduct(b.scoped, { businessId: b.businessId, name: "Rice" });
    const v = await createVariant(b.scoped, { businessId: b.businessId, productId: p.id, sku: "RICE", name: "bag", baseUnit: "bag" });
    await receiveStock(b.scoped, { businessId: b.businessId, shopId: b.shopId, variantId: v.id, quantity: 20, unitCostMinor: 100_000n, currencyCode: "NGN" });
    expect(await handleCommand(ctx, "/store list RICE")).toMatch(/price/i); // no retail price yet: refused with a reason
    const list = await createPriceList(b.scoped, { businessId: b.businessId, name: "Retail", kind: "RETAIL", currencyCode: "NGN" });
    await addPriceRule(b.scoped, { businessId: b.businessId, priceListId: list.id, variantId: v.id, unitPriceMinor: 150_000n });
    expect(await handleCommand(ctx, "/store list RICE")).toContain("RICE is listed");
    expect(await handleCommand(ctx, "/store open")).toContain("OPEN");
    const st = await handleCommand(ctx, "/store");
    expect(st).toContain("Ade Foods Ltd: your shop is OPEN");
    expect(st).toContain("/shop/ade-foods");
    expect(st).toContain("1 product(s) listed");
    expect(await handleCommand(ctx, "/store unlist RICE")).toContain("no longer shown");
    expect(await handleCommand(ctx, "/store close")).toContain("CLOSED");
    expect(await handleCommand(ctx, "/store zone add Ikeja")).toContain("Use /store zone add");
    expect(await handleCommand(ctx, "/store returns 500")).toContain("1 to 90");
    expect(await handleCommand(ctx, "/store nonsense")).toContain('I don\'t know "/store nonsense"');
  });

  it("walks a pickup order: confirm, ready, hand over with the code and collect payment; wrong code refused", async () => {
    const s = await shop();
    const ctx = ctxFor(s);
    const o = await place(s, 3);
    expect(await handleCommand(ctx, "/store orders")).toContain(`${o.reference} Amaka Obi: 300.00 NGN, pickup, placed, pay on handover <- confirm it`);
    expect(await handleCommand(ctx, `/store order ${o.reference}`)).toContain("3 x can");
    expect(await handleCommand(ctx, `/store ready ${o.reference}`)).toContain("that action is not available");
    expect(await handleCommand(ctx, `/store confirm ${o.reference.toLowerCase()}`)).toContain(`Confirmed ${o.reference}`);
    expect(await handleCommand(ctx, `/store ready ${o.reference}`)).toContain("ready for collection");
    const full = await loadStoreOrder(s.scoped, o.id);
    expect(await handleCommand(ctx, `/store done ${o.reference} ${full.pickupCode === "000000" ? "111111" : "000000"}`)).toContain("code does not match");
    expect(await handleCommand(ctx, `/store done ${o.reference} nocode lost it`)).toContain("only be completed with the buyer's code");
    expect(await handleCommand(ctx, `/store done ${o.reference} ${full.pickupCode} cash`)).toContain("300.00 NGN collected");
    expect(await loadStoreOrder(s.scoped, o.id)).toMatchObject({ status: "COMPLETED", paidMinor: 30_000n });
    expect(await handleCommand(ctx, `/store confirm ${o.reference}`)).toContain("that action is not available");
    expect(await handleCommand(ctx, "/store confirm ORD-999999")).toContain("can't find shop order");
  });

  it("walks a delivery order: dispatch, hand over (with a stated reason if the code is lost), and a failed delivery restocks", async () => {
    const s = await shop();
    const ctx = ctxFor(s);
    const a = await place(s, 2, "DELIVERY");
    await handleCommand(ctx, `/store confirm ${a.reference}`);
    expect(await handleCommand(ctx, `/store dispatch ${a.reference} RIDER-77`)).toContain("out for delivery");
    expect(await handleCommand(ctx, `/store done ${a.reference} nocode buyer phone was dead`)).toContain("handed over");
    expect((await s.scoped.auditLog.count({ where: { action: "store.order.completed_without_code" } })) + (await prisma.auditLog.count({ where: { businessId: s.businessId, action: "store.order.completed_without_code" } }))).toBeGreaterThan(0);

    const b = await place(s, 2, "DELIVERY");
    await handleCommand(ctx, `/store confirm ${b.reference}`);
    await handleCommand(ctx, `/store dispatch ${b.reference}`);
    expect(await handleCommand(ctx, `/store failed ${b.reference} nobody home`)).toContain("back in stock");
    expect((await loadStoreOrder(s.scoped, b.id)).status).toBe("CANCELLED");
  });

  it("handles cancellation requests, refund requests and held payments through short ids", async () => {
    const s = await shop();
    const ctx = ctxFor(s);
    const a = await place(s, 2);
    await handleCommand(ctx, `/store confirm ${a.reference}`);
    expect((await cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: a.id, reason: "changed my mind" })).outcome).toBe("REQUESTED");
    const q = await handleCommand(ctx, "/store requests");
    const id = /#([0-9a-f]{6}) CANCEL/.exec(q)?.[1];
    expect(id).toBeTruthy();
    expect(await handleCommand(ctx, `/store approve ${id}`)).toContain("Cancellation approved");
    expect((await loadStoreOrder(s.scoped, a.id)).status).toBe("CANCELLED");
    expect(await handleCommand(ctx, `/store approve ${id}`)).toContain("can't find");

    // a completed, paid order: the buyer asks for a partial refund
    const b = await place(s, 2);
    await handleCommand(ctx, `/store confirm ${b.reference}`);
    await handleCommand(ctx, `/store ready ${b.reference}`);
    const code = (await loadStoreOrder(s.scoped, b.id)).pickupCode;
    await handleCommand(ctx, `/store done ${b.reference} ${code} cash`);
    await requestRefund(prisma, { businessId: s.businessId, orderId: b.id, kind: "REFUND_ONLY", reason: "one can was dented", requestedAmountMinor: 10_000n });
    const list = await handleCommand(ctx, "/store requests");
    const rid = /#([0-9a-f]{6}) REFUND/.exec(list)?.[1];
    expect(rid).toBeTruthy();
    expect(await handleCommand(ctx, `/store refund approve ${rid} 99999`)).toContain("more than has been paid");
    expect(await handleCommand(ctx, `/store refund approve ${rid} 100`)).toContain("Approved a refund of 100.00 NGN");
    expect(await handleCommand(ctx, `/store refund pay ${rid} cash`)).toContain("Refund of 100.00 NGN recorded");
    expect(await handleCommand(ctx, `/store refund pay ${rid} cash`)).toContain("already been refunded");
    expect(await loadStoreOrder(s.scoped, b.id)).toMatchObject({ refundedMinor: 10_000n });

    // an over-payment is held; the seller refunds it
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    const c = await place(s, 1, "PICKUP", true);
    await applyStoreProviderPayment(prisma, { sellerBusinessId: s.businessId, orderId: c.id, provider: "simulator", externalId: `sim-cmd-${++k}-aaaa`, amountMinor: 50_000n, currencyCode: "NGN", evidence: "SIMULATOR_CONFIRMED" });
    const held = await handleCommand(ctx, "/store requests");
    const eid = /#([0-9a-f]{6}) PAYMENT/.exec(held)?.[1];
    expect(held).toContain("overpayment of 500.00 NGN is being held");
    expect(await handleCommand(ctx, `/store payment ${eid} refund`)).toContain("resolved by refund");
    expect(await handleCommand(ctx, "/store requests")).not.toContain("PAYMENT");
  });

  it("lets the seller see and answer shopper problems", async () => {
    const s = await shop();
    const ctx = ctxFor(s);
    const a = await place(s, 1);
    const c = await openSupportCase(prisma, { businessId: s.businessId, orderId: a.id, type: "DELIVERY", openedBy: "CONSUMER", summary: "Nobody called me about delivery", contactName: "Amaka Obi", contactPhone: "2348031234567" });
    const list = await handleCommand(ctx, "/store cases");
    expect(list).toContain(`#${c.id.slice(0, 6)} delivery on ${a.reference}`);
    expect(list).toContain("Call Amaka Obi on 2348031234567");
    expect(await handleCommand(ctx, `/store case ${c.id.slice(0, 6)} note Called him, redelivering tomorrow`)).toContain("Note added");
    expect(await s.scoped.supportCaseNote.count({ where: { caseId: c.id, authorType: "SELLER" } })).toBe(1);
    expect(await handleCommand(ctx, "/store case zzzzzz note hello")).toContain("can't find");
  });

  it("applies the permission matrix: a clerk can move orders but not set up, decide refunds, or read nothing it should not", async () => {
    const s = await shop();
    const clerk = ctxFor(s, "STAFF");
    const a = await place(s, 1);
    expect(await handleCommand(clerk, "/store close")).toContain("Only the owner or a manager");
    expect(await handleCommand(clerk, "/store zone add X 100")).toContain("Only the owner or a manager");
    expect(await handleCommand(clerk, "/store refund approve abcdef")).toContain("Only the owner or a manager");
    expect(await handleCommand(clerk, "/store approve abcdef")).toContain("Only the owner or a manager");
    expect(await handleCommand(clerk, `/store confirm ${a.reference}`)).toContain(`Confirmed ${a.reference}`);
    expect((await publicOrderView(prisma, s.businessId, a.id)).status).toBe("CONFIRMED");
  });
});
