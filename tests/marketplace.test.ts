import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { addPriceRule } from "../src/domain/pricing.js";
import { receiveStock } from "../src/domain/stock.js";
import { addToBasket } from "../src/domain/store/basket.js";
import { checkoutBasket, completeStoreOrder, confirmStoreOrder, loadStoreOrder, markStoreOrderReady } from "../src/domain/store/orders.js";
import { listVariant } from "../src/domain/store/storefront.js";
import { enableMarketplace, fileReport, getMarketplaceListing, marketplaceReadiness, publishMarketplaceListing, searchMarketplace } from "../src/domain/marketplace.js";
import { decideAppeal, fileAppeal, reinstateListing, reinstateSeller, resolveReport, suspendSeller, unpublishListing } from "../src/domain/moderation.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  await prisma.country.upsert({ where: { code: "GH" }, update: {}, create: { code: "GH", name: "Ghana", callingCode: "233", defaultCurrency: "NGN", defaultTimezone: "Africa/Accra" } }); // a second country (it keeps the naira here; only the country matters)
  app = express();
  app.use(createStorefrontRouter(prisma, { marketplace: true, limiters: { write: new InMemoryLoginRateLimiter(1000, 60_000), read: new InMemoryLoginRateLimiter(1000, 60_000) } }));
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

/** A marketplace seller with one published item ("Cola" by default). */
async function onMarket(name: string, opts: { category?: string; stock?: number; extraItem?: { name: string; sku: string } } = {}) {
  const s = await makeSeller(prisma, `${name} ${++k}`, { slug: `mk-${name.toLowerCase().replace(/\W+/g, "-")}-${k}`, stock: opts.stock ?? 50 });
  await enableFlag(prisma, s.businessId, "marketplace");
  if (opts.extraItem) {
    const p = await createProduct(s.scoped, { businessId: s.businessId, name: opts.extraItem.name });
    const v = await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku: opts.extraItem.sku, name: opts.extraItem.name, baseUnit: "each" });
    await receiveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: v.id, quantity: 10, unitCostMinor: 1_000n, currencyCode: "NGN" });
    await addPriceRule(s.scoped, { businessId: s.businessId, priceListId: s.list.id, variantId: v.id, unitPriceMinor: 5_000n });
    await listVariant(prisma, s.businessId, v.id);
    await publishMarketplaceListing(prisma, s.businessId, v.id, opts.category ?? "Groceries");
  }
  await publishMarketplaceListing(prisma, s.businessId, s.variant.id, opts.category ?? "Food and drink");
  await enableMarketplace(prisma, s.businessId);
  const listing = await s.scoped.listing.findFirstOrThrow({ where: { variantId: s.variant.id, channel: "MARKETPLACE" } });
  return { ...s, listing, slug: (await s.scoped.storefront.findFirstOrThrow({ where: {} })).slug };
}
const search = (o: Partial<Parameters<typeof searchMarketplace>[1]> = {}) => searchMarketplace(prisma, { country: "NG", ...o });

describe("seller onboarding", () => {
  it("is refused until the seller is ready, and says exactly what is missing", async () => {
    const s = await makeSeller(prisma, `Newcomer ${++k}`, { slug: `newcomer-${k}` });
    await expect(enableMarketplace(prisma, s.businessId)).rejects.toMatchObject({ code: "NOT_READY" });
    let r = await marketplaceReadiness(prisma, s.businessId);
    expect(r.missing.join(" ")).toContain("not switched on");
    expect(r.missing.join(" ")).toContain("publish at least one item");
    await enableFlag(prisma, s.businessId, "marketplace");
    await expect(publishMarketplaceListing(prisma, s.businessId, s.variant.id, "Spaceships")).rejects.toMatchObject({ code: "INVALID" });
    await publishMarketplaceListing(prisma, s.businessId, s.variant.id, "food");
    r = await marketplaceReadiness(prisma, s.businessId);
    expect(r).toEqual({ ready: true, missing: [] });
    await enableMarketplace(prisma, s.businessId);
    expect((await s.scoped.storefront.findFirstOrThrow({ where: {} })).marketplaceStatus).toBe("ACTIVE");
    // an item must be on the shop (and priced) before it can be on the marketplace
    const p = await createProduct(s.scoped, { businessId: s.businessId, name: "Unlisted" });
    const v = await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku: `UNL-${k}`, name: "Unlisted", baseUnit: "each" });
    await expect(publishMarketplaceListing(prisma, s.businessId, v.id, "Groceries")).rejects.toMatchObject({ code: "NOT_LISTED" });
  });
});

