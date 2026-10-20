import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder } from "./helpers/store.js";
import { AdapterRegistry } from "../src/payments/adapter.js";
import { SimulatorAdapter } from "../src/payments/simulatorAdapter.js";
import { PHONE, billingWorld, makeSlBusiness, publishedPlan, seedSierraLeone } from "./helpers/billing.js";
import { DAY_MS, setBillingConfig, type BillingConfig } from "../src/domain/subscriptions/common.js";
import type { PawaPayFake } from "./helpers/pawapayFake.js";
import { EntitlementError, assertEntitled, getEntitlement, PREMIUM_OPERATIONS, SERVICING_OPERATIONS } from "../src/domain/subscriptions/entitlements.js";
import { startRenewal } from "../src/domain/subscriptions/renewal.js";
import { applyBillingDeposit, applyBillingRefund, reconcileBilling, refundHeldBillingPayment, refundSubscriptionCharge } from "../src/domain/subscriptions/collection.js";
import { getEffectivePlan } from "../src/domain/billing.js";
import { createPurchaseOrder } from "../src/domain/trade/orders.js";
import { updateStorefront } from "../src/domain/store/storefront.js";
import { confirmStoreOrder, completeStoreOrder, loadStoreOrder, markStoreOrderReady } from "../src/domain/store/orders.js";
import { startPaymentAttempt } from "../src/domain/merchantPayments/intents.js";
import { registerConnection } from "../src/domain/merchantPayments/intents.js";
import { PaymentPurposeForbiddenError } from "../src/domain/paymentPurpose.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let fake: PawaPayFake;
let cfg: BillingConfig;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  await seedSierraLeone(prisma);
  ({ fake, cfg } = await billingWorld(prisma));
}, 60_000);
afterAll(async () => {
  setBillingConfig(null);
  await testDb.teardown();
});

const D0 = new Date("2026-11-01T10:00:00Z");
const at = (days: number) => new Date(D0.getTime() + days * DAY_MS);
type Biz = Awaited<ReturnType<typeof makeSlBusiness>>;

async function paidBusiness(opts: { flags?: string[]; planCode?: string; features?: string[]; graceDays?: number; now?: Date } = {}) {
  await publishedPlan(prisma, opts.planCode ?? "STARTER", { ...(opts.features ? { features: opts.features } : {}), ...(opts.graceDays !== undefined ? { graceDays: opts.graceDays } : {}) });
  const b = await makeSlBusiness(prisma, { flags: opts.flags ?? ["pawapayBilling", "subscriptionEntitlements", "tradeOrders"] });
  const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: opts.planCode ?? "STARTER", now: opts.now ?? D0 });
  fake.complete(s.depositId);
  await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", opts.now ?? D0);
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { reference: s.invoiceReference } });
  return { b, s, invoice };
}
const tryTrade = (b: Biz, now: Date) => createPurchaseOrder(prisma, { businessId: b.businessId, partnerId: "no-such-partner", currencyCode: "SLE", lines: [], now }).catch((e) => e);

