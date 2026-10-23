import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, type Seller } from "./helpers/store.js";
import { accountNet, trialBalance } from "../src/domain/accounting.js";
import { getStockLevel, reconcileStock, reserveStock } from "../src/domain/stock.js";
import { addToBasket } from "../src/domain/store/basket.js";
import {
  cancelStoreOrderByBuyer, cancelStoreOrderBySeller, cancellationPolicy, checkoutBasket, completeStoreOrder, confirmStoreOrder, decideCancellationRequest, dispatchStoreOrder,
  expireStoreOrders, loadStoreOrder, markDeliveryFailed, markStoreOrderReady, publicOrderView, refundPolicy, type StoreOrderFull,
} from "../src/domain/store/orders.js";
import { applyStoreProviderPayment, recordStorePayment, resolvePaymentException } from "../src/domain/store/payments.js";
import { decideRefund, issueStoreRefund, receiveReturn, requestRefund } from "../src/domain/store/refunds.js";
import { openSupportCase, responsibleParty } from "../src/domain/store/cases.js";

vi.setConfig({ testTimeout: 60_000 });

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

const BUYER = { name: "Amaka Obi", phone: "08031234567", contactConsent: true };
const DAY = 86_400_000;
let k = 0;
let slugN = 0;
const net = (s: Seller, key: Parameters<typeof accountNet>[1]) => accountNet(s.scoped, key, { currencyCode: "NGN" });
const stock = (s: Seller) => getStockLevel(s.scoped, s.shopId, s.variant.id);

async function place(s: Seller, qty = 3, opts: { fulfilment?: "PICKUP" | "DELIVERY"; online?: boolean; now?: Date } = {}): Promise<{ order: StoreOrderFull; token: string }> {
  const t = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: qty });
  const zone = await s.scoped.deliveryZone.findFirst({ where: {} });
  const r = await checkoutBasket(prisma, {
    basketToken: t.token, buyer: BUYER, allowOnline: opts.online ?? false, ...(opts.now ? { now: opts.now } : {}),
    sellers: [{ businessId: s.businessId, fulfilment: opts.fulfilment ?? "PICKUP", paymentMethod: opts.online ? "ONLINE_SIMULATED" : "PAY_ON_COLLECTION", ...(opts.fulfilment === "DELIVERY" ? { zoneId: zone!.id, address: { landmark: "Near the blue gate" } } : {}) }],
  });
  const o = r.outcomes[0]!;
  if (!o.ok) throw new Error(`placement failed: ${o.error}`);
  return { order: o.order, token: o.accessToken };
}
const seller = (extra: object = {}) => makeSeller(prisma, `Shop ${++k}`, { slug: `lifecycle-shop-${++slugN}`, ...extra });
const reload = (s: Seller, id: string) => loadStoreOrder(s.scoped, id);

