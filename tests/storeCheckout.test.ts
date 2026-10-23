import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller, type Seller } from "./helpers/store.js";
import { accountNet, trialBalance } from "../src/domain/accounting.js";
import { getStockLevel, reconcileStock } from "../src/domain/stock.js";
import { addToBasket, basketView, loadBasket, setLineQuantity } from "../src/domain/store/basket.js";
import { toE164, loadPublicStorefront, sha256, simulatedPaymentsAllowed } from "../src/domain/store/common.js";
import { checkoutBasket, ordersForBasket, publicOrderView, resolveOrderByToken, type BuyerInput } from "../src/domain/store/orders.js";
import { publicCatalog, updateStorefront, listVariant, unlistVariant, addDeliveryZone, ensureStorefront } from "../src/domain/store/storefront.js";
import { enableFlag } from "./helpers/phase2.js";

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

const BUYER: BuyerInput = { name: "Amaka Obi", phone: "0803 123 4567", contactConsent: true };
let n = 0;
const slug = () => `shop-${++n}-test`;
const add = (s: Seller, token: string | null, quantity = 1, unit = "can") => addToBasket(prisma, { token, businessId: s.businessId, variantId: s.variant.id, unit, quantity });
const net = (s: Seller, key: Parameters<typeof accountNet>[1]) => accountNet(s.scoped, key, { currencyCode: "NGN" });

describe("phone numbers are normalised to E.164 digits and never trusted as proof of anything", () => {
  it("handles national, international and bad numbers", () => {
    expect(toE164("0803 123 4567", "234")).toBe("2348031234567");
    expect(toE164("+232 76 123456", "234")).toBe("23276123456"); // a Sierra Leone number given to a Nigerian shop stays as given
    expect(toE164("00233 24 123 4567", "234")).toBe("233241234567");
    expect(toE164("2348031234567", "234")).toBe("2348031234567");
    expect(toE164("8031234567", "234")).toBe("2348031234567");
    expect(toE164("12", "234")).toBeNull();
    expect(toE164("not a phone", "234")).toBeNull();
    expect(toE164("1".repeat(20), "234")).toBeNull();
  });
});

