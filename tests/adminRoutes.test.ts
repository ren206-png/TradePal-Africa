import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";

const JWT_SECRET = "test-secret-do-not-use-in-production";

let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let businessId: string;
let merchantId: string;

async function login(email: string, password: string) {
  const response = await request(app).post("/admin/login").send({ email, password });
  return response;
}

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

  const merchant = await prisma.merchant.create({
    data: { businessId, phoneNumber: "+2340000000001", onboardingStep: "COMPLETE" },
  });
  merchantId = merchant.id;

  await prisma.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false },
  });

  await prisma.paymentProvider.upsert({
    where: { code: "FLUTTERWAVE" },
    update: {},
    create: { code: "FLUTTERWAVE", countryCode: "NG", config: {}, enabled: true },
  });

  await createAdminUser(prisma, { email: "super@tradepal.test", name: "Super Admin", role: "SUPER_ADMIN", password: "correct-horse" });
  await createAdminUser(prisma, { email: "analyst@tradepal.test", name: "Analyst", role: "ANALYST", password: "correct-horse" });
  await createAdminUser(prisma, { email: "support@tradepal.test", name: "Support", role: "SUPPORT", password: "correct-horse" });

  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, JWT_SECRET));
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("POST /admin/login", () => {
  it("issues a token for correct credentials", async () => {
    const res = await login("super@tradepal.test", "correct-horse");
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.admin.role).toBe("SUPER_ADMIN");
    expect(res.body.admin.passwordHash).toBeUndefined();
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await login("super@tradepal.test", "wrong-password");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid email or password/i);
  });

  it("rejects an unknown email with the same generic message (no account enumeration)", async () => {
    const res = await login("nobody@tradepal.test", "whatever");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid email or password/i);
  });
});

describe("authenticated routes", () => {
  it("reject requests with no Authorization header", async () => {
    const res = await request(app).get("/admin/businesses");
    expect(res.status).toBe(401);
  });

  it("reject requests with a garbage token", async () => {
    const res = await request(app).get("/admin/businesses").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("GET /admin/businesses lists businesses for any authenticated role, including ANALYST", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app).get("/admin/businesses").set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.businesses.some((b: { id: string }) => b.id === businessId)).toBe(true);
  });

  it("GET /admin/businesses/:id returns 404 for an unknown business", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .get("/admin/businesses/does-not-exist")
      .set("Authorization", `Bearer ${body.token}`);
    expect(res.status).toBe(404);
  });

  it("GET /admin/deletion-requests defaults to PENDING and GET /admin/audit-logs lists entries", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const auth = `Bearer ${body.token}`;

    const deletionRes = await request(app).get("/admin/deletion-requests").set("Authorization", auth);
    expect(deletionRes.status).toBe(200);
    expect(Array.isArray(deletionRes.body.deletionRequests)).toBe(true);

    const auditRes = await request(app).get("/admin/audit-logs").set("Authorization", auth);
    expect(auditRes.status).toBe(200);
    expect(Array.isArray(auditRes.body.auditLogs)).toBe(true);
  });
});

describe("POST /admin/merchants/:id/phone-number (RBAC + write path)", () => {
  it("refuses an ANALYST, even though they're authenticated", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");

    const res = await request(app)
      .post(`/admin/merchants/${merchantId}/phone-number`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId, newPhoneNumber: "+2340000000099", reason: "Analyst attempting a write." });

    expect(res.status).toBe(403);
  });

  it("allows SUPPORT to change a merchant's phone number and records an audit log entry attributing the admin", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");

    const res = await request(app)
      .post(`/admin/merchants/${merchantId}/phone-number`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId, newPhoneNumber: "+2340000000002", reason: "Merchant lost phone; verified via call." });

    expect(res.status).toBe(200);
    expect(res.body.merchant.phoneNumber).toBe("+2340000000002");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: merchantId, entityType: "Merchant", action: "MERCHANT_PHONE_NUMBER_CHANGED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorId).toBe(body.admin.id);
  });

  it("rejects a request missing the mandatory reason with a 400, not a 500", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");

    const res = await request(app)
      .post(`/admin/merchants/${merchantId}/phone-number`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId, newPhoneNumber: "+2340000000003" });

    expect(res.status).toBe(400);
  });
});

