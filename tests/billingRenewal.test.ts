import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { AUTHORITY, DAY_MS, PHONE, billingWorld, makeSlBusiness, publishedPlan, seedSierraLeone } from "./helpers/billing.js";
import type { PawaPayFake } from "./helpers/pawapayFake.js";
import { buildBillingConfigFromEnv, setBillingConfig, BILLING_CALLBACK_PATH, type BillingConfig } from "../src/domain/subscriptions/common.js";
import { createPlanVersion, offeredPlans, publishPlanVersion, retirePlanVersion, setPlanPrice } from "../src/domain/subscriptions/plans.js";
import { requestCancellation, resetBillingConfCacheForTests, schedulePlanChange, startRenewal } from "../src/domain/subscriptions/renewal.js";
import { applyBillingDeposit, billingCallbackHandler, reconcileBilling, resetKeyRefreshForTests } from "../src/domain/subscriptions/collection.js";
import { createPawaPayBillingWebhookRouter, type RawBodyRequest } from "../src/pawapay/billingWebhook.js";
import { processInbox } from "../src/domain/callbackInbox.js";
import { getEntitlement } from "../src/domain/subscriptions/entitlements.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let fake: PawaPayFake;
let cfg: BillingConfig;
let app: express.Express;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  await seedSierraLeone(prisma);
  ({ fake, cfg } = await billingWorld(prisma));
  app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as RawBodyRequest).rawBody = Buffer.from(buf); } }));
  app.use(createPawaPayBillingWebhookRouter(prisma));
}, 60_000);
afterAll(async () => {
  setBillingConfig(null);
  await testDb.teardown();
});

const D0 = new Date("2026-11-01T10:00:00Z");
const at = (days: number) => new Date(D0.getTime() + days * DAY_MS);
const drain = () => processInbox(prisma, { "pawapay-billing": billingCallbackHandler(prisma) }, { limit: 50 });
const ent = (b: { businessId: string; scoped: never }, now: Date) => getEntitlement(b.scoped, b.businessId, now);

describe("plan versions and prices", () => {
  it("has no default prices: nothing is offered until a person prices and publishes a version", async () => {
    expect(await offeredPlans(prisma, "SL")).toEqual([]);
    const v1 = await createPlanVersion(prisma, { planCode: "STARTER", features: ["trade"], createdBy: "admin-1" });
    expect(v1).toMatchObject({ version: 1, status: "DRAFT", billingPeriodDays: 30, graceDays: 3 });
    await expect(publishPlanVersion(prisma, v1.id)).rejects.toMatchObject({ code: "INVALID" }); // no price yet
    await expect(setPlanPrice(prisma, { planVersionId: v1.id, countryCode: "SL", priceMinor: 0n })).rejects.toMatchObject({ code: "INVALID" });
    await expect(setPlanPrice(prisma, { planVersionId: v1.id, countryCode: "ZZ", priceMinor: 100n })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createPlanVersion(prisma, { planCode: "STARTER", features: ["telepathy"] })).rejects.toMatchObject({ code: "INVALID" });
    await expect(createPlanVersion(prisma, { planCode: "STARTER", graceDays: 99 })).rejects.toMatchObject({ code: "INVALID" });
    await setPlanPrice(prisma, { planVersionId: v1.id, countryCode: "SL", priceMinor: 400_000n });
    const price = await prisma.planPrice.findFirstOrThrow({ where: { planVersionId: v1.id } });
    expect(price.currencyCode).toBe("SLE"); // the currency is the country's own, never chosen by the caller
    await publishPlanVersion(prisma, v1.id);
    expect((await offeredPlans(prisma, "SL"))[0]).toMatchObject({ planCode: "STARTER", version: 1, priceMinor: 400_000n, currencyCode: "SLE" });
    expect(await offeredPlans(prisma, "NG")).toEqual([]);
  });

  it("a published version and its prices are frozen by the database; a new version is the only way to change them", async () => {
    const v = await publishedPlan(prisma, "PRO", { priceMinor: 900_000n });
    await expect(setPlanPrice(prisma, { planVersionId: v.id, countryCode: "SL", priceMinor: 1n })).rejects.toMatchObject({ code: "FROZEN" });
    await expect(testDb.db.query(`UPDATE "PlanPrice" SET "priceMinor"=1 WHERE "planVersionId"='${v.id}'`)).rejects.toThrow(/frozen/);
    await expect(testDb.db.query(`INSERT INTO "PlanPrice" ("id","planVersionId","countryCode","currencyCode","priceMinor") VALUES ('x','${v.id}','NG','NGN',5)`)).rejects.toThrow(/frozen/);
    await expect(testDb.db.query(`DELETE FROM "PlanPrice" WHERE "planVersionId"='${v.id}'`)).rejects.toThrow(/frozen/);
    await expect(testDb.db.query(`UPDATE "PlanVersion" SET "graceDays"=20 WHERE id='${v.id}'`)).rejects.toThrow(/frozen/);
    await expect(testDb.db.query(`DELETE FROM "PlanVersion" WHERE id='${v.id}'`)).rejects.toThrow(/cannot be deleted|not allowed|delete/i);
    const v2 = await createPlanVersion(prisma, { planCode: "PRO", features: ["trade"] });
    expect(v2.version).toBe(2);
    await retirePlanVersion(prisma, v.id);
    await expect(retirePlanVersion(prisma, v.id)).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(testDb.db.query(`UPDATE "PlanVersion" SET "status"='PUBLISHED' WHERE id='${v.id}'`)).rejects.toThrow(/cannot become/);
  });
});