describe("scenario 16: the entitlement matrix", () => {
  it("ACTIVE and GRACE allow plan-authorised operations; EXPIRED restricts new premium ones with a message pointing to renewal; FREE lacks the feature", async () => {
    const { b } = await paidBusiness();
    const state = async (d: number) => (await getEntitlement(b.scoped, b.businessId, at(d))).state;
    expect(await state(10)).toBe("ACTIVE");
    expect(await state(31)).toBe("GRACE"); // the period ended at day 30; three days of grace
    expect(await state(33.5)).toBe("EXPIRED");
    expect((await getEntitlement(b.scoped, b.businessId, at(31))).planCode).toBe("STARTER"); // the SAME entitlements continue in grace

    expect(await tryTrade(b, at(10))).toMatchObject({ code: "NOT_FOUND" }); // got past the entitlement gate: refused only because the partner does not exist
    expect(await tryTrade(b, at(31))).toMatchObject({ code: "NOT_FOUND" });
    const expired = await tryTrade(b, at(40));
    expect(expired).toBeInstanceOf(EntitlementError);
    expect(expired).toMatchObject({ code: "SUBSCRIPTION_EXPIRED" });
    expect(expired.message).toContain("/renew");
    expect(expired.message).toContain("untouched"); // says what is NOT affected

    const free = await makeSlBusiness(prisma, { flags: ["subscriptionEntitlements", "tradeOrders"] });
    expect((await getEntitlement(free.scoped, free.businessId, D0)).state).toBe("FREE");
    expect(await tryTrade(free, D0)).toMatchObject({ code: "NOT_IN_PLAN" });
    // a plan version that does not list the feature
    const narrow = await paidBusiness({ planCode: "PRO", features: ["storefront"] });
    expect(await tryTrade(narrow.b, at(1))).toMatchObject({ code: "NOT_IN_PLAN" });
    await expect(assertEntitled(narrow.b.scoped, narrow.b.businessId, "store.open", at(1))).resolves.toBeUndefined();
    expect(Object.keys(PREMIUM_OPERATIONS).length).toBeGreaterThanOrEqual(4);
  });

  it("enforcement is off unless the business has the flag: with it off nothing changes, even for an expired subscription", async () => {
    const { b } = await paidBusiness({ flags: ["pawapayBilling", "tradeOrders"] });
    expect(await tryTrade(b, at(200))).toMatchObject({ code: "NOT_FOUND" });
    expect((await getEffectivePlan(b.scoped, b.businessId, at(200))).code).toBe("FREE"); // the legacy read-time rule, untouched
  });

  it("the entitlement flag changes the plan caps the existing quota code sees: grace keeps the paid plan, expiry returns the FREE caps", async () => {
    const { b } = await paidBusiness();
    await prisma.planVersion.findFirstOrThrow({ where: { planCode: "STARTER" } });
    expect((await getEffectivePlan(b.scoped, b.businessId, at(10))).code).toBe("STARTER");
    expect((await getEffectivePlan(b.scoped, b.businessId, at(31))).code).toBe("STARTER"); // grace
    const after = await getEffectivePlan(b.scoped, b.businessId, at(40));
    expect(after).toMatchObject({ code: "FREE", entryCapPerMonth: 50 });
  });

  it("a security suspension is a separate state with its own message, and paying does not lift it", async () => {
    const { b, s } = await paidBusiness();
    await prisma.business.update({ where: { id: b.businessId }, data: { status: "SUSPENDED" } });
    expect((await getEntitlement(b.scoped, b.businessId, at(5))).state).toBe("SECURITY_SUSPENDED");
    const err = await tryTrade(b, at(5));
    expect(err).toMatchObject({ code: "SECURITY_SUSPENDED" });
    expect(err.message).toContain("suspended by TradePal");
    expect(err.message).not.toContain("/renew"); // never confused with an ordinary expiry
    // pay again while suspended: the period is recorded (it was paid for) but the suspension stands
    const again = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, now: at(20) });
    fake.complete(again.depositId);
    await applyBillingDeposit(prisma, cfg, again.depositId, "CALLBACK", at(20));
    expect((await getEntitlement(b.scoped, b.businessId, at(21))).state).toBe("SECURITY_SUSPENDED");
    await prisma.business.update({ where: { id: b.businessId }, data: { status: "ACTIVE" } });
    expect((await getEntitlement(b.scoped, b.businessId, at(21))).state).toBe("ACTIVE");
    void s;
  });

  it("EXPIRY never stops servicing: callbacks and status checks, existing orders, closing a shop, renewal and historical data all keep working", async () => {
    // (1) a charge that already exists still completes after the subscription expired AND with new charges switched off everywhere
    const { b } = await paidBusiness();
    const lateRenewal = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, now: at(45) }); // renewal itself works while expired
    await enableFlag(prisma, b.businessId, "pawapayBilling", false);
    await prisma.billingSwitch.update({ where: { provider_countryCode_purpose: { provider: "pawapay", countryCode: "SL", purpose: "PLATFORM_SUBSCRIPTION" } }, data: { newAttemptsEnabled: false } });
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, now: at(46) })).rejects.toMatchObject({ code: expect.stringMatching(/NOT_AVAILABLE|SWITCHED_OFF|ATTEMPT_ACTIVE/) });
    fake.complete(lateRenewal.depositId);
    expect(await applyBillingDeposit(prisma, cfg, lateRenewal.depositId, "CALLBACK", at(47))).toBe("GRANTED"); // servicing is a separate control from new charges
    expect((await getEntitlement(b.scoped, b.businessId, at(48))).state).toBe("ACTIVE");
    await prisma.billingSwitch.update({ where: { provider_countryCode_purpose: { provider: "pawapay", countryCode: "SL", purpose: "PLATFORM_SUBSCRIPTION" } }, data: { newAttemptsEnabled: true } });

    // (2) a consumer shop whose subscription has expired: shoppers still order, the seller still fulfils, closing still works, re-opening is the premium step
    const seller = await makeSeller(prisma, "Expired Shop", { slug: "expired-shop" });
    await enableFlag(prisma, seller.businessId, "subscriptionEntitlements");
    await seller.scoped.subscription.create({ data: { businessId: seller.businessId, planCode: "STARTER", status: "ACTIVE", currentPeriodStart: at(-60), currentPeriodEnd: at(-30) } });
    expect((await getEntitlement(seller.scoped, seller.businessId, at(0))).state).toBe("EXPIRED");
    const placed = await placeStoreOrder(prisma, seller, { qty: 2 }); // a shopper checking out
    await confirmStoreOrder(prisma, { businessId: seller.businessId, orderId: placed.order.id });
    await markStoreOrderReady(prisma, { businessId: seller.businessId, orderId: placed.order.id });
    await completeStoreOrder(prisma, { businessId: seller.businessId, orderId: placed.order.id, code: (await loadStoreOrder(seller.scoped, placed.order.id)).pickupCode, collect: { method: "CASH" } });
    expect((await loadStoreOrder(seller.scoped, placed.order.id)).status).toBe("COMPLETED");
    await updateStorefront(prisma, seller.businessId, { enabled: false }); // closing is never restricted
    await expect(updateStorefront(prisma, seller.businessId, { enabled: true })).rejects.toBeInstanceOf(EntitlementError); // re-opening a shop is a new premium operation
    expect(await seller.scoped.storeOrder.count()).toBe(1); // history intact and readable

    // (3) the documented servicing list is exactly the set of things this file proves; none of them is a premium operation
    for (const op of SERVICING_OPERATIONS) expect(Object.keys(PREMIUM_OPERATIONS)).not.toContain(op);
    expect(SERVICING_OPERATIONS).toEqual(expect.arrayContaining(["payments.callbacks", "payments.reconciliation", "refunds.authorised", "data.export", "billing.renew"]));
  });
});