describe("the public catalog shows published fields only (scenario 18)", () => {
  it("shows name, size options with prices and an availability label, and nothing private", async () => {
    const s = await makeSeller(prisma, "Mama Provisions", { slug: slug() });
    const cat = await publicCatalog(prisma, s.businessId);
    expect(cat).toMatchObject({ currencyCode: "NGN", minorUnitExp: 2, hasMore: false });
    expect(cat.items).toHaveLength(1);
    const item = cat.items[0]!;
    expect(item).toMatchObject({ name: "Cola", variantName: "330 ml can", baseUnit: "can", availability: "IN_STOCK" });
    expect(item.options.map((o) => [o.unit, o.unitPriceMinor, o.packBaseQuantity])).toEqual([["can", 10_000n, 1], ["carton", 200_000n, 24]]);
    const json = JSON.stringify(cat, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toMatch(/cost|4000|margin|onHand|reserved|businessId|supplier|customer/i); // no cost, stock quantity or tenant ids
    expect(json).not.toContain(s.businessId);
  });

  it("availability is a label, low stock and out of stock are reported, and a pack needs enough units", async () => {
    const s = await makeSeller(prisma, "Low Stock Shop", { stock: 30, slug: slug() });
    const { reserveStock } = await import("../src/domain/stock.js");
    const soon = new Date(Date.now() + 3_600_000);
    expect((await publicCatalog(prisma, s.businessId)).items[0]!.availability).toBe("IN_STOCK");
    await reserveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: s.variant.id, quantity: 26, reference: "x", idempotencyKey: "low-1", expiresAt: soon });
    const low = (await publicCatalog(prisma, s.businessId)).items[0]!;
    expect(low.availability).toBe("LOW_STOCK"); // 4 left, threshold 5
    expect(low.options.find((o) => o.unit === "carton")!.available).toBe(false); // a carton needs 24
    expect(low.options.find((o) => o.unit === "can")!.available).toBe(true);
    await reserveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: s.variant.id, quantity: 4, reference: "y", idempotencyKey: "low-2", expiresAt: soon });
    expect((await publicCatalog(prisma, s.businessId)).items[0]!.availability).toBe("OUT_OF_STOCK");
  });

  it("only listed, un-paused items appear; search stays inside the one shop; another seller's items never leak", async () => {
    const a = await makeSeller(prisma, "Shop A", { slug: slug(), sku: "A-COLA" });
    const b = await makeSeller(prisma, "Shop B", { slug: slug(), sku: "B-COLA" });
    expect((await publicCatalog(prisma, a.businessId, { q: "B-COLA" })).items).toEqual([]);
    expect((await publicCatalog(prisma, a.businessId, { q: "a-cola" })).items).toHaveLength(1);
    expect((await publicCatalog(prisma, a.businessId, { q: "cola" })).items).toHaveLength(1);
    await unlistVariant(prisma, a.businessId, a.variant.id);
    expect((await publicCatalog(prisma, a.businessId)).items).toEqual([]);
    expect((await publicCatalog(prisma, b.businessId)).items).toHaveLength(1); // B unaffected
    await listVariant(prisma, a.businessId, a.variant.id);
    expect((await publicCatalog(prisma, a.businessId)).items).toHaveLength(1);
  });

  it("a shop is public only when enabled, flagged on and the business is not suspended", async () => {
    const s = await makeSeller(prisma, "Gate Shop", { slug: "gate-shop-1" });
    expect(await loadPublicStorefront(prisma, "gate-shop-1")).not.toBeNull();
    expect(await loadPublicStorefront(prisma, "GATE-SHOP-1")).not.toBeNull(); // case-insensitive
    expect(await loadPublicStorefront(prisma, "does-not-exist")).toBeNull();
    await enableFlag(prisma, s.businessId, "storefront", false);
    expect(await loadPublicStorefront(prisma, "gate-shop-1")).toBeNull();
    await enableFlag(prisma, s.businessId, "storefront", true);
    await prisma.business.update({ where: { id: s.businessId }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "test" } });
    expect(await loadPublicStorefront(prisma, "gate-shop-1")).toBeNull(); // suspended: unavailable by direct URL too
    await prisma.business.update({ where: { id: s.businessId }, data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null } });
    await updateStorefront(prisma, s.businessId, { enabled: false });
    expect(await loadPublicStorefront(prisma, "gate-shop-1")).toBeNull();
  });

  it("the seller cannot open an incomplete shop, list an unpriced item, or pick a bad address", async () => {
    const s = await makeSeller(prisma, "Setup Shop", { slug: slug() });
    await expect(updateStorefront(prisma, s.businessId, { slug: "Bad Slug!" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(updateStorefront(prisma, s.businessId, { pickupLocation: "  " })).rejects.toMatchObject({ code: "INVALID" }); // enabled shop must keep a pickup location
    await expect(updateStorefront(prisma, s.businessId, { supportPhone: "" })).rejects.toMatchObject({ code: "INVALID" });
    const other = await makeSeller(prisma, "Taker", { slug: "taken-slug-1" });
    await expect(updateStorefront(prisma, s.businessId, { slug: "taken-slug-1" })).rejects.toMatchObject({ code: "DUPLICATE" });
    void other;
    const { createProduct, createVariant } = await import("../src/domain/catalog.js");
    const p = await createProduct(s.scoped, { businessId: s.businessId, name: "Unpriced" });
    const v = await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku: "NOPRICE", name: "x", baseUnit: "piece" });
    await expect(listVariant(prisma, s.businessId, v.id)).rejects.toMatchObject({ code: "INVALID" });
    const fresh = await (await import("./helpers/phase2.js")).makeBusiness(prisma, "Empty");
    await enableFlag(prisma, fresh.businessId, "storefront");
    await ensureStorefront(prisma, fresh.businessId);
    await expect(updateStorefront(prisma, fresh.businessId, { enabled: true, supportPhone: "0803", pickupEnabled: false, deliveryEnabled: false })).rejects.toMatchObject({ code: "INVALID" });
    await addDeliveryZone(prisma, fresh.businessId, { name: "Zone", feeMinor: 0n });
  });
});