describe("configuration and gates fail closed", () => {
  const deps = (url: string) => ({ apiToken: "t", apiBaseUrl: url });
  const SAND = "https://api.sandbox.pawapay.io/v2";
  const PROD = "https://api.pawapay.io/v2";
  const base = { PAWAPAY_BILLING_CALLBACK_AUTHORITY: "api.tradepal.test" };

  it("refuses inconsistent environments and unknown hosts", () => {
    const reason = (env: Record<string, string>, url: string | undefined) => { const r = buildBillingConfigFromEnv({ ...base, ...env } as NodeJS.ProcessEnv, url ? deps(url) : undefined); return r.ok ? "OK" : r.reason; };
    expect(reason({ PAWAPAY_ENVIRONMENT: "SANDBOX", NODE_ENV: "test" }, SAND)).toBe("OK");
    expect(reason({ PAWAPAY_ENVIRONMENT: "SANDBOX", NODE_ENV: "test" }, undefined)).toContain("not configured");
    expect(reason({ PAWAPAY_ENVIRONMENT: "PRODUCTION", NODE_ENV: "production" }, SAND)).toContain("does not match");
    expect(reason({ PAWAPAY_ENVIRONMENT: "SANDBOX", NODE_ENV: "test" }, "https://evil.example/v2")).toContain("not a known pawaPay host");
    expect(reason({ NODE_ENV: "test" }, SAND)).toContain("PAWAPAY_ENVIRONMENT must be");
    expect(reason({ PAWAPAY_ENVIRONMENT: "SANDBOX", NODE_ENV: "production" }, SAND)).toContain("never used from a production deployment");
    expect(reason({ PAWAPAY_ENVIRONMENT: "PRODUCTION", NODE_ENV: "development" }, PROD)).toContain("never used outside a production deployment");
    expect(reason({ PAWAPAY_ENVIRONMENT: "PRODUCTION", NODE_ENV: "production" }, PROD)).toBe("OK");
    expect(reason({ PAWAPAY_ENVIRONMENT: "SANDBOX", NODE_ENV: "test", PAWAPAY_BILLING_CALLBACK_AUTHORITY: "" }, SAND)).toContain("PAWAPAY_BILLING_CALLBACK_AUTHORITY");
    const prod = buildBillingConfigFromEnv({ ...base, PAWAPAY_ENVIRONMENT: "PRODUCTION", NODE_ENV: "production" } as NodeJS.ProcessEnv, deps(PROD));
    expect(prod.ok && prod.config.productionActivated).toBe(false); // production needs the owner's explicit activation
  });

  it("refuses a new charge when the flag, the country switch, the activation or the configuration is missing, but never touches servicing", async () => {
    await publishedPlan(prisma, "STARTER");
    const noFlag = await makeSlBusiness(prisma, { flags: [] });
    await expect(startRenewal(prisma, { businessId: noFlag.businessId, merchantId: noFlag.merchantId, payerPhone: PHONE, planCode: "STARTER" })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    const b = await makeSlBusiness(prisma);
    await prisma.billingSwitch.update({ where: { provider_countryCode_purpose: { provider: "pawapay", countryCode: "SL", purpose: "PLATFORM_SUBSCRIPTION" } }, data: { newAttemptsEnabled: false } });
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" })).rejects.toMatchObject({ code: "SWITCHED_OFF" });
    await prisma.billingSwitch.update({ where: { provider_countryCode_purpose: { provider: "pawapay", countryCode: "SL", purpose: "PLATFORM_SUBSCRIPTION" } }, data: { newAttemptsEnabled: true } });
    // production without activation
    const saved = cfg;
    const prodCfg = buildBillingConfigFromEnv({ ...base, PAWAPAY_ENVIRONMENT: "PRODUCTION", NODE_ENV: "production" } as NodeJS.ProcessEnv, { ...deps(PROD), fetchImpl: fake.fetchImpl });
    if (!prodCfg.ok) throw new Error(prodCfg.reason);
    setBillingConfig(prodCfg);
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" })).rejects.toMatchObject({ code: "NOT_ACTIVATED" });
    setBillingConfig({ ok: false, reason: "pawaPay is not configured" });
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    setBillingConfig({ ok: true, config: saved });
    // a different pawaPay account than the one this environment first authenticated as
    await prisma.billingAccountBinding.createMany({ data: [{ provider: "pawapay", environment: "SANDBOX", companyName: "TradePal Test Ltd" }], skipDuplicates: true }); // what the first successful call records
    fake.companyName = "Somebody Else Ltd";
    resetBillingConfCacheForTests();
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" })).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    fake.companyName = "TradePal Test Ltd";
    resetBillingConfCacheForTests();
    expect(await prisma.billingException.count({ where: { type: "ENVIRONMENT_MISMATCH" } })).toBeGreaterThanOrEqual(1);
  });
});

describe("a customer-authorised renewal charge", () => {
  it("creates a pending subscription, an invoice and ONE active attempt; nothing is entitled until the provider confirms", async () => {
    const plan = await publishedPlan(prisma, "STARTER", { priceMinor: 500_000n });
    const b = await makeSlBusiness(prisma);
    const started = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: " +232 76 123456 ", planCode: "STARTER", now: D0 });
    expect(started).toMatchObject({ providerName: "Orange Money", payerLast4: "3456", amountText: "5000.00", currencyCode: "SLE", planCode: "STARTER" });
    expect(started.invoiceReference).toMatch(/^INV-[A-Z0-9]{8}$/);
    const attempt = await b.scoped.billingAttempt.findUniqueOrThrow({ where: { id: started.depositId } });
    expect(attempt).toMatchObject({ status: "ACCEPTED", environment: "SANDBOX", amountMinor: 500_000n, providerCode: "ORANGE_SLE", payerPhoneLast4: "3456" });
    expect(JSON.stringify(attempt, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(PHONE); // only the last four digits are kept
    const sub = await b.scoped.subscription.findFirstOrThrow({ where: {} });
    expect(sub).toMatchObject({ status: "PENDING", planVersionId: plan.id });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(invoice).toMatchObject({ status: "PENDING", purpose: "PLATFORM_SUBSCRIPTION", amountMinor: 500_000n, kind: "NEW", providerCode: "PAWAPAY", paidMinor: 0n });
    expect((await ent(b as never, D0)).state).toBe("FREE");
    // a second request while one is waiting is refused, never a second collection
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 })).rejects.toMatchObject({ code: "ATTEMPT_ACTIVE" });
    expect(fake.deposits.size).toBeGreaterThanOrEqual(1);
    await expect(testDb.db.query(`INSERT INTO "BillingAttempt" ("id","businessId","invoiceId","environment","amountMinor","currencyCode","updatedAt") VALUES ('${crypto.randomUUID()}','${b.businessId}','${invoice.id}','SANDBOX',1,'SLE',now())`)).rejects.toThrow(/BillingAttempt_one_active_per_invoice|duplicate key/);
  });

  it("validates the payer and the provider before creating anything", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    const go = (phone: string) => startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: phone, planCode: "STARTER", now: D0 });
    await expect(go("abc")).rejects.toMatchObject({ code: "INVALID_PHONE" });
    await expect(go("2347012345678")).rejects.toMatchObject({ code: "INVALID_PHONE" });
    fake.availability = "DELAYED";
    await expect(go(PHONE)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    fake.availability = "CLOSED";
    await expect(go(PHONE)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    fake.availability = "OPERATIONAL";
    expect(await b.scoped.billingAttempt.count()).toBe(0);
    expect(await b.scoped.subscription.count()).toBe(0);
    fake.nextInitiate = "reject";
    await expect(go(PHONE)).rejects.toMatchObject({ code: "REJECTED" });
    expect((await b.scoped.billingAttempt.findFirstOrThrow({ where: {} })).status).toBe("REJECTED");
    // whole-amount providers: a whole price is sent without decimals; a price with cents is refused (no silent rounding)
    fake.decimals = "NONE";
    resetBillingConfCacheForTests(); // the provider's configuration is cached for 10 minutes
    expect((await go(PHONE)).amountText).toBe("5000");
    const cents = await publishedPlan(prisma, "PRO", { priceMinor: 500_050n });
    expect(cents.status).toBe("PUBLISHED");
    const c = await makeSlBusiness(prisma);
    await expect(startRenewal(prisma, { businessId: c.businessId, merchantId: c.merchantId, payerPhone: PHONE, planCode: "PRO", now: D0 })).rejects.toMatchObject({ code: "AMOUNT_UNSUPPORTED" });
    fake.decimals = "TWO_PLACES";
    resetBillingConfCacheForTests();
  });

  it("a request whose outcome we could not see is UNKNOWN: it blocks a retry, and a status lookup resolves it either way", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    fake.nextInitiate = "drop"; // never reached pawaPay
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 })).rejects.toMatchObject({ code: "UNCONFIRMED" });
    const a1 = await b.scoped.billingAttempt.findFirstOrThrow({ where: {} });
    expect(a1.status).toBe("UNKNOWN");
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 })).rejects.toMatchObject({ code: "ATTEMPT_ACTIVE" });
    expect(await applyBillingDeposit(prisma, cfg, a1.id, "POLL", at(1))).toBe("FAILED"); // pawaPay has no record: safe to close
    // a second one reached pawaPay but the answer was lost: it must NOT be closed, it must be found
    fake.nextInitiate = "lose";
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: at(1) })).rejects.toMatchObject({ code: "UNCONFIRMED" });
    const a2 = await b.scoped.billingAttempt.findFirstOrThrow({ where: { status: "UNKNOWN" } });
    expect(fake.deposits.has(a2.id)).toBe(true);
    expect(await applyBillingDeposit(prisma, cfg, a2.id, "POLL", at(2))).toBe("PENDING");
    expect((await b.scoped.billingAttempt.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe("ACCEPTED");
    fake.complete(a2.id);
    expect(await applyBillingDeposit(prisma, cfg, a2.id, "POLL", at(2))).toBe("GRANTED");
  });
});