describe("pickup lifecycle: hold, confirm, ready, hand over with the code", () => {
  it("revenue is recognised only at hand-over; stock leaves only when the goods do; the cost stays private", async () => {
    const s = await seller();
    const { order } = await place(s, 3); // 3 cans = 300.00
    expect(await stock(s)).toMatchObject({ onHand: 50, reserved: 3 });
    const confirmed = await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, actor: "owner-1" });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.reservedUntil!.getTime()).toBeGreaterThan(Date.now() + 40 * 3_600_000); // pickup hold (48 h) now applies
    const ready = await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: order.id });
    expect(ready.status).toBe("READY");
    expect(await net(s, "SALES_REVENUE")).toBe(0n);

    // wrong code, then no code: refused; stock still held
    await expect(completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: "000000", collect: { method: "CASH" } })).rejects.toMatchObject({ code: "BAD_CODE" });
    await expect(completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, collect: { method: "CASH" } })).rejects.toMatchObject({ code: "BAD_CODE" });
    expect(await stock(s)).toMatchObject({ onHand: 50, reserved: 3 });
    // right code but the money has not been collected: refused
    await expect(completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: order.pickupCode })).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    await expect(completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: order.pickupCode, collect: { method: "CASH", amountMinor: 100n } })).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });

    const done = await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: order.pickupCode, collect: { method: "CASH" }, actor: "clerk-1" });
    expect(done).toMatchObject({ status: "COMPLETED", paidMinor: 30_000n });
    expect(await stock(s)).toMatchObject({ onHand: 47, reserved: 0 });
    // books: cash in as an advance, then recognised as sales; cost of goods from the private average cost
    expect(await net(s, "CASH")).toBe(30_000n);
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(0n);
    expect(await net(s, "SALES_REVENUE")).toBe(-30_000n);
    expect(await net(s, "COGS")).toBe(12_000n); // 3 x 40.00
    expect(await net(s, "INVENTORY")).toBe(-12_000n); // the fixture received stock without a purchase journal, so only the cost leaving shows
    const tb = await trialBalance(s.scoped, { currencyCode: "NGN" });
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    expect(await reconcileStock(s.scoped)).toEqual([]);
    // a finished order cannot be driven again
    await expect(completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: order.pickupCode, collect: { method: "CASH" } })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(cancelStoreOrderBySeller(prisma, { businessId: s.businessId, orderId: order.id, reason: "too late" })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("only legal transitions are available, and each is available once", async () => {
    const s = await seller();
    const { order } = await place(s, 1);
    await expect(markStoreOrderReady(prisma, { businessId: s.businessId, orderId: order.id })).rejects.toMatchObject({ code: "WRONG_STATE" }); // not confirmed yet
    await expect(dispatchStoreOrder(prisma, { businessId: s.businessId, orderId: order.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    await expect(confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(dispatchStoreOrder(prisma, { businessId: s.businessId, orderId: order.id })).rejects.toMatchObject({ code: "WRONG_STATE" }); // a pickup order is not dispatched
  });

  it("the database refuses to revive a finished order (except an expired one being reinstated)", async () => {
    const s = await seller();
    const { order } = await place(s, 1);
    await cancelStoreOrderBySeller(prisma, { businessId: s.businessId, orderId: order.id, reason: "out of stock" });
    await expect(testDb.db.query(`UPDATE "StoreOrder" SET status = 'CONFIRMED' WHERE id = '${order.id}'`)).rejects.toThrow(/cannot change status/);
    await expect(testDb.db.query(`DELETE FROM "StoreOrder" WHERE id = '${order.id}'`)).rejects.toThrow(/not permitted/);
    await expect(testDb.db.query(`UPDATE "StoreOrder" SET "refundedMinor" = 5, "paidMinor" = 1 WHERE id = '${order.id}'`)).rejects.toThrow(/check constraint|amounts_check/);
    await expect(testDb.db.query(`UPDATE "StoreOrder" SET "totalMinor" = 1 WHERE id = '${order.id}'`)).rejects.toThrow(/check constraint|amounts_check/);
    await expect(testDb.db.query(`UPDATE "StoreOrderLine" SET "lineTotalMinor" = 1 WHERE "orderId" = '${order.id}'`)).rejects.toThrow(/check constraint|values_check/);
  });
});

describe("delivery lifecycle", () => {
  it("stock leaves at dispatch, hand-over needs the code (or a stated, audited reason), and the fee is its own revenue line", async () => {
    const s = await seller();
    const { order } = await place(s, 2, { fulfilment: "DELIVERY" }); // 200.00 + 500.00 fee
    expect(order).toMatchObject({ subtotalMinor: 20_000n, deliveryFeeMinor: 50_000n, totalMinor: 70_000n });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    await expect(markStoreOrderReady(prisma, { businessId: s.businessId, orderId: order.id })).rejects.toMatchObject({ code: "WRONG_STATE" }); // a delivery order is dispatched, not "ready"
    const out = await dispatchStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, deliveryRef: "RIDER-17", carrier: "Seller's own rider" });
    expect(out).toMatchObject({ status: "OUT_FOR_DELIVERY", deliveryRef: "RIDER-17" });
    expect(await stock(s)).toMatchObject({ onHand: 48, reserved: 0 });
    expect(await net(s, "SALES_REVENUE")).toBe(0n); // goods left, but no sale is recognised until delivered
    await expect(completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: "123456", collect: { method: "MOBILE_MONEY" } })).rejects.toMatchObject({ code: "BAD_CODE" });
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, withoutCodeReason: "Buyer phone was off; neighbour signed", collect: { method: "MOBILE_MONEY" }, actor: "rider-1" });
    expect(await net(s, "MOBILE_MONEY")).toBe(70_000n);
    expect(await net(s, "SALES_REVENUE")).toBe(-20_000n);
    expect(await net(s, "DELIVERY_FEES")).toBe(-50_000n);
    expect((await s.scoped.auditLog.findFirstOrThrow({ where: { action: "store.order.completed_without_code" } })).metadata).toMatchObject({ reason: "Buyer phone was off; neighbour signed" });
  });

  it("a failed delivery puts the goods back and cancels the order", async () => {
    const s = await seller();
    const { order } = await place(s, 4, { fulfilment: "DELIVERY" });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    await dispatchStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    expect((await stock(s)).onHand).toBe(46);
    await expect(markDeliveryFailed(prisma, { businessId: s.businessId, orderId: order.id, reason: " " })).rejects.toMatchObject({ code: "INVALID" });
    const failed = await markDeliveryFailed(prisma, { businessId: s.businessId, orderId: order.id, reason: "Address could not be found" });
    expect(failed).toMatchObject({ status: "CANCELLED", cancelledBy: "SELLER" });
    expect(await stock(s)).toMatchObject({ onHand: 50, reserved: 0 });
    expect(await reconcileStock(s.scoped)).toEqual([]);
  });
});

