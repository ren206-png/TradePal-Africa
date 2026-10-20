import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { SIM_SECRET, deliverCallback, drainInbox, simulatorWorld, startPayment } from "./helpers/payments.js";
import { AdapterRegistry, CapabilityError, type ProviderAdapter } from "../src/payments/adapter.js";
import { SimulatorAdapter } from "../src/payments/simulatorAdapter.js";
import { setAdapterRegistry } from "../src/payments/registry.js";
import { accountNet, trialBalance } from "../src/domain/accounting.js";
import { PaymentPurposeForbiddenError } from "../src/domain/paymentPurpose.js";
import { PaymentsError } from "../src/domain/merchantPayments/common.js";
import { createPaymentIntent, ensureSimulatorConnection, registerConnection, startPaymentAttempt } from "../src/domain/merchantPayments/intents.js";
import { applyPaymentSnapshot, closeAttemptAfterCheck, reconcilePayments, receiveProviderCallback } from "../src/domain/merchantPayments/outcomes.js";
import { refundThroughProvider } from "../src/domain/merchantPayments/refunds.js";
import { recordSettlementReport } from "../src/domain/merchantPayments/settlements.js";
import { cancelStoreOrderBySeller, expireStoreOrders, loadStoreOrder } from "../src/domain/store/orders.js";
import { resolvePaymentException } from "../src/domain/store/payments.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let sim: SimulatorAdapter;
let registry: AdapterRegistry;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  ({ sim, registry } = simulatorWorld(prisma));
}, 60_000);
afterAll(async () => {
  delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
  setAdapterRegistry(null);
  await testDb.teardown();
});

const seller = async (extra: object = {}) => {
  const s = await makeSeller(prisma, `Pay Shop ${++k}`, { slug: `pay-shop-${k}`, ...extra });
  await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
  return s;
};
const net = (s: Seller, key: Parameters<typeof accountNet>[1]) => accountNet(s.scoped, key, { currencyCode: "NGN" });

/** An online order (2 cans = 200.00) with its payment request accepted by the provider (PENDING). */
async function pending(s: Seller, qty = 2) {
  const { order } = await placeStoreOrder(prisma, s, { qty, online: true });
  const { intent, attempt } = await startPayment(prisma, registry, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
  return { order, intent, attempt };
}
const orderOf = (s: Seller, id: string) => loadStoreOrder(s.scoped, id);

describe("scenario 9: accepted, timed-out and unknown states stay unpaid until authenticated evidence", () => {
  it("a provider acceptance is PENDING and pays nothing", async () => {
    const s = await seller();
    const { order, attempt } = await pending(s);
    expect(attempt).toMatchObject({ status: "PENDING", amountMinor: 20_000n, capturedMinor: 0n });
    expect(attempt.externalRef).toMatch(/^sim_/);
    expect(await orderOf(s, order.id)).toMatchObject({ status: "PLACED", paidMinor: 0n });
    expect(await net(s, "PROVIDER_CLEARING")).toBe(0n);
    expect(await s.scoped.paymentAttemptEvent.count({ where: { attemptId: attempt.id } })).toBeGreaterThanOrEqual(2);
  });

  it("a request that timed out is UNKNOWN (it may still collect), blocks another attempt, and is resolved only by an authenticated lookup", async () => {
    const s = await seller();
    const { order } = await placeStoreOrder(prisma, s, { qty: 2, online: true });
    await ensureSimulatorConnection(prisma, s.businessId);
    const intent = await createPaymentIntent(prisma, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
    sim.dropNextCreate = true;
    const err = await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent.id, provider: "simulator" }).catch((e) => e);
    expect(err).toMatchObject({ code: "PAYMENT_UNCONFIRMED" });
    const unknown = await s.scoped.paymentAttempt.findFirstOrThrow({ where: { intentId: intent.id } });
    expect(unknown.status).toBe("UNKNOWN");
    expect(await orderOf(s, order.id)).toMatchObject({ paidMinor: 0n });
    // a retry while the first may still collect is refused
    await expect(startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent.id, provider: "simulator" })).rejects.toMatchObject({ code: "ATTEMPT_UNRESOLVED" });

    // the provider is unreachable at the next look: still unknown, still unpaid, backoff scheduled
    sim.outage = true;
    const t1 = new Date(Date.now() + 60_000);
    expect((await reconcilePayments(prisma, registry, t1)).unreachable).toBeGreaterThanOrEqual(1);
    sim.outage = false;
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe("UNKNOWN");
    // provider reachable: it has no record of the request, so it never collected -> safe to close, and only now
    await reconcilePayments(prisma, registry, new Date(Date.now() + 10 * 60_000));
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe("FAILED");
    // and a fresh attempt is now allowed
    const again = await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent.id, provider: "simulator" });
    expect(again.attempt.status).toBe("PENDING");
  });

  it("a payment the provider completed while our callback was lost is found by the status poll, applied once", async () => {
    const s = await seller();
    const { order, attempt } = await pending(s);
    await sim.completePayment(attempt.externalRef!); // provider-side success; we never got the callback
    expect(await orderOf(s, order.id)).toMatchObject({ paidMinor: 0n, status: "PLACED" });
    const r = await reconcilePayments(prisma, registry, new Date(Date.now() + 5 * 60_000));
    expect(r.applied).toBeGreaterThanOrEqual(1);
    expect(await orderOf(s, order.id)).toMatchObject({ paidMinor: 20_000n, status: "CONFIRMED" });
    await reconcilePayments(prisma, registry, new Date(Date.now() + 20 * 60_000)); // nothing more to do
    expect(await s.scoped.storePayment.count({ where: { orderId: order.id } })).toBe(1);
  });
});

