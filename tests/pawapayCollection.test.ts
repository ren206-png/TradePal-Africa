import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import {
  initiatePawaPayCollection,
  InvalidPayerPhoneError,
  PawaPayAmountError,
  PawaPayDepositNotFoundError,
  PawaPayRejectedError,
  PawaPayUnavailableError,
  reconcilePendingPawaPayDeposits,
  resetPawaPayConfigCacheForTests,
  settlePawaPayDeposit,
} from "../src/domain/pawapayCollection.js";
import { createPawaPayWebhookPostHandler } from "../src/pawapay/webhookRoute.js";
import { redactInPayload, redactPayerNumberInStoredMessage, REDACTED_PAYER_NUMBER } from "../src/whatsapp/redaction.js";

let testDb: TestDb;
let prisma: PrismaClient;

const PAYER = "23276123456";

/** An in-memory stand-in for PawaPay's API: every route the integration uses, controllable per test. */
class FakePawaPay {
  predictCountry = "SLE";
  predictProviderCode = "AFRIMONEY_SLE";
  predictValid = true;
  decimals: "NONE" | "TWO_PLACES" = "NONE";
  minAmount = "1";
  maxAmount = "100000";
  operational = true;
  depositInitStatus: "ACCEPTED" | "REJECTED" | "DUPLICATE_IGNORED" = "ACCEPTED";
  depositInitHttpStatus = 200;
  depositInitFailureCode: string | undefined;
  networkDown = false;
  /** depositId -> what checkDepositStatus returns; absent = 404. */
  deposits = new Map<string, { status: string; amount?: string; currency?: string; providerTransactionId?: string; failureCode?: string }>();
  calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

  fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace(/^\/v2/, "");
    this.calls.push({ method, path, ...(body ? { body } : {}) });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

    if (path === "/predict-provider") {
      if (!this.predictValid) return json({}, 400);
      return json({ country: this.predictCountry, provider: this.predictProviderCode, phoneNumber: PAYER });
    }
    if (path === "/active-conf") {
      return json({
        companyName: "TradePal",
        countries: [
          {
            country: "SLE",
            prefix: "232",
            displayName: { en: "Sierra Leone" },
            providers: [
              {
                provider: "AFRIMONEY_SLE",
                displayName: "Afrimoney",
                nameDisplayedToCustomer: "Afrimoney",
                logo: "",
                currencies: [
                  {
                    currency: "SLE",
                    displayName: "Leone",
                    operationTypes: {
                      DEPOSIT: {
                        status: this.operational ? "OPERATIONAL" : "CLOSED",
                        decimalsInAmount: this.decimals,
                        minAmount: this.minAmount,
                        maxAmount: this.maxAmount,
                        authType: "PROVIDER_AUTH",
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    if (path === "/deposits" && method === "POST") {
      if (this.networkDown) throw new TypeError("fetch failed");
      if (this.depositInitHttpStatus !== 200) return json({ error: "bad" }, this.depositInitHttpStatus);
      const depositId = String(body?.["depositId"]);
      return json({
        depositId,
        status: this.depositInitStatus,
        created: new Date().toISOString(),
        ...(this.depositInitFailureCode ? { failureReason: { failureCode: this.depositInitFailureCode, failureMessage: "x" } } : {}),
      });
    }
    const m = path.match(/^\/deposits\/(.+)$/);
    if (m) {
      if (this.networkDown) throw new TypeError("fetch failed");
      const d = this.deposits.get(m[1]!);
      if (!d) return json({}, 404);
      return json({
        depositId: m[1],
        status: d.status,
        ...(d.amount ? { amount: d.amount } : {}),
        ...(d.currency ? { currency: d.currency } : {}),
        ...(d.providerTransactionId ? { providerTransactionId: d.providerTransactionId } : {}),
        ...(d.failureCode ? { failureReason: { failureCode: d.failureCode, failureMessage: "failed" } } : {}),
      });
    }
    return json({}, 404);
  });

  deps() {
    return { apiToken: "t", fetchImpl: this.fetchImpl as unknown as typeof fetch };
  }
}

let fake: FakePawaPay;
let whatsappFetch: ReturnType<typeof vi.fn>;

function gateway() {
  return { accessToken: "wa-token", phoneNumberId: "pn-id", fetchImpl: whatsappFetch as unknown as typeof fetch };
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "SLE", name: "Sierra Leonean Leone", minorUnitExp: 2 } });
  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "SL", name: "Sierra Leone", callingCode: "232", defaultCurrency: "SLE", defaultTimezone: "Africa/Freetown" },
  });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });
  await prisma.paymentProvider.upsert({
    where: { code: "PAWAPAY" },
    update: {},
    create: { code: "PAWAPAY", countryCode: "SL", config: {}, enabled: true },
  });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

beforeEach(() => {
  fake = new FakePawaPay();
  resetPawaPayConfigCacheForTests();
  whatsappFetch = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 }));
});