describe("cancellation: one rule, used everywhere", () => {
  it("is immediate before confirmation, a request after it, and unavailable from ready onward", async () => {
    expect(cancellationPolicy({ status: "PLACED", fulfilment: "PICKUP" }).mode).toBe("IMMEDIATE");
    expect(cancellationPolicy({ status: "CONFIRMED", fulfilment: "PICKUP" }).mode).toBe("REQUEST");
    for (const status of ["READY", "OUT_FOR_DELIVERY", "COMPLETED", "CANCELLED", "EXPIRED"] as const) expect(cancellationPolicy({ status, fulfilment: "PICKUP" }).mode).toBe("NONE");

    const s = await seller();
    const a = await place(s, 2);
    const done = await cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: a.order.id, reason: "changed my mind" });
    expect(done.outcome).toBe("CANCELLED");
    expect(await stock(s)).toMatchObject({ reserved: 0 });
    expect(done.order).toMatchObject({ status: "CANCELLED", cancelledBy: "BUYER" });

    const b = await place(s, 2);
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: b.order.id });
    await expect(cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: b.order.id })).rejects.toMatchObject({ code: "INVALID" }); // a reason is needed
    const asked = await cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: b.order.id, reason: "found it cheaper elsewhere" });
    expect(asked.outcome).toBe("REQUESTED");
    expect((await reload(s, b.order.id)).status).toBe("CONFIRMED"); // a request is not a cancellation
    expect(await stock(s)).toMatchObject({ reserved: 2 });
    await expect(cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: b.order.id, reason: "again" })).rejects.toMatchObject({ code: "DUPLICATE" });
    const req = await s.scoped.storeCancellationRequest.findFirstOrThrow({ where: { orderId: b.order.id } });
    await decideCancellationRequest(prisma, { businessId: s.businessId, requestId: req.id, approve: true, actor: "owner-1" });
    expect((await reload(s, b.order.id)).status).toBe("CANCELLED");
    expect(await stock(s)).toMatchObject({ reserved: 0 });
    await expect(decideCancellationRequest(prisma, { businessId: s.businessId, requestId: req.id, approve: false })).rejects.toMatchObject({ code: "WRONG_STATE" });

    const c = await place(s, 2);
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: c.order.id });
    await cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: c.order.id, reason: "please" });
    const req2 = await s.scoped.storeCancellationRequest.findFirstOrThrow({ where: { orderId: c.order.id } });
    await decideCancellationRequest(prisma, { businessId: s.businessId, requestId: req2.id, approve: false });
    expect((await reload(s, c.order.id)).status).toBe("CONFIRMED"); // denied: the order goes ahead

    const d = await place(s, 1);
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: d.order.id });
    await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: d.order.id });
    await expect(cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: d.order.id, reason: "late" })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("the public order page reports exactly what the backend will allow", async () => {
    const s = await seller();
    const { order } = await place(s, 1);
    const v1 = await publicOrderView(prisma, s.businessId, order.id);
    expect(v1.actions.cancel).toBe(cancellationPolicy(order).mode);
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    const v2 = await publicOrderView(prisma, s.businessId, order.id);
    expect(v2.actions.cancel).toBe("REQUEST");
    expect(v2.status).toBe("CONFIRMED");
    expect(JSON.stringify(v2, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/cost|4000|accessTokenHash|businessId/i);
  });
});