describe("POST /admin/deletion-requests/:id/complete and /reject (RBAC + write path)", () => {
  it("refuses an ANALYST, even though they're authenticated", async () => {
    const customer = await prisma.customer.create({ data: { businessId, name: "Analyst Test Customer" } });
    const deletionRequest = await prisma.deletionRequest.create({
      data: { businessId, customerId: customer.id, requestorType: "MERCHANT", description: "test" },
    });

    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/deletion-requests/${deletionRequest.id}/complete`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId });

    expect(res.status).toBe(403);
  });

  it("allows SUPPORT to complete a request, anonymizing the customer and attributing the audit log to that admin", async () => {
    const customer = await prisma.customer.create({ data: { businessId, name: "Grace" } });
    const deletionRequest = await prisma.deletionRequest.create({
      data: { businessId, customerId: customer.id, requestorType: "CUSTOMER_VIA_MERCHANT", description: "test" },
    });

    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/deletion-requests/${deletionRequest.id}/complete`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId, resolutionNote: "Verified and anonymized." });

    expect(res.status).toBe(200);
    expect(res.body.deletionRequest.status).toBe("COMPLETED");

    const anonymized = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(anonymized?.isAnonymized).toBe(true);
    expect(anonymized?.name).not.toBe("Grace");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: deletionRequest.id, action: "DELETION_REQUEST_COMPLETED" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorType).toBe("ADMIN");
    expect(auditRows[0]?.actorId).toBe(body.admin.id);
  });

  it("returns 404 for an unknown deletion request id", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/deletion-requests/does-not-exist/complete")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId });

    expect(res.status).toBe(404);
  });

  it("returns 409 when completing an already-resolved request", async () => {
    const customer = await prisma.customer.create({ data: { businessId, name: "Hassan" } });
    const deletionRequest = await prisma.deletionRequest.create({
      data: { businessId, customerId: customer.id, requestorType: "MERCHANT", description: "test" },
    });

    const { body } = await login("super@tradepal.test", "correct-horse");
    const auth = `Bearer ${body.token}`;

    const first = await request(app)
      .post(`/admin/deletion-requests/${deletionRequest.id}/complete`)
      .set("Authorization", auth)
      .send({ businessId });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/admin/deletion-requests/${deletionRequest.id}/complete`)
      .set("Authorization", auth)
      .send({ businessId });
    expect(second.status).toBe(409);
  });

  it("rejects a /reject request missing the mandatory resolutionNote with a 400, not a 500", async () => {
    const customer = await prisma.customer.create({ data: { businessId, name: "Ibrahim" } });
    const deletionRequest = await prisma.deletionRequest.create({
      data: { businessId, customerId: customer.id, requestorType: "MERCHANT", description: "test" },
    });

    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/deletion-requests/${deletionRequest.id}/reject`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId });

    expect(res.status).toBe(400);
  });

  it("allows SUPPORT to reject a request with a resolution note, leaving the customer untouched", async () => {
    const customer = await prisma.customer.create({ data: { businessId, name: "Joy" } });
    const deletionRequest = await prisma.deletionRequest.create({
      data: { businessId, customerId: customer.id, requestorType: "CUSTOMER_DIRECT", description: "test" },
    });

    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/deletion-requests/${deletionRequest.id}/reject`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ businessId, resolutionNote: "Could not verify identity." });

    expect(res.status).toBe(200);
    expect(res.body.deletionRequest.status).toBe("REJECTED");

    const untouched = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(untouched?.isAnonymized).toBe(false);
    expect(untouched?.name).toBe("Joy");
  });
});

describe("POST /admin/logout (JWT revocation)", () => {
  it("logs out successfully, and the same token is rejected as 401 afterward", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const auth = `Bearer ${body.token}`;

    // Token works before logout.
    const before = await request(app).get("/admin/businesses").set("Authorization", auth);
    expect(before.status).toBe(200);

    const logoutRes = await request(app).post("/admin/logout").set("Authorization", auth);
    expect(logoutRes.status).toBe(200);

    // Same token is now rejected, even though it hasn't naturally expired.
    const after = await request(app).get("/admin/businesses").set("Authorization", auth);
    expect(after.status).toBe(401);
    expect(after.body.error).toMatch(/logged out/i);
  });

  it("does not affect a different admin's still-valid token", async () => {
    const supportLogin = await login("support@tradepal.test", "correct-horse");
    const analystLogin = await login("analyst@tradepal.test", "correct-horse");

    await request(app).post("/admin/logout").set("Authorization", `Bearer ${supportLogin.body.token}`);

    const res = await request(app).get("/admin/businesses").set("Authorization", `Bearer ${analystLogin.body.token}`);
    expect(res.status).toBe(200);
  });
});

describe("POST /admin/login rate limiting", () => {
  it("returns 429 with Retry-After once the per-email attempt limit is exceeded, and a correct login still works after reset()", async () => {
    // A fresh router + tiny limit so this test doesn't depend on / interfere with the shared app's counters.
    const limitedApp = express();
    limitedApp.use(express.json());
    limitedApp.use("/admin", createAdminRouter(prisma, JWT_SECRET, { loginRateLimiter: new InMemoryLoginRateLimiter(2, 60_000) }));

    const attempt = () => request(limitedApp).post("/admin/login").send({ email: "super@tradepal.test", password: "wrong" });

    const first = await attempt();
    const second = await attempt();
    const third = await attempt();

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a successful login resets the counter so subsequent attempts aren't blocked by earlier failures", async () => {
    const limitedApp = express();
    limitedApp.use(express.json());
    limitedApp.use("/admin", createAdminRouter(prisma, JWT_SECRET, { loginRateLimiter: new InMemoryLoginRateLimiter(2, 60_000) }));

    await request(limitedApp).post("/admin/login").send({ email: "analyst@tradepal.test", password: "wrong" });
    const success = await request(limitedApp).post("/admin/login").send({ email: "analyst@tradepal.test", password: "correct-horse" });
    expect(success.status).toBe(200);

    // Fresh attempts after a reset should be allowed again (not still counted from before the reset).
    const afterReset = await request(limitedApp).post("/admin/login").send({ email: "analyst@tradepal.test", password: "wrong" });
    expect(afterReset.status).toBe(401);
  });
});

describe("GET /admin/businesses pagination", () => {
  it("respects ?take= and reports hasMore, and a later page (via ?skip=) returns different rows", async () => {
    // Seed extra businesses so there are enough rows to paginate over, on top of the one created in beforeAll.
    for (let i = 0; i < 5; i += 1) {
      await prisma.business.create({
        data: { name: `Pagination Shop ${i}`, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
    }

    const { body: loginBody } = await login("super@tradepal.test", "correct-horse");
    const auth = `Bearer ${loginBody.token}`;

    const page1 = await request(app).get("/admin/businesses?take=2&skip=0").set("Authorization", auth);
    expect(page1.status).toBe(200);
    expect(page1.body.businesses).toHaveLength(2);
    expect(page1.body.pagination).toEqual({ take: 2, skip: 0, hasMore: true });

    const page2 = await request(app).get("/admin/businesses?take=2&skip=2").set("Authorization", auth);
    expect(page2.status).toBe(200);
    expect(page2.body.businesses).toHaveLength(2);

    const page1Ids = page1.body.businesses.map((b: { id: string }) => b.id);
    const page2Ids = page2.body.businesses.map((b: { id: string }) => b.id);
    expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);
  });
});

describe("GET /admin/mobile-money-alerts", () => {
  it("lists alerts, supports a status filter, and is paginated", async () => {
    await prisma.mobileMoneyAlert.create({
      data: {
        businessId,
        provider: "M-PESA",
        amountMinor: 10000n,
        currencyCode: "NGN",
        rawText: "unmatched alert",
        matchStatus: "UNMATCHED",
      },
    });
    await prisma.mobileMoneyAlert.create({
      data: {
        businessId,
        provider: "M-PESA",
        amountMinor: 20000n,
        currencyCode: "NGN",
        rawText: "suggested alert",
        matchStatus: "SUGGESTED",
      },
    });

    const { body: loginBody } = await login("super@tradepal.test", "correct-horse");
    const auth = `Bearer ${loginBody.token}`;

    const all = await request(app).get("/admin/mobile-money-alerts").set("Authorization", auth);
    expect(all.status).toBe(200);
    expect(all.body.mobileMoneyAlerts.length).toBeGreaterThanOrEqual(2);
    expect(all.body.pagination).toMatchObject({ take: expect.any(Number), skip: 0 });

    const suggestedOnly = await request(app)
      .get("/admin/mobile-money-alerts?status=SUGGESTED")
      .set("Authorization", auth);
    expect(suggestedOnly.status).toBe(200);
    expect(suggestedOnly.body.mobileMoneyAlerts.every((a: { matchStatus: string }) => a.matchStatus === "SUGGESTED")).toBe(
      true,
    );
    expect(
      suggestedOnly.body.mobileMoneyAlerts.some((a: { rawText: string }) => a.rawText === "suggested alert"),
    ).toBe(true);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/admin/mobile-money-alerts");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/plans and POST /admin/plans (RBAC + write path)", () => {
  it("GET /admin/plans lists plans for any authenticated role, with priceMinor serialized as a string", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app).get("/admin/plans").set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    const free = res.body.plans.find((p: { code: string }) => p.code === "FREE");
    expect(free).toBeDefined();
    expect(typeof free.priceMinor).toBe("string");
  });

  it("refuses a SUPPORT admin (only SUPER_ADMIN may create/update plans)", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/plans")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ code: "PRO", name: "Pro", priceMinor: "500000", currencyCode: "NGN", entryCapPerMonth: null, voiceEnabled: true });

    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN can create a new plan, with priceMinor accepted/returned as a string", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/plans")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ code: "PRO", name: "Pro", priceMinor: "500000", currencyCode: "NGN", entryCapPerMonth: null, voiceEnabled: true });

    expect(res.status).toBe(200);
    expect(res.body.plan.code).toBe("PRO");
    expect(res.body.plan.priceMinor).toBe("500000");
    expect(res.body.plan.entryCapPerMonth).toBeNull();
  });

  it("rejects an unknown currencyCode with a 400", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/plans")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ code: "BADCUR", name: "Bad Currency", priceMinor: "100", currencyCode: "ZZZ", entryCapPerMonth: 10, voiceEnabled: false });

    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric priceMinor with a 400 (schema validation, not a 500)", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/plans")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ code: "BADPRICE", name: "Bad Price", priceMinor: "not-a-number", currencyCode: "NGN", entryCapPerMonth: 10, voiceEnabled: false });

    expect(res.status).toBe(400);
  });
});

describe("POST /admin/businesses/:id/subscription (+ /cancel) (RBAC + write path)", () => {
  it("refuses an ANALYST", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const now = new Date();
    const res = await request(app)
      .post(`/admin/businesses/${businessId}/subscription`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({
        planCode: "PRO",
        currentPeriodStart: now.toISOString(),
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

    expect(res.status).toBe(403);
  });

  it("SUPPORT can assign a business to a plan, and GET /admin/businesses/:id reflects it as currentPlan", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const now = new Date();

    const assignRes = await request(app)
      .post(`/admin/businesses/${businessId}/subscription`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({
        planCode: "PRO",
        currentPeriodStart: now.toISOString(),
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        reason: "Merchant paid via bank transfer, verified by support.",
      });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.subscription.planCode).toBe("PRO");

    const detailRes = await request(app)
      .get(`/admin/businesses/${businessId}`)
      .set("Authorization", `Bearer ${body.token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.currentPlan.code).toBe("PRO");
    expect(detailRes.body.business.subscriptions.some((s: { planCode: string }) => s.planCode === "PRO")).toBe(true);
  });

  it("returns 404 for an unknown planCode", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const now = new Date();
    const res = await request(app)
      .post(`/admin/businesses/${businessId}/subscription`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({
        planCode: "DOES-NOT-EXIST",
        currentPeriodStart: now.toISOString(),
        currentPeriodEnd: new Date(now.getTime() + 1000).toISOString(),
      });

    expect(res.status).toBe(404);
  });

  it("POST /cancel cancels the active subscription and falls the business back to FREE", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");

    const cancelRes = await request(app)
      .post(`/admin/businesses/${businessId}/subscription/cancel`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ reason: "Testing cancellation." });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.subscription.status).toBe("CANCELED");

    const detailRes = await request(app)
      .get(`/admin/businesses/${businessId}`)
      .set("Authorization", `Bearer ${body.token}`);
    expect(detailRes.body.currentPlan.code).toBe("FREE");
  });

  it("POST /cancel returns 404 when there is no active subscription to cancel", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");

    // businessId's subscription was just canceled in the previous test, so calling again should 404.
    const res = await request(app)
      .post(`/admin/businesses/${businessId}/subscription/cancel`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe("POST /admin/maintenance/expire-subscriptions (RBAC + Phase 6 sweep trigger)", () => {
  it("refuses a SUPPORT admin — this is a global maintenance action, not a single-business write", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/maintenance/expire-subscriptions")
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(403);
  });

  it("refuses an ANALYST admin", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/maintenance/expire-subscriptions")
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(403);
  });

  it("allows a SUPER_ADMIN to trigger the sweep, which flips a lapsed ACTIVE subscription to PAST_DUE", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");

    // Assign a business a subscription whose period has already lapsed.
    const now = new Date();
    await request(app)
      .post(`/admin/businesses/${businessId}/subscription`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({
        planCode: "PRO",
        currentPeriodStart: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        currentPeriodEnd: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      });

    const sweepRes = await request(app)
      .post("/admin/maintenance/expire-subscriptions")
      .set("Authorization", `Bearer ${body.token}`);

    expect(sweepRes.status).toBe(200);
    expect(sweepRes.body.expiredCount).toBeGreaterThanOrEqual(1);

    const detailRes = await request(app)
      .get(`/admin/businesses/${businessId}`)
      .set("Authorization", `Bearer ${body.token}`);
    expect(detailRes.body.currentPlan.code).toBe("FREE");
    expect(
      detailRes.body.business.subscriptions.some(
        (s: { planCode: string; status: string }) => s.planCode === "PRO" && s.status === "PAST_DUE",
      ),
    ).toBe(true);
  });
});