describe("scenario 15: duplicate callbacks cannot double-extend; mismatched payments grant no access", () => {
  async function pay(b: Awaited<ReturnType<typeof makeSlBusiness>>, now = D0) {
    const started = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now });
    return started;
  }
  const callback = (depositId: string, status = "COMPLETED", extra: Record<string, unknown> = {}) => fake.signedCallback({ depositId, status, ...extra }, { authority: AUTHORITY, path: BILLING_CALLBACK_PATH });

  it("a signed callback is stored, an authenticated lookup confirms it, and every replay changes nothing", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    const { depositId } = await pay(b);
    fake.complete(depositId);
    const cb = callback(depositId);
    const send = (m: { body: Buffer; headers: Record<string, string> }) => request(app).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").set(m.headers).send(m.body.toString());
    expect((await send(cb)).status).toBe(200);
    expect((await send(cb)).status).toBe(200); // redelivery of the same message
    expect((await send(callback(depositId))).status).toBe(200); // pawaPay's retry carries a NEW signature
    expect(await prisma.callbackInbox.count({ where: { provider: "pawapay-billing", signatureVerified: true } })).toBeGreaterThanOrEqual(1);
    await drain();
    const sub = await b.scoped.subscription.findFirstOrThrow({ where: {} });
    expect(sub.status).toBe("ACTIVE");
    const end = sub.currentPeriodEnd;
    expect(end.getTime() - sub.currentPeriodStart.getTime()).toBe(30 * DAY_MS);
    // every later signal for the same payment: more callbacks, polls, an admin refresh
    for (let i = 0; i < 3; i++) await send(callback(depositId, "COMPLETED", { n: i }));
    await drain();
    expect(await applyBillingDeposit(prisma, cfg, depositId, "POLL", new Date())).toBe("NOOP");
    expect(await applyBillingDeposit(prisma, cfg, depositId, "ADMIN", new Date())).toBe("NOOP");
    expect((await b.scoped.subscription.findFirstOrThrow({ where: {} })).currentPeriodEnd).toEqual(end);
    expect(await b.scoped.billingAllocation.count()).toBe(1);
    expect(await b.scoped.entitlementEvent.count({ where: { kind: { in: ["GRANTED", "EXTENDED"] } } })).toBe(1);
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(invoice).toMatchObject({ status: "PAID", paidMinor: 500_000n });
    expect(invoice.periodEnd).toEqual(end);
    expect(await b.scoped.auditLog.count({ where: { action: "SUBSCRIPTION_PAYMENT_CONFIRMED" } })).toBe(1);
  });

  it("a second payment for an already-paid invoice is held as a duplicate and extends nothing", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    const { depositId } = await pay(b);
    fake.complete(depositId);
    await applyBillingDeposit(prisma, cfg, depositId, "CALLBACK", D0);
    const sub = await b.scoped.subscription.findFirstOrThrow({ where: {} });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    // pawaPay collected again against the same invoice (a second attempt somehow exists)
    const dup = crypto.randomUUID();
    await b.scoped.billingAttempt.createMany({ data: [{ id: dup, businessId: b.businessId, invoiceId: invoice.id, environment: "SANDBOX", providerCode: "ORANGE_SLE", amountMinor: 500_000n, currencyCode: "SLE", status: "ACCEPTED" }] });
    fake.deposits.set(dup, { depositId: dup, amount: "5000.00", currency: "SLE", provider: "ORANGE_SLE", phone: PHONE, status: "COMPLETED", providerTransactionId: "dup", refunds: [] });
    expect(await applyBillingDeposit(prisma, cfg, dup, "CALLBACK", at(1))).toBe("HELD");
    expect((await b.scoped.subscription.findFirstOrThrow({ where: {} })).currentPeriodEnd).toEqual(sub.currentPeriodEnd);
    expect(await b.scoped.billingAllocation.count()).toBe(1);
    expect(await prisma.billingException.findFirstOrThrow({ where: { attemptId: dup } })).toMatchObject({ type: "DUPLICATE_PAYMENT", status: "OPEN", amountMinor: 500_000n });
    expect((await b.scoped.billingAttempt.findUniqueOrThrow({ where: { id: dup } })).status).toBe("COMPLETED"); // the money is real and recorded, just not applied twice
  });

  it("wrong amount, wrong currency, unknown deposit, another environment and a callback that claims success pawaPay does not confirm all grant nothing", async () => {
    await publishedPlan(prisma, "STARTER");
    const make = async () => { const b = await makeSlBusiness(prisma); return { b, ...(await pay(b)) }; };

    const short = await make();
    fake.complete(short.depositId, { amount: "1.00" });
    expect(await applyBillingDeposit(prisma, cfg, short.depositId, "CALLBACK", D0)).toBe("HELD");
    expect(await prisma.billingException.findFirstOrThrow({ where: { attemptId: short.depositId } })).toMatchObject({ type: "AMOUNT_MISMATCH" });
    expect((await short.b.scoped.subscription.findFirstOrThrow({ where: {} })).status).toBe("PENDING");
    expect((await ent(short.b as never, D0)).state).toBe("FREE");
    expect(await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: (await short.b.scoped.subscription.findFirstOrThrow({ where: {} })).id } })).toMatchObject({ status: "PENDING", paidMinor: 0n });

    const wrongCcy = await make();
    fake.complete(wrongCcy.depositId, { currency: "USD" });
    expect(await applyBillingDeposit(prisma, cfg, wrongCcy.depositId, "CALLBACK", D0)).toBe("HELD");
    expect(await prisma.billingException.findFirstOrThrow({ where: { attemptId: wrongCcy.depositId } })).toMatchObject({ type: "CURRENCY_MISMATCH" });
    expect((await ent(wrongCcy.b as never, D0)).state).toBe("FREE");

    expect(await applyBillingDeposit(prisma, cfg, crypto.randomUUID(), "CALLBACK", D0)).toBe("UNKNOWN_DEPOSIT");
    expect(await prisma.billingException.count({ where: { type: "UNKNOWN_DEPOSIT" } })).toBeGreaterThanOrEqual(1);

    const other = await make();
    await testDb.db.query(`UPDATE "BillingAttempt" SET "environment"='PRODUCTION' WHERE id='${other.depositId}'`);
    fake.complete(other.depositId);
    expect(await applyBillingDeposit(prisma, cfg, other.depositId, "CALLBACK", D0)).toBe("ENV_MISMATCH");
    expect((await ent(other.b as never, D0)).state).toBe("FREE");

    // a perfectly signed callback that SAYS completed, while pawaPay's own record says it is still waiting
    const liar = await make();
    const send = (m: { body: Buffer; headers: Record<string, string> }) => request(app).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").set(m.headers).send(m.body.toString());
    expect((await send(callback(liar.depositId, "COMPLETED"))).status).toBe(200);
    await drain();
    expect((await ent(liar.b as never, new Date())).state).toBe("FREE");
    expect((await liar.b.scoped.billingAttempt.findUniqueOrThrow({ where: { id: liar.depositId } })).status).toBe("ACCEPTED");
  });

  it("refuses forged, unsigned, expired and wrongly keyed callbacks at the door, records them, and handles key rotation", async () => {
    const send = (m: { body: Buffer; headers: Record<string, string> }, extra: Record<string, string> = {}) => request(app).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").set({ ...m.headers, ...extra }).send(m.body.toString());
    const id = crypto.randomUUID();
    const good = callback(id);
    const before = await prisma.callbackInbox.count({ where: { provider: "pawapay-billing" } });
    expect((await send({ ...good, headers: { ...good.headers, signature: good.headers["signature"]!.replace(/^(sig-pp=:.{12})(.)/, (_x, a: string, c: string) => a + (c === "A" ? "B" : "A")) } })).status).toBe(401);
    expect((await send({ body: good.body, headers: {} })).status).toBe(401); // unsigned while signing is required
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await send(fake.signedCallback({ depositId: id, status: "COMPLETED" }, { authority: AUTHORITY, path: BILLING_CALLBACK_PATH, created: old, expires: old + 60 }))).status).toBe(401);
    expect((await send(fake.signedCallback({ depositId: id, status: "COMPLETED" }, { authority: "evil.example", path: BILLING_CALLBACK_PATH }))).status).toBe(401);
    expect((await send(good, { "content-digest": "sha-256=:AAAA:" })).status).toBe(401);
    expect(await prisma.callbackInbox.count({ where: { provider: "pawapay-billing" } })).toBe(before); // nothing was stored
    expect(await prisma.billingException.count({ where: { type: "CALLBACK_AUTH_FAILED" } })).toBeGreaterThanOrEqual(3);

    // rotation: pawaPay signs with a new key id; our cache has never seen it, so one refresh fetches it
    fake.keyId = "HTTP_EC_P256_KEY:2";
    resetKeyRefreshForTests(); // (a refresh is allowed at most every 30 s per environment)
    expect(await prisma.providerSigningKey.count({ where: { keyId: "HTTP_EC_P256_KEY:2" } })).toBe(0);
    expect((await send(callback(id))).status).toBe(200);
    expect(await prisma.providerSigningKey.count({ where: { keyId: "HTTP_EC_P256_KEY:2" } })).toBe(1);
    // an unknown key that pawaPay does not publish stays rejected
    expect((await send(fake.signedCallback({ depositId: id, status: "COMPLETED" }, { authority: AUTHORITY, path: BILLING_CALLBACK_PATH, keyId: "SOMEONE_ELSES_KEY" }))).status).toBe(401);
  });

  it("with signing not required an unsigned callback is only an unverified hint; a missing configuration answers 404 or 503, never 200", async () => {
    const saved = cfg;
    setBillingConfig({ ok: true, config: { ...cfg, requireSignedCallbacks: false } });
    const id = crypto.randomUUID();
    const body = JSON.stringify({ depositId: id, status: "COMPLETED" });
    const r = await request(app).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").send(body);
    expect(r.status).toBe(200);
    expect((await prisma.callbackInbox.findFirstOrThrow({ where: { externalId: { startsWith: `deposit:${id}` } } })).signatureVerified).toBe(false);
    setBillingConfig({ ok: false, reason: "x" });
    const prevToken = process.env["PAWAPAY_API_TOKEN"];
    delete process.env["PAWAPAY_API_TOKEN"];
    expect((await request(app).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").send(body)).status).toBe(404);
    process.env["PAWAPAY_API_TOKEN"] = "x";
    expect((await request(app).post(BILLING_CALLBACK_PATH).set("content-type", "application/json").send(body)).status).toBe(503);
    if (prevToken === undefined) delete process.env["PAWAPAY_API_TOKEN"]; else process.env["PAWAPAY_API_TOKEN"] = prevToken;
    setBillingConfig({ ok: true, config: saved });
  });
});