describe("scenario 7: concurrent and replayed callbacks apply one business effect", () => {
  it("the same callback twice, the same payment under a new event id, and two simultaneous appliers all leave one payment", async () => {
    const s = await seller();
    const { order, attempt } = await pending(s);
    const cb = await sim.completePayment(attempt.externalRef!);
    expect(await deliverCallback(prisma, registry, cb)).toEqual({ status: "recorded" });
    expect(await deliverCallback(prisma, registry, cb)).toEqual({ status: "duplicate" });
    const resend = await sim.completePayment(attempt.externalRef!, { eventId: "evt-resend-0001" }); // the provider re-sends under a new id
    expect(await deliverCallback(prisma, registry, resend)).toEqual({ status: "recorded" });
    await drainInbox(prisma);
    expect(await orderOf(s, order.id)).toMatchObject({ paidMinor: 20_000n, status: "CONFIRMED" });
    expect(await s.scoped.storePayment.count({ where: { orderId: order.id } })).toBe(1);
    expect(await s.scoped.paymentAllocation.count({ where: { attemptId: attempt.id } })).toBe(1);
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(-20_000n);

    // three workers apply the same success (run one after another: the in-process test database serialises sessions, so real
    // interleaving is NOT exercised here; the guarded UPDATE that makes exactly one winner is)
    const b = await pending(s);
    await sim.completePayment(b.attempt.externalRef!);
    const snapshot = await sim.getStatus({ externalRef: b.attempt.externalRef, merchantReference: b.attempt.id, destinationKey: "x" });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await applyPaymentSnapshot(prisma, { attemptId: b.attempt.id, snapshot, adapter: sim, source: "CALLBACK" }));
    expect(results.filter((r) => r.result === "APPLIED")).toHaveLength(1);
    expect(await orderOf(s, b.order.id)).toMatchObject({ paidMinor: 20_000n });
    expect(await s.scoped.storePayment.count({ where: { orderId: b.order.id } })).toBe(1);
    const tb = await trialBalance(s.scoped, { currencyCode: "NGN" });
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
  });
});