describe("refunds of subscription charges", () => {
  it("are authorised and audited, bounded by what was paid, one at a time, and only move the invoice when pawaPay confirms", async () => {
    const { b, invoice } = await paidBusiness();
    const refund = (amount: bigint | undefined, extra: Partial<Parameters<typeof refundSubscriptionCharge>[1]> = {}) =>
      refundSubscriptionCharge(prisma, { invoiceId: invoice.id, ...(amount !== undefined ? { amountMinor: amount } : {}), reason: "Charged twice by mistake", adminUserId: "admin-1", now: at(2), ...extra });
    await expect(refund(100_000n, { reason: "short" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(refund(600_000n)).rejects.toMatchObject({ code: "REFUND_LIMIT" });
    await expect(refund(0n)).rejects.toMatchObject({ code: "REFUND_LIMIT" });

    fake.refundFinal = "PROCESSING";
    const r1 = await refund(100_000n);
    expect(r1.status).toBe("ACCEPTED");
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "PAID", refundedMinor: 100_000n }); // reserved, not yet confirmed
    await expect(refund(50_000n)).rejects.toMatchObject({ code: "REFUND_IN_PROGRESS" }); // pawaPay allows one refund at a time per deposit
    expect(await applyBillingRefund(prisma, cfg, r1.id, at(2))).toBe("PENDING");
    fake.refunds.get(r1.id)!.status = "COMPLETED";
    expect(await applyBillingRefund(prisma, cfg, r1.id, at(2))).toBe("COMPLETED");
    expect(await applyBillingRefund(prisma, cfg, r1.id, at(2))).toBe("NOOP"); // a replay changes nothing
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedMinor: 100_000n });
    expect((await getEntitlement(b.scoped, b.businessId, at(3))).state).toBe("ACTIVE"); // a partial refund never revokes service

    fake.refundFinal = "COMPLETED";
    await expect(refund(450_000n)).rejects.toMatchObject({ code: "REFUND_LIMIT" }); // 400,000 remain
    const r2 = await refund(undefined);
    expect(await applyBillingRefund(prisma, cfg, r2.id, at(3))).toBe("COMPLETED");
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "REFUNDED", refundedMinor: 500_000n });
    await expect(refund(1n)).rejects.toMatchObject({ code: "NOT_REFUNDABLE" });
    expect((await getEntitlement(b.scoped, b.businessId, at(3))).state).toBe("ACTIVE"); // still: refunding is not revoking
    const audits = await b.scoped.auditLog.findMany({ where: { action: { in: ["SUBSCRIPTION_REFUND_REQUESTED", "SUBSCRIPTION_REFUND_COMPLETED"] } } });
    expect(audits.filter((a) => a.action === "SUBSCRIPTION_REFUND_REQUESTED").every((a) => a.actorId === "admin-1")).toBe(true);
    expect(audits).toHaveLength(4);
    // a refunded invoice can never be paid again, and a paid one can never go back to unpaid (database)
    await expect(testDb.db.query(`UPDATE "Invoice" SET "status"='PAID' WHERE id='${invoice.id}'`)).rejects.toThrow(/refunded invoice cannot become/);
    await expect(testDb.db.query(`UPDATE "Invoice" SET "refundedMinor" = "paidMinor" + 1 WHERE id='${invoice.id}'`)).rejects.toThrow(/check/i);
  });

  it("a rejected or lost refund releases the reserved funds and raises an exception; an unknown outcome is checked, never assumed", async () => {
    const { invoice } = await paidBusiness();
    const refund = (amount: bigint) => refundSubscriptionCharge(prisma, { invoiceId: invoice.id, amountMinor: amount, reason: "Customer asked for it back", adminUserId: "admin-1", now: at(2) });
    fake.nextRefund = "reject";
    await expect(refund(100_000n)).rejects.toMatchObject({ code: "REJECTED" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedMinor).toBe(0n);
    expect(await prisma.billingException.count({ where: { type: "REFUND_FAILED", invoiceId: invoice.id } })).toBe(1);

    fake.nextRefund = "lose"; // pawaPay recorded it but we never saw the answer
    const lost = await refund(100_000n).catch((e) => e);
    expect(lost).toMatchObject({ code: "UNCONFIRMED" });
    const row = await prisma.billingRefund.findFirstOrThrow({ where: { invoiceId: invoice.id, status: "REQUESTED" } });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedMinor).toBe(100_000n); // funds stay reserved until we know
    expect(await applyBillingRefund(prisma, cfg, row.id, at(3))).toBe("COMPLETED"); // the lookup found it

    // one that pawaPay never saw: NOT_FOUND is the only proof it did not happen
    fake.nextRefund = "lose";
    await refund(50_000n).catch(() => undefined);
    const ghost = await prisma.billingRefund.findFirstOrThrow({ where: { invoiceId: invoice.id, status: "REQUESTED" } });
    fake.refunds.delete(ghost.id);
    expect(await applyBillingRefund(prisma, cfg, ghost.id, at(3))).toBe("FAILED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedMinor).toBe(100_000n); // released
    fake.refundFinal = "FAILED";
    const failed = await refund(60_000n);
    expect(await applyBillingRefund(prisma, cfg, failed.id, at(3))).toBe("FAILED"); // provider-reported failure
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedMinor).toBe(100_000n);
    fake.refundFinal = "COMPLETED";
  });

  it("a payment pawaPay collected but that was never applied (a duplicate) can be given back, in part or in full, without touching the invoice", async () => {
    const { b, invoice } = await paidBusiness();
    const dup = crypto.randomUUID();
    await b.scoped.billingAttempt.createMany({ data: [{ id: dup, businessId: b.businessId, invoiceId: invoice.id, environment: "SANDBOX", providerCode: "ORANGE_SLE", amountMinor: 500_000n, currencyCode: "SLE", status: "ACCEPTED" }] });
    fake.deposits.set(dup, { depositId: dup, amount: "5000.00", currency: "SLE", provider: "ORANGE_SLE", phone: PHONE, status: "COMPLETED", providerTransactionId: "dup-1", refunds: [] });
    expect(await applyBillingDeposit(prisma, cfg, dup, "CALLBACK", at(1))).toBe("HELD");
    const give = (amount: bigint | undefined, reason = "Duplicate payment, returning it") => refundHeldBillingPayment(prisma, { attemptId: dup, ...(amount !== undefined ? { amountMinor: amount } : {}), reason, adminUserId: "admin-1", now: at(2) });
    await expect(give(100_000n, "short")).rejects.toMatchObject({ code: "INVALID" });
    await expect(give(600_000n)).rejects.toMatchObject({ code: "REFUND_LIMIT" });
    const r1 = await give(200_000n);
    expect(await applyBillingRefund(prisma, cfg, r1.id, at(2))).toBe("COMPLETED");
    expect(await prisma.billingException.findFirstOrThrow({ where: { attemptId: dup, type: "DUPLICATE_PAYMENT" } })).toMatchObject({ status: "OPEN" }); // only part has gone back
    fake.refundFinal = "FAILED";
    const bad = await give(100_000n);
    expect(await applyBillingRefund(prisma, cfg, bad.id, at(2))).toBe("FAILED");
    expect((await prisma.billingAttempt.findUniqueOrThrow({ where: { id: dup } })).refundedMinor).toBe(200_000n); // the failed one released its funds
    fake.refundFinal = "COMPLETED";
    const r2 = await give(undefined);
    expect(await applyBillingRefund(prisma, cfg, r2.id, at(3))).toBe("COMPLETED");
    expect(await prisma.billingException.findFirstOrThrow({ where: { attemptId: dup, type: "DUPLICATE_PAYMENT" } })).toMatchObject({ status: "RESOLVED", resolution: expect.stringContaining("REFUNDED") });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "PAID", paidMinor: 500_000n, refundedMinor: 0n }); // the invoice that was legitimately paid is untouched
    expect((await getEntitlement(b.scoped, b.businessId, at(3))).state).toBe("ACTIVE");
    await expect(give(1n)).rejects.toMatchObject({ code: "REFUND_LIMIT" });
    // the payment that WAS applied is refunded through its invoice, not this way
    const applied = await b.scoped.billingAttempt.findFirstOrThrow({ where: { id: { not: dup } } });
    await expect(refundHeldBillingPayment(prisma, { attemptId: applied.id, reason: "Trying the wrong door", adminUserId: "a", now: at(3) })).rejects.toMatchObject({ code: "NOT_REFUNDABLE" });
    expect(await prisma.auditLog.count({ where: { action: "SUBSCRIPTION_HELD_PAYMENT_REFUND_COMPLETED", entityId: invoice.id } })).toBe(2);
    await expect(testDb.db.query(`UPDATE "BillingAttempt" SET "refundedMinor" = "capturedMinor" + 1 WHERE id='${dup}'`)).rejects.toThrow(/check/i);
  });

  it("revoking entitlement is an explicit choice on a full refund; refunds are for subscription charges only", async () => {
    const { b, invoice } = await paidBusiness();
    const r = await refundSubscriptionCharge(prisma, { invoiceId: invoice.id, reason: "Cancelled within the hour", adminUserId: "admin-2", revokeEntitlement: true, now: at(1) });
    await applyBillingRefund(prisma, cfg, r.id, at(1));
    expect((await getEntitlement(b.scoped, b.businessId, at(1.5))).state).not.toBe("ACTIVE");
    expect(await b.scoped.entitlementEvent.findFirstOrThrow({ where: { kind: "REFUND_REVOKED" } })).toMatchObject({ adminUserId: "admin-2", reason: "Cancelled within the hour" });

    const other = await paidBusiness();
    await prisma.invoice.update({ where: { id: other.invoice.id }, data: { purpose: "MERCHANT_SALE" } });
    await expect(refundSubscriptionCharge(prisma, { invoiceId: other.invoice.id, reason: "Not a subscription charge", adminUserId: "a", now: at(1) })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const unpaid = await makeSlBusiness(prisma);
    const s = await startRenewal(prisma, { businessId: unpaid.businessId, merchantId: unpaid.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 });
    const inv = await prisma.invoice.findFirstOrThrow({ where: { reference: s.invoiceReference } });
    await expect(refundSubscriptionCharge(prisma, { invoiceId: inv.id, reason: "Nothing was paid yet", adminUserId: "a", now: at(1) })).rejects.toMatchObject({ code: "NOT_REFUNDABLE" });
  });
});

