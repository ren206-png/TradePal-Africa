import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  addStaffMerchant,
  CannotRemoveOwnerError,
  changeMerchantPhoneNumber,
  MerchantAlreadyRemovedError,
  MerchantNotFoundError,
  PhoneNumberAlreadyRegisteredError,
  removeStaffMerchant,
  StaffCapExceededError,
} from "../src/domain/merchantIdentity.js";

let testDb: TestDb;
let prisma: PrismaClient;
let businessId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  // addStaffMerchant resolves the business's effective plan (getEffectivePlan, billing.ts),
  // which falls back to the "FREE" plan code when there's no Subscription row — that lookup
  // throws PlanNotFoundError if the row doesn't exist, so it must be seeded here.
  await prisma.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false, staffCapCount: null },
  });

  const business = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessId = business.id;
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("changeMerchantPhoneNumber", () => {
  it("updates the phone number and records an audit log entry with the reason", async () => {
    const merchant = await prisma.merchant.create({
      data: { businessId, phoneNumber: "+2340000000001", onboardingStep: "COMPLETE" },
    });

    const updated = await changeMerchantPhoneNumber(prisma, {
      merchantId: merchant.id,
      businessId,
      newPhoneNumber: "+2340000000002",
      reason: "Merchant lost their phone; verified identity via support call.",
    });

    expect(updated.phoneNumber).toBe("+2340000000002");

    const auditRows = await prisma.auditLog.findMany({ where: { entityId: merchant.id, entityType: "Merchant" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("MERCHANT_PHONE_NUMBER_CHANGED");
    expect(auditRows[0]?.actorType).toBe("ADMIN");
    expect((auditRows[0]?.metadata as { reason?: string } | null)?.reason).toBe(
      "Merchant lost their phone; verified identity via support call.",
    );
  });

  it("refuses a blank reason", async () => {
    const merchant = await prisma.merchant.create({
      data: { businessId, phoneNumber: "+2340000000003", onboardingStep: "COMPLETE" },
    });

    await expect(
      changeMerchantPhoneNumber(prisma, {
        merchantId: merchant.id,
        businessId,
        newPhoneNumber: "+2340000000004",
        reason: "   ",
      }),
    ).rejects.toThrow(/reason/i);
  });

  it("refuses to reuse a phone number already registered to a different merchant", async () => {
    const merchantA = await prisma.merchant.create({
      data: { businessId, phoneNumber: "+2340000000005", onboardingStep: "COMPLETE" },
    });
    const merchantB = await prisma.merchant.create({
      data: { businessId, phoneNumber: "+2340000000006", onboardingStep: "COMPLETE" },
    });

    await expect(
      changeMerchantPhoneNumber(prisma, {
        merchantId: merchantB.id,
        businessId,
        newPhoneNumber: merchantA.phoneNumber,
        reason: "Attempted collision.",
      }),
    ).rejects.toThrow(PhoneNumberAlreadyRegisteredError);
  });

  it("throws MerchantNotFoundError for an unknown merchant id", async () => {
    await expect(
      changeMerchantPhoneNumber(prisma, {
        merchantId: "does-not-exist",
        businessId,
        newPhoneNumber: "+2340000000007",
        reason: "Testing not-found path.",
      }),
    ).rejects.toThrow(MerchantNotFoundError);
  });
});

describe("addStaffMerchant", () => {
  it("creates a STAFF merchant awaiting consent (not COMPLETE) and records an audit log entry", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348050000001", role: "OWNER", onboardingStep: "COMPLETE" },
    });

    const staff = await addStaffMerchant(prisma, {
      businessId,
      phoneNumber: "2348050000002",
      invitedByMerchantId: owner.id,
    });

    expect(staff.businessId).toBe(businessId);
    expect(staff.role).toBe("STAFF");
    expect(staff.onboardingStep).toBe("AWAITING_CONSENT");

    const auditRows = await prisma.auditLog.findMany({ where: { entityId: staff.id, entityType: "Merchant" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("STAFF_MERCHANT_ADDED");
    expect(auditRows[0]?.actorType).toBe("MERCHANT");
    expect(auditRows[0]?.actorId).toBe(owner.id);
  });

  it("refuses to add a phone number already registered to a merchant in a different business", async () => {
    const otherBusiness = await prisma.business.create({
      data: { name: "Shop Other", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    await prisma.merchant.create({
      data: { businessId: otherBusiness.id, phoneNumber: "2348050000003", onboardingStep: "COMPLETE" },
    });

    await expect(
      addStaffMerchant(prisma, {
        businessId,
        phoneNumber: "2348050000003",
        invitedByMerchantId: "some-owner-id",
      }),
    ).rejects.toThrow(PhoneNumberAlreadyRegisteredError);
  });

  it("enforces the plan's staffCapCount, ignoring the OWNER and any already-removed STAFF rows", async () => {
    const capBusiness = await prisma.business.create({
      data: { name: "Cap Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    await prisma.plan.upsert({
      where: { code: "CAPPED" },
      update: {},
      create: {
        code: "CAPPED",
        name: "Capped",
        priceMinor: 0n,
        currencyCode: "NGN",
        entryCapPerMonth: 100,
        voiceEnabled: false,
        staffCapCount: 1,
      },
    });
    await prisma.subscription.create({
      data: {
        businessId: capBusiness.id,
        planCode: "CAPPED",
        status: "ACTIVE",
        currentPeriodStart: new Date(Date.now() - 1000),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const owner = await prisma.merchant.create({
      data: { businessId: capBusiness.id, phoneNumber: "2348060000001", role: "OWNER", onboardingStep: "COMPLETE" },
    });

    // A previously-removed STAFF row must not count against the cap.
    const removed = await prisma.merchant.create({
      data: {
        businessId: capBusiness.id,
        phoneNumber: "2348060000002",
        role: "STAFF",
        onboardingStep: "COMPLETE",
        removedAt: new Date(),
      },
    });
    expect(removed.removedAt).not.toBeNull();

    const firstStaff = await addStaffMerchant(prisma, {
      businessId: capBusiness.id,
      phoneNumber: "2348060000003",
      invitedByMerchantId: owner.id,
    });
    expect(firstStaff.role).toBe("STAFF");

    await expect(
      addStaffMerchant(prisma, {
        businessId: capBusiness.id,
        phoneNumber: "2348060000004",
        invitedByMerchantId: owner.id,
      }),
    ).rejects.toThrow(StaffCapExceededError);
  });

  it("reactivates a previously-removed STAFF row for the same business instead of refusing (Phase 17)", async () => {
    const reactivateBusiness = await prisma.business.create({
      data: { name: "Reactivate Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const owner = await prisma.merchant.create({
      data: { businessId: reactivateBusiness.id, phoneNumber: "2348090000001", role: "OWNER", onboardingStep: "COMPLETE" },
    });
    const removedStaff = await prisma.merchant.create({
      data: {
        businessId: reactivateBusiness.id,
        phoneNumber: "2348090000002",
        role: "STAFF",
        onboardingStep: "COMPLETE",
        removedAt: new Date(),
      },
    });

    const reactivated = await addStaffMerchant(prisma, {
      businessId: reactivateBusiness.id,
      phoneNumber: "2348090000002",
      invitedByMerchantId: owner.id,
    });

    expect(reactivated.id).toBe(removedStaff.id);
    expect(reactivated.removedAt).toBeNull();
    expect(reactivated.onboardingStep).toBe("AWAITING_CONSENT");
    expect(reactivated.role).toBe("STAFF");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: removedStaff.id, action: "STAFF_MERCHANT_REACTIVATED" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("still refuses to reactivate a removed number that belongs to a different business", async () => {
    const businessA = await prisma.business.create({
      data: { name: "Cross Biz A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const businessB = await prisma.business.create({
      data: { name: "Cross Biz B", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    await prisma.merchant.create({
      data: {
        businessId: businessA.id,
        phoneNumber: "2348090000003",
        role: "STAFF",
        onboardingStep: "COMPLETE",
        removedAt: new Date(),
      },
    });

    await expect(
      addStaffMerchant(prisma, {
        businessId: businessB.id,
        phoneNumber: "2348090000003",
        invitedByMerchantId: "some-owner-id",
      }),
    ).rejects.toThrow(PhoneNumberAlreadyRegisteredError);
  });

  it("still refuses to reuse a number that's active (not removed) even within the same business", async () => {
    const activeBusiness = await prisma.business.create({
      data: { name: "Active Reuse Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    await prisma.merchant.create({
      data: { businessId: activeBusiness.id, phoneNumber: "2348090000004", role: "STAFF", onboardingStep: "COMPLETE" },
    });

    await expect(
      addStaffMerchant(prisma, {
        businessId: activeBusiness.id,
        phoneNumber: "2348090000004",
        invitedByMerchantId: "some-owner-id",
      }),
    ).rejects.toThrow(PhoneNumberAlreadyRegisteredError);
  });

  it("sends a proactive WhatsApp notification to the new staff member and audits success", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348070000001", role: "OWNER", onboardingStep: "COMPLETE" },
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    const staff = await addStaffMerchant(
      prisma,
      { businessId, phoneNumber: "2348070000002", invitedByMerchantId: owner.id },
      { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sentTo = (JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as { to: string }).to;
    expect(sentTo).toBe(staff.phoneNumber);

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: staff.id, entityType: "Merchant", action: "STAFF_MERCHANT_ADD_NOTIFICATION_SENT" },
    });
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0]?.metadata as { attempts?: number })?.attempts).toBe(1);
    expect((auditRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("text");
  });

  /**
   * Phase 21 gap closure: mirrors tests/businessDigest.test.ts's and
   * tests/deletion.test.ts's own "sends via a Meta-approved template" tests
   * — the identical 24-hour-window delivery risk Phase 9 fixed for the lapse
   * notification was never fixed for the staff-add notification until now.
   */
  it("sends via a Meta-approved template (not free-form text) when staffAddedTemplate is configured", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348070000007", role: "OWNER", onboardingStep: "COMPLETE" },
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    const staff = await addStaffMerchant(
      prisma,
      { businessId, phoneNumber: "2348070000008", invitedByMerchantId: owner.id },
      { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl, staffAddedTemplate: { name: "staff_added_notice", languageCode: "en_US" } },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("staff_added_notice");
    expect(body.template.language).toEqual({ code: "en_US" });
    expect(body.template.components).toBeUndefined();

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: staff.id, entityType: "Merchant", action: "STAFF_MERCHANT_ADD_NOTIFICATION_SENT" },
    });
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("template");
  });

  it("audits a failed notification but still resolves addStaffMerchant successfully", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348070000003", role: "OWNER", onboardingStep: "COMPLETE" },
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));

    const staff = await addStaffMerchant(
      prisma,
      { businessId, phoneNumber: "2348070000004", invitedByMerchantId: owner.id },
      { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
    );

    expect(staff.role).toBe("STAFF");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 400 is non-retryable, so no retry attempts.

    const failedRows = await prisma.auditLog.findMany({
      where: { entityId: staff.id, entityType: "Merchant", action: "STAFF_MERCHANT_ADD_NOTIFICATION_FAILED" },
    });
    expect(failedRows).toHaveLength(1);
    expect((failedRows[0]?.metadata as { error?: string })?.error).toMatch(/WhatsApp send failed \(400\)/);
  });

  it("skips the notification entirely when no outboundGateway is given", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348070000005", role: "OWNER", onboardingStep: "COMPLETE" },
    });

    const staff = await addStaffMerchant(prisma, {
      businessId,
      phoneNumber: "2348070000006",
      invitedByMerchantId: owner.id,
    });

    const notificationRows = await prisma.auditLog.findMany({
      where: {
        entityId: staff.id,
        entityType: "Merchant",
        action: { in: ["STAFF_MERCHANT_ADD_NOTIFICATION_SENT", "STAFF_MERCHANT_ADD_NOTIFICATION_FAILED"] },
      },
    });
    expect(notificationRows).toHaveLength(0);
  });
});

describe("removeStaffMerchant", () => {
  it("soft-removes a STAFF merchant by phone number and records an audit log entry", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348080000001", role: "OWNER", onboardingStep: "COMPLETE" },
    });
    const staff = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348080000002", role: "STAFF", onboardingStep: "COMPLETE" },
    });

    const removed = await removeStaffMerchant(prisma, {
      businessId,
      phoneNumber: staff.phoneNumber,
      removedByMerchantId: owner.id,
    });

    expect(removed.removedAt).not.toBeNull();

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: staff.id, entityType: "Merchant", action: "STAFF_MERCHANT_REMOVED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("MERCHANT");
    expect(auditRows[0]?.actorId).toBe(owner.id);
  });

  it("throws MerchantNotFoundError for an unknown phone number", async () => {
    await expect(
      removeStaffMerchant(prisma, { businessId, phoneNumber: "does-not-exist", removedByMerchantId: "someone" }),
    ).rejects.toThrow(MerchantNotFoundError);
  });

  it("throws CannotRemoveOwnerError when targeting the OWNER", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348080000003", role: "OWNER", onboardingStep: "COMPLETE" },
    });

    await expect(
      removeStaffMerchant(prisma, { businessId, phoneNumber: owner.phoneNumber, removedByMerchantId: owner.id }),
    ).rejects.toThrow(CannotRemoveOwnerError);
  });

  it("throws MerchantAlreadyRemovedError when the staff row was already removed", async () => {
    const owner = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348080000004", role: "OWNER", onboardingStep: "COMPLETE" },
    });
    const staff = await prisma.merchant.create({
      data: { businessId, phoneNumber: "2348080000005", role: "STAFF", onboardingStep: "COMPLETE" },
    });

    await removeStaffMerchant(prisma, { businessId, phoneNumber: staff.phoneNumber, removedByMerchantId: owner.id });

    await expect(
      removeStaffMerchant(prisma, { businessId, phoneNumber: staff.phoneNumber, removedByMerchantId: owner.id }),
    ).rejects.toThrow(MerchantAlreadyRemovedError);
  });
});
