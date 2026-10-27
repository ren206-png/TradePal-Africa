import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { PHONE, billingWorld, makeSlBusiness, publishedPlan, seedSierraLeone } from "./helpers/billing.js";
import { FakeRedis } from "./helpers/fakeRedis.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { ADMIN_JWT_AUDIENCE } from "../src/admin/auth.js";
import { RedisLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { executeRefund, requestRefund, approveRefund } from "../src/admin/refundRequests.js";
import { csvText } from "../src/admin/csv.js";
import { buildBillingConfigFromEnv, setBillingConfig } from "../src/domain/subscriptions/common.js";
import { startRenewal } from "../src/domain/subscriptions/renewal.js";
import { applyBillingDeposit } from "../src/domain/subscriptions/collection.js";
import { buildHarness, PW, SECRET, type Harness } from "./helpers/adminConsole.js";

vi.setConfig({ testTimeout: 300_000 });

/**
 * Admin-console Phase 4: the adversarial self-check. One block per scenario in docs/admin/security.md; each shows the attack failing.
 * (Scenarios 5, 6, 7, 10 and 14 are also covered where noted in security.md.)
 */
const REAL = !!process.env["TEST_PG_ADMIN_URL"];
let testDb: TestDb;
let prisma: PrismaClient;
let h: Harness;
const closers: Harness[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  await seedSierraLeone(prisma);
  for (const [email, role] of [["owner@t.test", "SUPER_ADMIN"], ["owner2@t.test", "SUPER_ADMIN"], ["support@t.test", "SUPPORT"], ["fin1@t.test", "FINANCE_ADMIN"], ["fin2@t.test", "FINANCE_ADMIN"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  h = buildHarness(prisma, { enforceMfa: false });
}, 90_000);
afterAll(async () => {
  h.close();
  for (const c of closers) c.close();
  setBillingConfig(null);
  await testDb.teardown();
});

describe("1. a merchant (or anyone) who writes 'role: platform_owner' into data they control gains nothing", () => {
  it("takes the role from the staff table, never from a token claim or any editable field", async () => {
    const support = await prisma.adminUser.findUniqueOrThrow({ where: { email: "support@t.test" } });
    // even a correctly signed token that CLAIMS the owner role is ignored: the database says support
    const { token } = await h.signedIn("support@t.test");
    const sid = (jwt.decode(token) as { jti: string }).jti;
    const lying = jwt.sign({ adminUserId: support.id, email: support.email, role: "SUPER_ADMIN" }, SECRET, { expiresIn: 600, jwtid: sid, audience: ADMIN_JWT_AUDIENCE });
    expect((await h.http().get("/admin/me/permissions").set(h.auth(lying))).body.role).toBe("SUPPORT");
    expect((await h.http().get("/admin/admins").set(h.auth(lying))).status).toBe(403); // owner-only
    expect((await h.http().post("/admin/staff/invitations").set(h.auth(lying)).send({ email: "x@t.test", role: "SUPER_ADMIN" })).status).toBe(403);
  });

  it("has no merchant-editable field that is read as a staff role (the staff role is only written by the staff services)", () => {
    const writers = ["staffAdmin.ts", "ownerBootstrap.ts", "adminUsers.ts"];
    const dir = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts") && !p.includes(" 2.")) { const t = readFileSync(p, "utf8"); if (/adminUser\.(update|create|upsert)(Many)?\(/.test(t) && !writers.includes(f) && !/src\/(admin\/(adminAuthRoutes|mfa|adminSessions)|db)/.test(p.replace(/\\/g, "/")) ) offenders.push(p.replace(dir, "src")); } } };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});

describe("2. an admin URL replayed with someone else's session", () => {
  it("ignores cookies and refuses a token minted for any other audience, so a merchant or consumer session cannot reach admin", async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: "owner@t.test" } });
    const merchantish = jwt.sign({ adminUserId: admin.id, email: admin.email, role: "SUPER_ADMIN" }, SECRET, { expiresIn: 600, jwtid: "33333333-3333-4333-8333-333333333333", audience: "tradepal-merchant" });
    expect((await h.http().get("/admin/overview").set(h.auth(merchantish))).status).toBe(401);
    const withCookie = await h.http().get("/admin/overview").set("Cookie", "session=abc; tradepal_session=abc; token=abc");
    expect(withCookie.status).toBe(401);
  });
});

describe("3. a staff member is demoted or disabled while their queued refund is waiting", () => {
  it("re-checks the executor when the job runs, not when it was queued", async () => {
    await publishedPlan(prisma, "STARTER");
    const { fake, cfg } = await billingWorld(prisma);
    const b = await makeSlBusiness(prisma, { name: "Queued Shop" });
    const s = await startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" });
    fake.complete(s.depositId);
    await applyBillingDeposit(prisma, cfg, s.depositId, "CALLBACK", new Date());
    const inv = await prisma.invoice.findFirstOrThrow({ where: { reference: s.invoiceReference } });
    const [f1, f2] = await Promise.all([prisma.adminUser.findUniqueOrThrow({ where: { email: "fin1@t.test" } }), prisma.adminUser.findUniqueOrThrow({ where: { email: "fin2@t.test" } })]);
    const req = await requestRefund({ prisma }, { action: "SUBSCRIPTION_CHARGE_REFUND", targetId: inv.id, reason: "customer was charged twice", requestedById: f1.id });
    await approveRefund({ prisma }, { id: req.id, approverId: f2.id, payloadHash: req.payloadHash });
    const sent: unknown[] = [];
    const executors = { refundSubscriptionCharge: (async (_p: unknown, i: unknown) => { sent.push(i); return { id: "r", status: "REQUESTED" }; }) as never, refundHeldBillingPayment: (async () => ({ id: "r", status: "REQUESTED" })) as never };
    const env = { ADMIN_CONSOLE_ENABLED: "true", ADMIN_MODULE_REFUNDS: "true", ADMIN_REFUND_EXECUTION_ENABLED: "true" } as NodeJS.ProcessEnv;
    // queued with fin2's role version, then fin2 is disabled before it runs
    await prisma.adminUser.update({ where: { id: f2.id }, data: { disabledAt: new Date() } });
    await expect(executeRefund({ prisma, env, executors }, { id: req.id, executorId: f2.id, executorRoleVersion: f2.roleVersion })).rejects.toMatchObject({ code: "ACTOR_NOT_ALLOWED" });
    await prisma.adminUser.update({ where: { id: f2.id }, data: { disabledAt: null } });
    // role changed since queueing (version moved): refused even though the new role could also run refunds
    await prisma.adminUser.update({ where: { id: f2.id }, data: { role: "SUPER_ADMIN" } });
    await expect(executeRefund({ prisma, env, executors }, { id: req.id, executorId: f2.id, executorRoleVersion: f2.roleVersion })).rejects.toMatchObject({ code: "ACTOR_NOT_ALLOWED" });
    await prisma.adminUser.update({ where: { id: f2.id }, data: { role: "FINANCE_ADMIN" } });
    expect(sent).toHaveLength(0); // nothing reached the provider in either case
  });
});

describe.skipIf(!REAL)("4. two owners demote each other within the same instant (real Postgres)", () => {
  it("through the API: exactly one demotion succeeds and an owner always remains", async () => {
    const a = buildHarness(prisma, { enforceMfa: false }); const b = buildHarness(prisma, { enforceMfa: false });
    closers.push(a, b);
    for (let round = 0; round < 6; round++) {
      await prisma.adminUser.updateMany({ where: { email: { in: ["owner@t.test", "owner2@t.test"] } }, data: { role: "SUPER_ADMIN", disabledAt: null } });
      const ta = (await a.signedIn("owner@t.test")).token; const tb = (await b.signedIn("owner2@t.test")).token;
      const ida = (await prisma.adminUser.findUniqueOrThrow({ where: { email: "owner@t.test" } })).id;
      const idb = (await prisma.adminUser.findUniqueOrThrow({ where: { email: "owner2@t.test" } })).id;
      const [ra, rb] = await Promise.all([
        a.http().put(`/admin/staff/${idb}/role`).set(a.auth(ta)).send({ role: "OPERATOR", reason: "race a demotes b" }),
        b.http().put(`/admin/staff/${ida}/role`).set(b.auth(tb)).send({ role: "OPERATOR", reason: "race b demotes a" }),
      ]);
      expect([ra.status, rb.status].filter((s) => s === 200)).toHaveLength(1);
      expect(await prisma.adminUser.count({ where: { role: "SUPER_ADMIN", disabledAt: null, email: { in: ["owner@t.test", "owner2@t.test"] } } })).toBe(1);
    }
    await prisma.adminUser.updateMany({ where: { email: { in: ["owner@t.test", "owner2@t.test"] } }, data: { role: "SUPER_ADMIN", disabledAt: null } });
  });
});

describe("8. an export or list requested for 'all' organizations by someone without that right", () => {
  it("never accepts a wildcard business: unknown ids answer not-found or refuse, and a support agent still needs a recorded reason for one business", async () => {
    const { token } = await h.signedIn("support@t.test");
    for (const path of ["/admin/businesses/*/transactions.csv", "/admin/businesses/%2A/transactions.csv", "/admin/businesses/%25/transactions", "/admin/audit-logs?businessId=*", "/admin/businesses?org=*"]) {
      const res = await h.http().get(path).set(h.auth(token));
      expect([200, 400, 403, 404], path).toContain(res.status);
      if (path.includes("transactions")) expect([403, 404], path).toContain(res.status);
      if (path.startsWith("/admin/audit-logs")) expect(res.body.auditLogs).toEqual([]); // the filter is a literal, not a pattern
    }
  });
});

describe("9. flipping a flag or switch from the console cannot enable real pawaPay charges", () => {
  it("leaves charging blocked by the deployment-level activation even with the flag and the country switch on", async () => {
    const { token } = await h.signedIn("owner@t.test");
    const flagOn = await h.http().post("/admin/feature-flags/pawapayBilling").set(h.auth(token)).send({ enabledByDefault: true });
    expect([200, 404]).toContain(flagOn.status);
    const sw = await h.http().put("/admin/billing-switches").set(h.auth(token)).send({ provider: "pawapay", countryCode: "SL", newAttemptsEnabled: true, reason: "turning it on for a test" });
    expect(sw.status).toBe(200);
    const { fake } = await billingWorld(prisma);
    const prod = buildBillingConfigFromEnv(
      { PAWAPAY_ENVIRONMENT: "PRODUCTION", NODE_ENV: "production", PAWAPAY_BILLING_CALLBACK_AUTHORITY: "tradepal.test" } as NodeJS.ProcessEnv,
      { apiToken: "t", apiBaseUrl: "https://api.pawapay.io/v2", fetchImpl: fake.fetchImpl },
    );
    if (!prod.ok) throw new Error(prod.reason);
    expect(prod.config.productionActivated).toBe(false);
    setBillingConfig(prod);
    const b = await makeSlBusiness(prisma, { name: "Prod Gate Shop" });
    await expect(startRenewal(prisma, { businessId: b.businessId, merchantId: b.merchantId, payerPhone: PHONE, planCode: "STARTER" })).rejects.toMatchObject({ code: "NOT_ACTIVATED" });
    // and no admin route can set the activation: it is an environment variable, and there is no route that writes configuration
    const routesText = ["adminRoutes.ts", "adminSubscriptions.ts", "platformAdmin.ts", "staffAdmin.ts", "refundRequests.ts"].map((f) => readFileSync(join(process.cwd(), "src/admin", f), "utf8")).join("\n");
    expect(routesText).not.toMatch(/PAWAPAY_BILLING_PRODUCTION_ACTIVATED\s*=|process\.env\[["']PAWAPAY_[A-Z_]+["']\]\s*=/);
    setBillingConfig(null);
  });
});

describe("10 and 11. a shared computer and caching", () => {
  it("sends no-store on every admin API response, signed in or not, including errors", async () => {
    const { token } = await h.signedIn("owner@t.test");
    // the harness builds the router without the mount wrapper, so check the wrapper itself on a real mount
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const { mountAdminConsole } = await import("../src/admin/mount.js");
    const app = express(); app.use(express.json());
    mountAdminConsole(app, { prisma, jwtSecret: SECRET, env: { ADMIN_CONSOLE_ENABLED: "true", ADMIN_MFA_ENFORCE: "false" } as NodeJS.ProcessEnv, allowedOrigins: [] });
    for (const [method, path, auth] of [["get", "/admin/overview", false], ["post", "/admin/login", false], ["get", "/admin/me/permissions", true], ["get", "/admin/nope", true]] as const) {
      let r = (request(app) as any)[method](path); if (auth) r = r.set(h.auth(token)); if (method === "post") r = r.send({ email: "x@t.test", password: "x" });
      const res = await r;
      expect(res.headers["cache-control"], `${method} ${path}`).toMatch(/no-store/);
    }
  });

  it("has no service worker or offline cache in the admin site, and the site asks browsers not to cache its pages", () => {
    const root = join(process.cwd(), "admin-frontend");
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { if (f === "node_modules" || f === "dist") continue; const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (!p.includes(" 2.")) files.push(p); } };
    walk(root);
    const hits = files.filter((f) => /\.(t|j)sx?$|\.html$/.test(f) && /serviceWorker|workbox|registerSW|navigator\.serviceWorker/.test(readFileSync(f, "utf8")) && !f.endsWith(".test.tsx") && !f.endsWith(".test.ts"));
    expect(hits).toEqual([]);
    expect(files.some((f) => /(^|\/)(sw|service-worker)\.js$/.test(f))).toBe(false);
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as { headers?: { source: string; headers: { key: string; value: string }[] }[] };
    const all = (vercel.headers ?? []).flatMap((h2) => h2.headers.map((x) => `${x.key}: ${x.value}`));
    expect(all).toContain("Cache-Control: no-store");
    expect(all).toContain("X-Frame-Options: DENY");
    expect(all).toContain("X-Content-Type-Options: nosniff");
  });
});

describe("12. spreading attempts across two server instances", () => {
  it("shares the count through Redis, so two instances together allow no more than one", async () => {
    const redis = new FakeRedis();
    const one = buildHarness(prisma, { enforceMfa: false, loginRateLimiter: new RedisLoginRateLimiter(redis) });
    const two = buildHarness(prisma, { enforceMfa: false, loginRateLimiter: new RedisLoginRateLimiter(redis) });
    closers.push(one, two);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await (i % 2 === 0 ? one : two).login("owner@t.test", "wrong-password-here")).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });
});

describe("13. a spreadsheet formula in an exported cell", () => {
  it("neutralises =, +, -, @, tab and carriage return, including after leading spaces", () => {
    for (const evil of ['=HYPERLINK("http://evil.example","x")', "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "  =cmd|' /C calc'!A0"]) {
      const cell = csvText(evil);
      expect(cell.startsWith(`"'`), JSON.stringify(evil)).toBe(true);
    }
    expect(csvText("plain text")).toBe('"plain text"');
    expect(csvText('has "quotes"')).toBe('"has ""quotes"""');
  });
});
