import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  expireLapsedSubscriptions,
  SUBSCRIPTION_EXPIRY_JOB_NAME,
  SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY,
} from "../src/domain/subscriptionExpiry.js";
import { getEffectivePlan } from "../src/domain/billing.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";
import { setFeatureFlagForBusiness } from "../src/domain/featureFlags.js";

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
    where: { code: "FREE" },
    update: {},
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false },
  });
  await prisma.plan.upsert({
    where: { code: "PRO" },
    update: {},
    create: { code: "PRO", name: "Pro", priceMinor: 500000n, currencyCode: "NGN", entryCapPerMonth: null, voiceEnabled: true },
  });

  await prisma.featureFlag.create({
    data: {
      key: SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY,
      description: "test flag",
      enabledByDefault: false,
    },
  });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

async function makeBusiness(name: string): Promise<string> {
  const business = await prisma.business.create({
    data: { name, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  return business.id;
}

describe("expireLapsedSubscriptions", () => {
  it("flips a lapsed ACTIVE subscription to PAST_DUE and records a SYSTEM-attributed audit log", async () => {
    const businessId = await makeBusiness("Lapsed Shop");
    const now = new Date();
    const subscription = await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    });

    const result = await expireLapsedSubscriptions(prisma, now);
    expect(result.expiredCount).toBe(1);
    expect(result.expiredSubscriptionIds).toEqual([subscription.id]);

    const reloaded = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(reloaded.status).toBe("PAST_DUE");

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "Subscription", action: "SUBSCRIPTION_EXPIRED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("SYSTEM");
    expect(auditRows[0]?.actorId).toBe(SUBSCRIPTION_EXPIRY_JOB_NAME);
  });

  it("does not touch an ACTIVE subscription whose period has not yet lapsed", async () => {
    const businessId = await makeBusiness("Still Active Shop");
    const now = new Date();
    const subscription = await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const result = await expireLapsedSubscriptions(prisma, now);
    expect(result.expiredSubscriptionIds).not.toContain(subscription.id);

    const reloaded = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(reloaded.status).toBe("ACTIVE");
  });

  it("is idempotent — a second sweep does not re-expire or double-audit an already-PAST_DUE row", async () => {
    const businessId = await makeBusiness("Double Sweep Shop");
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    });

    const first = await expireLapsedSubscriptions(prisma, now);
    expect(first.expiredCount).toBe(1);

    const second = await expireLapsedSubscriptions(prisma, now);
    expect(second.expiredCount).toBe(0);

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "Subscription", action: "SUBSCRIPTION_EXPIRED" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("leaves an already-CANCELED subscription untouched", async () => {
    const businessId = await makeBusiness("Already Canceled Shop");
    const now = new Date();
    const subscription = await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "CANCELED",
        currentPeriodStart: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    });

    const result = await expireLapsedSubscriptions(prisma, now);
    expect(result.expiredSubscriptionIds).not.toContain(subscription.id);

    const reloaded = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(reloaded.status).toBe("CANCELED");
  });

  it("after a sweep, getEffectivePlan for the business reflects the fallback plan (FREE)", async () => {
    const businessId = await makeBusiness("Post Sweep Effective Plan Shop");
    const now = new Date();
    await prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    });

    await expireLapsedSubscriptions(prisma, now);

    const scoped = getTenantScopedClient(prisma, businessId);
    const effective = await getEffectivePlan(scoped, businessId, now);
    expect(effective.code).toBe("FREE");
  });
});

