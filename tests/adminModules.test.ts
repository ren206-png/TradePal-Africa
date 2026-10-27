import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { ADMIN_MODULES, adminConsoleEnabled, adminModuleEnabled, refundExecutionEnabled } from "../src/admin/adminConfig.js";
import { moduleOf } from "../src/admin/moduleGate.js";
import { buildHarness, PW, SECRET, type Harness } from "./helpers/adminConsole.js";

vi.setConfig({ testTimeout: 300_000 });

/**
 * Admin-console Phase 3: every route belongs to a module (or is deliberately module-free), module switches close routes like routes that do
 * not exist, and the roles added in Phase 1 reach exactly the routes their permissions allow (a pinned inventory, so a new route cannot open
 * to them by accident).
 */
const UUID = "00000000-0000-4000-8000-000000000000";
interface RouteDef { method: string; path: string }
function enumerate(stack: any[], out: RouteDef[] = []): RouteDef[] {
  for (const l of stack) {
    if (l.route) for (const m of Object.keys(l.route.methods)) out.push({ method: m, path: l.route.path });
    else if (l.handle?.stack) enumerate(l.handle.stack, out);
  }
  return out;
}
const SELF_SERVICE = /^\/(login|logout|session|mfa|me|step-up|modules)(\/|$)/;
const PUBLIC = new Set(["/login", "/invitations/accept"]);