let phoneCounter = 0;
async function makeSierraLeoneBusiness(name: string) {
  const business = await prisma.business.create({
    data: { name, countryCode: "SL", currencyCode: "SLE", languageCode: "en", timezone: "Africa/Freetown" },
  });
  const merchant = await prisma.merchant.create({ data: { businessId: business.id, phoneNumber: `2327${String(1000000 + ++phoneCounter)}` } });
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: "Aminata" } });
  return { businessId: business.id, merchantId: merchant.id, customerId: customer.id, merchantPhone: merchant.phoneNumber };
}

async function startCollection(b: Awaited<ReturnType<typeof makeSierraLeoneBusiness>>, amountMinor = 50_000n) {
  return initiatePawaPayCollection(
    prisma,
    {
      businessId: b.businessId,
      customerId: b.customerId,
      description: "Payment from Aminata",
      amountMinor,
      currencyCode: "SLE",
      initiatedByMerchantId: b.merchantId,
      payerPhone: "+232 76-123-456",
    },
    fake.deps(),
  );
}

describe("initiatePawaPayCollection", () => {
  it("creates a PENDING request + ACCEPTED deposit, sends PawaPay the sanitised number and a whole-number amount, and never stores the number", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 1");
    const result = await startCollection(b);

    expect(result.providerName).toBe("Afrimoney");
    expect(result.payerPhoneLast4).toBe("3456");

    const pr = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: result.paymentRequestId } });
    expect(pr.status).toBe("PENDING");
    expect(pr.providerCode).toBe("PAWAPAY");
    expect(pr.providerReference).toBe(result.depositId);
    expect(pr.amountMinor).toBe(50_000n);

    const deposit = await prisma.pawaPayDeposit.findUniqueOrThrow({ where: { id: result.depositId } });
    expect(deposit.status).toBe("ACCEPTED");
    expect(deposit.provider).toBe("AFRIMONEY_SLE");
    expect(deposit.payerPhoneLast4).toBe("3456");

    const init = fake.calls.find((c) => c.path === "/deposits" && c.method === "POST")!;
    expect(init.body).toMatchObject({
      depositId: result.depositId,
      amount: "500", // 50_000 minor units, provider takes no decimals
      currency: "SLE",
      payer: { type: "MMO", accountDetails: { phoneNumber: PAYER, provider: "AFRIMONEY_SLE" } },
    });

    // Standard #9: the full number is in none of our rows.
    const everything = JSON.stringify(
      [deposit, pr, await prisma.auditLog.findMany({ where: { businessId: b.businessId } })],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(everything).not.toContain(PAYER);
    expect(everything).not.toContain("76123456");

    const audit = await prisma.auditLog.findMany({ where: { businessId: b.businessId, action: "PAYMENT_REQUEST_INITIATED" } });
    expect(audit).toHaveLength(1);
  });

  it("rejects a number PawaPay can't validate, creating nothing", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 2");
    fake.predictValid = false;
    await expect(startCollection(b)).rejects.toBeInstanceOf(InvalidPayerPhoneError);
    expect(await prisma.paymentRequest.count({ where: { businessId: b.businessId } })).toBe(0);
  });

  it("rejects a number from another country", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 3");
    fake.predictCountry = "LBR";
    await expect(startCollection(b)).rejects.toThrow(/isn't a Sierra Leone mobile-money number/);
    expect(await prisma.paymentRequest.count({ where: { businessId: b.businessId } })).toBe(0);
  });

  it("rejects cents when the provider only accepts whole amounts", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 4");
    await expect(startCollection(b, 50_050n)).rejects.toBeInstanceOf(PawaPayAmountError);
    expect(await prisma.paymentRequest.count({ where: { businessId: b.businessId } })).toBe(0);
  });

  it("allows cents when the provider supports two decimal places", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 4b");
    fake.decimals = "TWO_PLACES";
    await startCollection(b, 50_050n);
    const init = fake.calls.find((c) => c.path === "/deposits" && c.method === "POST")!;
    expect(init.body?.["amount"]).toBe("500.50");
  });

  it("rejects an amount outside the provider's limits", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 5");
    fake.maxAmount = "100";
    await expect(startCollection(b, 50_000n)).rejects.toThrow(/between 1 and 100 SLE/);
  });

  it("refuses while the provider is closed", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 6");
    fake.operational = false;
    await expect(startCollection(b)).rejects.toBeInstanceOf(PawaPayUnavailableError);
  });

  it("is unavailable for a currency PawaPay collection isn't offered in", async () => {
    const business = await prisma.business.create({
      data: { name: "Lagos Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const merchant = await prisma.merchant.create({ data: { businessId: business.id, phoneNumber: "2348099990001" } });
    await expect(
      initiatePawaPayCollection(
        prisma,
        {
          businessId: business.id,
          description: "x",
          amountMinor: 1000n,
          currencyCode: "NGN",
          initiatedByMerchantId: merchant.id,
          payerPhone: PAYER,
        },
        fake.deps(),
      ),
    ).rejects.toThrow(/isn't available in your country/);
  });

  it("marks the request FAILED when PawaPay rejects the deposit, with a human reason", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 7");
    fake.depositInitStatus = "REJECTED";
    fake.depositInitFailureCode = "PAYER_NOT_FOUND";
    await expect(startCollection(b)).rejects.toThrow(/isn't registered for mobile money/);

    const [deposit] = await prisma.pawaPayDeposit.findMany({ where: { businessId: b.businessId } });
    expect(deposit?.status).toBe("REJECTED");
    expect(deposit?.failureCode).toBe("PAYER_NOT_FOUND");
    const pr = await prisma.paymentRequest.findFirstOrThrow({ where: { businessId: b.businessId } });
    expect(pr.status).toBe("FAILED");
  });

  it("treats a definitive HTTP 4xx the same as a rejection", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 8");
    fake.depositInitHttpStatus = 400;
    await expect(startCollection(b)).rejects.toBeInstanceOf(PawaPayRejectedError);
    const pr = await prisma.paymentRequest.findFirstOrThrow({ where: { businessId: b.businessId } });
    expect(pr.status).toBe("FAILED");
  });

  it("leaves the deposit INITIATED (outcome unknown) when the network drops mid-call, so reconciliation can resolve it", async () => {
    const b = await makeSierraLeoneBusiness("Collect Shop 9");
    fake.networkDown = true;
    await expect(startCollection(b)).rejects.toBeInstanceOf(PawaPayUnavailableError);
    const deposit = await prisma.pawaPayDeposit.findFirstOrThrow({ where: { businessId: b.businessId } });
    expect(deposit.status).toBe("INITIATED");
    const pr = await prisma.paymentRequest.findFirstOrThrow({ where: { businessId: b.businessId } });
    expect(pr.status).toBe("PENDING");
  });
});

describe("settlePawaPayDeposit", () => {
  it("credits a verified COMPLETED deposit once: PAID, a PAYMENT_RECEIVED ledger entry, and a WhatsApp notice to the merchant", async () => {
    const b = await makeSierraLeoneBusiness("Settle Shop 1");
    const { depositId, paymentRequestId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "COMPLETED", amount: "500", currency: "SLE", providerTransactionId: "afri-tx-1" });

    const first = await settlePawaPayDeposit(prisma, depositId, fake.deps(), gateway());
    expect(first.outcome).toBe("paid");

    const pr = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } });
    expect(pr.status).toBe("PAID");
    expect(pr.paidAt).not.toBeNull();
    expect(pr.transactionId).toBe(first.transactionId);

    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: first.transactionId! } });
    expect(tx.type).toBe("PAYMENT_RECEIVED");
    expect(tx.amountMinor).toBe(50_000n);
    expect(tx.currencyCode).toBe("SLE");

    const deposit = await prisma.pawaPayDeposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.status).toBe("COMPLETED");
    expect(deposit.providerTransactionId).toBe("afri-tx-1");

    expect(whatsappFetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((whatsappFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.to).toBe(b.merchantPhone);
    expect(sent.text.body).toContain("Payment received");

    // Idempotent: a repeated callback records nothing more.
    const second = await settlePawaPayDeposit(prisma, depositId, fake.deps(), gateway());
    expect(second.outcome).toBe("already_processed");
    expect(await prisma.transaction.count({ where: { businessId: b.businessId, type: "PAYMENT_RECEIVED" } })).toBe(1);
    expect(whatsappFetch).toHaveBeenCalledTimes(1);
  });

  it("records no second ledger entry when another settler already claimed the request (the callback/sweep race)", async () => {
    // The PENDING -> PAID move is one conditional UPDATE, so of two concurrent settlers exactly one
    // wins. Simulated deterministically (the in-memory test database can't run truly parallel
    // queries): the "other" settler has already flipped the request to PAID, but this one still sees
    // the deposit as ACCEPTED and PawaPay as COMPLETED.
    const b = await makeSierraLeoneBusiness("Settle Shop 2");
    const { depositId, paymentRequestId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "COMPLETED", amount: "500", currency: "SLE" });
    await prisma.paymentRequest.update({ where: { id: paymentRequestId }, data: { status: "PAID", paidAt: new Date() } });

    const result = await settlePawaPayDeposit(prisma, depositId, fake.deps(), gateway());
    expect(result.outcome).toBe("already_processed");
    expect(await prisma.transaction.count({ where: { businessId: b.businessId, type: "PAYMENT_RECEIVED" } })).toBe(0);
    expect(whatsappFetch).not.toHaveBeenCalled();
    expect((await prisma.pawaPayDeposit.findUniqueOrThrow({ where: { id: depositId } })).status).toBe("COMPLETED");
  });

  it("does not credit when PawaPay's own record disagrees on the amount", async () => {
    const b = await makeSierraLeoneBusiness("Settle Shop 3");
    const { depositId, paymentRequestId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "COMPLETED", amount: "5", currency: "SLE" });

    const result = await settlePawaPayDeposit(prisma, depositId, fake.deps(), gateway());
    expect(result.outcome).toBe("verification_failed");
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status).toBe("PENDING");
    expect(await prisma.transaction.count({ where: { businessId: b.businessId, type: "PAYMENT_RECEIVED" } })).toBe(0);
    expect(whatsappFetch).not.toHaveBeenCalled();
    expect(await prisma.auditLog.count({ where: { businessId: b.businessId, action: "PAYMENT_REQUEST_VERIFICATION_FAILED" } })).toBe(1);
  });

  it("does not credit when the currency disagrees", async () => {
    const b = await makeSierraLeoneBusiness("Settle Shop 3b");
    const { depositId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "COMPLETED", amount: "500", currency: "LRD" });
    expect((await settlePawaPayDeposit(prisma, depositId, fake.deps())).outcome).toBe("verification_failed");
  });

  it("marks a FAILED deposit and its request FAILED, and tells the merchant", async () => {
    const b = await makeSierraLeoneBusiness("Settle Shop 4");
    const { depositId, paymentRequestId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "FAILED", failureCode: "PAYER_LIMIT_REACHED" });

    const result = await settlePawaPayDeposit(prisma, depositId, fake.deps(), gateway());
    expect(result.outcome).toBe("failed");
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status).toBe("FAILED");
    const deposit = await prisma.pawaPayDeposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.status).toBe("FAILED");
    expect(deposit.failureCode).toBe("PAYER_LIMIT_REACHED");
    expect(await prisma.transaction.count({ where: { businessId: b.businessId } })).toBe(0);

    const sent = JSON.parse((whatsappFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.text.body).toContain("Payment not completed");
    expect(sent.text.body).toContain("mobile-money limit");
  });

  it("leaves a still-waiting deposit alone", async () => {
    const b = await makeSierraLeoneBusiness("Settle Shop 5");
    const { depositId, paymentRequestId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "ACCEPTED" });

    expect((await settlePawaPayDeposit(prisma, depositId, fake.deps(), gateway())).outcome).toBe("pending");
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status).toBe("PENDING");
    expect(whatsappFetch).not.toHaveBeenCalled();
  });

  it("still credits money that arrives after the request was swept to EXPIRED", async () => {
    const b = await makeSierraLeoneBusiness("Settle Shop 6");
    const { depositId, paymentRequestId } = await startCollection(b);
    await prisma.paymentRequest.update({ where: { id: paymentRequestId }, data: { status: "EXPIRED" } });
    fake.deposits.set(depositId, { status: "COMPLETED", amount: "500", currency: "SLE" });

    expect((await settlePawaPayDeposit(prisma, depositId, fake.deps())).outcome).toBe("paid");
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status).toBe("PAID");
  });

  it("marks an INITIATED deposit FAILED when PawaPay has no record of it (the initiation never arrived)", async () => {
    const b = await makeSierraLeoneBusiness("Settle Shop 7");
    fake.networkDown = true;
    await expect(startCollection(b)).rejects.toBeInstanceOf(PawaPayUnavailableError);
    const deposit = await prisma.pawaPayDeposit.findFirstOrThrow({ where: { businessId: b.businessId } });

    fake.networkDown = false; // PawaPay is reachable again, and has never heard of this depositId
    expect((await settlePawaPayDeposit(prisma, deposit.id, fake.deps(), gateway())).outcome).toBe("failed");
    expect((await prisma.pawaPayDeposit.findUniqueOrThrow({ where: { id: deposit.id } })).status).toBe("FAILED");
  });

  it("throws PawaPayDepositNotFoundError for an id TradePal never created", async () => {
    await expect(settlePawaPayDeposit(prisma, "11111111-1111-4111-8111-111111111111", fake.deps())).rejects.toBeInstanceOf(
      PawaPayDepositNotFoundError,
    );
  });
});