describe("holds expire and release stock", () => {
  it("an unpaid online order and an unconfirmed pay-on-collection order lapse after their windows; the sweep is idempotent", async () => {
    const s = await seller();
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
    try {
      const online = await place(s, 2, { online: true });
      const cod = await place(s, 3);
      expect(await stock(s)).toMatchObject({ reserved: 5 });
      // (the sweep is global, so it may also expire other tests' orders in this shared database: assert on THESE orders)
      await expireStoreOrders(prisma, new Date(Date.now() + 30 * 60_000)); // inside both windows
      expect((await reload(s, online.order.id)).status).toBe("PLACED");
      await expireStoreOrders(prisma, new Date(Date.now() + 2 * 3_600_000)); // online (60 min) has lapsed, COD (48 h) has not
      expect((await reload(s, online.order.id)).status).toBe("EXPIRED");
      expect((await reload(s, cod.order.id)).status).toBe("PLACED");
      expect(await stock(s)).toMatchObject({ reserved: 3 });
      expect(await expireStoreOrders(prisma, new Date(Date.now() + 3 * DAY))).toBeGreaterThanOrEqual(1);
      expect((await reload(s, cod.order.id))).toMatchObject({ status: "EXPIRED", cancelledBy: "SYSTEM" });
      expect(await expireStoreOrders(prisma, new Date(Date.now() + 4 * DAY))).toBe(0); // nothing left to expire anywhere: idempotent
      expect(await stock(s)).toMatchObject({ reserved: 0 });
      expect(await reconcileStock(s.scoped)).toEqual([]);
    } finally {
      delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
    }
  });
});