describe("scenario 8: forged or mismatched evidence can never mark an order paid", () => {
  it("refuses a forged signature, a forged purpose, another tenant's claim, a wrong reference, destination or currency, and an unknown payment", async () => {
    const s = await seller();
    const other = await seller();
    const { order, attempt } = await pending(s);
    const claim = (extra: Record<string, unknown>) => sim.signedEvent({ event: "payment.updated", eventId: `evt-claim-${++k}-0001`, purpose: "MERCHANT_SALE", externalRef: attempt.externalRef, merchantReference: attempt.id, status: "SUCCEEDED", amountMinor: "20000", currencyCode: "NGN", destinationKey: `sim-dest-${s.businessId.slice(0, 8)}`, ...extra });
    const paid = async () => (await orderOf(s, order.id)).paidMinor;

    const forgedSig = claim({});
    expect(await receiveProviderCallback(prisma, registry, "simulator", forgedSig.body, { "x-simulator-signature": "ab".repeat(32) })).toEqual({ status: "rejected", reason: "BAD_SIGNATURE" });
    expect(await receiveProviderCallback(prisma, registry, "simulator", forgedSig.body, {})).toEqual({ status: "rejected", reason: "BAD_SIGNATURE" });
    expect(await deliverCallback(prisma, registry, claim({ purpose: "PLATFORM_SUBSCRIPTION" }))).toEqual({ status: "rejected", reason: "PURPOSE_FORBIDDEN" });
    expect(await prisma.providerException.count({ where: { type: "PURPOSE_MISMATCH" } })).toBeGreaterThanOrEqual(1);

    const bad: [string, Record<string, unknown>, string][] = [
      ["WRONG_TENANT", { sellerBusinessId: other.businessId }, "WRONG_TENANT"],
      ["UNKNOWN_REFERENCE", { merchantReference: "some-other-reference" }, "UNKNOWN_REFERENCE"],
      ["DESTINATION_MISMATCH", { destinationKey: "someone-elses-wallet" }, "DESTINATION_MISMATCH"],
      ["CURRENCY_MISMATCH", { currencyCode: "USD" }, "CURRENCY_MISMATCH"],
    ];
    for (const [, extra, type] of bad) {
      expect(await deliverCallback(prisma, registry, claim(extra))).toEqual({ status: "recorded" });
      await drainInbox(prisma);
      expect(await paid(), type).toBe(0n);
      expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status, type).toBe("PENDING");
      expect(await prisma.providerException.count({ where: { attemptId: attempt.id, type: type as never } }), type).toBe(1);
    }
    // a payment nobody asked for
    expect(await deliverCallback(prisma, registry, claim({ externalRef: "sim_doesnotexist01", eventId: "evt-unknown-0001" }))).toEqual({ status: "recorded" });
    await drainInbox(prisma);
    expect(await prisma.providerException.count({ where: { type: "UNKNOWN_REFERENCE", provider: "simulator", attemptId: null } })).toBeGreaterThanOrEqual(1);
    expect(await paid()).toBe(0n);
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(0n);
    // replaying the same bad callback does not pile up exceptions
    const dup = claim({ currencyCode: "USD", eventId: "evt-dup-bad-0001" });
    await deliverCallback(prisma, registry, dup);
    await deliverCallback(prisma, registry, dup);
    await drainInbox(prisma);
    expect(await prisma.providerException.count({ where: { attemptId: attempt.id, type: "CURRENCY_MISMATCH" } })).toBe(2); // two distinct bad events, each once
  });

  it("a short or excess payment is captured but never applied silently: it is held with an exception on both sides of the books", async () => {
    const s = await seller();
    const { order, attempt } = await pending(s);
    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!, { amountMinor: 15_000n }));
    await drainInbox(prisma);
    expect(await orderOf(s, order.id)).toMatchObject({ paidMinor: 0n, status: "PLACED" });
    expect(await s.scoped.paymentException.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ type: "UNDERPAYMENT", status: "OPEN", amountMinor: 15_000n });
    expect(await prisma.providerException.count({ where: { attemptId: attempt.id, type: "AMOUNT_MISMATCH" } })).toBe(1);
    expect(await s.scoped.paymentAllocation.findFirstOrThrow({ where: { attemptId: attempt.id } })).toMatchObject({ state: "HELD", amountMinor: 15_000n });
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(-15_000n); // the money is real and is on the books, but not applied to the order
  });
});

