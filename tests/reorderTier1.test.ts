import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { tradeWorld } from "./helpers/trade.js";
import { addPackConversion, createProduct, createVariant } from "../src/domain/catalog.js";
import { fulfilSale, getStockLevel, receiveStock, reserveStock } from "../src/domain/stock.js";
import { acceptSuggestion, computeTier1, deactivateReorderRule, dismissSuggestion, generateReorderSuggestions, listOpenSuggestions, setReorderRule } from "../src/domain/reorder.js";
import { cancelOrder, confirmUnlinkedPurchase, createPurchaseOrder } from "../src/domain/trade/orders.js";
import { createPartner } from "../src/domain/trade/partners.js";
import { deliverTradeEvents } from "../src/domain/trade/handlers.js";

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

const NOW = new Date("2026-10-20T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
let n = 0;

/** The documented fixture: stocked 110, sold 10 (40 days ago, outside a 30-day window) then 20 + 25 + 15 = 60 inside it. On hand 40. */
async function fixture() {
  const env = await makeBusiness(prisma);
  for (const f of ["reorderRules", "tradeOrders", "stockV2"]) await enableFlag(prisma, env.businessId, f);
  n++;
  const product = await createProduct(env.scoped, { businessId: env.businessId, name: "Cola" });
  const variant = await createVariant(env.scoped, { businessId: env.businessId, productId: product.id, sku: `COLA-${n}`, name: "can", baseUnit: "piece" });
  const common = { businessId: env.businessId, shopId: env.shopId, variantId: variant.id, currencyCode: "NGN" };
  await receiveStock(env.scoped, { ...common, quantity: 110, unitCostMinor: 8_000n, occurredAt: ago(45) });
  for (const [qty, days] of [[10, 40], [20, 25], [25, 15], [15, 3]] as const) await fulfilSale(env.scoped, { ...common, quantity: qty, occurredAt: ago(days) });
  return { ...env, variant, common };
}

describe("Tier 1 arithmetic (scenario 31)", () => {
  it("FIXED: suggests the reorder quantity when position is at or below the point, and shows its working", async () => {
    const f = await fixture();
    const supplier = await createPartner(f.scoped, { businessId: f.businessId, name: "Market Trader", role: "SUPPLIER" });
    await reserveStock(f.scoped, { ...f.common, quantity: 10, reference: "order:x", idempotencyKey: "hold-1", expiresAt: new Date(Date.now() + 3_600_000) });
    // 24 units already on an agreed purchase order
    const po = await createPurchaseOrder(prisma, { businessId: f.businessId, partnerId: supplier.id, currencyCode: "NGN", lines: [{ variantId: f.variant.id, quantity: 24, unitPriceMinor: 9_000n }] });
    await confirmUnlinkedPurchase(prisma, { businessId: f.businessId, orderId: po.id, evidenceNote: "phone" });

    await setReorderRule(f.scoped, { businessId: f.businessId, shopId: f.shopId, variantId: f.variant.id, mode: "FIXED", reorderPoint: 50, reorderQuantity: 48 });
    // position = 40 on hand - 10 reserved + 24 incoming = 54 > 50: nothing to do
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toEqual({ created: 0, superseded: 0, unchanged: 0 });

    // the order is cancelled: position = 40 - 10 + 0 = 30 <= 50
    await cancelOrder(prisma, { businessId: f.businessId, orderId: po.id });
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toEqual({ created: 1, superseded: 0, unchanged: 0 });
    const [s] = await listOpenSuggestions(f.scoped);
    expect(s).toMatchObject({ method: "TIER1_FIXED", suggestedBaseQty: 48, status: "PROPOSED", sku: f.variant.sku });
    expect(s!.arithmetic).toBe("You have 30 piece (on hand 40 - reserved 10 + on order 0). Your reorder point is 50, and 30 is at or below it. Your usual reorder quantity is 48 piece.");
    expect(s!.inputs).toEqual({ onHand: 40, reserved: 10, incoming: 0, position: 30, reorderPoint: 50, reorderQuantity: 48 });
  });

  it("DAYS_OF_COVER: needed = ceil(sold x cover / window); suggests needed - position only when short", async () => {
    const f = await fixture();
    await setReorderRule(f.scoped, { businessId: f.businessId, shopId: f.shopId, variantId: f.variant.id, mode: "DAYS_OF_COVER", targetCoverDays: 14, windowDays: 30 });
    // sold in the window = 60 (the 40-day-old sale is outside); needed = ceil(60 x 14 / 30) = 28; position = 40 >= 28
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toMatchObject({ created: 0 });
    await reserveStock(f.scoped, { ...f.common, quantity: 20, reference: "order:y", idempotencyKey: "hold-2", expiresAt: new Date(Date.now() + 3_600_000) });
    // position = 40 - 20 = 20 < 28
    await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW });
    const [s] = await listOpenSuggestions(f.scoped);
    expect(s).toMatchObject({ method: "TIER1_COVER", suggestedBaseQty: 8 });
    expect(s!.arithmetic).toBe(
      "You sold 60 piece in the last 30 days (2.00 a day). To cover 14 days you need 28 (60 x 14 / 30, rounded up). You have 20 piece (on hand 40 - reserved 20 + on order 0). Order 28 - 20 = 8 piece.",
    );
    expect(s!.inputs).toMatchObject({ soldInWindow: 60, windowDays: 30, targetCoverDays: 14, needed: 28, position: 20 });
  });

  it("the pure rule: boundaries, rounding up, no demand evidence, negative stock", () => {
    const rule = (o: object) => ({ mode: "FIXED" as const, reorderPoint: 10, reorderQuantity: 5, targetCoverDays: null, windowDays: null, ...o });
    const snap = (position: number, sold: number | null = null) => ({ onHand: position, reserved: 0, incoming: 0, position, soldInWindow: sold });
    expect(computeTier1(rule({}), snap(11), "u")).toBeNull();
    expect(computeTier1(rule({}), snap(10), "u")).toMatchObject({ suggestedBaseQty: 5 }); // at the point triggers
    expect(computeTier1(rule({}), snap(-3), "u")).toMatchObject({ suggestedBaseQty: 5 }); // oversold still gets the fixed quantity
    const cover = (o: object = {}) => ({ mode: "DAYS_OF_COVER" as const, reorderPoint: null, reorderQuantity: null, targetCoverDays: 14, windowDays: 30, ...o });
    expect(computeTier1(cover(), snap(0, 0), "u")).toBeNull(); // no sales, no evidence, no suggestion
    expect(computeTier1(cover(), snap(0, null), "u")).toBeNull();
    expect(computeTier1(cover(), snap(0, 7), "u")).toMatchObject({ suggestedBaseQty: 4 }); // 7 x 14 / 30 = 3.27 -> 4
    expect(computeTier1(cover(), snap(4, 7), "u")).toBeNull(); // 4 >= 4: covered
    expect(computeTier1(cover(), snap(3, 7), "u")).toMatchObject({ suggestedBaseQty: 1 });
    expect(computeTier1(cover({ targetCoverDays: 30, windowDays: 30 }), snap(-5, 12), "u")).toMatchObject({ suggestedBaseQty: 17 });
  });

  it("only the merchant's own recorded sales count: returns and reversed sales are netted, other businesses' sales never leak in", async () => {
    const f = await fixture();
    const other = await fixture(); // a different business with the same sales history
    await setReorderRule(f.scoped, { businessId: f.businessId, shopId: f.shopId, variantId: f.variant.id, mode: "DAYS_OF_COVER", targetCoverDays: 30, windowDays: 30 });
    const { restockReturn, reverseStockMovement } = await import("../src/domain/stock.js");
    await restockReturn(f.scoped, { ...f.common, quantity: 5, unitCostMinor: 8_000n, occurredAt: ago(2) });
    const sale = await fulfilSale(f.scoped, { ...f.common, quantity: 4, occurredAt: ago(1) });
    await reverseStockMovement(f.scoped, sale.movement.id);
    const { netUnitsSold } = await import("../src/domain/reorder.js");
    expect(await netUnitsSold(f.scoped, f.shopId, f.variant.id, 30, new Date())).toBe(60 - 5 + 4 - 4); // 55: the return nets out; the reversed sale nets to zero
    expect(await netUnitsSold(other.scoped, other.shopId, f.variant.id, 30, new Date())).toBe(0); // someone else's shop and variant
  });
});