describe("reconcilePendingPawaPayDeposits", () => {
  it("settles old pending deposits, skips recent ones, and carries on past a failing one", async () => {
    const b = await makeSierraLeoneBusiness("Reconcile Shop");
    const old1 = await startCollection(b);
    const old2 = await startCollection(b);
    const recent = await startCollection(b);
    fake.deposits.set(old1.depositId, { status: "COMPLETED", amount: "500", currency: "SLE" });
    fake.deposits.set(old2.depositId, { status: "FAILED", failureCode: "PAYER_NOT_FOUND" });
    fake.deposits.set(recent.depositId, { status: "COMPLETED", amount: "500", currency: "SLE" });

    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.pawaPayDeposit.updateMany({ where: { id: { in: [old1.depositId, old2.depositId] } }, data: { createdAt: longAgo } });

    const result = await reconcilePendingPawaPayDeposits(prisma, fake.deps(), gateway());
    expect(result).toMatchObject({ checked: 2, paid: 1, failed: 1, pending: 0, errors: 0 });
    expect((await prisma.pawaPayDeposit.findUniqueOrThrow({ where: { id: recent.depositId } })).status).toBe("ACCEPTED");

    // An unreachable PawaPay is counted as an error, not thrown.
    const stuck = await startCollection(b);
    await prisma.pawaPayDeposit.update({ where: { id: stuck.depositId }, data: { createdAt: longAgo } });
    fake.networkDown = true;
    const second = await reconcilePendingPawaPayDeposits(prisma, fake.deps(), gateway());
    expect(second).toMatchObject({ checked: 1, errors: 1 });
  });
});