describe("scenario 10: late success after expiry or cancellation is a recoverable exception", () => {
  it("expired order: the money is held; the seller re-reserves the stock and the allocation becomes applied", async () => {
    const s = await seller();
    const { order, intent, attempt } = await pending(s);
    const later = new Date(Date.now() + 3 * 3_600_000);
    expect(await expireStoreOrders(prisma, later)).toBeGreaterThanOrEqual(1);
    expect((await s.scoped.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe("EXPIRED"); // the offer to pay closed with the order
    expect(await orderOf(s, order.id)).toMatchObject({ status: "EXPIRED" });

    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!)); // the provider collected anyway
    await drainInbox(prisma);
    expect(await orderOf(s, order.id)).toMatchObject({ status: "EXPIRED", paidMinor: 0n });
    const ex = await s.scoped.paymentException.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ex).toMatchObject({ type: "LATE_SUCCESS", status: "OPEN", amountMinor: 20_000n });
    expect((await s.scoped.paymentAllocation.findFirstOrThrow({ where: { attemptId: attempt.id } })).state).toBe("HELD");

    await resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: ex.id, action: "RE_RESERVE" });
    expect(await orderOf(s, order.id)).toMatchObject({ status: "CONFIRMED", paidMinor: 20_000n });
    expect((await s.scoped.paymentAllocation.findFirstOrThrow({ where: { attemptId: attempt.id } })).state).toBe("APPLIED");
    expect((await s.scoped.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).paidMinor).toBe(20_000n);
  });

  it("cancelled order: the late money cannot reinstate it and goes back through the provider that took it", async () => {
    const s = await seller();
    const { order, attempt } = await pending(s);
    await cancelStoreOrderBySeller(prisma, { businessId: s.businessId, orderId: order.id, reason: "Out of stock after all" });
    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!));
    await drainInbox(prisma);
    const ex = await s.scoped.paymentException.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ex.type).toBe("LATE_SUCCESS");
    await expect(resolvePaymentException(prisma, { businessId: s.businessId, exceptionId: ex.id, action: "RE_RESERVE" })).rejects.toMatchObject({ code: "WRONG_STATE" });

    const { refund } = await refundThroughProvider(prisma, registry, { businessId: s.businessId, attemptId: attempt.id, amountMinor: 20_000n, reason: "Order was cancelled", idempotencyKey: `held-${ex.id}`, storeExceptionId: ex.id });
    expect(refund.status).toBe("SUCCEEDED");
    expect(await s.scoped.paymentException.findUniqueOrThrow({ where: { id: ex.id } })).toMatchObject({ status: "RESOLVED", resolution: "REFUNDED" });
    expect((await s.scoped.paymentAllocation.findFirstOrThrow({ where: { attemptId: attempt.id } })).state).toBe("REFUNDED");
    expect(await net(s, "PROVIDER_CLEARING")).toBe(0n); // collected 200.00, returned 200.00
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(0n);
  });
});

describe("scenario 11: a retry or fallback cannot create a second active collection", () => {
  it("returns the same attempt for a double click or repeated start, and the database refuses a second active attempt", async () => {
    const s = await seller();
    const { order } = await placeStoreOrder(prisma, s, { qty: 2, online: true });
    await ensureSimulatorConnection(prisma, s.businessId);
    const intent = await createPaymentIntent(prisma, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
    const starts = [];
    for (let i = 0; i < 3; i++) starts.push(await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent.id, provider: "simulator" }).catch((e) => e));
    const ids = new Set(starts.filter((x) => !(x instanceof Error)).map((x) => x.attempt.id));
    expect(ids.size).toBe(1);
    expect(await s.scoped.paymentAttempt.count({ where: { intentId: intent.id } })).toBe(1);
    expect(await sim["prisma"].simulatorPayment.count({ where: { merchantReference: [...ids][0]! } })).toBe(1);

    const [first] = [...ids];
    const conn = await s.scoped.providerConnection.findFirstOrThrow({ where: {} });
    await expect(
      testDb.db.query(`INSERT INTO "PaymentAttempt" ("id","businessId","intentId","connectionId","provider","status","amountMinor","currencyCode","idempotencyKey","expiresAt","updatedAt")
        VALUES ('forced-second','${s.businessId}','${intent.id}','${conn.id}','simulator','PENDING',20000,'NGN','forced-key',now(),now())`),
    ).rejects.toThrow(/PaymentAttempt_one_active_per_intent|duplicate key/);
    expect(first).toBeTruthy();

    // once the first attempt has definitively failed, a new one is allowed
    const sp = await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: first! } });
    await deliverCallback(prisma, registry, await sim.completePayment(sp.externalRef!, { status: "FAILED" }));
    await drainInbox(prisma);
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: first! } })).status).toBe("FAILED");
    const second = await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent.id, provider: "simulator" });
    expect(second.attempt.id).not.toBe(first);
    expect(second.reused).toBe(false);
  });

  it("a provider-reported FAILED is final: a later SUCCEEDED for it is an exception, not a payment", async () => {
    const s = await seller();
    const { order, attempt } = await pending(s);
    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!, { status: "FAILED" }));
    await drainInbox(prisma);
    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!, { status: "SUCCEEDED", eventId: "evt-contradict-001" }));
    await drainInbox(prisma);
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("FAILED");
    expect(await orderOf(s, order.id)).toMatchObject({ paidMinor: 0n });
    expect(await prisma.providerException.count({ where: { attemptId: attempt.id, type: "CONTRADICTORY_STATUS" } })).toBe(1);
    // the database agrees: a final status cannot be edited
    const row = await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    await expect(testDb.db.query(`UPDATE "PaymentAttempt" SET "status"='PENDING' WHERE id='${row.id}'`)).rejects.toThrow(/final/);
  });
});