describe("suggestion lifecycle: one open per method, supersede, never auto-send", () => {
  it("is idempotent, supersedes when the numbers change, and clears when the stock is healthy again", async () => {
    const f = await fixture();
    await setReorderRule(f.scoped, { businessId: f.businessId, shopId: f.shopId, variantId: f.variant.id, mode: "FIXED", reorderPoint: 50, reorderQuantity: 48 });
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toMatchObject({ created: 1 });
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toEqual({ created: 0, superseded: 0, unchanged: 1 });
    await reserveStock(f.scoped, { ...f.common, quantity: 5, reference: "o", idempotencyKey: "sup-1", expiresAt: new Date(Date.now() + 3_600_000) });
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toEqual({ created: 1, superseded: 1, unchanged: 0 });
    expect(await f.scoped.reorderSuggestion.count({ where: { status: "PROPOSED" } })).toBe(1);
    await receiveStock(f.scoped, { ...f.common, quantity: 100, unitCostMinor: 8_000n });
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toEqual({ created: 0, superseded: 1, unchanged: 0 });
    expect(await f.scoped.reorderSuggestion.count({ where: { status: "PROPOSED" } })).toBe(0);
    expect(await f.scoped.reorderSuggestion.count({ where: { status: "SUPERSEDED" } })).toBe(2);
  });

  it("accepting makes a DRAFT purchase order and nothing else: it is not sent, paid, journaled or messaged", async () => {
    const f = await fixture();
    const supplier = await createPartner(f.scoped, { businessId: f.businessId, name: "Market Trader", role: "SUPPLIER" });
    await setReorderRule(f.scoped, { businessId: f.businessId, shopId: f.shopId, variantId: f.variant.id, mode: "FIXED", reorderPoint: 50, reorderQuantity: 48, preferredPartnerId: supplier.id });
    await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW });
    const [s] = await listOpenSuggestions(f.scoped);
    const before = { onHand: (await getStockLevel(f.scoped, f.shopId, f.variant.id)).onHand, journals: await f.scoped.journalEntry.count({ where: {} }), outbox: await prisma.outboxEvent.count({}) };

    const order = await acceptSuggestion(prisma, { businessId: f.businessId, suggestionId: s!.id, actor: "owner-1", now: NOW });
    expect(order).toMatchObject({ acceptance: "DRAFT", side: "BUY", totalMinor: 0n }); // an unpriced draft for a supplier with no shared prices
    expect(order.lines[0]).toMatchObject({ baseQuantity: 48, unitPriceMinor: 0n });
    expect(order.note).toContain("Your usual reorder quantity is 48");
    expect(await f.scoped.reorderSuggestion.findUniqueOrThrow({ where: { id: s!.id } })).toMatchObject({ status: "ACCEPTED", draftOrderId: order.id, decidedBy: "owner-1" });
    // nothing was placed, paid or posted
    expect((await getStockLevel(f.scoped, f.shopId, f.variant.id)).onHand).toBe(before.onHand);
    expect(await f.scoped.journalEntry.count({ where: {} })).toBe(before.journals);
    expect(await prisma.outboxEvent.count({})).toBe(before.outbox);
    expect(await f.scoped.tradePayment.count({ where: {} })).toBe(0);
    await expect(acceptSuggestion(prisma, { businessId: f.businessId, suggestionId: s!.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("for a linked supplier the draft is priced from their shared list, in whole packs (rounded up)", async () => {
    const w = await tradeWorld(prisma);
    await addPackConversion(w.R.scoped, w.R.businessId, w.rVariant.id, "carton", 24);
    await enableFlag(prisma, w.R.businessId, "reorderRules");
    await setReorderRule(w.R.scoped, { businessId: w.R.businessId, shopId: w.R.shopId, variantId: w.rVariant.id, mode: "FIXED", reorderPoint: 10, reorderQuantity: 60, preferredPartnerId: w.rPartner.id });
    await generateReorderSuggestions(prisma, { businessId: w.R.businessId, now: new Date() });
    const [s] = await listOpenSuggestions(w.R.scoped);
    expect(s?.suggestedBaseQty).toBe(60);
    const order = await acceptSuggestion(prisma, { businessId: w.R.businessId, suggestionId: s!.id, counterpartVariantId: w.wVariant.id });
    expect(order.lines[0]).toMatchObject({ unit: "carton", quantity: 3, baseQuantity: 72, unitPriceMinor: 220_000n }); // 60 -> 3 cartons = 72
    expect(order).toMatchObject({ acceptance: "DRAFT", totalMinor: 660_000n });
    await deliverTradeEvents(prisma);
    expect(await w.W.scoped.tradeOrder.count({ where: {} })).toBe(0); // the supplier has heard nothing
  });

  it("needs a supplier, can be dismissed, and a closed suggestion cannot be reused", async () => {
    const f = await fixture();
    await setReorderRule(f.scoped, { businessId: f.businessId, shopId: f.shopId, variantId: f.variant.id, mode: "FIXED", reorderPoint: 50, reorderQuantity: 48 });
    await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW });
    const [s] = await listOpenSuggestions(f.scoped);
    await expect(acceptSuggestion(prisma, { businessId: f.businessId, suggestionId: s!.id })).rejects.toMatchObject({ code: "INVALID" });
    await dismissSuggestion(f.scoped, { suggestionId: s!.id, actor: "owner-1" });
    await expect(dismissSuggestion(f.scoped, { suggestionId: s!.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(acceptSuggestion(prisma, { businessId: f.businessId, suggestionId: s!.id, partnerId: "x" })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("does nothing while the flag is off, ignores deactivated rules, and one business's rules never touch another's", async () => {
    const f = await fixture();
    const g = await fixture();
    for (const x of [f, g]) await setReorderRule(x.scoped, { businessId: x.businessId, shopId: x.shopId, variantId: x.variant.id, mode: "FIXED", reorderPoint: 50, reorderQuantity: 48 });
    await enableFlag(prisma, f.businessId, "reorderRules", false);
    expect(await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW })).toEqual({ created: 0, superseded: 0, unchanged: 0 });
    expect(await generateReorderSuggestions(prisma, { businessId: g.businessId, now: NOW })).toMatchObject({ created: 1 });
    expect(await f.scoped.reorderSuggestion.count({ where: {} })).toBe(0);
    expect(await g.scoped.reorderSuggestion.count({ where: {} })).toBe(1);
    const rule = await g.scoped.reorderRule.findFirstOrThrow({ where: {} });
    await deactivateReorderRule(g.scoped, rule.id);
    expect(await generateReorderSuggestions(prisma, { businessId: g.businessId, now: NOW })).toEqual({ created: 0, superseded: 0, unchanged: 0 });
  });

  it("validates rules, and the database enforces the same (one open suggestion per method, rule shape)", async () => {
    const f = await fixture();
    const base = { businessId: f.businessId, shopId: f.shopId, variantId: f.variant.id };
    await expect(setReorderRule(f.scoped, { ...base, mode: "FIXED", reorderPoint: -1, reorderQuantity: 5 })).rejects.toMatchObject({ code: "INVALID" });
    await expect(setReorderRule(f.scoped, { ...base, mode: "FIXED", reorderPoint: 5, reorderQuantity: 0 })).rejects.toMatchObject({ code: "INVALID" });
    await expect(setReorderRule(f.scoped, { ...base, mode: "DAYS_OF_COVER", targetCoverDays: 14 })).rejects.toMatchObject({ code: "INVALID" });
    await expect(setReorderRule(f.scoped, { ...base, variantId: "nope", mode: "FIXED", reorderPoint: 1, reorderQuantity: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(testDb.db.query(`INSERT INTO "ReorderRule" (id,"businessId","shopId","variantId",mode,"updatedAt") VALUES ('rr-x','${f.businessId}','${f.shopId}','${f.variant.id}','FIXED',now())`)).rejects.toThrow(/check constraint|mode_check/);
    await setReorderRule(f.scoped, { ...base, mode: "FIXED", reorderPoint: 50, reorderQuantity: 48 });
    await generateReorderSuggestions(prisma, { businessId: f.businessId, now: NOW });
    const [open] = await listOpenSuggestions(f.scoped);
    await expect(
      testDb.db.query(`INSERT INTO "ReorderSuggestion" (id,"businessId","shopId","variantId",method,"suggestedBaseQty",inputs,arithmetic,status) VALUES ('rs-dup','${f.businessId}','${f.shopId}','${f.variant.id}','${open!.method}',9,'{}','dup','PROPOSED')`),
    ).rejects.toThrow(/duplicate key|one_open_per_method|unique/);
  });
});