describe("POST /webhooks/pawapay", () => {
  function app(withGateway = true) {
    const a = express();
    a.use(express.json());
    a.post(
      "/webhooks/pawapay",
      createPawaPayWebhookPostHandler({ prisma, pawapay: fake.deps(), ...(withGateway ? { outboundGateway: gateway() } : {}) }),
    );
    return a;
  }

  it("rejects a payload that isn't a PawaPay callback", async () => {
    expect((await request(app()).post("/webhooks/pawapay").send({})).status).toBe(400);
    expect((await request(app()).post("/webhooks/pawapay").send({ depositId: 5, status: "COMPLETED" })).status).toBe(400);
  });

  it("acknowledges (and ignores) a deposit TradePal never created", async () => {
    const res = await request(app()).post("/webhooks/pawapay").send({ depositId: "22222222-2222-4222-8222-222222222222", status: "COMPLETED" });
    expect(res.status).toBe(200);
  });

  it("settles a genuine COMPLETED callback", async () => {
    const b = await makeSierraLeoneBusiness("Webhook Shop 1");
    const { depositId, paymentRequestId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "COMPLETED", amount: "500", currency: "SLE" });

    const res = await request(app()).post("/webhooks/pawapay").send({ depositId, status: "COMPLETED" });
    expect(res.status).toBe(200);
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status).toBe("PAID");
  });

  it("never credits a forged COMPLETED callback that PawaPay's own record contradicts", async () => {
    const b = await makeSierraLeoneBusiness("Webhook Shop 2");
    const { depositId, paymentRequestId } = await startCollection(b);
    fake.deposits.set(depositId, { status: "ACCEPTED" }); // PawaPay says: still waiting

    const res = await request(app()).post("/webhooks/pawapay").send({ depositId, status: "COMPLETED" });
    expect(res.status).toBe(200);
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status).toBe("PENDING");
    expect(await prisma.transaction.count({ where: { businessId: b.businessId } })).toBe(0);
  });

  it("does nothing for in-flight statuses", async () => {
    const b = await makeSierraLeoneBusiness("Webhook Shop 3");
    const { depositId } = await startCollection(b);
    const callsBefore = fake.fetchImpl.mock.calls.length;
    const res = await request(app()).post("/webhooks/pawapay").send({ depositId, status: "PROCESSING" });
    expect(res.status).toBe(200);
    expect(fake.fetchImpl.mock.calls.length).toBe(callsBefore);
  });

  it("answers 500 when PawaPay can't be reached, so PawaPay retries the callback", async () => {
    const b = await makeSierraLeoneBusiness("Webhook Shop 4");
    const { depositId } = await startCollection(b);
    fake.networkDown = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app()).post("/webhooks/pawapay").send({ depositId, status: "COMPLETED" });
    spy.mockRestore();
    expect(res.status).toBe(500);
  });
});