describe("online payment (simulator): exact amounts apply once; everything else is a recoverable exception (scenario 10)", () => {
  async function onlineOrder(opts: { stock?: number } = {}) {
    const s = await seller(opts);
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
    const placed = await place(s, 2, { online: true });
    delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
    return { s, ...placed };
  }
  const pay = (s: Seller, orderId: string, amount: bigint, extra: Partial<Parameters<typeof applyStoreProviderPayment>[1]> = {}) =>
    applyStoreProviderPayment(prisma, { sellerBusinessId: s.businessId, orderId, provider: "simulator", externalId: `sim-${++k}-abcdefgh`, amountMinor: amount, currencyCode: "NGN", evidence: "SIMULATOR_CONFIRMED", ...extra });

  it("the exact amount applies, confirms the order and keeps the stock; a replay changes nothing", async () => {
    const { s, order } = await onlineOrder();
    expect((await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id }).catch((e) => e)).code).toBe("PAYMENT_REQUIRED"); // unpaid online order cannot be confirmed by hand
    const first = await pay(s, order.id, 20_000n, { externalId: "sim-same-0001" });
    expect(first.payment).toMatchObject({ state: "APPLIED", evidence: "SIMULATOR_CONFIRMED", provider: "simulator" });
    const again = await pay(s, order.id, 20_000n, { externalId: "sim-same-0001" });
    expect(again.replayed).toBe(true);
    const o = await reload(s, order.id);
    expect(o).toMatchObject({ status: "CONFIRMED", paidMinor: 20_000n });
    expect(await s.scoped.storePayment.count({ where: { orderId: order.id } })).toBe(1);
    expect(await net(s, "PROVIDER_CLEARING")).toBe(20_000n); // collected by the provider, not in the bank yet
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(-20_000n);
    expect(await net(s, "SALES_REVENUE")).toBe(0n);
    expect(o.reservedUntil!.getTime()).toBeGreaterThan(Date.now() + 40 * 3_600_000);
  });

  it("a payment that arrives AFTER the order expired is held, never silently applied, and the seller can reinstate it by re-reserving the stock", async () => {
    const { s, order } = await onlineOrder();
    await expireStoreOrders(prisma, new Date(Date.now() + 2 * 3_600_000));
    expect((await reload(s, order.id)).status).toBe("EXPIRED");
    expect(await stock(s)).toMatchObject({ reserved: 0 });
    const late = await pay(s, order.id, 20_000n);
    expect(late.payment.state).toBe("HELD");
    expect(late.exception).toMatchObject({ type: "LATE_SUCCESS", status: "OPEN", amountMinor: 20_000n });
    expect(await reload(s, order.id)).toMatchObject({ status: "EXPIRED", paidMinor: 0n }); // not applied
    expect(await stock(s)).toMatchObject({ reserved: 0 }); // and the stock was not silently re-taken
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(-20_000n); // but the money is on the books as a liability

    const out = await resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: late.exception!.id, action: "RE_RESERVE", actor: "owner-1" });
    expect(out.exception).toMatchObject({ status: "RESOLVED", resolution: "RE_RESERVED" });
    expect(out.order).toMatchObject({ status: "CONFIRMED", paidMinor: 20_000n });
    expect(await stock(s)).toMatchObject({ reserved: 2 });
    expect((await s.scoped.storePayment.findUniqueOrThrow({ where: { id: late.payment.id } })).state).toBe("APPLIED");
    await expect(resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: late.exception!.id, action: "REFUND" })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("if the stock has gone by then, reinstating is refused and the seller refunds; nothing is oversold", async () => {
    const { s, order } = await onlineOrder({ stock: 5 });
    await expireStoreOrders(prisma, new Date(Date.now() + 2 * 3_600_000));
    // someone else buys what is left
    await reserveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: s.variant.id, quantity: 5, reference: "other", idempotencyKey: `other-${k}`, expiresAt: new Date(Date.now() + 3_600_000) });
    const late = await pay(s, order.id, 20_000n);
    await expect(resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: late.exception!.id, action: "RE_RESERVE" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await reload(s, order.id)).status).toBe("EXPIRED");
    expect((await stock(s)).available).toBeGreaterThanOrEqual(0);
    const refunded = await resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: late.exception!.id, action: "REFUND", refundMethod: "MOBILE_MONEY", actor: "owner-1" });
    expect(refunded.exception.resolution).toBe("REFUNDED");
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(0n); // the held money went back
    expect(await net(s, "PROVIDER_CLEARING")).toBe(0n);
    expect((await s.scoped.storePayment.findMany({ where: { orderId: order.id, direction: "OUT" } })).length).toBe(1);
    const tb = await trialBalance(s.scoped, { currencyCode: "NGN" });
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
  });

  it("a payment after the BUYER cancelled is held and can only be refunded (a cancelled order is not reinstated)", async () => {
    const { s, order } = await onlineOrder();
    await cancelStoreOrderByBuyer(prisma, { businessId: s.businessId, orderId: order.id });
    const late = await pay(s, order.id, 20_000n);
    expect(late.exception).toMatchObject({ type: "LATE_SUCCESS" });
    await expect(resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: late.exception!.id, action: "RE_RESERVE" })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: late.exception!.id, action: "REFUND" });
    expect((await reload(s, order.id)).status).toBe("CANCELLED");
  });

  it("over, under and wrong-currency payments are held; an underpayment can be applied as a part-payment", async () => {
    const { s, order } = await onlineOrder();
    const over = await pay(s, order.id, 25_000n);
    const under = await pay(s, order.id, 5_000n);
    const wrong = await pay(s, order.id, 20_000n, { currencyCode: "USD" });
    expect([over, under, wrong].map((r) => r.exception!.type)).toEqual(["OVERPAYMENT", "UNDERPAYMENT", "CURRENCY_MISMATCH"]);
    expect(await reload(s, order.id)).toMatchObject({ paidMinor: 0n, status: "PLACED" });
    await expect(resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: over.exception!.id, action: "APPLY" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: wrong.exception!.id, action: "RE_RESERVE" })).rejects.toMatchObject({ code: "INVALID" });
    await resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: under.exception!.id, action: "APPLY" });
    expect((await reload(s, order.id)).paidMinor).toBe(5_000n);
    // the exact remainder now applies and completes the payment
    const rest = await pay(s, order.id, 15_000n);
    expect(rest.payment.state).toBe("APPLIED");
    expect(await reload(s, order.id)).toMatchObject({ paidMinor: 20_000n, status: "CONFIRMED" });
    // a further payment on a fully paid order is an overpayment exception
    expect((await pay(s, order.id, 1_000n)).exception!.type).toBe("OVERPAYMENT");
    await expect(pay(s, "no-such-order", 1_000n)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a payment can never be applied to another seller's order", async () => {
    const a = await onlineOrder();
    const b = await seller();
    await expect(pay(b, a.order.id, 20_000n)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await reload(a.s, a.order.id)).paidMinor).toBe(0n);
  });
});