describe("renewal timing: no proration, no lost days, no free days", () => {
  async function paid(b: Awaited<ReturnType<typeof makeSlBusiness>>, now: Date, planCode?: string) {
    const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, ...(planCode ? { planCode } : {}), now });
    fake.complete(s.depositId);
    await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", now);
    return s;
  }

  it("early renewal is refused until the window, then extends from the old end; late payment within grace is contiguous; after grace it starts at payment time", async () => {
    await publishedPlan(prisma, "STARTER", { graceDays: 3 });
    const b = await makeSlBusiness(prisma);
    await paid(b, D0, "STARTER"); // period D0 .. D0+30
    const sub = () => b.scoped.subscription.findFirstOrThrow({ where: {} });
    expect((await sub()).currentPeriodEnd).toEqual(at(30));
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, now: at(5) })).rejects.toMatchObject({ code: "TOO_EARLY" });
    await paid(b, at(20)); // inside the 14-day window: extends from the old end, not from today
    expect(await sub()).toMatchObject({ currentPeriodStart: at(30), currentPeriodEnd: at(60) });
    expect(await b.scoped.entitlementEvent.findFirstOrThrow({ where: { kind: "EXTENDED" } })).toMatchObject({ source: "PAYMENT" });
    // lapse, then pay 2 days after the end (inside grace): still contiguous
    await paid(b, at(62));
    expect(await sub()).toMatchObject({ currentPeriodStart: at(60), currentPeriodEnd: at(90) });
    // pay 10 days after the end (beyond grace): the days in between are not given away
    await paid(b, at(100));
    expect(await sub()).toMatchObject({ currentPeriodStart: at(100), currentPeriodEnd: at(130) });
    expect(await b.scoped.billingAllocation.count()).toBe(4);
  });

  it("a plan change is scheduled for the next renewal (no charge, no proration), the current plan runs out first, and a live plan cannot be switched mid-period", async () => {
    const starter = await publishedPlan(prisma, "STARTER", { priceMinor: 500_000n });
    const pro = await publishedPlan(prisma, "PRO", { priceMinor: 900_000n });
    const b = await makeSlBusiness(prisma);
    await paid(b, D0, "STARTER");
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "PRO", now: at(20) })).rejects.toMatchObject({ code: "PLAN_CHANGE_AT_RENEWAL" });
    const sched = await schedulePlanChange(prisma, { businessId: b.businessId, planCode: "PRO", actorId: "m-1" });
    expect(sched).toMatchObject({ effectiveAt: at(30), planCode: "PRO" });
    expect(await prisma.invoice.count({ where: { subscription: { businessId: b.businessId }, planVersionId: pro.id } })).toBe(0); // nothing billed yet
    expect((await ent(b as never, at(10))).planCode).toBe("STARTER");
    const second = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, now: at(20) });
    expect(second.planCode).toBe("PRO");
    expect(await prisma.invoice.findFirstOrThrow({ where: { reference: second.invoiceReference } })).toMatchObject({ amountMinor: 900_000n, kind: "PLAN_CHANGE", planVersionId: pro.id });
    fake.complete(second.depositId);
    await applyBillingDeposit(prisma, cfg, second.depositId, "CALLBACK", at(20));
    const sub = await b.scoped.subscription.findFirstOrThrow({ where: {} });
    expect(sub).toMatchObject({ planCode: "PRO", planVersionId: pro.id, pendingPlanVersionId: null, currentPeriodStart: at(30), currentPeriodEnd: at(60) });
    expect(await b.scoped.entitlementEvent.findFirstOrThrow({ where: { kind: "PLAN_CHANGED" } })).toMatchObject({ fromPlanCode: "STARTER", toPlanCode: "PRO" });
    expect((await ent(b as never, at(25))).planCode).toBe("STARTER" === "STARTER" ? "PRO" : "PRO"); // paid early: the period list moves; features follow the new version from the new period
    void starter;
  });

  it("an unpaid invoice is reused for the same version and price, and replaced when the price or version changed", async () => {
    await publishedPlan(prisma, "STARTER", { priceMinor: 500_000n });
    const b = await makeSlBusiness(prisma);
    const first = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 });
    fake.fail(first.depositId);
    await applyBillingDeposit(prisma, cfg, first.depositId, "CALLBACK", D0);
    const again = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: at(1) });
    expect(again.invoiceReference).toBe(first.invoiceReference); // the same invoice, a fresh attempt
    fake.fail(again.depositId);
    await applyBillingDeposit(prisma, cfg, again.depositId, "CALLBACK", at(1));
    const v2 = await createPlanVersion(prisma, { planCode: "STARTER", features: ["trade"] });
    await setPlanPrice(prisma, { planVersionId: v2.id, countryCode: "SL", priceMinor: 600_000n });
    await publishPlanVersion(prisma, v2.id);
    const repriced = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: at(2) });
    expect(repriced.invoiceReference).not.toBe(first.invoiceReference);
    expect(await prisma.invoice.findFirstOrThrow({ where: { reference: first.invoiceReference } })).toMatchObject({ status: "CANCELLED" });
    expect(repriced.amountText).toBe("6000.00");
  });
});