describe("/collect command", () => {
  async function ctxFor(b: Awaited<ReturnType<typeof makeSierraLeoneBusiness>>, over: Partial<CommandContext> = {}): Promise<CommandContext> {
    return {
      prisma,
      scopedPrisma: getTenantScopedClient(prisma, b.businessId),
      businessId: b.businessId,
      currencyCode: "SLE",
      minorUnitExp: 2,
      timezone: "Africa/Freetown",
      languageCode: "en",
      merchantId: b.merchantId,
      merchantRole: "OWNER",
      pawapay: fake.deps(),
      ...over,
    };
  }

  async function enableFlag(businessId: string) {
    await prisma.featureFlag.upsert({
      where: { key: "customerPaymentLinks" },
      update: {},
      create: { key: "customerPaymentLinks", description: "test", enabledByDefault: false },
    });
    await getTenantScopedClient(prisma, businessId).businessFeatureFlag.upsert({
      where: { businessId_flagKey: { businessId, flagKey: "customerPaymentLinks" } },
      update: { enabled: true },
      create: { businessId, flagKey: "customerPaymentLinks", enabled: true },
    });
  }

  it("is refused while the customerPaymentLinks flag is off (off by default)", async () => {
    const b = await makeSierraLeoneBusiness("Cmd Shop 1");
    expect(await handleCommand(await ctxFor(b), "/collect Aminata 500 23276123456")).toContain("isn't available for your account yet");
    expect(fake.fetchImpl).not.toHaveBeenCalled();
  });

  it("explains its usage for malformed input", async () => {
    const b = await makeSierraLeoneBusiness("Cmd Shop 2");
    await enableFlag(b.businessId);
    const ctx = await ctxFor(b);
    for (const text of ["/collect", "/collect Aminata", "/collect Aminata 500", "/collect Aminata 500 notaphone", "/collect 500 23276123456"]) {
      expect(await handleCommand(ctx, text)).toContain("Usage: /collect");
    }
    expect(await handleCommand(ctx, "/collect Aminata abc 23276123456")).not.toContain("Usage: /collect Aminata");
    expect(await prisma.paymentRequest.count({ where: { businessId: b.businessId } })).toBe(0);
  });

  it("reports itself unconfigured when PAWAPAY_API_TOKEN isn't set", async () => {
    const b = await makeSierraLeoneBusiness("Cmd Shop 3");
    await enableFlag(b.businessId);
    const reply = await handleCommand(await ctxFor(b, { pawapay: undefined }), "/collect Aminata 500 23276123456");
    expect(reply).toContain("isn't configured for your account yet");
  });

  it("starts a collection and replies with the provider and only the last 4 digits", async () => {
    const b = await makeSierraLeoneBusiness("Cmd Shop 4");
    await enableFlag(b.businessId);
    const reply = await handleCommand(await ctxFor(b), "/collect Aminata Kamara 500 23276123456");
    expect(reply).toContain("Aminata Kamara");
    expect(reply).toContain("Afrimoney");
    expect(reply).toContain("ending 3456");
    expect(reply).toContain("500.00");
    expect(reply).not.toContain("23276123456");
    expect(await prisma.pawaPayDeposit.count({ where: { businessId: b.businessId, status: "ACCEPTED" } })).toBe(1);
  });

  it("shows the merchant a plain-language reason when the payment can't be started", async () => {
    const b = await makeSierraLeoneBusiness("Cmd Shop 5");
    await enableFlag(b.businessId);
    fake.operational = false;
    const reply = await handleCommand(await ctxFor(b), "/collect Aminata 500 23276123456");
    expect(reply).toContain("isn't accepting payments right now");
  });
});