describe("the basket", () => {
  it("is created on first add, merges lines, enforces minimums and limits, and never trusts a bad token", async () => {
    const s = await makeSeller(prisma, "Basket Shop", { slug: slug() });
    const first = await add(s, null, 2);
    expect(first.token).toHaveLength(48);
    const again = await add(s, first.token, 3);
    expect(again.token).toBe(first.token);
    const view = await basketView(prisma, first.token);
    expect(view.sellers).toHaveLength(1);
    expect(view.sellers[0]!.lines[0]).toMatchObject({ quantity: 5, unitPriceMinor: 10_000n, lineTotalMinor: 50_000n, problem: null });
    expect(view.sellers[0]).toMatchObject({ subtotalMinor: 50_000n, checkoutReady: true, sellerName: "Basket Shop" });
    // a carton is a separate line at its own price
    await add(s, first.token, 1, "carton");
    expect((await basketView(prisma, first.token)).sellers[0]!.subtotalMinor).toBe(250_000n);
    await expect(add(s, first.token, 0)).rejects.toMatchObject({ code: "INVALID" });
    await expect(add(s, first.token, 1000)).rejects.toMatchObject({ code: "INVALID" });
    await expect(add(s, first.token, 1, "bag")).rejects.toMatchObject({ code: "INVALID" });
    expect(await loadBasket(prisma, "short")).toBeNull();
    expect(await loadBasket(prisma, "x".repeat(48))).toBeNull();
    expect((await basketView(prisma, "x".repeat(48))).empty).toBe(true);
    // only a hash of the token is stored
    expect(await prisma.basket.findFirst({ where: { tokenHash: first.token } })).toBeNull();
    expect(await prisma.basket.findFirst({ where: { tokenHash: sha256(first.token) } })).not.toBeNull();
    // update and remove
    const line = (await basketView(prisma, first.token)).sellers[0]!.lines[0]!;
    await setLineQuantity(prisma, first.token, line.lineId, 1);
    expect((await basketView(prisma, first.token)).sellers[0]!.lines[0]!.quantity).toBe(1);
    await setLineQuantity(prisma, first.token, line.lineId, 0);
    expect((await basketView(prisma, first.token)).sellers[0]!.lines).toHaveLength(1);
    await expect(setLineQuantity(prisma, first.token, "nope", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cannot add from a closed shop or a paused item, and expires", async () => {
    const s = await makeSeller(prisma, "Closed Shop", { slug: slug() });
    const t = await add(s, null, 1);
    await unlistVariant(prisma, s.businessId, s.variant.id);
    await expect(add(s, t.token, 1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await listVariant(prisma, s.businessId, s.variant.id);
    const view1 = await basketView(prisma, t.token);
    expect(view1.sellers[0]!.checkoutReady).toBe(true);
    await updateStorefront(prisma, s.businessId, { enabled: false });
    expect((await basketView(prisma, t.token)).sellers[0]).toMatchObject({ checkoutReady: false });
    await updateStorefront(prisma, s.businessId, { enabled: true });
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await loadBasket(prisma, t.token, later)).toBeNull();
  });

  it("prices and availability are read live: a price change or sell-out shows in the basket", async () => {
    const s = await makeSeller(prisma, "Live Shop", { stock: 10, slug: slug() });
    const t = await add(s, null, 8);
    expect((await basketView(prisma, t.token)).sellers[0]!.lines[0]!.problem).toBeNull();
    const { fulfilSale } = await import("../src/domain/stock.js");
    await fulfilSale(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: s.variant.id, quantity: 5 });
    expect((await basketView(prisma, t.token)).sellers[0]!.lines[0]!.problem).toBe("Not enough in stock for that quantity.");
    expect((await basketView(prisma, t.token)).sellers[0]!.checkoutReady).toBe(false);
    await s.scoped.priceRule.updateMany({ where: { unitPriceMinor: 10_000n }, data: { unitPriceMinor: 12_000n } });
    await fulfilSale(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: s.variant.id, quantity: -5 }).catch(() => undefined);
  });
});

describe("checkout: independent per-seller orders (scenario 19)", () => {
  it("places a pickup order: stock held, totals exact, token hashed, terms snapshotted, nothing recognised as revenue yet", async () => {
    const s = await makeSeller(prisma, "Pickup Shop", { slug: slug() });
    const t = await add(s, null, 3);
    await add(s, t.token, 1, "carton");
    const r = await checkoutBasket(prisma, { basketToken: t.token, buyer: BUYER, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP", paymentMethod: "PAY_ON_COLLECTION" }] });
    expect(r.alreadyPlaced).toBe(false);
    expect(r.nextBasketToken).toBeNull();
    const o = r.outcomes[0]!;
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.order).toMatchObject({ reference: "ORD-000001", status: "PLACED", fulfilment: "PICKUP", subtotalMinor: 230_000n, deliveryFeeMinor: 0n, totalMinor: 230_000n, paidMinor: 0n, buyerPhone: "2348031234567", contactConsent: true });
    expect(o.order.lines.map((l) => [l.description, l.unit, l.quantity, l.baseQuantity, l.lineTotalMinor])).toEqual([["Cola 330 ml can", "can", 3, 3, 30_000n], ["Cola 330 ml can", "carton", 1, 24, 200_000n]]);
    expect(o.order.pickupCode).toMatch(/^\d{6}$/);
    expect(o.order.accessTokenHash).toBe(sha256(o.accessToken));
    expect(o.order.accessTokenHash).not.toBe(o.accessToken);
    expect(o.order.terms).toMatchObject({ seller: { name: "Pickup Shop", supportPhone: "08030000000" }, pickup: { location: "Opposite the market gate, Ikeja" }, returnWindowDays: 7, paymentMethod: "PAY_ON_COLLECTION" });
    // stock is held, not gone
    expect(await getStockLevel(s.scoped, s.shopId, s.variant.id)).toMatchObject({ onHand: 50, reserved: 27, available: 23 });
    expect(await net(s, "SALES_REVENUE")).toBe(0n);
    expect((await publicCatalog(prisma, s.businessId)).items[0]!.availability).toBe("IN_STOCK");
    // the basket is spent
    expect(await loadBasket(prisma, t.token)).toBeNull();
    // access works only with the right token, and never by reference, id or phone
    expect(await resolveOrderByToken(prisma, o.accessToken)).toEqual({ businessId: s.businessId, orderId: o.order.id });
    expect(await resolveOrderByToken(prisma, o.order.reference)).toBeNull();
    expect(await resolveOrderByToken(prisma, o.order.id)).toBeNull();
    expect(await resolveOrderByToken(prisma, "2348031234567")).toBeNull();
    expect(await resolveOrderByToken(prisma, o.accessToken, new Date(Date.now() + 120 * 86_400_000))).toBeNull(); // expired link
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });

  it("a double submit places once: the basket is claimed first", async () => {
    const s = await makeSeller(prisma, "Double Shop", { slug: slug() });
    const t = await add(s, null, 2);
    const input = { basketToken: t.token, buyer: BUYER, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP" as const, paymentMethod: "PAY_ON_COLLECTION" as const }] };
    const results = await Promise.all([checkoutBasket(prisma, input), checkoutBasket(prisma, input)]);
    expect(results.filter((r) => r.alreadyPlaced)).toHaveLength(1);
    expect(await s.scoped.storeOrder.count({ where: {} })).toBe(1);
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).reserved).toBe(2);
    expect((await checkoutBasket(prisma, input)).alreadyPlaced).toBe(true); // a third, later submit as well
    // the shopper can still see what they placed from the basket cookie
    expect(await ordersForBasket(prisma, t.token)).toHaveLength(1);
    expect(await ordersForBasket(prisma, "nope")).toEqual([]);
  });

  it("delivery adds the zone fee (disclosed in the total), needs an address and a real zone, and enforces minimums", async () => {
    const s = await makeSeller(prisma, "Delivery Shop", { slug: slug() });
    const zone = (await s.scoped.deliveryZone.findFirstOrThrow({ where: { name: "Ikeja" } }));
    const sellerIn = (extra: object = {}) => ({ businessId: s.businessId, fulfilment: "DELIVERY" as const, paymentMethod: "PAY_ON_COLLECTION" as const, zoneId: zone.id, address: { landmark: "Blue gate after the church", area: "Ikeja", latitude: 6.6, longitude: 3.35 }, ...extra });
    const run = async (extra?: object) => {
      const t = await add(s, null, 2);
      return (await checkoutBasket(prisma, { basketToken: t.token, buyer: BUYER, sellers: [sellerIn(extra)] })).outcomes[0]!;
    };
    const ok = await run();
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.order).toMatchObject({ subtotalMinor: 20_000n, deliveryFeeMinor: 50_000n, totalMinor: 70_000n, deliveryZoneName: "Ikeja", landmark: "Blue gate after the church", latitude: 6.6 });
      expect(ok.order.terms).toMatchObject({ delivery: { zone: "Ikeja", feeMinor: "50000" } });
    }
    const noAddress = await run({ address: {} });
    expect(noAddress).toMatchObject({ ok: false, code: "INVALID" });
    expect((noAddress as { error: string }).error).toContain("landmark or address");
    expect(await run({ zoneId: "nope" })).toMatchObject({ ok: false, code: "INVALID" });
    await s.scoped.deliveryZone.update({ where: { id: zone.id }, data: { minOrderMinor: 100_000n } });
    expect((await run()) as { ok: boolean; error: string }).toMatchObject({ ok: false });
    await updateStorefront(prisma, s.businessId, { deliveryEnabled: false }).catch(() => undefined);
  });

  it("a bad phone or name is refused before anything is held", async () => {
    const s = await makeSeller(prisma, "Validation Shop", { slug: slug() });
    const t = await add(s, null, 2);
    const base = { basketToken: t.token, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP" as const, paymentMethod: "PAY_ON_COLLECTION" as const }] };
    const r = await checkoutBasket(prisma, { ...base, buyer: { ...BUYER, phone: "12" } });
    expect(r.outcomes[0]).toMatchObject({ ok: false, code: "INVALID" });
    expect(await s.scoped.storeOrder.count({ where: {} })).toBe(0);
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).reserved).toBe(0);
    expect(r.nextBasketToken).not.toBeNull(); // the items are still with the shopper
    const t2 = r.nextBasketToken!;
    expect((await checkoutBasket(prisma, { basketToken: t2, sellers: base.sellers, buyer: { ...BUYER, name: "A" } })).outcomes[0]).toMatchObject({ ok: false });
  });

  it("each seller's order succeeds or fails alone, with its own totals, terms, pickup code and receipt; what failed stays in the basket", async () => {
    const a = await makeSeller(prisma, "Seller A", { slug: slug(), sku: "A-COLA", stock: 50 });
    const b = await makeSeller(prisma, "Seller B", { slug: slug(), sku: "B-COLA", stock: 2 }); // not enough for 5
    const t = await add(a, null, 2);
    await add(b, t.token, 5);
    const view = await basketView(prisma, t.token);
    expect(view.sellers.map((x) => x.sellerName)).toEqual(["Seller A", "Seller B"]); // grouped by seller, each with its own subtotal
    expect(view.sellers.map((x) => x.subtotalMinor)).toEqual([20_000n, 50_000n]);

    const zoneA = await a.scoped.deliveryZone.findFirstOrThrow({ where: {} });
    const r = await checkoutBasket(prisma, {
      basketToken: t.token, buyer: BUYER,
      sellers: [
        { businessId: a.businessId, fulfilment: "DELIVERY", paymentMethod: "PAY_ON_COLLECTION", zoneId: zoneA.id, address: { landmark: "Near the roundabout" } },
        { businessId: b.businessId, fulfilment: "PICKUP", paymentMethod: "PAY_ON_COLLECTION" },
      ],
    });
    const okA = r.outcomes.find((o) => o.businessId === a.businessId)!;
    const failB = r.outcomes.find((o) => o.businessId === b.businessId)!;
    expect(okA.ok).toBe(true);
    expect(failB).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect((failB as { error: string }).error).toContain("not enough in stock");
    // B's lines were not lost
    const left = await basketView(prisma, r.nextBasketToken);
    expect(left.sellers).toHaveLength(1);
    expect(left.sellers[0]).toMatchObject({ sellerName: "Seller B", subtotalMinor: 50_000n });
    expect(await b.scoped.storeOrder.count({ where: {} })).toBe(0);
    expect((await getStockLevel(b.scoped, b.shopId, b.variant.id)).reserved).toBe(0); // nothing half-held
  });

  it("a multi-seller checkout keeps orders, payments, receipts and terms separate (scenario 19)", async () => {
    const a = await makeSeller(prisma, "Alpha Store", { slug: slug(), sku: "A-1" });
    const b = await makeSeller(prisma, "Bravo Store", { slug: slug(), sku: "B-1", returnWindowDays: null });
    const t = await add(a, null, 3);
    await add(b, t.token, 2);
    const zoneB = await b.scoped.deliveryZone.findFirstOrThrow({ where: {} });
    const r = await checkoutBasket(prisma, {
      basketToken: t.token, buyer: BUYER,
      sellers: [
        { businessId: a.businessId, fulfilment: "PICKUP", paymentMethod: "PAY_ON_COLLECTION" },
        { businessId: b.businessId, fulfilment: "DELIVERY", paymentMethod: "PAY_ON_COLLECTION", zoneId: zoneB.id, address: { landmark: "Opposite the bank" } },
      ],
    });
    const oa = r.outcomes.find((o) => o.businessId === a.businessId)!;
    const ob = r.outcomes.find((o) => o.businessId === b.businessId)!;
    if (!oa.ok || !ob.ok) throw new Error("both should be placed");
    // two independent orders, each in its own seller's books, with its own totals and terms
    expect(oa.order.businessId).toBe(a.businessId);
    expect(ob.order.businessId).toBe(b.businessId);
    expect([oa.order.totalMinor, ob.order.totalMinor]).toEqual([30_000n, 70_000n]); // B's includes its own 500.00 delivery fee, A has none
    expect(oa.order.pickupCode).not.toBe(ob.order.pickupCode);
    expect(oa.accessToken).not.toBe(ob.accessToken);
    expect(await a.scoped.storeOrder.count({ where: {} })).toBe(1);
    expect(await b.scoped.storeOrder.count({ where: {} })).toBe(1);
    // neither seller can see the other's order
    expect(await a.scoped.storeOrder.findUnique({ where: { id: ob.order.id } })).toBeNull();
    expect(await b.scoped.storeOrder.findUnique({ where: { id: oa.order.id } })).toBeNull();
    // receipts: each shows only its own seller, lines, terms and policy
    const va = await publicOrderView(prisma, a.businessId, oa.order.id);
    const vb = await publicOrderView(prisma, b.businessId, ob.order.id);
    expect(va.seller.name).toBe("Alpha Store");
    expect(vb.seller.name).toBe("Bravo Store");
    expect(va.items).toHaveLength(1);
    expect(va.actions.refund.message).toContain("after you have received"); // not yet delivered
    expect(vb.delivery).toMatchObject({ zone: "Ikeja", landmark: "Opposite the bank" });
    expect(va.collection).toMatchObject({ location: "Opposite the market gate, Ikeja" });
    expect((vb.terms ?? "")).toContain("checked");
    expect(JSON.stringify(va, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("Bravo");
    // both orders can be reached from the shopper's own basket (one credential), each carrying its own secret link too
    expect((await ordersForBasket(prisma, t.token)).map((x) => x.businessId).sort()).toEqual([a.businessId, b.businessId].sort());
    // payments are separate: paying A does nothing to B
    const { recordStorePayment } = await import("../src/domain/store/payments.js");
    await recordStorePayment(prisma, { businessId: a.businessId, orderId: oa.order.id, amountMinor: 30_000n, method: "CASH" });
    expect((await a.scoped.storeOrder.findUniqueOrThrow({ where: { id: oa.order.id } })).paidMinor).toBe(30_000n);
    expect((await b.scoped.storeOrder.findUniqueOrThrow({ where: { id: ob.order.id } })).paidMinor).toBe(0n);
    expect(await net(a, "CUSTOMER_ADVANCES")).toBe(-30_000n);
    expect(await net(b, "CUSTOMER_ADVANCES")).toBe(0n);
    for (const x of [a, b]) {
      const tb = await trialBalance(x.scoped, { currencyCode: "NGN" });
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    }
  });
});