describe("POST /admin/maintenance/expire-payment-requests (RBAC + Phase 26 sweep trigger)", () => {
  it("refuses a SUPPORT admin — this is a global maintenance action, not a single-business write", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/maintenance/expire-payment-requests")
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(403);
  });

  it("refuses an ANALYST admin", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/maintenance/expire-payment-requests")
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(403);
  });

  it("allows a SUPER_ADMIN to trigger the sweep, which flips a stale PENDING PaymentRequest to EXPIRED", async () => {
    // Deliberately its own business, not the shared module-level `businessId` — the
    // Phase 24 payment-requests listing test above asserts that business has exactly
    // one PaymentRequest row, and adding a second here would break that count.
    const sweepBusiness = await prisma.business.create({
      data: { name: "Sweep Trigger Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const staleRequest = await prisma.paymentRequest.create({
      data: {
        businessId: sweepBusiness.id,
        description: "Admin sweep test paylink",
        amountMinor: 25000n,
        currencyCode: "NGN",
        status: "PENDING",
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });

    const { body } = await login("super@tradepal.test", "correct-horse");
    const sweepRes = await request(app)
      .post("/admin/maintenance/expire-payment-requests")
      .set("Authorization", `Bearer ${body.token}`);

    expect(sweepRes.status).toBe(200);
    expect(sweepRes.body.expiredPaymentRequestIds).toContain(staleRequest.id);

    const reloaded = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: staleRequest.id } });
    expect(reloaded.status).toBe("EXPIRED");
  });
});