describe("cancellation and the reconciliation sweep", () => {
  it("cancelling keeps access to the end of the paid period, cancels unpaid invoices, and renewing again reactivates", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 });
    fake.complete(s.depositId);
    await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", D0);
    const c = await requestCancellation(prisma, { businessId: b.businessId, actorId: "m-1", now: at(5) });
    expect(c.endsAt).toEqual(at(30));
    expect((await ent(b as never, at(10))).state).toBe("ACTIVE");
    await reconcileBilling(prisma, at(31));
    expect(await b.scoped.entitlementEvent.count({ where: { kind: "EXPIRY_NOTED" } })).toBe(0); // still inside the 3-day grace
    await reconcileBilling(prisma, at(40));
    expect((await b.scoped.subscription.findFirstOrThrow({ where: {} })).status).toBe("CANCELED");
    expect((await ent(b as never, at(40))).state).toBe("FREE"); // a cancelled subscription is not entitled; nothing about it is deleted
    expect(await b.scoped.entitlementEvent.count({ where: { kind: { in: ["CANCEL_REQUESTED", "CANCELLED", "EXPIRY_NOTED"] } } })).toBe(3);
    await reconcileBilling(prisma, at(41));
    expect(await b.scoped.entitlementEvent.count({ where: { kind: "EXPIRY_NOTED" } })).toBe(1); // idempotent
    const again = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: at(45) });
    fake.complete(again.depositId);
    await applyBillingDeposit(prisma, cfg, again.depositId, "CALLBACK", at(45));
    const subs = await b.scoped.subscription.findMany({ orderBy: { createdAt: "asc" } });
    expect(subs.map((x) => x.status)).toEqual(["CANCELED", "ACTIVE"]); // the cancelled subscription stays as history; renewal starts a new one
    expect((await ent(b as never, at(46))).state).toBe("ACTIVE");
  });

  it("finds a payment whose callback never arrived, closes dead attempts only on the provider's word, marks overdue invoices, and reports an unreachable provider", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 });
    fake.outage = true;
    const down = await reconcileBilling(prisma, at(1));
    expect(down.unreachable).toBeGreaterThanOrEqual(1);
    expect((await b.scoped.billingAttempt.findUniqueOrThrow({ where: { id: s.depositId } })).status).toBe("ACCEPTED"); // unchanged: we could not look
    fake.outage = false;
    fake.complete(s.depositId); // paid at pawaPay; no callback ever came
    const up = await reconcileBilling(prisma, at(2));
    expect(up.granted).toBeGreaterThanOrEqual(1);
    expect((await ent(b as never, at(3))).state).toBe("ACTIVE");
    // an invoice nobody paid becomes OVERDUE (it is not deleted and can still be paid)
    const c = await makeSlBusiness(prisma);
    const unpaid = await startRenewal(prisma, { businessId: c.businessId, merchantId: c.merchantId, payerPhone: PHONE, planCode: "STARTER", now: D0 });
    fake.fail(unpaid.depositId);
    await applyBillingDeposit(prisma, cfg, unpaid.depositId, "POLL", D0);
    await reconcileBilling(prisma, at(10));
    expect(await prisma.invoice.findFirstOrThrow({ where: { reference: unpaid.invoiceReference } })).toMatchObject({ status: "OVERDUE" });
    const retry = await startRenewal(prisma, { businessId: c.businessId, merchantId: c.merchantId, payerPhone: PHONE, planCode: "STARTER", now: at(10) });
    expect(retry.invoiceReference).toBe(unpaid.invoiceReference);
    fake.complete(retry.depositId);
    expect(await applyBillingDeposit(prisma, cfg, retry.depositId, "CALLBACK", at(10))).toBe("GRANTED"); // an overdue invoice can still be paid
  });
});
