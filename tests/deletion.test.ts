import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { findOrCreateCustomerByName } from "../src/domain/debtBook.js";
import {
  completeDeletionRequest,
  createDeletionRequest,
  DeletionRequestAlreadyResolvedError,
  DeletionRequestNotFoundError,
  rejectDeletionRequest,
} from "../src/domain/deletion.js";

let testDb: TestDb;
let prisma: PrismaClient;
let scoped: TenantScopedClient;
let businessId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  const business = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessId = business.id;
  scoped = getTenantScopedClient(prisma, businessId);
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("completeDeletionRequest", () => {
  it("anonymizes the linked customer's name and flips isAnonymized, without touching their debts/transactions", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Amina");
    const debt = await scoped.debt.create({
      data: { businessId, customerId: customer.id, originalAmountMinor: 500n, outstandingAmountMinor: 500n, currencyCode: "NGN" },
    });

    const request = await createDeletionRequest(scoped, {
      businessId,
      customerId: customer.id,
      requestorType: "CUSTOMER_VIA_MERCHANT",
      description: "Customer asked to have their data removed.",
    });
    expect(request.status).toBe("PENDING");

    const resolved = await completeDeletionRequest(scoped, request.id, "Anonymized per customer request.");
    expect(resolved.status).toBe("COMPLETED");
    expect(resolved.resolvedAt).not.toBeNull();

    const anonymizedCustomer = await scoped.customer.findUnique({ where: { id: customer.id } });
    expect(anonymizedCustomer?.isAnonymized).toBe(true);
    expect(anonymizedCustomer?.name).not.toBe("Amina");

    const untouchedDebt = await scoped.debt.findUnique({ where: { id: debt.id } });
    expect(untouchedDebt?.outstandingAmountMinor).toBe(500n);
  });

  it("throws DeletionRequestNotFoundError for an unknown id", async () => {
    await expect(completeDeletionRequest(scoped, "does-not-exist")).rejects.toThrow(DeletionRequestNotFoundError);
  });

  it("throws DeletionRequestAlreadyResolvedError when resolving twice", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Bello");
    const request = await createDeletionRequest(scoped, {
      businessId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    await completeDeletionRequest(scoped, request.id);

    await expect(completeDeletionRequest(scoped, request.id)).rejects.toThrow(DeletionRequestAlreadyResolvedError);
  });
});

describe("rejectDeletionRequest", () => {
  it("marks a request REJECTED with a resolution note, leaving the customer untouched", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Chidi");
    const request = await createDeletionRequest(scoped, {
      businessId,
      customerId: customer.id,
      requestorType: "CUSTOMER_DIRECT",
      description: "Direct customer request.",
    });

    const resolved = await rejectDeletionRequest(scoped, request.id, "Could not verify identity.");
    expect(resolved.status).toBe("REJECTED");
    expect(resolved.resolutionNote).toBe("Could not verify identity.");

    const customerAfter = await scoped.customer.findUnique({ where: { id: customer.id } });
    expect(customerAfter?.isAnonymized).toBe(false);
    expect(customerAfter?.name).toBe("Chidi");
  });
});