describe("feature flag admin routes (Phase 10)", () => {
  it("GET /admin/feature-flags lists flags for any authenticated role, including ANALYST", async () => {
    await prisma.featureFlag.create({
      data: { key: "route-test-flag", description: "test flag", enabledByDefault: false },
    });

    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app).get("/admin/feature-flags").set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.featureFlags.some((f: { key: string }) => f.key === "route-test-flag")).toBe(true);
  });

  it("POST /admin/feature-flags/:key refuses SUPPORT (only SUPER_ADMIN may flip a global default)", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/feature-flags/route-test-flag")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ enabledByDefault: true });

    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN can flip a global default, and it's reflected in the list", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/feature-flags/route-test-flag")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ enabledByDefault: true });

    expect(res.status).toBe(200);
    expect(res.body.featureFlag.enabledByDefault).toBe(true);
  });

  it("POST /admin/feature-flags/:key returns 404 for an unknown flag key", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post("/admin/feature-flags/does-not-exist")
      .set("Authorization", `Bearer ${body.token}`)
      .send({ enabledByDefault: true });

    expect(res.status).toBe(404);
  });

  it("GET /admin/businesses/:id/feature-flags returns 404 for an unknown business", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .get("/admin/businesses/does-not-exist/feature-flags")
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(404);
  });

  it("GET /admin/businesses/:id/feature-flags shows the merged per-business state", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .get(`/admin/businesses/${businessId}/feature-flags`)
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    const flag = res.body.featureFlags.find((f: { key: string }) => f.key === "route-test-flag");
    expect(flag).toBeDefined();
    expect(flag.override).toBeNull();
    expect(flag.effective).toBe(true);
  });

  it("POST /admin/businesses/:id/feature-flags/:key refuses an ANALYST", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/businesses/${businessId}/feature-flags/route-test-flag`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ enabled: false });

    expect(res.status).toBe(403);
  });

  it("SUPPORT can set a per-business override, which then wins over the global default", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/businesses/${businessId}/feature-flags/route-test-flag`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ enabled: false, reason: "opted out for testing" });

    expect(res.status).toBe(200);
    expect(res.body.featureFlag.enabled).toBe(false);

    const listRes = await request(app)
      .get(`/admin/businesses/${businessId}/feature-flags`)
      .set("Authorization", `Bearer ${body.token}`);
    const flag = listRes.body.featureFlags.find((f: { key: string }) => f.key === "route-test-flag");
    expect(flag.override).toBe(false);
    expect(flag.effective).toBe(false);

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "BusinessFeatureFlag", entityId: "route-test-flag", action: "BUSINESS_FEATURE_FLAG_SET" },
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /admin/businesses/:id/feature-flags/:key returns 404 for an unknown business", async () => {
    const { body } = await login("super@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/businesses/does-not-exist/feature-flags/route-test-flag`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it("POST /admin/businesses/:id/feature-flags/:key/reset reverts the business back to the global default", async () => {
    const { body } = await login("support@tradepal.test", "correct-horse");
    const res = await request(app)
      .post(`/admin/businesses/${businessId}/feature-flags/route-test-flag/reset`)
      .set("Authorization", `Bearer ${body.token}`)
      .send({ reason: "reverting to default for testing" });

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);

    const listRes = await request(app)
      .get(`/admin/businesses/${businessId}/feature-flags`)
      .set("Authorization", `Bearer ${body.token}`);
    const flag = listRes.body.featureFlags.find((f: { key: string }) => f.key === "route-test-flag");
    expect(flag.override).toBeNull();
    expect(flag.effective).toBe(true);
  });
});