describe("scenario 12: refunds are bounded by what was collected; a failed refund stays unresolved", () => {
  async function collected(s: Seller, qty = 2) {
    const p = await pending(s, qty);
    await deliverCallback(prisma, registry, await sim.completePayment(p.attempt.externalRef!));
    await drainInbox(prisma);
    return p;
  }

  it("repeated partial refunds can never total more than was captured, and a repeated request is one refund", async () => {
    const s = await seller();
    const { order, attempt } = await collected(s); // 200.00 captured
    const tries = [];
    for (const i of [1, 2, 3, 4, 5, 6]) tries.push(await refundThroughProvider(prisma, registry, { businessId: s.businessId, attemptId: attempt.id, amountMinor: 5_000n, reason: `Partial refund ${i}`, idempotencyKey: `r-${order.id}-${i}` }).catch((e) => e));
    const ok = tries.filter((t) => !(t instanceof Error));
    const refused = tries.filter((t) => t instanceof PaymentsError && t.code === "REFUND_LIMIT");
    expect(ok).toHaveLength(4);
    expect(refused).toHaveLength(2);
    const a = await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(a.refundedMinor).toBe(20_000n);
    expect(a.refundedMinor <= a.capturedMinor).toBe(true);
    const sp = await prisma.simulatorPayment.findUniqueOrThrow({ where: { externalRef: attempt.externalRef! } });
    expect(sp.refundedMinor).toBe(20_000n); // the provider agrees

    const again = await refundThroughProvider(prisma, registry, { businessId: s.businessId, attemptId: attempt.id, amountMinor: 5_000n, reason: "Partial refund 1", idempotencyKey: `r-${order.id}-1` });
    expect(again.replayed).toBe(true);
    await expect(testDb.db.query(`UPDATE "PaymentAttempt" SET "refundedMinor" = "capturedMinor" + 1 WHERE id='${attempt.id}'`)).rejects.toThrow(/check/i);
  });

  it("a failed refund is recorded, releases the reserved funds, raises an exception and is never retried elsewhere", async () => {
    const s = await seller();
    const { attempt } = await collected(s);
    await sim.setBehaviour(attempt.externalRef!, "REFUND_FAILS");
    const r = await refundThroughProvider(prisma, registry, { businessId: s.businessId, attemptId: attempt.id, amountMinor: 8_000n, reason: "Customer returned goods", idempotencyKey: `fail-${attempt.id}` });
    expect(r.refund).toMatchObject({ status: "FAILED" });
    expect(r.refund.failureReason).toContain("could not send");
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).refundedMinor).toBe(0n);
    const ex = await prisma.providerException.findFirstOrThrow({ where: { attemptId: attempt.id, type: "REFUND_FAILED" } });
    expect(ex).toMatchObject({ status: "OPEN", amountMinor: 8_000n });
    expect((await prisma.simulatorPayment.findUniqueOrThrow({ where: { externalRef: attempt.externalRef! } })).refundedMinor).toBe(0n);
    // the full amount is still refundable once the provider can do it
    await sim.setBehaviour(attempt.externalRef!, "NORMAL");
    const retry = await refundThroughProvider(prisma, registry, { businessId: s.businessId, attemptId: attempt.id, amountMinor: 20_000n, reason: "Retry after the provider recovered", idempotencyKey: `retry-${attempt.id}` });
    expect(retry.refund.status).toBe("SUCCEEDED");
  });

  it("a pending refund is confirmed by its callback exactly once; the seller's books move only then", async () => {
    const s = await seller();
    const { order, attempt } = await collected(s);
    await cancelStoreOrderBySeller(prisma, { businessId: s.businessId, orderId: order.id, reason: "Cannot deliver" });
    await sim.setBehaviour(attempt.externalRef!, "REFUND_PENDING");
    const r = await refundThroughProvider(prisma, registry, { businessId: s.businessId, attemptId: attempt.id, amountMinor: 20_000n, reason: "Cancelled paid order", idempotencyKey: `pend-${order.id}`, storeOrderId: order.id });
    expect(r.refund.status).toBe("PENDING");
    expect(await orderOf(s, order.id)).toMatchObject({ refundedMinor: 0n }); // not yet: the provider has not confirmed
    const ev = sim.refundEvent({ paymentExternalRef: attempt.externalRef!, refundExternalRef: r.refund.externalRef!, status: "SUCCEEDED", amountMinor: 20_000n });
    await deliverCallback(prisma, registry, ev);
    await drainInbox(prisma);
    expect(await orderOf(s, order.id)).toMatchObject({ refundedMinor: 20_000n });
    expect((await s.scoped.providerRefund.findUniqueOrThrow({ where: { id: r.refund.id } })).status).toBe("SUCCEEDED");
    await deliverCallback(prisma, registry, sim.refundEvent({ paymentExternalRef: attempt.externalRef!, refundExternalRef: r.refund.externalRef!, status: "SUCCEEDED", amountMinor: 20_000n, eventId: "evt-refund-replay" }));
    await drainInbox(prisma);
    expect(await orderOf(s, order.id)).toMatchObject({ refundedMinor: 20_000n }); // a replay changes nothing
  });

  it("an operation the provider does not support is an explicit capability error before any money is reserved", async () => {
    const s = await seller();
    const { attempt } = await collected(s);
    const noRefund = { ...sim, id: "simulator", capabilities: new Set(["createPayment", "getStatus"]), getStatus: sim.getStatus.bind(sim) } as unknown as ProviderAdapter;
    const reg2 = new AdapterRegistry().register(noRefund);
    await expect(refundThroughProvider(prisma, reg2, { businessId: s.businessId, attemptId: attempt.id, amountMinor: 1_000n, reason: "No refund support", idempotencyKey: "cap-1" })).rejects.toBeInstanceOf(CapabilityError);
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).refundedMinor).toBe(0n);
    await expect(sim.fetchSettlements()).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe("scenario 13/14: settlement is not a second sale; subscription money has no path in", () => {
  it("posts Dr bank + fees, Cr provider clearing; revenue and payments are untouched; replays and bad reports change nothing", async () => {
    const s = await seller({ flags: [] });
    const a = await pending(s);
    const b = await pending(s);
    for (const x of [a, b]) await deliverCallback(prisma, registry, await sim.completePayment(x.attempt.externalRef!));
    await drainInbox(prisma);
    for (const x of [a, b]) await s.scoped.storeOrder.update({ where: { id: x.order.id }, data: {} });
    expect(await net(s, "PROVIDER_CLEARING")).toBe(40_000n);
    const dest = `sim-dest-${s.businessId.slice(0, 8)}`;
    const refs = [a.attempt.externalRef!, b.attempt.externalRef!];

    const bad = await sim.settle({ reference: "SET-BAD-0001", destinationKey: "another-merchants-account", externalRefs: refs, feePerPaymentMinor: 100n });
    await deliverCallback(prisma, registry, bad);
    await drainInbox(prisma);
    expect(await prisma.providerException.count({ where: { type: "DESTINATION_MISMATCH", provider: "simulator" } })).toBeGreaterThanOrEqual(1);
    expect(await s.scoped.providerSettlement.count()).toBe(0);

    const cb = await sim.settle({ reference: "SET-0001", destinationKey: dest, externalRefs: refs, feePerPaymentMinor: 150n });
    await deliverCallback(prisma, registry, cb);
    await drainInbox(prisma);
    const st = await s.scoped.providerSettlement.findFirstOrThrow({ where: { reference: "SET-0001" } });
    expect(st).toMatchObject({ grossMinor: 40_000n, feeMinor: 300n, netMinor: 39_700n, status: "POSTED", evidence: "SIMULATOR_CONFIRMED" });
    expect(await net(s, "PROVIDER_CLEARING")).toBe(0n); // cleared
    expect(await net(s, "BANK")).toBe(39_700n);
    expect(await net(s, "PAYMENT_FEES")).toBe(300n);
    expect(await net(s, "SALES_REVENUE")).toBe(0n); // settlement is not revenue: nothing was handed over, and nothing was added
    expect(await net(s, "CUSTOMER_ADVANCES")).toBe(-40_000n);
    const tb = await trialBalance(s.scoped, { currencyCode: "NGN" });
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: a.attempt.id } })).settledAt).not.toBeNull();

    // the same report again, and the same payment under a different reference
    expect(await recordSettlementReport(prisma, { provider: "simulator", report: (await replayReport(cb)), evidence: "SIMULATOR_CONFIRMED" })).toMatchObject({ status: "REPLAY" });
    const dupe = await sim.settle({ reference: "SET-0002", destinationKey: dest, externalRefs: [refs[0]!], feePerPaymentMinor: 10n });
    await deliverCallback(prisma, registry, dupe);
    await drainInbox(prisma);
    expect(await s.scoped.providerSettlement.count()).toBe(1);
    expect(await prisma.providerException.count({ where: { type: "SETTLEMENT_MISMATCH", businessId: s.businessId } })).toBeGreaterThanOrEqual(1);
    expect(await net(s, "BANK")).toBe(39_700n);

    // totals that do not add up post nothing
    const tampered = await sim.settle({ reference: "SET-0003", destinationKey: dest, externalRefs: [refs[1]!], feePerPaymentMinor: 10n, amountOverrideMinor: 5n });
    const body = JSON.parse(tampered.body);
    body.grossMinor = "999999";
    const resigned = sim.signedEvent(body);
    await deliverCallback(prisma, registry, resigned);
    await drainInbox(prisma);
    expect(await s.scoped.providerSettlement.count()).toBe(1);
  });

  it("scenario 14: a payment intent can never be for subscription money, and pawaPay cannot be connected to a merchant", async () => {
    const s = await seller();
    const { order } = await placeStoreOrder(prisma, s, { qty: 1, online: true });
    await expect(
      testDb.db.query(`INSERT INTO "PaymentIntent" ("id","businessId","purpose","subjectType","subjectId","reference","amountMinor","currencyCode","idempotencyKey","expiresAt","updatedAt")
        VALUES ('forged-intent','${s.businessId}','PLATFORM_SUBSCRIPTION','STORE_ORDER','${order.id}','x',100,'NGN','forged-intent-key',now(),now())`),
    ).rejects.toThrow(/PaymentIntent_values_check|check constraint/);
    await expect(registerConnection(prisma, { businessId: s.businessId, provider: "pawapay", arrangementRef: "x", destinationKey: "y", destinationLabel: "z" })).rejects.toBeInstanceOf(PaymentPurposeForbiddenError);
    await expect(registerConnection(prisma, { businessId: s.businessId, provider: "flutterwave", arrangementRef: "x", destinationKey: "y", destinationLabel: "z" })).rejects.toBeInstanceOf(PaymentPurposeForbiddenError);
    await expect(registerConnection(prisma, { businessId: s.businessId, provider: "simulator", arrangementRef: "x", destinationKey: "y", destinationLabel: "z", credentialRef: "sk_live_abc123secretvalue" })).rejects.toMatchObject({ code: "INVALID" });
    const sub = await sim.completePayment((await startPayment(prisma, registry, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id })).attempt.externalRef!, { purpose: "PLATFORM_SUBSCRIPTION" });
    expect(await deliverCallback(prisma, registry, sub)).toEqual({ status: "rejected", reason: "PURPOSE_FORBIDDEN" });
  });
});