describe("returns and refunds: a request is not a refund, and refunds are bounded by what was paid", () => {
  async function completed(opts: { returnWindowDays?: number | null } = {}) {
    const s = await seller(opts);
    const { order, token } = await place(s, 5); // 500.00
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: order.id });
    const done = await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: order.pickupCode, collect: { method: "CASH" } });
    return { s, order: done, token };
  }

  it("refund policy: only after hand-over, only inside the seller's own window; a seller with no window accepts none by default", async () => {
    const { s, order } = await completed({ returnWindowDays: 7 });
    expect(refundPolicy(order, 7, new Date()).allowed).toBe(true);
    expect(refundPolicy(order, 7, new Date(Date.now() + 8 * DAY)).allowed).toBe(false);
    expect(refundPolicy(order, null, new Date()).allowed).toBe(false);
    expect(refundPolicy({ status: "PLACED", completedAt: null }, 7, new Date()).allowed).toBe(false);
    await expect(requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "REFUND_ONLY", reason: "arrived damaged", requestedAmountMinor: 10_000n, now: new Date(Date.now() + 9 * DAY) })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const none = await completed({ returnWindowDays: null });
    await expect(requestRefund(prisma, { businessId: none.s.businessId, orderId: none.order.id, kind: "REFUND_ONLY", reason: "arrived damaged", requestedAmountMinor: 10_000n })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const pending = await place(s, 1);
    await expect(requestRefund(prisma, { businessId: s.businessId, orderId: pending.order.id, kind: "REFUND_ONLY", reason: "not delivered", requestedAmountMinor: 100n })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("a return: request, approve, goods received back into stock at the cost they left at, then refund exactly the value received", async () => {
    const { s, order } = await completed();
    expect(await stock(s)).toMatchObject({ onHand: 45 });
    const line = order.lines[0]!;
    await expect(requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "RETURN", reason: "wrong size", lines: [{ orderLineId: line.id, quantityBase: 6 }] })).rejects.toMatchObject({ code: "OVER_QUANTITY" });
    await expect(requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "RETURN", reason: "wrong size", lines: [] })).rejects.toMatchObject({ code: "INVALID" });
    const req = await requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "RETURN", reason: "two cans were dented", lines: [{ orderLineId: line.id, quantityBase: 2 }] });
    expect(req.status).toBe("REQUESTED");
    expect((await reload(s, order.id)).refundedMinor).toBe(0n); // a request is not a refund
    await expect(issueStoreRefund(prisma, { businessId: s.businessId, orderId: order.id, requestId: req.id, method: "CASH" })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(receiveReturn(prisma, { businessId: s.businessId, requestId: req.id, accepted: [{ orderLineId: line.id, quantityBase: 2 }] })).rejects.toMatchObject({ code: "WRONG_STATE" }); // not approved yet
    await decideRefund(prisma, { businessId: s.businessId, requestId: req.id, approve: true, actor: "owner-1" });
    await expect(receiveReturn(prisma, { businessId: s.businessId, requestId: req.id, accepted: [{ orderLineId: line.id, quantityBase: 3 }] })).rejects.toMatchObject({ code: "OVER_QUANTITY" });
    const received = await receiveReturn(prisma, { businessId: s.businessId, requestId: req.id, accepted: [{ orderLineId: line.id, quantityBase: 1 }], actor: "owner-1" }); // only 1 of 2 was in sellable condition
    expect(received).toMatchObject({ status: "GOODS_RECEIVED", approvedAmountMinor: 10_000n });
    expect(await stock(s)).toMatchObject({ onHand: 46 });
    expect(await net(s, "COGS")).toBe(20_000n - 4_000n); // the restocked can reverses its cost at 40.00
    await expect(issueStoreRefund(prisma, { businessId: s.businessId, orderId: order.id, requestId: req.id, amountMinor: 50_000n, method: "CASH" })).rejects.toMatchObject({ code: "REFUND_LIMIT" }); // exactly as approved
    const refund = await issueStoreRefund(prisma, { businessId: s.businessId, orderId: order.id, requestId: req.id, method: "CASH", actor: "owner-1" });
    expect(refund).toMatchObject({ direction: "OUT", amountMinor: 10_000n });
    expect((await reload(s, order.id)).refundedMinor).toBe(10_000n);
    expect(await net(s, "SALES_RETURNS")).toBe(10_000n);
    expect(await net(s, "CASH")).toBe(50_000n - 10_000n);
    await expect(issueStoreRefund(prisma, { businessId: s.businessId, orderId: order.id, requestId: req.id, method: "CASH" })).rejects.toMatchObject({ code: "WRONG_STATE" }); // once
    const tb = await trialBalance(s.scoped, { currencyCode: "NGN" });
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    expect(await reconcileStock(s.scoped)).toEqual([]);
    // a returned item cannot be returned again
    await expect(requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "RETURN", reason: "again please", lines: [{ orderLineId: line.id, quantityBase: 5 }] })).rejects.toMatchObject({ code: "OVER_QUANTITY" });
  });

  it("concurrent refunds can never exceed what was paid", async () => {
    const { s, order } = await completed(); // paid 500.00
    const mk = async (amount: bigint) => {
      const r = await requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "REFUND_ONLY", reason: "compensation for a late order", requestedAmountMinor: amount });
      await decideRefund(prisma, { businessId: s.businessId, requestId: r.id, approve: true });
      return r;
    };
    const r1 = await mk(30_000n);
    const r2 = await mk(30_000n);
    const results = await Promise.allSettled([
      issueStoreRefund(prisma, { businessId: s.businessId, orderId: order.id, requestId: r1.id, method: "CASH" }),
      issueStoreRefund(prisma, { businessId: s.businessId, orderId: order.id, requestId: r2.id, method: "CASH" }),
    ]);
    // 30 + 30 = 60 > 50 paid: exactly one may succeed
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "REFUND_LIMIT" });
    expect((await reload(s, order.id)).refundedMinor).toBe(30_000n);
    await expect(testDb.db.query(`UPDATE "StoreOrder" SET "refundedMinor" = 60000 WHERE id = '${order.id}'`)).rejects.toThrow(/check constraint|amounts_check/); // and the database agrees
    // an unrelated request cannot be asked for more than was paid
    await expect(requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "REFUND_ONLY", reason: "too much", requestedAmountMinor: 90_000n })).rejects.toMatchObject({ code: "REFUND_LIMIT" });
  });

  it("denying a request ends it; a cancelled order that was paid is refunded without a request; unpaid orders have nothing to refund", async () => {
    const { s, order } = await completed();
    const req = await requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "REFUND_ONLY", reason: "changed my mind", requestedAmountMinor: 10_000n });
    await decideRefund(prisma, { businessId: s.businessId, requestId: req.id, approve: false, note: "Outside our policy for opened items" });
    await expect(issueStoreRefund(prisma, { businessId: s.businessId, orderId: order.id, requestId: req.id, method: "CASH" })).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(decideRefund(prisma, { businessId: s.businessId, requestId: req.id, approve: true })).rejects.toMatchObject({ code: "WRONG_STATE" });

    const t = await seller();
    const paid = await place(t, 2);
    await recordStorePayment(prisma, { businessId: t.businessId, orderId: paid.order.id, amountMinor: 20_000n, method: "MOBILE_MONEY" }); // paid in advance
    await cancelStoreOrderBySeller(prisma, { businessId: t.businessId, orderId: paid.order.id, reason: "item discontinued" });
    await expect(issueStoreRefund(prisma, { businessId: t.businessId, orderId: paid.order.id, amountMinor: 30_000n, method: "MOBILE_MONEY" })).rejects.toMatchObject({ code: "REFUND_LIMIT" });
    await issueStoreRefund(prisma, { businessId: t.businessId, orderId: paid.order.id, amountMinor: 20_000n, method: "MOBILE_MONEY" });
    expect(await net(t, "CUSTOMER_ADVANCES")).toBe(0n);
    expect(await net(t, "MOBILE_MONEY")).toBe(0n);
    const unpaid = await place(t, 1);
    await cancelStoreOrderBySeller(prisma, { businessId: t.businessId, orderId: unpaid.order.id, reason: "x" });
    await expect(issueStoreRefund(prisma, { businessId: t.businessId, orderId: unpaid.order.id, amountMinor: 1n, method: "CASH" })).rejects.toMatchObject({ code: "REFUND_LIMIT" });
    // a live order is refunded through a request, not directly
    const live = await place(t, 1);
    await expect(issueStoreRefund(prisma, { businessId: t.businessId, orderId: live.order.id, amountMinor: 1n, method: "CASH" })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });
});