describe("discovery", () => {
  it("filters by country, category, words and area; ranks by match, then stock, then recency; shows seller identity; no cost, stock numbers or ids", async () => {
    const a = await onMarket("Alpha Foods", { category: "Groceries", extraItem: { name: "Cola Zero Special", sku: "ZERO" } });
    const b = await onMarket("Bravo Drinks", { category: "Food and drink", stock: 3 }); // low stock
    const c = await onMarket("Charlie Cola", { category: "Food and drink", stock: 50 });
    await prisma.business.update({ where: { id: c.businessId }, data: { countryCode: "GH" } });

    const ng = await search({ q: "cola" });
    const names = ng.results.map((r) => `${r.seller.name.split(" ")[0]}:${r.item.name}`);
    // "Cola" (name starts with) ranks before "Cola Zero Special"? both start with cola: the higher availability / recency decide; "Charlie" is another country
    expect(names.some((n) => n.startsWith("Charlie"))).toBe(false);
    expect(ng.results.every((r) => r.seller.countryCode === "NG")).toBe(true);
    expect(ng.results.length).toBeGreaterThanOrEqual(3);
    expect((await search({ q: "cola", country: "GH" })).results.map((r) => r.seller.name)).toEqual([expect.stringContaining("Charlie")]);

    const cat = await search({ category: "groceries" });
    expect(cat.results.every((r) => r.category === "Groceries")).toBe(true);
    const inStockFirst = await search({ q: "cola", category: "Food and drink" });
    const order = inStockFirst.results.map((r) => r.item.availability);
    expect(order).toEqual([...order].sort((x, y) => ({ IN_STOCK: 2, LOW_STOCK: 1, OUT_OF_STOCK: 0 }[y] - { IN_STOCK: 2, LOW_STOCK: 1, OUT_OF_STOCK: 0 }[x]))); // non-increasing availability
    expect((await search({ area: "ikeja" })).results.length).toBeGreaterThanOrEqual(3); // every fixture seller delivers to Ikeja
    expect((await search({ area: "nowhere-land" })).results).toHaveLength(0);
    // a name that starts with the words ranks above one that only contains them
    const zero = await search({ q: "special" });
    expect(zero.results[0]!.item.name).toBe("Cola Zero Special");
    void a; void b;

    const web = await request(app).get("/marketplace?c=NG&q=cola");
    expect(web.status).toBe(200);
    expect(web.text).toContain("Sold by");
    expect(web.text).toContain("Alpha Foods");
    expect(web.text).toContain("Nobody pays to be placed higher");
    expect(web.text).not.toContain("40.00"); // private unit cost
    expect(web.text).not.toContain(a.businessId);
    expect(web.text).not.toMatch(/\b50 in stock|\b3 in stock/);
    expect((await request(app).get("/marketplace")).text).toContain("Nigeria");
  });

  it("is absent when the marketplace flag is off, the shop is closed or the business is inactive, whatever the listing says", async () => {
    const s = await onMarket("Gated Goods");
    const present = async () => (await search({ q: "cola" })).results.some((r) => r.seller.businessId === s.businessId);
    expect(await present()).toBe(true);
    await enableFlag(prisma, s.businessId, "marketplace", false);
    expect(await present()).toBe(false);
    await enableFlag(prisma, s.businessId, "marketplace", true);
    expect(await present()).toBe(true);
    await prisma.storefront.update({ where: { businessId: s.businessId }, data: { enabled: false } });
    expect(await present()).toBe(false);
    await prisma.storefront.update({ where: { businessId: s.businessId }, data: { enabled: true } });
    await prisma.business.update({ where: { id: s.businessId }, data: { status: "SUSPENDED" } });
    expect(await present()).toBe(false);
    expect((await request(app).get(`/listing/${s.listing.id}`)).status).toBe(404);
    await prisma.business.update({ where: { id: s.businessId }, data: { status: "ACTIVE" } });
    expect(await present()).toBe(true);
  });
});

