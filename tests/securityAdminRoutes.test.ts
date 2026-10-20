import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { createOfflineRouter } from "../src/offline/routes.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Admin-route penetration checks (expansion Phase 8, scenario 27). The route table is READ FROM THE ROUTER ITSELF, so a route added
 * later is covered automatically; nothing here is a hand-kept list.
 */
const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
const UUID = "00000000-0000-4000-8000-000000000000";

let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;

interface RouteDef { method: "get" | "post" | "put" | "delete" | "patch"; path: string }

function enumerate(stack: any[], prefix = ""): RouteDef[] {
  const out: RouteDef[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.push({ method: m as RouteDef["method"], path: prefix + layer.route.path });
    } else if (layer.handle?.stack) {
      out.push(...enumerate(layer.handle.stack, prefix));
    }
  }
  return out;
}
const fill = (path: string, value = UUID) => path.replace(/:[A-Za-z]+/g, value);

let routes: RouteDef[] = [];
let tokens: Record<string, string> = {};

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"], ["gone@t.test", "SUPER_ADMIN"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  const router = createAdminRouter(prisma, SECRET);
  routes = enumerate((router as any).stack);
  app = express();
  app.use(express.json());
  app.use("/admin", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "unhandled", detail: String(err).slice(0, 200) }); });
  for (const e of ["super", "op", "support", "analyst", "gone"]) tokens[e] = (await request(app).post("/admin/login").send({ email: `${e}@t.test`, password: PW })).body.token;
}, 90_000);
afterAll(async () => {
  await testDb.teardown();
});

const send = (r: RouteDef, token?: string, path = fill(r.path)) => {
  let req = (request(app) as any)[r.method](`/admin${path}`) as request.Test;
  if (token !== undefined) req = req.set("Authorization", `Bearer ${token}`);
  return r.method === "get" || r.method === "delete" ? req : req.send({});
};
const isLogin = (r: RouteDef) => r.path === "/login";

describe("the route table", () => {
  it("is read from the router and is large enough to mean something", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter(isLogin)).toHaveLength(1); // exactly one public route
  });
});