let testDb: TestDb;
let prisma: PrismaClient;
let routes: RouteDef[];
const harnesses: Harness[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  for (const [email, role] of [["owner@t.test", "SUPER_ADMIN"], ["mod@t.test", "MODERATOR"], ["fin@t.test", "FINANCE_ADMIN"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  routes = enumerate((createAdminRouter(prisma, SECRET) as any).stack);
}, 60_000);
afterAll(async () => {
  for (const h of harnesses) h.close();
  await testDb.teardown();
});

describe("the module report", () => {
  it("tells the truth about what is built, and which modules are on", async () => {
    const h = buildHarness(prisma, { enforceMfa: false, modules: (m) => m !== "REPORTS" });
    harnesses.push(h);
    const { token } = await h.signedIn("owner@t.test");
    const res = await h.http().get("/admin/modules").set(h.auth(token));
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.modules.map((m: { module: string }) => [m.module, m]));
    expect(Object.keys(byName).sort()).toEqual([...ADMIN_MODULES].sort());
    expect(byName["REPORTS"]).toMatchObject({ enabled: false, build: "not_built" });
    expect(byName["PAYMENTS"].build).toBe("partial"); // no real sales provider is connected
    expect(byName["STAFF"]).toMatchObject({ enabled: true, build: "available" });
    expect((await h.http().get("/admin/modules")).status).toBe(401); // not public
  });
});

describe("the module map", () => {
  it("puts every registered admin route in a module, or in the sign-in/self-service set; nothing is left unowned", () => {
    expect(routes.length).toBeGreaterThan(130);
    const unowned = routes.filter((r) => !PUBLIC.has(r.path) && !SELF_SERVICE.test(r.path) && moduleOf(r.path) === null).map((r) => `${r.method} ${r.path}`);
    expect(unowned).toEqual([]);
  });

  it("maps the sub-paths that cross modules to the right owner", () => {
    expect(moduleOf("/businesses/x/transactions")).toBe("ORDERS");
    expect(moduleOf("/businesses/x/payment-connections")).toBe("PAYMENTS");
    expect(moduleOf("/businesses/x/feature-flags/key")).toBe("CONFIG");
    expect(moduleOf("/businesses/x/invoices")).toBe("SUBSCRIPTIONS");
    expect(moduleOf("/businesses/x")).toBe("MERCHANTS");
    expect(moduleOf("/staff/invitations")).toBe("STAFF");
    expect(moduleOf("/refund-requests")).toBe("REFUNDS");
    expect(moduleOf("/totally-unknown")).toBeNull();
  });
});

describe("environment switches", () => {
  it("are off unless exactly true, and a module also needs the master switch", () => {
    expect(adminConsoleEnabled({})).toBe(false);
    expect(adminConsoleEnabled({ ADMIN_CONSOLE_ENABLED: "yes" })).toBe(false);
    expect(adminModuleEnabled("STAFF", { ADMIN_MODULE_STAFF: "true" })).toBe(false); // master off
    expect(adminModuleEnabled("STAFF", { ADMIN_CONSOLE_ENABLED: "true" })).toBe(false); // module off
    expect(adminModuleEnabled("STAFF", { ADMIN_CONSOLE_ENABLED: "true", ADMIN_MODULE_STAFF: "true" })).toBe(true);
    expect(refundExecutionEnabled({ ADMIN_CONSOLE_ENABLED: "true", ADMIN_MODULE_REFUNDS: "true" })).toBe(false); // execution has its own switch
    expect(refundExecutionEnabled({ ADMIN_CONSOLE_ENABLED: "true", ADMIN_MODULE_REFUNDS: "true", ADMIN_REFUND_EXECUTION_ENABLED: "true" })).toBe(true);
    expect(refundExecutionEnabled({ ADMIN_CONSOLE_ENABLED: "true", ADMIN_REFUND_EXECUTION_ENABLED: "true" })).toBe(false); // module off
    expect(ADMIN_MODULES).toHaveLength(12);
  });
});

describe("module switches in the router", () => {
  it("closes an off module like a route that does not exist, keeps sign-in and self-service open, and opens the rest", async () => {
    const h = buildHarness(prisma, { enforceMfa: false, modules: (m) => m !== "MODERATION" && m !== "STAFF" });
    harnesses.push(h);
    const { token } = await h.signedIn("owner@t.test");
    const auth = h.auth(token);
    // an off module: the same answer as a path that never existed
    const off = await h.http().get("/admin/moderation/queue").set(auth);
    const never = await h.http().get("/admin/no-such-thing/queue").set(auth);
    expect(off.status).toBe(404);
    expect(off.text.replace("/admin/moderation/queue", "<p>")).toBe(never.text.replace("/admin/no-such-thing/queue", "<p>"));
    expect((await h.http().get("/admin/staff").set(auth)).status).toBe(404);
    expect((await h.http().post("/admin/invitations/accept").send({ token: "x".repeat(30), name: "n", password: "a-long-password-1" })).status).toBe(404);
    // always open to a signed-in person
    expect((await h.http().get("/admin/me/permissions").set(auth)).status).toBe(200);
    expect((await h.http().get("/admin/session").set(auth)).status).toBe(200);
    // modules that are on work
    expect((await h.http().get("/admin/businesses").set(auth)).status).toBe(200);
    expect((await h.http().get("/admin/audit-logs").set(auth)).status).toBe(200);
  });

  it("with every module off only sign-in, session and the caller's own permissions answer", async () => {
    const h = buildHarness(prisma, { enforceMfa: false, modules: () => false });
    harnesses.push(h);
    const { token } = await h.signedIn("owner@t.test");
    expect((await h.http().get("/admin/me/permissions").set(h.auth(token))).status).toBe(200);
    for (const path of ["/admin/businesses", "/admin/overview", "/admin/audit-logs", "/admin/payments/overview", "/admin/feature-flags"]) {
      expect((await h.http().get(path).set(h.auth(token))).status, path).toBe(404);
    }
  });
});

describe("least privilege for the roles added after the original four", () => {
  const MODERATOR_OPEN = [
    "POST /staff/ownership-transfers/:id/accept", "POST /staff/ownership-transfers/:id/cancel",
    "GET /moderation/queue", "GET /moderation/sellers", "GET /moderation/listings", "GET /moderation/appeals", "GET /moderation/actions",
    "POST /moderation/listings/:id/unpublish", "POST /moderation/listings/:id/reinstate", "POST /moderation/sellers/:id/suspend",
    "POST /moderation/sellers/:id/reinstate", "POST /moderation/reports/:id/dismiss", "POST /moderation/appeals/:id/decide",
    "GET /me/permissions", "POST /step-up", "GET /overview", "GET /businesses", "GET /businesses/:id", "GET /feature-flags", "GET /businesses/:id/feature-flags",
  ].sort();
  const FINANCE_OPEN = [
    "POST /staff/ownership-transfers/:id/accept", "POST /staff/ownership-transfers/:id/cancel",
    "GET /businesses/:id/transactions", "GET /businesses/:id/transactions/:txnId", "GET /businesses/:id/stock-movements", "GET /businesses/:id/journals",
    "GET /businesses/:id/trade-orders", "GET /businesses/:id/trade-invoices", "GET /businesses/:id/store-orders", "GET /businesses/:id/transactions.csv",
    "GET /payments/overview", "GET /payments/attempts", "GET /payments/attempts/:id", "GET /payments/exceptions", "GET /payments/refunds", "GET /payments/settlements", "GET /payments/callbacks",
    "POST /payments/reconcile", "POST /payments/attempts/:id/refresh", "POST /payments/attempts/:id/close", "POST /payments/exceptions/:id/resolve", "POST /payments/refunds/:id/retry",
    "GET /businesses/:id/payment-connections",
    "GET /subscriptions/overview", "GET /subscriptions", "GET /subscriptions/exceptions", "GET /subscriptions/invoices", "GET /subscriptions/invoices.csv", "GET /subscriptions/:id",
    "GET /plan-versions", "POST /plan-versions/:planCode", "PUT /plan-versions/:id/prices", "POST /plan-versions/:id/publish", "POST /plan-versions/:id/retire",
    "POST /subscriptions/:id/adjust", "POST /invoices/:id/refund", "POST /subscriptions/attempts/:id/refund", "PUT /billing-switches",
    "POST /subscriptions/exceptions/:id/resolve", "POST /subscriptions/attempts/:id/refresh", "POST /subscriptions/reconcile", "POST /subscriptions/:id/remind",
    "GET /me/permissions", "POST /step-up", "POST /businesses/:id/support-access", "GET /overview", "GET /businesses", "GET /businesses/:id",
    "GET /mobile-money-alerts", "GET /plans", "GET /feature-flags", "GET /businesses/:id/feature-flags", "GET /businesses/:id/invoices", "GET /businesses/:id/payment-requests",
    // two-person refunds: finance may request, approve, reject, cancel and run (each step has its own permission and the database forbids self-approval)
    "GET /refund-requests", "GET /refund-requests/:id", "POST /refund-requests", "POST /refund-requests/:id/approve", "POST /refund-requests/:id/reject",
    "POST /refund-requests/:id/cancel", "POST /refund-requests/:id/execute",
  ].sort();

  async function openRoutesFor(email: string): Promise<string[]> {
    const h = buildHarness(prisma, { enforceMfa: false });
    harnesses.push(h);
    const { token } = await h.signedIn(email);
    const open: string[] = [];
    for (const r of routes) {
      if (PUBLIC.has(r.path) || r.path === "/logout" || r.path === "/modules" || r.path.startsWith("/mfa") || r.path.startsWith("/session")) continue;
      let req = (h.http() as any)[r.method](`/admin${r.path.replace(/:[A-Za-z]+/g, UUID)}`).set(h.auth(token));
      if (r.method !== "get" && r.method !== "delete") req = req.send({});
      const res = await req;
      if (res.status !== 403) open.push(`${r.method.toUpperCase()} ${r.path}`);
    }
    return open.sort();
  }

  it("moderator: moderation, the overview, organizations and flag metadata, and nothing financial, support, messaging, staff or audit", async () => {
    expect(await openRoutesFor("mod@t.test")).toEqual(MODERATOR_OPEN);
  });

  it("finance admin: billing, payments, reconciliation and refunds-in-billing, and nothing about staff, flags writes, moderation, messaging or audit", async () => {
    expect(await openRoutesFor("fin@t.test")).toEqual(FINANCE_OPEN);
  });
});