describe("support cases name who is responsible", () => {
  it("assigns the seller for delivery, complaints and refunds, the provider for provider-paid disputes, and the platform otherwise", async () => {
    expect(responsibleParty("DELIVERY", false)).toBe("SELLER");
    expect(responsibleParty("PRODUCT_COMPLAINT", true)).toBe("SELLER");
    expect(responsibleParty("REFUND", false)).toBe("SELLER");
    expect(responsibleParty("PAYMENT_DISPUTE", false)).toBe("SELLER");
    expect(responsibleParty("PAYMENT_DISPUTE", true)).toBe("PROVIDER");
    expect(responsibleParty("OTHER", false)).toBe("PLATFORM");

    const s = await seller();
    const { order } = await place(s, 1);
    const c = await openSupportCase(prisma, { businessId: s.businessId, orderId: order.id, type: "DELIVERY", openedBy: "CONSUMER", summary: "The rider has not arrived after three hours", contactName: "Amaka", contactPhone: "2348031234567" });
    expect(c).toMatchObject({ handledBy: "SELLER", status: "OPEN", orderId: order.id });
    expect(await s.scoped.supportCaseNote.count({ where: { caseId: c.id } })).toBe(1);
    await expect(openSupportCase(prisma, { businessId: s.businessId, orderId: order.id, type: "OTHER", openedBy: "CONSUMER", summary: "short" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(openSupportCase(prisma, { businessId: s.businessId, orderId: "nope", type: "OTHER", openedBy: "CONSUMER", summary: "A problem with an order that is not there" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // a payment that moved through the provider routes a dispute to the provider
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    const note = await s.scoped.supportCaseNote.findFirstOrThrow({ where: { caseId: c.id } });
    await expect(testDb.db.query(`UPDATE "SupportCaseNote" SET body = 'x' WHERE id = '${note.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "SupportCase" WHERE id = '${c.id}'`)).rejects.toThrow(/not permitted/);
    // another seller cannot see this case
    const other = await seller();
    expect(await other.scoped.supportCase.count({ where: {} })).toBe(0);
  });
});