describe("scenario 23: provider outage blocks new attempts with a clear message; reconciliation stays operable", () => {
  it("opens a circuit after repeated failures, keeps applying callbacks and checks meanwhile, and recovers", async () => {
    const s = await seller();
    const live = await pending(s); // accepted before the outage
    sim.outage = true;
    const orders = [];
    for (let i = 0; i < 3; i++) orders.push((await placeStoreOrder(prisma, s, { qty: 1, online: true })).order);
    for (const o of orders) {
      await ensureSimulatorConnection(prisma, s.businessId);
      const intent = await createPaymentIntent(prisma, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: o.id });
      const err = await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent.id, provider: "simulator" }).catch((e) => e);
      expect(err).toMatchObject({ code: "PAYMENT_UNCONFIRMED" });
    }
    const fourth = (await placeStoreOrder(prisma, s, { qty: 1, online: true })).order;
    const intent4 = await createPaymentIntent(prisma, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: fourth.id });
    const refused = await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent4.id, provider: "simulator" }).catch((e) => e);
    expect(refused).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(refused.message).toContain("temporarily unavailable");
    expect(await s.scoped.paymentAttempt.count({ where: { intentId: intent4.id } })).toBe(0); // nothing was created or sent

    // during the outage, evidence we already have still applies (the signed callback needs no call to the provider)
    sim.outage = false;
    const cb = await sim.completePayment(live.attempt.externalRef!);
    sim.outage = true;
    await deliverCallback(prisma, registry, cb);
    await drainInbox(prisma);
    expect(await orderOf(s, live.order.id)).toMatchObject({ paidMinor: 20_000n, status: "CONFIRMED" });
    // and an admin cannot "close" an unknown attempt without being able to check
    const unknown = await s.scoped.paymentAttempt.findFirstOrThrow({ where: { status: "UNKNOWN" } });
    await expect(closeAttemptAfterCheck(prisma, registry, { attemptId: unknown.id, as: "FAILED", adminUserId: "admin-1", reason: "Provider down" })).rejects.toMatchObject({ code: "CANNOT_VERIFY" });

    // recovery: after the cooldown a new attempt is allowed again and the unknown ones resolve
    sim.outage = false;
    const later = new Date(Date.now() + 15 * 60_000);
    await reconcilePayments(prisma, registry, later);
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe("FAILED");
    const ok = await startPaymentAttempt(prisma, registry, { businessId: s.businessId, intentId: intent4.id, provider: "simulator", now: later });
    expect(ok.attempt.status).toBe("PENDING");
    expect((await s.scoped.providerConnection.findFirstOrThrow({ where: {} })).consecutiveFailures).toBe(0);
  });

  it("an admin can close a dead attempt only after the provider confirms it never collected, and cannot close one that is still pending", async () => {
    const s = await seller();
    const { attempt } = await pending(s);
    await expect(closeAttemptAfterCheck(prisma, registry, { attemptId: attempt.id, as: "FAILED", adminUserId: "admin-1", reason: "Customer gave up" })).rejects.toMatchObject({ code: "STILL_PENDING" });
    await sim.completePayment(attempt.externalRef!);
    const r = await closeAttemptAfterCheck(prisma, registry, { attemptId: attempt.id, as: "FAILED", adminUserId: "admin-1", reason: "Customer gave up" });
    expect(r).toMatchObject({ closed: false, providerSays: "SUCCEEDED" }); // it was paid after all: applied instead of closed
    expect((await s.scoped.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("SUCCEEDED");
  });
});

async function replayReport(cb: { body: string }) {
  const e = JSON.parse(cb.body);
  return {
    reference: e.reference as string, destinationKey: e.destinationKey as string, currencyCode: e.currencyCode as string, settledAt: new Date(e.settledAt), grossMinor: BigInt(e.grossMinor), feeMinor: BigInt(e.feeMinor), netMinor: BigInt(e.netMinor),
    lines: (e.lines as { externalRef: string; grossMinor: string; feeMinor: string }[]).map((l) => ({ externalRef: l.externalRef, grossMinor: BigInt(l.grossMinor), feeMinor: BigInt(l.feeMinor) })),
  };
}
void SIM_SECRET;
