import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  confirmPaymentRequestPayment,
  initiatePaymentRequest,
  PaymentRequestNotFoundError,
} from "../src/domain/paymentRequests.js";
import { MerchantNotFoundError } from "../src/domain/payments.js";

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

describe("initiatePaymentRequest", () => {
  it("creates a PENDING payment request, requests a checkout link, and audits it", async () => {
    const { businessId, merchantId, phoneNumber } = await makeBusinessWithMerchant("Paylink Shop", "+2340003330001");
    const customer = await prisma.customer.create({ data: { businessId, name: "Amina" } });

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "success", data: { link: "https://checkout.example/paylink" } }));

    const result = await initiatePaymentRequest(
      prisma,
      {
        businessId,
        customerId: customer.id,
        description: "Payment from Amina",
        amountMinor: 75000n,
        currencyCode: "NGN",
        initiatedByMerchantId: merchantId,
        redirectUrl: "https://tradepal.africa/paylink/done",
      },
      { secretKey: "test-secret", fetchImpl },
    );

    expect(result.checkoutUrl).toBe("https://checkout.example/paylink");

    const paymentRequest = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: result.paymentRequestId } });
    expect(paymentRequest.status).toBe("PENDING");
    expect(paymentRequest.providerCode).toBe("FLUTTERWAVE");
    expect(paymentRequest.providerReference).toBeTruthy();
    expect(paymentRequest.providerReference).toMatch(/^tpr_/);
    expect(paymentRequest.amountMinor).toBe(75000n);
    expect(paymentRequest.customerId).toBe(customer.id);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.tx_ref).toBe(paymentRequest.providerReference);
    expect(body.amount).toBe("750.00");
    expect(body.currency).toBe("NGN");
    expect(body.customer).toEqual({ email: `${phoneNumber}@invoice.tradepal.africa`, phonenumber: phoneNumber });

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, action: "PAYMENT_REQUEST_INITIATED", entityId: paymentRequest.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("MERCHANT");
    expect(auditRows[0]?.actorId).toBe(merchantId);
  });

  it("throws MerchantNotFoundError for a merchant that doesn't belong to the business", async () => {
    const { businessId } = await makeBusinessWithMerchant("Unknown Merchant Paylink Shop", "+2340003330002");

    await expect(
      initiatePaymentRequest(
        prisma,
        {
          businessId,
          description: "Payment from a stranger",
          amountMinor: 1000n,
          currencyCode: "NGN",
          initiatedByMerchantId: "00000000-0000-0000-0000-000000000000",
          redirectUrl: "https://tradepal.africa/paylink/done",
        },
        { secretKey: "test-secret", fetchImpl: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
  });
});

describe("confirmPaymentRequestPayment", () => {
  async function makePendingRequest(businessLabel: string, phoneNumber: string, amountMinor = 75000n) {
    const { businessId, merchantId } = await makeBusinessWithMerchant(businessLabel, phoneNumber);
    const customer = await prisma.customer.create({ data: { businessId, name: "Amina" } });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "success", data: { link: "https://checkout.example/paylink" } }));
    const checkout = await initiatePaymentRequest(
      prisma,
      {
        businessId,
        customerId: customer.id,
        description: "Payment from Amina",
        amountMinor,
        currencyCode: "NGN",
        initiatedByMerchantId: merchantId,
        redirectUrl: "https://tradepal.africa/paylink/done",
      },
      { secretKey: "test-secret", fetchImpl },
    );
    const paymentRequest = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: checkout.paymentRequestId } });
    return { businessId, merchantId, customerId: customer.id, paymentRequest };
  }

  it("throws PaymentRequestNotFoundError for an unrecognized tx_ref", async () => {
    await expect(
      confirmPaymentRequestPayment(prisma, { txRef: "no-such-tx-ref", flutterwaveTransactionId: "1" }, { secretKey: "test-secret", fetchImpl: vi.fn() }),
    ).rejects.toBeInstanceOf(PaymentRequestNotFoundError);
  });

  it("records the sale as a transaction and marks the payment request PAID on a verified payment", async () => {
    const { paymentRequest, businessId, customerId } = await makePendingRequest("Confirm Paylink Shop", "+2340003330010");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 750, currency: "NGN", tx_ref: paymentRequest.providerReference } }),
    );

    const result = await confirmPaymentRequestPayment(
      prisma,
      { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-1" },
      { secretKey: "test-secret", fetchImpl },
    );

    expect(result.outcome).toBe("recorded");
    expect(result.transactionId).toBeTruthy();

    const reloaded = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
    expect(reloaded.status).toBe("PAID");
    expect(reloaded.paidAt).not.toBeNull();
    expect(reloaded.transactionId).toBe(result.transactionId);

    const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: result.transactionId! } });
    expect(transaction.businessId).toBe(businessId);
    expect(transaction.type).toBe("PAYMENT_RECEIVED");
    expect(transaction.amountMinor).toBe(75000n);
    expect(transaction.customerId).toBe(customerId);

    const auditRows = await prisma.auditLog.findMany({
      where: { action: "PAYMENT_REQUEST_CONFIRMED", entityId: paymentRequest.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("SYSTEM");
  });

  it("is idempotent — replaying a webhook for an already-PAID payment request short-circuits without re-verifying", async () => {
    const { paymentRequest } = await makePendingRequest("Replay Paylink Shop", "+2340003330011");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 750, currency: "NGN", tx_ref: paymentRequest.providerReference } }),
    );

    const first = await confirmPaymentRequestPayment(prisma, { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-2" }, { secretKey: "test-secret", fetchImpl });
    expect(first.outcome).toBe("recorded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await confirmPaymentRequestPayment(prisma, { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-2" }, { secretKey: "test-secret", fetchImpl });
    expect(second.outcome).toBe("already_processed");
    expect(second.transactionId).toBe(first.transactionId);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not called again — no re-verification
  });

  it("reports verification_failed and does not record a transaction when Flutterwave reports an unsuccessful transaction", async () => {
    const { paymentRequest } = await makePendingRequest("Failed Verify Paylink Shop", "+2340003330012");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "failed", amount: 750, currency: "NGN", tx_ref: paymentRequest.providerReference } }),
    );

    const result = await confirmPaymentRequestPayment(prisma, { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-3" }, { secretKey: "test-secret", fetchImpl });
    expect(result.outcome).toBe("verification_failed");

    const reloaded = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
    expect(reloaded.status).toBe("PENDING");
    expect(reloaded.transactionId).toBeNull();

    const auditRows = await prisma.auditLog.findMany({ where: { action: "PAYMENT_REQUEST_VERIFICATION_FAILED", entityId: paymentRequest.id } });
    expect(auditRows).toHaveLength(1);
  });

  it("reports verification_failed when the verified amount doesn't match the payment request", async () => {
    const { paymentRequest } = await makePendingRequest("Amount Mismatch Paylink Shop", "+2340003330013");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 1, currency: "NGN", tx_ref: paymentRequest.providerReference } }),
    );

    const result = await confirmPaymentRequestPayment(prisma, { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-4" }, { secretKey: "test-secret", fetchImpl });
    expect(result.outcome).toBe("verification_failed");
  });

  it("sends a WhatsApp text confirmation to every registered merchant when an outboundGateway is supplied", async () => {
    const { paymentRequest, businessId } = await makePendingRequest("Notify Text Paylink Shop", "+2340003330014");
    const secondMerchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340003330015", role: "STAFF" } });

    const verifyFetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 750, currency: "NGN", tx_ref: paymentRequest.providerReference } }),
    );
    const sendFetch = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.OUT" }] }));

    const result = await confirmPaymentRequestPayment(
      prisma,
      { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-5" },
      { secretKey: "test-secret", fetchImpl: verifyFetch },
      { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl: sendFetch },
    );

    expect(result.outcome).toBe("recorded");
    expect(sendFetch).toHaveBeenCalledTimes(2);

    const sentTo = sendFetch.mock.calls.map((call) => (JSON.parse((call[1] as RequestInit).body as string) as { to: string }).to);
    expect(sentTo.sort()).toEqual(["+2340003330014", secondMerchant.phoneNumber].sort());

    const sentRows = await prisma.auditLog.findMany({ where: { action: "PAYMENT_REQUEST_NOTIFICATION_SENT", businessId } });
    expect(sentRows).toHaveLength(2);
    expect((sentRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("text");
  });

  it("sends via a Meta-approved template (not free-form text) when paymentReceivedTemplate is configured", async () => {
    const { paymentRequest, businessId } = await makePendingRequest("Notify Template Paylink Shop", "+2340003330016");

    const verifyFetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 750, currency: "NGN", tx_ref: paymentRequest.providerReference } }),
    );
    const sendFetch = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.OUT" }] }));

    await confirmPaymentRequestPayment(
      prisma,
      { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-6" },
      { secretKey: "test-secret", fetchImpl: verifyFetch },
      {
        accessToken: "test-token",
        phoneNumberId: "pn-1",
        fetchImpl: sendFetch,
        paymentReceivedTemplate: { name: "payment_received", languageCode: "en_US" },
      },
    );

    expect(sendFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("payment_received");

    const sentRows = await prisma.auditLog.findMany({ where: { action: "PAYMENT_REQUEST_NOTIFICATION_SENT", businessId } });
    expect(sentRows).toHaveLength(1);
    expect((sentRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("template");
  });

  it("still records the transaction even if the outbound notification fails, and audits the failure", async () => {
    const { paymentRequest, businessId } = await makePendingRequest("Notify Fail Paylink Shop", "+2340003330017");

    const verifyFetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success", data: { status: "successful", amount: 750, currency: "NGN", tx_ref: paymentRequest.providerReference } }),
    );
    const sendFetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));

    const result = await confirmPaymentRequestPayment(
      prisma,
      { txRef: paymentRequest.providerReference!, flutterwaveTransactionId: "flw-tx-7" },
      { secretKey: "test-secret", fetchImpl: verifyFetch },
      { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl: sendFetch },
    );

    expect(result.outcome).toBe("recorded");

    const reloaded = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
    expect(reloaded.status).toBe("PAID");

    const failedRows = await prisma.auditLog.findMany({ where: { action: "PAYMENT_REQUEST_NOTIFICATION_FAILED", businessId } });
    expect(failedRows).toHaveLength(1);
  });
});