describe("scenario 24: suspended listings and sellers are unavailable by search and by direct URL; order servicing continues", () => {
  it("an unpublished listing disappears from search, its page, the shop and the basket, while orders already placed carry on", async () => {
    const s = await onMarket("Unpublish Me");
    const placed = await placeStoreOrder(prisma, s, { qty: 2 });
    const staleBasket = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: 1 });
    expect((await request(app).get(`/listing/${s.listing.id}`)).status).toBe(200);

    await expect(unpublishListing(prisma, { listingId: s.listing.id, adminUserId: "admin-1", reason: "short" })).rejects.toMatchObject({ code: "INVALID" });
    const action = await unpublishListing(prisma, { listingId: s.listing.id, adminUserId: "admin-1", reason: "Counterfeit goods reported and checked" });
    expect(action).toMatchObject({ type: "UNPUBLISH_LISTING", adminUserId: "admin-1", businessId: s.businessId });
    await expect(unpublishListing(prisma, { listingId: s.listing.id, adminUserId: "admin-1", reason: "Counterfeit goods reported again" })).rejects.toMatchObject({ code: "WRONG_STATE" });

    expect((await search({ q: "cola" })).results.some((r) => r.seller.businessId === s.businessId)).toBe(false);
    expect(await getMarketplaceListing(prisma, s.listing.id)).toBeNull();
    expect((await request(app).get(`/listing/${s.listing.id}`)).status).toBe(404);
    expect((await request(app).get(`/shop/${s.slug}`)).text).not.toContain("Cola");
    await expect(addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: 1 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const r = await checkoutBasket(prisma, { basketToken: staleBasket.token, buyer: { name: "Amaka Obi", phone: "08031234567", contactConsent: false }, allowOnline: false, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP", paymentMethod: "PAY_ON_COLLECTION" }] });
    expect(r.outcomes[0]).toMatchObject({ ok: false });
    // the seller cannot quietly put it back; the moderator's decision stands until reversed
    await expect(publishMarketplaceListing(prisma, s.businessId, s.variant.id, "Groceries")).rejects.toMatchObject({ code: "UNPUBLISHED" });

    // the order placed before the takedown is untouched and can be serviced to the end
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: placed.order.id });
    await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: placed.order.id });
    const code = (await loadStoreOrder(s.scoped, placed.order.id)).pickupCode;
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: placed.order.id, code, collect: { method: "CASH" } });
    expect((await loadStoreOrder(s.scoped, placed.order.id)).status).toBe("COMPLETED");
    expect((await request(app).get(`/order/${placed.token}`)).status).toBe(200);

    await reinstateListing(prisma, { listingId: s.listing.id, adminUserId: "admin-1", reason: "Checked the goods: genuine" });
    expect((await request(app).get(`/listing/${s.listing.id}`)).status).toBe(200);
    expect((await search({ q: "cola" })).results.some((r) => r.seller.businessId === s.businessId)).toBe(true);
  });

  it("a suspended seller vanishes from search, the listing URL, the shop and checkout; their orders, refunds and the shopper's page keep working; reinstating restores them", async () => {
    const s = await onMarket("Suspend Me");
    const placed = await placeStoreOrder(prisma, s, { qty: 2 });
    const staleBasket = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: 1 });
    const act = await suspendSeller(prisma, { businessId: s.businessId, adminUserId: "admin-1", reason: "Repeated scam reports confirmed" });
    expect(act.type).toBe("SUSPEND_SELLER");
    await expect(suspendSeller(prisma, { businessId: s.businessId, adminUserId: "admin-1", reason: "Suspending twice by mistake" })).rejects.toMatchObject({ code: "WRONG_STATE" });

    expect((await search({ q: "cola" })).results.some((r) => r.seller.businessId === s.businessId)).toBe(false);
    for (const url of [`/listing/${s.listing.id}`, `/shop/${s.slug}`]) expect((await request(app).get(url)).status, url).toBe(404);
    expect((await request(app).post(`/shop/${s.slug}/add`).type("form").send({ variantId: s.variant.id, unit: "can", quantity: "1" })).status).toBe(404);
    const r = await checkoutBasket(prisma, { basketToken: staleBasket.token, buyer: { name: "Amaka Obi", phone: "08031234567", contactConsent: false }, allowOnline: false, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP", paymentMethod: "PAY_ON_COLLECTION" }] });
    expect(r.outcomes[0]).toMatchObject({ ok: false });
    await expect(enableMarketplace(prisma, s.businessId)).rejects.toMatchObject({ code: "SUSPENDED" });

    // servicing what was already ordered is NOT blocked
    expect((await request(app).get(`/order/${placed.token}`)).status).toBe(200);
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: placed.order.id });
    await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: placed.order.id });
    const code = (await loadStoreOrder(s.scoped, placed.order.id)).pickupCode;
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: placed.order.id, code, collect: { method: "CASH" } });
    expect((await loadStoreOrder(s.scoped, placed.order.id)).status).toBe("COMPLETED");

    await reinstateSeller(prisma, { businessId: s.businessId, adminUserId: "admin-1", reason: "Appeal reviewed: the reports were wrong" });
    expect((await request(app).get(`/shop/${s.slug}`)).status).toBe(200);
    expect((await search({ q: "cola" })).results.some((r) => r.seller.businessId === s.businessId)).toBe(true);
  });
});