describe("billing money never enters a merchant's ledger, and merchant routes cannot reach pawaPay", () => {
  it("a full paid and refunded subscription creates no journal, store, trade or merchant-payment record", async () => {
    const { b, invoice } = await paidBusiness({ flags: ["pawapayBilling", "accountingJournals", "stockV2"] });
    const r = await refundSubscriptionCharge(prisma, { invoiceId: invoice.id, amountMinor: 100_000n, reason: "Partial goodwill refund", adminUserId: "admin-1", now: at(1) });
    await applyBillingRefund(prisma, cfg, r.id, at(1));
    await reconcileBilling(prisma, at(2));
    expect(await b.scoped.journalEntry.count()).toBe(0);
    expect(await b.scoped.journalLine.count()).toBe(0);
    expect(await b.scoped.storePayment.count()).toBe(0);
    expect(await b.scoped.tradePayment.count()).toBe(0);
    expect(await b.scoped.paymentIntent.count()).toBe(0);
    expect(await b.scoped.providerRefund.count()).toBe(0);
    expect(await b.scoped.providerSettlement.count()).toBe(0);
    expect(await b.scoped.transaction.count()).toBe(0);
    expect(invoice.purpose).toBe("PLATFORM_SUBSCRIPTION");
  });

  it("the merchant adapter registry has no pawaPay; a merchant connection to it is refused in code, and billing switches and intents are refused for merchant sales in the database", async () => {
    const seller = await makeSeller(prisma, "Boundary Shop", { slug: "boundary-shop" });
    const registry = new AdapterRegistry().register(new SimulatorAdapter(prisma, "x".repeat(16)));
    expect(registry.has("pawapay")).toBe(false);
    await expect(registerConnection(prisma, { businessId: seller.businessId, provider: "pawapay", arrangementRef: "a", destinationKey: "b", destinationLabel: "c" })).rejects.toBeInstanceOf(PaymentPurposeForbiddenError);
    await expect(startPaymentAttempt(prisma, registry, { businessId: seller.businessId, intentId: "any", provider: "pawapay" })).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|NO_CONNECTION/) });
    await expect(testDb.db.query(`INSERT INTO "BillingSwitch" ("id","provider","countryCode","purpose","newAttemptsEnabled","updatedAt") VALUES ('x','pawapay','NG','MERCHANT_SALE',true,now())`)).rejects.toThrow(/BillingSwitch_purpose_check|check constraint/);
    // and a billing callback body that names a merchant order is just an unknown deposit: nothing to apply it to
    expect(await applyBillingDeposit(prisma, cfg, crypto.randomUUID(), "CALLBACK", at(1))).toBe("UNKNOWN_DEPOSIT");
  });
});
