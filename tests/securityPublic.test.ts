import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller } from "./helpers/store.js";
import { simulatorWorld } from "./helpers/payments.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { createOfflineRouter } from "../src/offline/routes.js";
import { createMerchantPaymentWebhookRouter } from "../src/payments/webhookRoute.js";
import { createPawaPayBillingWebhookRouter } from "../src/pawapay/billingWebhook.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Public surfaces (no login): the storefront, the phone page and API, and the provider webhooks. The route tables are read from the
 * routers. The checks: hostile input never produces a 500 or a stack trace, no response gives a secret away, and nothing is cacheable that
 * should not be.
 */
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let routes: { method: string; path: string }[] = [];

function enumerate(stack: any[]): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const layer of stack) {
    if (layer.route) for (const m of Object.keys(layer.route.methods)) out.push({ method: m, path: layer.route.path });
    else if (layer.handle?.stack) out.push(...enumerate(layer.handle.stack));
  }
  return out;
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  const world = simulatorWorld(prisma);
  await makeSeller(prisma, "Public Shop", { slug: "public-shop" });
  process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
  process.env["REPORTS_WEB_ENABLED"] = "true";
  const storefront = createStorefrontRouter(prisma, { payments: { registry: world.registry }, marketplace: true, limiters: { read: new InMemoryLoginRateLimiter(1e6, 1000), write: new InMemoryLoginRateLimiter(1e6, 1000), order: new InMemoryLoginRateLimiter(1e6, 1000) } });
  const phone = createOfflineRouter(prisma, { limiters: { exchange: new InMemoryLoginRateLimiter(1e6, 1000), api: new InMemoryLoginRateLimiter(1e6, 1000) } });
  const hooks = createMerchantPaymentWebhookRouter(prisma, () => world.registry);
  const billing = createPawaPayBillingWebhookRouter(prisma);
  routes = [storefront, phone, hooks, billing].flatMap((r) => enumerate((r as any).stack));
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  for (const r of [storefront, phone, hooks, billing]) app.use(r);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "unhandled", detail: String(err).slice(0, 200) }); });
}, 90_000);
afterAll(async () => {
  delete process.env["OFFLINE_DRAFTS_ENABLED"];
  delete process.env["REPORTS_WEB_ENABLED"];
  await testDb.teardown();
});

const HOSTILE = ["' OR 1=1 --", "../../etc/passwd", "%00", "<script>alert(1)</script>", "x".repeat(4000), "{{7*7}}", "${7*7}", "\u0000‮"];
const fill = (path: string, v: string) => path.replace(/:[A-Za-z]+/g, encodeURIComponent(v)).replace(/\(.*?\)/g, "");
const call = (m: string, path: string) => (request(app) as any)[m](path) as request.Test;

describe("public routes", () => {
  it("the table is read from the routers", () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  it("hostile path parameters never give a 500, a stack trace, or an echo of the payload", async () => {
    const failures: string[] = [];
    for (const r of routes.filter((x) => x.method === "get" && typeof x.path === "string")) {
      for (const h of HOSTILE) {
        const res = await call("get", fill(r.path, h));
        if (res.status >= 500) failures.push(`GET ${r.path} <- ${h.slice(0, 15)} => ${res.status} ${JSON.stringify(res.body).slice(0, 220)}`);
        if (/\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(res.text ?? "")) failures.push(`GET ${r.path} leaked a stack trace`);
        if (h.startsWith("<script") && (res.text ?? "").includes(h)) failures.push(`GET ${r.path} echoed markup`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("hostile POST bodies (form and JSON) never give a 500", async () => {
    const failures: string[] = [];
    const bodies: [string, unknown][] = [["json", { a: "x".repeat(50_000) }], ["json", [1, 2, 3]], ["json", { __proto__: { polluted: true }, constructor: { prototype: { x: 1 } } }], ["form", "a=%00&b=%ff&c[]=1&c[]=2"]];
    for (const r of routes.filter((x) => x.method === "post" && typeof x.path === "string")) {
      for (const [kind, body] of bodies) {
        let req = call("post", fill(r.path, "abc"));
        req = kind === "json" ? req.send(body as object) : req.type("form").send(body as string);
        const res = await req;
        if (res.status >= 500) failures.push(`POST ${r.path} [${kind}] => ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("webhooks refuse unsigned or forged requests and say nothing useful to an attacker", async () => {
    for (const path of ["/webhooks/merchant-payments/simulator", "/webhooks/merchant-payments/nonesuch", "/webhooks/pawapay/billing"]) {
      const res = await call("post", path).set("Content-Type", "application/json").send(JSON.stringify({ event: "payment.updated", status: "SUCCEEDED" }));
      expect([400, 401, 403, 404, 503]).toContain(res.status);
      expect(res.text).not.toMatch(/secret|token|stack/i);
    }
  });

  it("pages that carry a secret or private data are never stored by a cache or search engine", async () => {
    const res = await call("get", "/basket");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.headers["x-robots-tag"] ?? res.text).toMatch(/noindex/);
    const orders = await call("get", "/orders");
    expect(orders.headers["cache-control"]).toMatch(/no-store/);
    const phone = await call("get", "/m/api/drafts");
    expect(phone.headers["cache-control"]).toBe("no-store");
  });

  it("the phone API refuses a request from a browser on another site (no cross-origin credentials, no permissive CORS)", async () => {
    const res = await call("get", "/m/api/drafts").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await (request(app).options("/m/api/drafts") as request.Test).set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("an order link cannot be found by guessing: lookalike tokens give the same answer as nonsense", async () => {
    const a = await call("get", `/order/${"0".repeat(48)}`);
    const b = await call("get", `/order/${"f".repeat(48)}`);
    const c = await call("get", "/order/short");
    expect([a.status, b.status, c.status]).toEqual([404, 404, 404]);
    expect(a.text).toBe(b.text);
  });
});