describe("admin attribution (Phase 16)", () => {
  it("completeDeletionRequest attributes the audit log to MERCHANT when no admin id is given (backward compatible)", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Dupe");
    const request = await createDeletionRequest(scoped, {
      businessId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    await completeDeletionRequest(scoped, request.id);

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_COMPLETED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("MERCHANT");
  });

  it("completeDeletionRequest attributes the audit log to ADMIN with the given admin id when resolvedByAdminUserId is passed", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Efe");
    const request = await createDeletionRequest(scoped, {
      businessId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    await completeDeletionRequest(scoped, request.id, "Anonymized by support.", "admin-123");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_COMPLETED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("ADMIN");
    expect(auditRows[0]?.actorId).toBe("admin-123");
  });

  it("rejectDeletionRequest attributes the audit log to ADMIN with the given admin id when resolvedByAdminUserId is passed", async () => {
    const customer = await findOrCreateCustomerByName(scoped, businessId, "Femi");
    const request = await createDeletionRequest(scoped, {
      businessId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    await rejectDeletionRequest(scoped, request.id, "Could not verify identity.", "admin-456");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_REJECTED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("ADMIN");
    expect(auditRows[0]?.actorId).toBe("admin-456");
  });
});

/**
 * Phase 18 gap closure: before this, resolving a deletion request never
 * notified anyone — a merchant had no way to learn their (or their
 * customer's) deletion request was actioned short of asking support
 * directly. Mirrors subscriptionExpiry.test.ts's own
 * "notification (Phase 7)" describe block shape: no-gateway is a no-op,
 * a configured gateway sends + audits per registered merchant, and a failed
 * send is audited (never thrown) with the retry attempt count.
 *
 * Each test below creates its own Business (rather than reusing the
 * file-level `businessId`/`scoped`) specifically because it registers
 * Merchant rows — the shared `businessId` is reused across every other
 * describe block in this file, so merchants created against it would leak
 * across tests and inflate `notifyResolution`'s findMany results.
 */
describe("completeDeletionRequest / rejectDeletionRequest — resolution WhatsApp notification (Phase 18)", () => {
  async function makeBusiness(name: string): Promise<{ businessId: string; scoped: TenantScopedClient }> {
    const business = await prisma.business.create({
      data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    return { businessId: business.id, scoped: getTenantScopedClient(prisma, business.id) };
  }

  it("does not throw and sends nothing when no outboundGateway is supplied", async () => {
    const { businessId: bizId, scoped: bizScoped } = await makeBusiness("Notif No Gateway Shop");
    const customer = await findOrCreateCustomerByName(bizScoped, bizId, "Grace");
    const request = await createDeletionRequest(bizScoped, {
      businessId: bizId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    const resolved = await completeDeletionRequest(bizScoped, request.id, "Anonymized.");
    expect(resolved.status).toBe("COMPLETED");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_COMPLETION_NOTIFICATION_SENT" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("sends a WhatsApp text message to every registered merchant and audits each send on completion", async () => {
    const { businessId: bizId, scoped: bizScoped } = await makeBusiness("Notif Completion Shop");
    const merchantA = await prisma.merchant.create({ data: { businessId: bizId, phoneNumber: "+2340002220001" } });
    const merchantB = await prisma.merchant.create({ data: { businessId: bizId, phoneNumber: "+2340002220002", role: "STAFF" } });
    const customer = await findOrCreateCustomerByName(bizScoped, bizId, "Halima");
    const request = await createDeletionRequest(bizScoped, {
      businessId: bizId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await completeDeletionRequest(bizScoped, request.id, "Anonymized per request.", undefined, {
      prisma,
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sentTo = fetchImpl.mock.calls.map((call) => (JSON.parse((call[1] as RequestInit).body as string) as { to: string }).to);
    expect(sentTo.sort()).toEqual([merchantA.phoneNumber, merchantB.phoneNumber].sort());

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_COMPLETION_NOTIFICATION_SENT" },
      orderBy: { createdAt: "asc" },
    });
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.metadata as { merchantId: string }).map((m) => m.merchantId).sort()).toEqual(
      [merchantA.id, merchantB.id].sort(),
    );
  });

  it("sends a distinct notification and audit action on rejection", async () => {
    const { businessId: bizId, scoped: bizScoped } = await makeBusiness("Notif Rejection Shop");
    const merchant = await prisma.merchant.create({ data: { businessId: bizId, phoneNumber: "+2340002220003" } });
    const customer = await findOrCreateCustomerByName(bizScoped, bizId, "Ibrahim");
    const request = await createDeletionRequest(bizScoped, {
      businessId: bizId,
      customerId: customer.id,
      requestorType: "CUSTOMER_DIRECT",
      description: "Direct customer request.",
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await rejectDeletionRequest(bizScoped, request.id, "Could not verify identity.", undefined, {
      prisma,
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as { to: string; text: { body: string } };
    expect(body.to).toBe(merchant.phoneNumber);
    expect(body.text.body).toContain("was not approved");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_REJECTION_NOTIFICATION_SENT" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("retries a rate-limited (429) send up to 3 attempts, then audits it as failed with the attempt count, without throwing", async () => {
    const { businessId: bizId, scoped: bizScoped } = await makeBusiness("Notif Failure Shop");
    const merchant = await prisma.merchant.create({ data: { businessId: bizId, phoneNumber: "+2340002220004" } });
    const customer = await findOrCreateCustomerByName(bizScoped, bizId, "Joy");
    const request = await createDeletionRequest(bizScoped, {
      businessId: bizId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    const fetchImpl = vi.fn().mockImplementation(async () => new Response("rate limited", { status: 429 }));
    const resolved = await completeDeletionRequest(bizScoped, request.id, undefined, undefined, {
      prisma,
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
    });

    expect(resolved.status).toBe("COMPLETED");
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_COMPLETION_NOTIFICATION_FAILED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.metadata).toMatchObject({ merchantId: merchant.id, attempts: 3 });
  });

  /**
   * Phase 20 gap closure: mirrors businessDigest.test.ts's own "sends via a
   * Meta-approved template" test — the identical 24-hour-window delivery
   * risk Phase 9/18 fixed for the lapse notification and weekly digest was
   * never fixed for the deletion-resolution notice until now.
   */
  it("sends via a Meta-approved template (not free-form text) when resolutionTemplate is configured — completion", async () => {
    const { businessId: bizId, scoped: bizScoped } = await makeBusiness("Notif Completion Template Shop");
    const merchant = await prisma.merchant.create({ data: { businessId: bizId, phoneNumber: "+2340002220005" } });
    const customer = await findOrCreateCustomerByName(bizScoped, bizId, "Kemi");
    const request = await createDeletionRequest(bizScoped, {
      businessId: bizId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await completeDeletionRequest(bizScoped, request.id, "Anonymized per request.", undefined, {
      prisma,
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
      resolutionTemplate: { name: "deletion_resolution_notice", languageCode: "en_US" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("deletion_resolution_notice");
    expect(body.template.language).toEqual({ code: "en_US" });
    expect(body.template.components).toHaveLength(1);
    const params = body.template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(params).toEqual(["completed", "Anonymized per request."]);

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: request.id, action: "DELETION_REQUEST_COMPLETION_NOTIFICATION_SENT" },
    });
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0]?.metadata as { sendMethod?: string; merchantId: string })?.sendMethod).toBe("template");
    expect((auditRows[0]?.metadata as { merchantId: string }).merchantId).toBe(merchant.id);
  });

  it("sends via a Meta-approved template with the outcome and note for a rejection", async () => {
    const { businessId: bizId, scoped: bizScoped } = await makeBusiness("Notif Rejection Template Shop");
    await prisma.merchant.create({ data: { businessId: bizId, phoneNumber: "+2340002220006" } });
    const customer = await findOrCreateCustomerByName(bizScoped, bizId, "Lami");
    const request = await createDeletionRequest(bizScoped, {
      businessId: bizId,
      customerId: customer.id,
      requestorType: "CUSTOMER_DIRECT",
      description: "Direct customer request.",
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await rejectDeletionRequest(bizScoped, request.id, "Could not verify identity.", undefined, {
      prisma,
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
      resolutionTemplate: { name: "deletion_resolution_notice", languageCode: "en_US" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("template");
    const params = body.template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(params).toEqual(["not approved", "Could not verify identity."]);
  });

  it("falls back the note placeholder to a fixed string when a completion has no resolutionNote", async () => {
    const { businessId: bizId, scoped: bizScoped } = await makeBusiness("Notif Completion No-Note Template Shop");
    await prisma.merchant.create({ data: { businessId: bizId, phoneNumber: "+2340002220007" } });
    const customer = await findOrCreateCustomerByName(bizScoped, bizId, "Musa");
    const request = await createDeletionRequest(bizScoped, {
      businessId: bizId,
      customerId: customer.id,
      requestorType: "MERCHANT",
      description: "Merchant requested removal.",
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await completeDeletionRequest(bizScoped, request.id, undefined, undefined, {
      prisma,
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
      resolutionTemplate: { name: "deletion_resolution_notice", languageCode: "en_US" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    const params = body.template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(params).toEqual(["completed", "No additional note provided."]);
  });
});
