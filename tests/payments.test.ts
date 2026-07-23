import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  confirmSubscriptionPayment,
  initiateSubscriptionCheckout,
  InvoiceNotFoundError,
  MerchantNotFoundError,
  PlanNotFoundError,
} from "../src/domain/payments.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  await prisma.plan.upsert({
    where: { code: "STARTER" },
    update: {},
    create: {
      code: "STARTER",
      name: "Starter",
      priceMinor: 500000n, // NGN 5,000.00
      currencyCode: "NGN",
      entryCapPerMonth: 1000,
      voiceEnabled: true,
    },
  });

  await prisma.paymentProvider.upsert({
    where: { code: "FLUTTERWAVE" },
    update: {},
    create: { code: "FLUTTERWAVE", countryCode: "NG", config: {}, enabled: true },
  });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

async function makeBusinessWithMerchant(name: string, phoneNumber: string) {
  const business = await prisma.business.create({
    data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  const merchant = await prisma.merchant.create({ data: { businessId: business.id, phoneNumber } });
  return { businessId: business.id, merchantId: merchant.id, phoneNumber };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("initiateSubscriptionCheckout", () => {
  it("creates a PENDING subscription + invoice, requests a checkout link, and audits it", async () => {
    const { businessId, merchantId, phoneNumber } = await makeBusinessWithMerchant("Checkout Shop", "+2340002220001");

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "success", data: { link: "https://checkout.example/abc" } }));

    const result = await initiateSubscriptionCheckout(
      prisma,
      { businessId, planCode: "STARTER", initiatedByMerchantId: merchantId, redirectUrl: "https://tradepal.africa/upgrade/done" },
      { secretKey: "test-secret", fetchImpl },
    );

    expect(result.checkoutUrl).toBe("https://checkout.example/abc");

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { id: result.subscriptionId } });
    expect(subscription.status).toBe("PENDING");
    expect(subscription.planCode).toBe("STARTER");

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoiceId } });
    expect(invoice.status).toBe("PENDING");
    expect(invoice.providerCode).toBe("FLUTTERWAVE");
    expect(invoice.providerReference).toBeTruthy();
    expect(invoice.amountMinor).toBe(500000n);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.tx_ref).toBe(invoice.providerReference);
    expect(body.amount).toBe("5000.00");
    expect(body.currency).toBe("NGN");
    expect(body.customer).toEqual({ email: `${phoneNumber}@invoice.tradepal.africa`, phonenumber: phoneNumber });

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_CHECKOUT_INITIATED", entityId: invoice.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("MERCHANT");
    expect(auditRows[0]?.actorId).toBe(merchantId);
  });

  it("throws PlanNotFoundError for an unknown plan code", async () => {
    const { businessId, merchantId } = await makeBusinessWithMerchant("Unknown Plan Shop", "+2340002220002");

    await expect(
      initiateSubscriptionCheckout(
        prisma,
        { businessId, planCode: "NOT_A_PLAN", initiatedByMerchantId: merchantId, redirectUrl: "https://tradepal.africa/upgrade/done" },
        { secretKey: "test-secret", fetchImpl: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it("throws MerchantNotFoundError for a merchant that doesn't belong to the business", async () => {
    const { businessId } = await makeBusinessWithMerchant("Unknown Merchant Shop", "+2340002220003");

    await expect(
      initiateSubscriptionCheckout(
        prisma,
        { businessId, planCode: "STARTER", initiatedByMerchantId: "00000000-0000-0000-0000-000000000000", redirectUrl: "https://tradepal.africa/upgrade/done" },
        { secretKey: "test-secret", fetchImpl: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
  });
});

describe("confirmSubscriptionPayment", () => {
  async function makePendingCheckout(businessLabel: string, phoneNumber: string) {
    const { businessId, merchantId } = await makeBusinessWithMerchant(businessLabel, phoneNumber);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "success", data: { link: "https://checkout.example/abc" } }));
    const checkout = await initiateSubscriptionCheckout(
      prisma,
      { businessId, planCode: "STARTER", initiatedByMerchantId: merchantId, redirectUrl: "https://tradepal.africa/upgrade/done" },
      { secretKey: "test-secret", fetchImpl },
    );
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: checkout.invoiceId } });
    return { businessId, merchantId, invoice, subscriptionId: checkout.subscriptionId };
  }

  it("throws InvoiceNotFoundError for an unrecognized tx_ref", async () => {
    await expect(
      confirmSubscriptionPayment(prisma, { txRef: "no-such-tx-ref", flutterwaveTransactionId: "1" }, { secretKey: "test-secret", fetchImpl: vi.fn() }),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });

  it("activates the subscription and marks the invoice PAID on a verified payment", async () => {
    const { invoice, subscriptionId } = await makePendingCheckout("Confirm Shop", "+2340002220010");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 5000, currency: "NGN", tx_ref: invoice.providerReference } }),
    );

    const result = await confirmSubscriptionPayment(
      prisma,
      { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-1" },
      { secretKey: "test-secret", fetchImpl },
    );

    expect(result.outcome).toBe("activated");
    expect(result.subscription?.status).toBe("ACTIVE");

    const reloadedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloadedInvoice.status).toBe("PAID");
    expect(reloadedInvoice.paidAt).not.toBeNull();

    const reloadedSubscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(reloadedSubscription.status).toBe("ACTIVE");
    expect(reloadedSubscription.currentPeriodEnd.getTime()).toBeGreaterThan(reloadedSubscription.currentPeriodStart.getTime());

    const auditRows = await prisma.auditLog.findMany({
      where: { action: "SUBSCRIPTION_PAYMENT_CONFIRMED", entityId: subscriptionId },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("SYSTEM");
  });

  it("is idempotent — replaying a webhook for an already-PAID invoice short-circuits without re-verifying", async () => {
    const { invoice } = await makePendingCheckout("Replay Shop", "+2340002220011");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 5000, currency: "NGN", tx_ref: invoice.providerReference } }),
    );

    const first = await confirmSubscriptionPayment(prisma, { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-2" }, { secretKey: "test-secret", fetchImpl });
    expect(first.outcome).toBe("activated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await confirmSubscriptionPayment(prisma, { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-2" }, { secretKey: "test-secret", fetchImpl });
    expect(second.outcome).toBe("already_processed");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not called again — no re-verification
  });

  it("reports verification_failed and does not activate when Flutterwave reports an unsuccessful transaction", async () => {
    const { invoice, subscriptionId } = await makePendingCheckout("Failed Verify Shop", "+2340002220012");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "failed", amount: 5000, currency: "NGN", tx_ref: invoice.providerReference } }),
    );

    const result = await confirmSubscriptionPayment(prisma, { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-3" }, { secretKey: "test-secret", fetchImpl });
    expect(result.outcome).toBe("verification_failed");

    const reloadedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloadedInvoice.status).toBe("PENDING");

    const reloadedSubscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(reloadedSubscription.status).toBe("PENDING");

    const auditRows = await prisma.auditLog.findMany({ where: { action: "SUBSCRIPTION_PAYMENT_VERIFICATION_FAILED", entityId: invoice.id } });
    expect(auditRows).toHaveLength(1);
  });

  it("reports verification_failed when the verified amount doesn't match the invoice", async () => {
    const { invoice } = await makePendingCheckout("Amount Mismatch Shop", "+2340002220013");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 1, currency: "NGN", tx_ref: invoice.providerReference } }),
    );

    const result = await confirmSubscriptionPayment(prisma, { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-4" }, { secretKey: "test-secret", fetchImpl });
    expect(result.outcome).toBe("verification_failed");
  });

  it("sends a WhatsApp text confirmation to every registered merchant when an outboundGateway is supplied", async () => {
    const { invoice, businessId } = await makePendingCheckout("Notify Text Shop", "+2340002220014");
    const secondMerchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340002220015", role: "STAFF" } });

    const verifyFetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 5000, currency: "NGN", tx_ref: invoice.providerReference } }),
    );
    const sendFetch = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.OUT" }] }));

    const result = await confirmSubscriptionPayment(
      prisma,
      { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-5" },
      { secretKey: "test-secret", fetchImpl: verifyFetch },
      { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl: sendFetch },
    );

    expect(result.outcome).toBe("activated");
    expect(sendFetch).toHaveBeenCalledTimes(2);

    const sentTo = sendFetch.mock.calls.map((call) => (JSON.parse((call[1] as RequestInit).body as string) as { to: string }).to);
    expect(sentTo.sort()).toEqual(["+2340002220014", secondMerchant.phoneNumber].sort());

    const sentRows = await prisma.auditLog.findMany({ where: { action: "SUBSCRIPTION_PAYMENT_NOTIFICATION_SENT", businessId } });
    expect(sentRows).toHaveLength(2);
    expect((sentRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("text");
  });

  it("sends via a Meta-approved template (not free-form text) when paymentConfirmedTemplate is configured", async () => {
    const { invoice, businessId } = await makePendingCheckout("Notify Template Shop", "+2340002220016");

    const verifyFetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 5000, currency: "NGN", tx_ref: invoice.providerReference } }),
    );
    const sendFetch = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.OUT" }] }));

    await confirmSubscriptionPayment(
      prisma,
      { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-6" },
      { secretKey: "test-secret", fetchImpl: verifyFetch },
      {
        accessToken: "test-token",
        phoneNumberId: "pn-1",
        fetchImpl: sendFetch,
        paymentConfirmedTemplate: { name: "payment_confirmed", languageCode: "en_US" },
      },
    );

    expect(sendFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("payment_confirmed");

    const sentRows = await prisma.auditLog.findMany({ where: { action: "SUBSCRIPTION_PAYMENT_NOTIFICATION_SENT", businessId } });
    expect(sentRows).toHaveLength(1);
    expect((sentRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("template");
  });

  it("still activates the subscription even if the outbound notification fails, and audits the failure", async () => {
    const { invoice, businessId, subscriptionId } = await makePendingCheckout("Notify Fail Shop", "+2340002220017");

    const verifyFetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 5000, currency: "NGN", tx_ref: invoice.providerReference } }),
    );
    const sendFetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));

    const result = await confirmSubscriptionPayment(
      prisma,
      { txRef: invoice.providerReference!, flutterwaveTransactionId: "flw-tx-7" },
      { secretKey: "test-secret", fetchImpl: verifyFetch },
      { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl: sendFetch },
    );

    expect(result.outcome).toBe("activated");

    const reloadedSubscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(reloadedSubscription.status).toBe("ACTIVE");

    const failedRows = await prisma.auditLog.findMany({ where: { action: "SUBSCRIPTION_PAYMENT_NOTIFICATION_FAILED", businessId } });
    expect(failedRows).toHaveLength(1);
  });
});