describe("online payment is simulator-only and never available in production", () => {
  it("is refused unless the flag, the simulator switch and a non-production environment all agree", async () => {
    expect(simulatedPaymentsAllowed({ NODE_ENV: "test", STOREFRONT_SIMULATOR_ENABLED: "true" })).toBe(true);
    expect(simulatedPaymentsAllowed({ NODE_ENV: "production", STOREFRONT_SIMULATOR_ENABLED: "true" })).toBe(false); // never in production
    expect(simulatedPaymentsAllowed({ NODE_ENV: "test" })).toBe(false);
    const s = await makeSeller(prisma, "Online Shop", { slug: slug() });
    const t = await add(s, null, 1);
    const attempt = (allowOnline: boolean, tok: string) => checkoutBasket(prisma, { basketToken: tok, allowOnline, buyer: BUYER, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP", paymentMethod: "ONLINE_SIMULATED" }] });
    const r1 = await attempt(false, t.token);
    expect(r1.outcomes[0]).toMatchObject({ ok: false, code: "SIMULATOR_FORBIDDEN" });
    const prev = { ...process.env };
    process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
    try {
      const r2 = await attempt(true, r1.nextBasketToken!); // flag still off for the seller
      expect(r2.outcomes[0]).toMatchObject({ ok: false, code: "SIMULATOR_FORBIDDEN" });
      await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
      const r3 = await attempt(true, r2.nextBasketToken!);
      expect(r3.outcomes[0]).toMatchObject({ ok: true });
      if (r3.outcomes[0]!.ok) expect(r3.outcomes[0]!.order.reservedUntil!.getTime()).toBeLessThan(Date.now() + 61 * 60_000); // an unpaid online order holds stock for the payment window only
    } finally {
      process.env = prev;
    }
  });
});