describe("every admin route rejects every way of not being a signed-in platform admin", () => {
  it("no token, a malformed header, garbage, a wrong-secret token and an expired token all get 401 (never 2xx, never 500)", async () => {
    const wrong = jwt.sign({ adminUserId: UUID, role: "SUPER_ADMIN", jti: "x" }, "another-secret", { expiresIn: "1h" });
    const expired = jwt.sign({ adminUserId: UUID, role: "SUPER_ADMIN", jti: "y" }, SECRET, { expiresIn: -10 });
    const bad: { name: string; req: (r: RouteDef) => request.Test }[] = [
      { name: "no header", req: (r) => send(r) },
      { name: "garbage", req: (r) => send(r, "not-a-token") },
      { name: "wrong secret", req: (r) => send(r, wrong) },
      { name: "expired", req: (r) => send(r, expired) },
      { name: "basic scheme", req: (r) => ((request(app) as any)[r.method](`/admin${fill(r.path)}`) as request.Test).set("Authorization", "Basic c3VwZXI6cHc=") },
    ];
    const failures: string[] = [];
    for (const r of routes.filter((x) => !isLogin(x))) {
      for (const b of bad) {
        const res = await b.req(r);
        if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${r.path} [${b.name}] -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("a token that carries a MERCHANT's claims (even signed with the real secret) is not an admin", async () => {
    const merchantish = jwt.sign({ merchantId: UUID, businessId: UUID, role: "OWNER", jti: "m1" }, SECRET, { expiresIn: "1h" });
    const noRole = jwt.sign({ adminUserId: UUID, jti: "m2" }, SECRET, { expiresIn: "1h" });
    const roleOutsideSet = jwt.sign({ adminUserId: UUID, role: "OWNER", jti: "m3" }, SECRET, { expiresIn: "1h" });
    const failures: string[] = [];
    for (const r of routes.filter((x) => !isLogin(x))) {
      for (const [name, t] of [["merchant claims", merchantish], ["no role", noRole], ["merchant role name", roleOutsideSet]] as const) {
        const res = await send(r, t);
        if (res.status < 400 || res.status >= 500) failures.push(`${r.method.toUpperCase()} ${r.path} [${name}] -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("a logged-out token stops working on every route", async () => {
    const t = (await request(app).post("/admin/login").send({ email: "op@t.test", password: PW })).body.token as string;
    expect((await request(app).post("/admin/logout").set("Authorization", `Bearer ${t}`).send({})).status).toBeLessThan(300);
    const failures: string[] = [];
    for (const r of routes.filter((x) => !isLogin(x))) {
      const res = await send(r, t);
      if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("a DISABLED admin's still-unexpired token stops working at once, and they cannot log in again", async () => {
    expect((await request(app).get("/admin/me/permissions").set("Authorization", `Bearer ${tokens["gone"]}`)).status).toBe(200);
    const { disableAdminUser } = await import("../src/admin/adminUsers.js");
    expect(await disableAdminUser(prisma, "gone@t.test")).toBe(true);
    expect(await disableAdminUser(prisma, "gone@t.test")).toBe(false); // idempotent
    const failures: string[] = [];
    for (const r of routes.filter((x) => !isLogin(x))) {
      const res = await send(r, tokens["gone"]);
      if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
    expect((await request(app).post("/admin/login").send({ email: "gone@t.test", password: PW })).status).toBe(401);
  });

  it("an admin whose account was removed, or whose role was lowered, loses that power on the very next request", async () => {
    await createAdminUser(prisma, { email: "demoted@t.test", name: "d", role: "SUPER_ADMIN", password: PW });
    await createAdminUser(prisma, { email: "removed@t.test", name: "r", role: "SUPER_ADMIN", password: PW });
    const login = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
    const demoted = await login("demoted@t.test");
    const removed = await login("removed@t.test");
    expect((await request(app).get("/admin/admins").set("Authorization", `Bearer ${demoted}`)).status).toBe(200); // owner-only list
    await prisma.adminUser.update({ where: { email: "demoted@t.test" }, data: { role: "ANALYST" } });
    expect((await request(app).get("/admin/admins").set("Authorization", `Bearer ${demoted}`)).status).toBe(403);
    await prisma.adminUser.delete({ where: { email: "removed@t.test" } });
    expect((await request(app).get("/admin/me/permissions").set("Authorization", `Bearer ${removed}`)).status).toBe(401);
  });
});

describe("roles", () => {
  it("the read-only analyst can never change anything: every write is refused with 403", async () => {
    const failures: string[] = [];
    const allowedForAll = new Set(["/logout", "/step-up", "/support-access"]);
    for (const r of routes.filter((x) => x.method !== "get" && !isLogin(x) && !allowedForAll.has(x.path))) {
      const res = await send(r, tokens["analyst"]);
      if (res.status !== 403) failures.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("support cannot touch the owner-only controls (plans, admins, global flags, payment connections, template approval, forecasting gate)", async () => {
    const ownerOnly = routes.filter((r) => r.method !== "get" && /^(\/plan-versions|\/admins|\/feature-flags\/.*global|\/payment-connections|\/messaging\/templates\/[^/]+$|\/forecast|\/billing-switches)/.test(r.path));
    expect(ownerOnly.length).toBeGreaterThan(3);
    const failures: string[] = [];
    for (const r of ownerOnly) {
      const res = await send(r, tokens["support"]);
      if (res.status !== 403) failures.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("robustness and leakage", () => {
  it("hostile ids and parameters never produce a 500 or an echo of the payload", async () => {
    const hostile = ["' OR 1=1 --", "../../etc/passwd", "%00", "<script>alert(1)</script>", "x".repeat(5000), "0".repeat(60), "NaN", "-1"];
    const failures: string[] = [];
    for (const r of routes.filter((x) => x.method === "get" && !isLogin(x))) {
      for (const h of hostile) {
        const res = await send(r, tokens["super"], fill(r.path, encodeURIComponent(h)));
        if (res.status >= 500) failures.push(`GET ${r.path} id=${h.slice(0, 20)} -> ${res.status}`);
        if (typeof res.text === "string" && h.length < 40 && h.includes("<script>") && res.text.includes(h)) failures.push(`GET ${r.path} echoed the payload`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("hostile query strings on every list route stay below 500", async () => {
    const failures: string[] = [];
    for (const r of routes.filter((x) => x.method === "get" && !isLogin(x) && !x.path.includes(":"))) {
      for (const q of ["?take=-5&skip=abc", "?take=999999999999999999999", "?status[]=a&status[]=b", `?q=${encodeURIComponent("' OR 1=1 --")}&from=garbage&to=garbage`, "?take=1&skip=1e9"]) {
        const res = await (request(app).get(`/admin${r.path}${q}`) as request.Test).set("Authorization", `Bearer ${tokens["super"]}`);
        if (res.status >= 500) failures.push(`GET ${r.path}${q} -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("no response reveals a password hash, a token hash, a signing secret or an access token", async () => {
    const forbidden = /passwordHash|tokenHash|\$2[aby]\$\d\d\$|"apiKey"|WHATSAPP_ACCESS_TOKEN|JWT_SECRET|test-secret-do-not-use/i;
    const leaks: string[] = [];
    for (const r of routes.filter((x) => x.method === "get" && !isLogin(x))) {
      const res = await send(r, tokens["super"]);
      if (forbidden.test(res.text ?? "")) leaks.push(`GET ${r.path}`);
    }
    expect(leaks).toEqual([]);
    const admins = await request(app).get("/admin/admins").set("Authorization", `Bearer ${tokens["super"]}`);
    expect(JSON.stringify(admins.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it("the login endpoint answers the same for an unknown address and a wrong password", async () => {
    const a = await request(app).post("/admin/login").send({ email: "nobody@t.test", password: "whatever-whatever" });
    const b = await request(app).post("/admin/login").send({ email: "super@t.test", password: "whatever-whatever" });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});

describe("a platform admin is not a merchant, and a merchant's session is not an admin's", () => {
  it("an admin token is useless on the phone API, and a phone token is useless on the admin API", async () => {
    process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
    process.env["REPORTS_WEB_ENABLED"] = "true";
    const phone = express();
    phone.use(createOfflineRouter(prisma));
    for (const path of ["/m/api/drafts", "/m/api/reports/sales"]) expect((await request(phone).get(path).set("Authorization", `Bearer ${tokens["super"]}`)).status).toBe(401);
    expect((await request(phone).post("/m/api/drafts/sync").set("Authorization", `Bearer ${tokens["super"]}`).send({ drafts: [] })).status).toBe(401);
    const deviceish = "a".repeat(64);
    expect((await request(app).get("/admin/me/permissions").set("Authorization", `Bearer ${deviceish}`)).status).toBe(401);
    delete process.env["OFFLINE_DRAFTS_ENABLED"];
    delete process.env["REPORTS_WEB_ENABLED"];
  });

  it("an admin has no merchant permissions by default and none is granted by being SUPER_ADMIN", async () => {
    const { canMerchant, PLATFORM_PERMISSIONS, platformPermissionsFor } = await import("../src/auth/permissions.js");
    for (const role of ["SUPER_ADMIN", "OPERATOR", "SUPPORT", "ANALYST"] as const) {
      expect(platformPermissionsFor(role).every((p) => p.startsWith("admin:"))).toBe(true);
      expect(() => canMerchant(role as never, "sales:create")).not.toThrow();
      expect(canMerchant(role as never, "sales:create")).toBe(false); // a platform role name is not a merchant role
    }
    expect(PLATFORM_PERMISSIONS.every((p) => p.startsWith("admin:"))).toBe(true);
  });
});