describe("redaction of the stored inbound message (Standard #9)", () => {
  const payloadFor = (id: string, body: string) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [{ id, from: "232", type: "text", text: { body } }] } }] }],
  });

  it("replaces only the last word of the matching message", () => {
    const p = payloadFor("wamid.A", "/collect Aminata Kamara 500 23276123456");
    expect(redactInPayload(p, "wamid.A")).toBe(true);
    expect(p.entry[0]!.changes[0]!.value.messages[0]!.text.body).toBe(`/collect Aminata Kamara 500 ${REDACTED_PAYER_NUMBER}`);
    expect(redactInPayload(payloadFor("wamid.B", "hello"), "wamid.OTHER")).toBe(false);
  });

  it("scrubs the persisted WebhookEvent", async () => {
    const waMessageId = "wamid.REDACT.1";
    await prisma.webhookEvent.create({ data: { waMessageId, payload: payloadFor(waMessageId, "/collect Aminata 500 23276123456") } });
    await redactPayerNumberInStoredMessage(prisma, waMessageId);
    const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { waMessageId } });
    expect(JSON.stringify(stored.payload)).not.toContain("23276123456");
    expect(JSON.stringify(stored.payload)).toContain(REDACTED_PAYER_NUMBER);
  });

  it("is a harmless no-op for an unknown message", async () => {
    await expect(redactPayerNumberInStoredMessage(prisma, "wamid.NOPE")).resolves.toBeUndefined();
  });
});