describe("reports and appeals", () => {
  it("anyone can report a listing; it is stored for a person and nothing is taken down automatically", async () => {
    const s = await onMarket("Reported Co");
    const page = await request(app).get(`/report/${s.listing.id}`);
    expect(page.status).toBe(200);
    const bad = await request(app).post(`/report/${s.listing.id}`).type("form").send({ reason: "NOPE", details: "x" });
    expect(bad.status).toBe(400);
    const res = await request(app).post(`/report/${s.listing.id}`).type("form").send({ reason: "SCAM", details: "<script>alert(1)</script> They took my money and never delivered.", contact: "08030000000" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Thank you");
    const stored = await prisma.marketplaceReport.findFirstOrThrow({ where: { businessId: s.businessId } });
    expect(stored).toMatchObject({ status: "OPEN", reason: "SCAM", listingId: s.listing.id });
    expect((await request(app).get(`/listing/${s.listing.id}`)).status).toBe(200); // still visible: a report proposes, a person decides
    expect((await request(app).get("/report/no-such-listing")).status).toBe(404);
    await expect(fileReport(prisma, { listingId: s.listing.id, reason: "SCAM", details: "short" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(resolveReport(prisma, { reportId: stored.id, adminUserId: "admin-1", outcome: "DISMISSED", note: "Not substantiated" })).resolves.toBeUndefined();
    await expect(resolveReport(prisma, { reportId: stored.id, adminUserId: "admin-1", outcome: "DISMISSED", note: "Second time" })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("a decision is recorded append-only, can be appealed once, and an overturned appeal reinstates", async () => {
    const s = await onMarket("Appeal Me");
    const report = await fileReport(prisma, { listingId: s.listing.id, reason: "COUNTERFEIT", details: "These look like fakes of a famous brand." });
    const action = await unpublishListing(prisma, { listingId: s.listing.id, adminUserId: "admin-1", reason: "Looks counterfeit from the photos", reportId: report.id });
    expect((await prisma.marketplaceReport.findUniqueOrThrow({ where: { id: report.id } })).status).toBe("ACTIONED");
    await expect(testDb.db.query(`UPDATE "ModerationAction" SET reason='edited' WHERE id='${action.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "ModerationAction" WHERE id='${action.id}'`)).rejects.toThrow(/append-only|cannot be deleted|not allowed/i);

    await expect(fileAppeal(prisma, { businessId: s.businessId, text: "no" })).rejects.toMatchObject({ code: "INVALID" });
    const appeal = await fileAppeal(prisma, { businessId: s.businessId, text: "These are genuine goods; I have the supplier's invoice." });
    expect(appeal.status).toBe("OPEN");
    await expect(fileAppeal(prisma, { businessId: s.businessId, text: "Appealing the same decision again" })).rejects.toMatchObject({ code: "DUPLICATE" });
    const decided = await decideAppeal(prisma, { appealId: appeal.id, adminUserId: "admin-2", outcome: "OVERTURNED", note: "Invoice checked, goods are genuine" });
    expect(decided).toMatchObject({ status: "OVERTURNED", decidedBy: "admin-2" });
    expect((await getMarketplaceListing(prisma, s.listing.id))?.listingId).toBe(s.listing.id);
    const actions = await s.scoped.moderationAction.findMany({ orderBy: { createdAt: "asc" } });
    expect(actions.map((a) => a.type)).toEqual(["UNPUBLISH_LISTING", "REINSTATE_LISTING"]);
    await expect(decideAppeal(prisma, { appealId: appeal.id, adminUserId: "admin-2", outcome: "UPHELD", note: "Deciding twice by mistake" })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(fileAppeal(prisma, { businessId: s.businessId, text: "Appealing something already reversed" })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("an upheld appeal changes nothing", async () => {
    const s = await onMarket("Upheld Co");
    await suspendSeller(prisma, { businessId: s.businessId, adminUserId: "admin-1", reason: "Confirmed fraud against two buyers" });
    const appeal = await fileAppeal(prisma, { businessId: s.businessId, text: "I disagree with this decision, please review it." });
    await decideAppeal(prisma, { appealId: appeal.id, adminUserId: "admin-2", outcome: "UPHELD", note: "Evidence reviewed; decision stands" });
    expect((await s.scoped.storefront.findFirstOrThrow({ where: {} })).marketplaceStatus).toBe("SUSPENDED");
    expect((await search({ q: "cola" })).results.some((r) => r.seller.businessId === s.businessId)).toBe(false);
  });
});