describe("GET /admin/businesses/:id/invoices (Phase 23)", () => {
  it("returns 404 for an unknown business", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .get("/admin/businesses/does-not-exist/invoices")
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(404);
  });

  it("lists a business's invoices, serializing amountMinor as a string, and never leaks another business's invoices", async () => {
    const otherBusiness = await prisma.business.create({
      data: { name: "Shop B", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });

    const subscription = await prisma.subscription.create({
      data: {
        businessId,
        planCode: "FREE",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const otherSubscription = await prisma.subscription.create({
      data: {
        businessId: otherBusiness.id,
        planCode: "FREE",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        subscriptionId: subscription.id,
        amountMinor: 500000n,
        currencyCode: "NGN",
        status: "PAID",
        dueDate: new Date(),
        paidAt: new Date(),
      },
    });
    await prisma.invoice.create({
      data: {
        subscriptionId: otherSubscription.id,
        amountMinor: 250000n,
        currencyCode: "NGN",
        status: "PENDING",
        dueDate: new Date(),
      },
    });

    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .get(`/admin/businesses/${businessId}/invoices`)
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].id).toBe(invoice.id);
    expect(res.body.invoices[0].amountMinor).toBe("500000");
    expect(res.body.invoices[0].status).toBe("PAID");
    expect(res.body.invoices[0].subscription.planCode).toBe("FREE");
    expect(res.body.pagination).toEqual({ take: 20, skip: 0, hasMore: false });
  });
});

describe("GET /admin/businesses/:id/payment-requests (Phase 24)", () => {
  it("returns 404 for an unknown business", async () => {
    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .get("/admin/businesses/does-not-exist/payment-requests")
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(404);
  });

  it("lists a business's payment requests, serializing amountMinor as a string, and never leaks another business's payment requests", async () => {
    const otherBusiness = await prisma.business.create({
      data: { name: "Shop C", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const customer = await prisma.customer.create({ data: { businessId, name: "Amina" } });

    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        businessId,
        customerId: customer.id,
        description: "Payment from Amina",
        amountMinor: 75000n,
        currencyCode: "NGN",
        status: "PAID",
        providerCode: "FLUTTERWAVE",
        providerReference: "tpr_test-1",
        paidAt: new Date(),
      },
    });
    await prisma.paymentRequest.create({
      data: {
        businessId: otherBusiness.id,
        description: "Payment from a stranger",
        amountMinor: 10000n,
        currencyCode: "NGN",
        status: "PENDING",
        providerCode: "FLUTTERWAVE",
        providerReference: "tpr_test-2",
      },
    });

    const { body } = await login("analyst@tradepal.test", "correct-horse");
    const res = await request(app)
      .get(`/admin/businesses/${businessId}/payment-requests`)
      .set("Authorization", `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.paymentRequests).toHaveLength(1);
    expect(res.body.paymentRequests[0].id).toBe(paymentRequest.id);
    expect(res.body.paymentRequests[0].amountMinor).toBe("75000");
    expect(res.body.paymentRequests[0].status).toBe("PAID");
    expect(res.body.paymentRequests[0].customer.name).toBe("Amina");
    expect(res.body.pagination).toEqual({ take: 20, skip: 0, hasMore: false });
  });
});