describe("expireLapsedSubscriptions — subscription-lapse WhatsApp notification (Phase 7)", () => {
  async function makeLapsedSubscription(businessId: string, now: Date) {
    return prisma.subscription.create({
      data: {
        businessId,
        planCode: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    });
  }

  it("does nothing when the feature flag is off, even if an outboundGateway is supplied", async () => {
    const businessId = await makeBusiness("Notif Flag Off Shop");
    await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110001" } });
    const now = new Date();
    await makeLapsedSubscription(businessId, now);

    const fetchImpl = vi.fn();
    await expireLapsedSubscriptions(prisma, now, { accessToken: "t", phoneNumberId: "p", fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing when the flag is on but no outboundGateway is supplied", async () => {
    const businessId = await makeBusiness("Notif No Gateway Shop");
    await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110002" } });
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY, true);
    const now = new Date();
    await makeLapsedSubscription(businessId, now);

    // Should not throw even though no gateway is configured for this call.
    const result = await expireLapsedSubscriptions(prisma, now);
    expect(result.expiredCount).toBe(1);

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_LAPSE_NOTIFICATION_SENT" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("sends a WhatsApp text message to every registered merchant and audits each send when the flag is on", async () => {
    const businessId = await makeBusiness("Notif Enabled Shop");
    const merchantA = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110003" } });
    const merchantB = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110004", role: "STAFF" } });
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY, true);
    const now = new Date();
    const subscription = await makeLapsedSubscription(businessId, now);

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await expireLapsedSubscriptions(prisma, now, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sentTo = fetchImpl.mock.calls.map((call) => (JSON.parse((call[1] as RequestInit).body as string) as { to: string }).to);
    expect(sentTo.sort()).toEqual([merchantA.phoneNumber, merchantB.phoneNumber].sort());

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_LAPSE_NOTIFICATION_SENT" },
      orderBy: { createdAt: "asc" },
    });
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.entityId).sort()).toEqual([merchantA.id, merchantB.id].sort());
    expect(auditRows[0]?.actorType).toBe("SYSTEM");
    expect(auditRows[0]?.actorId).toBe(SUBSCRIPTION_EXPIRY_JOB_NAME);
    expect(auditRows[0]?.metadata).toMatchObject({ subscriptionId: subscription.id, planCode: "PRO" });
  });

  it("retries a rate-limited (429) send up to 3 attempts, then audits it as failed with the attempt count", async () => {
    const businessId = await makeBusiness("Notif Failure Shop");
    const merchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110005" } });
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY, true);
    const now = new Date();
    await makeLapsedSubscription(businessId, now);

    // mockImplementation (not mockResolvedValue) so every retry attempt gets its own Response
    // instance — a single shared Response's body stream can only be read once (by
    // postToGraphApi's `response.text()` on the non-ok path), so reusing one across the 3
    // retry attempts throws "Body is unusable: Body has already been read" on attempt 2.
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("rate limited", { status: 429 }));
    const result = await expireLapsedSubscriptions(prisma, now, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });

    expect(result.expiredCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const failedRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_LAPSE_NOTIFICATION_FAILED" },
    });
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]?.entityId).toBe(merchant.id);
    expect((failedRows[0]?.metadata as { error?: string; attempts?: number })?.error).toMatch(/WhatsApp send failed \(429\)/);
    expect((failedRows[0]?.metadata as { attempts?: number })?.attempts).toBe(3);

    const sentRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_LAPSE_NOTIFICATION_SENT" },
    });
    expect(sentRows).toHaveLength(0);
  }, 10_000);

  it("retries a transient failure and succeeds on the second attempt, auditing the attempt count", async () => {
    const businessId = await makeBusiness("Notif Retry Success Shop");
    const merchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110006" } });
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY, true);
    const now = new Date();
    await makeLapsedSubscription(businessId, now);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    const result = await expireLapsedSubscriptions(prisma, now, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });

    expect(result.expiredCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const sentRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_LAPSE_NOTIFICATION_SENT", entityId: merchant.id },
    });
    expect(sentRows).toHaveLength(1);
    expect((sentRows[0]?.metadata as { attempts?: number })?.attempts).toBe(2);
  }, 10_000);

  it("does not retry a non-retryable (e.g. 400) failure — fails after a single attempt", async () => {
    const businessId = await makeBusiness("Notif Permanent Failure Shop");
    const merchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110007" } });
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY, true);
    const now = new Date();
    await makeLapsedSubscription(businessId, now);

    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expireLapsedSubscriptions(prisma, now, { accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const failedRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_LAPSE_NOTIFICATION_FAILED", entityId: merchant.id },
    });
    expect(failedRows).toHaveLength(1);
    expect((failedRows[0]?.metadata as { attempts?: number })?.attempts).toBe(1);
  });

  it("sends via a Meta-approved template (not free-form text) when lapseNotificationTemplate is configured", async () => {
    const businessId = await makeBusiness("Notif Template Shop");
    const merchant = await prisma.merchant.create({ data: { businessId, phoneNumber: "+2340001110008" } });
    const scoped = getTenantScopedClient(prisma, businessId);
    await setFeatureFlagForBusiness(scoped, businessId, SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY, true);
    const now = new Date();
    await makeLapsedSubscription(businessId, now);

    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    await expireLapsedSubscriptions(prisma, now, {
      accessToken: "test-token",
      phoneNumberId: "pn-1",
      fetchImpl,
      lapseNotificationTemplate: { name: "subscription_lapse_notice", languageCode: "en_US" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("template");
    expect(body.template).toEqual({
      name: "subscription_lapse_notice",
      language: { code: "en_US" },
      components: [{ type: "body", parameters: [{ type: "text", text: "PRO" }] }],
    });

    const sentRows = await prisma.auditLog.findMany({
      where: { businessId, action: "SUBSCRIPTION_LAPSE_NOTIFICATION_SENT", entityId: merchant.id },
    });
    expect(sentRows).toHaveLength(1);
    expect((sentRows[0]?.metadata as { sendMethod?: string })?.sendMethod).toBe("template");
  });
});
