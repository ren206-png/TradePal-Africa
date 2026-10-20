import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder } from "./helpers/store.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { addPriceRule } from "../src/domain/pricing.js";
import { receiveStock } from "../src/domain/stock.js";
import { listVariant } from "../src/domain/store/storefront.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { createOfflineRouter } from "../src/offline/routes.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Transfer BUDGETS for the pages a person on a slow, expensive connection actually loads (expansion Phase 8). A budget here is a ceiling
 * on bytes, which is the one thing that can be measured reproducibly in CI. It is NOT a measurement of speed on a low-end phone: see
 * `docs/expansion/performance-baseline.md` for what was and was not measured. Budgets are set above today's size with some headroom, so
 * a change that makes a page much heavier fails here and has to be argued.
 */
const KB = 1024;
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let orderToken = "";

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  const s = await makeSeller(prisma, "Budget Shop", { slug: "budget-shop" });
  const list = await s.scoped.priceList.findFirstOrThrow({ where: { kind: "RETAIL" } });
  for (let i = 2; i <= 30; i++) {
    const p = await createProduct(s.scoped, { businessId: s.businessId, name: `Product number ${i} with a realistic name` });
    const v = await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku: `B${i}`, name: "unit", baseUnit: "unit" });
    await receiveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: v.id, quantity: 100, unitCostMinor: 1_000n, currencyCode: "NGN" });
    await addPriceRule(s.scoped, { businessId: s.businessId, priceListId: list.id, variantId: v.id, unitPriceMinor: 2_500n });
    await listVariant(prisma, s.businessId, v.id);
  }
  orderToken = (await placeStoreOrder(prisma, s, { qty: 2 })).token;
  process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
  const big = () => new InMemoryLoginRateLimiter(1e9, 1000);
  app = express();
  app.use(createStorefrontRouter(prisma, { limiters: { read: big(), write: big(), order: big() } }));
  app.use(createOfflineRouter(prisma, { limiters: { exchange: big(), api: big() } }));
}, 120_000);
afterAll(async () => {
  delete process.env["OFFLINE_DRAFTS_ENABLED"];
  await testDb.teardown();
});

const get = (path: string, gzip = true) => {
  const r = (request(app).get(path) as request.Test).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
  return gzip ? r.set("Accept-Encoding", "gzip") : r.set("Accept-Encoding", "identity");
};
// superagent decompresses for us, so the size on the wire is the Content-Length the server declared
const wireBytes = async (path: string) => { const r = await get(path); return { status: r.status, wire: Number(r.headers["content-length"] ?? 0), encoding: r.headers["content-encoding"] ?? "none" }; };
const plainBytes = async (path: string) => { const r = await get(path, false); return { status: r.status, text: (r.body as Buffer).toString("utf8"), len: (r.body as Buffer).length }; };

describe("transfer budgets", () => {
  it("a 30-product shop page: at most 32 KB uncompressed and 5 KB on the wire", async () => {
    const plain = await plainBytes("/shop/budget-shop");
    expect(plain.status).toBe(200);
    expect(plain.len).toBeLessThan(32 * KB);
    const wire = await wireBytes("/shop/budget-shop");
    expect(wire.encoding).toBe("gzip");
    expect(wire.wire).toBeLessThan(5 * KB);
  });

  it("the basket, an order page and the phone page are small", async () => {
    expect((await plainBytes("/basket")).len).toBeLessThan(8 * KB);
    expect((await plainBytes(`/order/${orderToken}`)).len).toBeLessThan(20 * KB);
    expect((await plainBytes("/m/")).len).toBeLessThan(6 * KB);
    expect((await plainBytes("/m/app.js")).len).toBeLessThan(20 * KB);
    expect((await plainBytes("/m/sw.js")).len).toBeLessThan(2 * KB);
  });

  it("pages pull in nothing else: no third-party script, font, stylesheet or image host, and no external request at all from the shop and phone pages", async () => {
    for (const path of ["/shop/budget-shop", "/basket", "/m/", `/order/${orderToken}`]) {
      const html = (await plainBytes(path)).text;
      const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!).filter((u) => /^(https?:)?\/\//i.test(u));
      expect(refs, `${path} references other hosts`).toEqual([]);
      expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i); // styles are inline: one fewer request on a slow link
      expect(html).not.toMatch(/@import|fonts\.googleapis|cdn\./i);
    }
  });

  it("the shop page works with no script at all", async () => {
    expect((await plainBytes("/shop/budget-shop")).text).not.toMatch(/<script/i);
    expect((await plainBytes("/basket")).text).not.toMatch(/<script/i);
  });

  it("the admin console bundle (if built) stays within its budget: 130 KB of script and 6 KB of styles, compressed", () => {
    const dir = join(process.cwd(), "admin-frontend", "dist", "assets");
    if (!existsSync(dir)) return; // not built in this environment; `npm run build` in admin-frontend produces it
    const gz = (f: string) => gzipSync(readFileSync(join(dir, f))).length;
    const files = readdirSync(dir);
    const js = files.filter((f) => f.endsWith(".js")).reduce((n, f) => n + gz(f), 0);
    const css = files.filter((f) => f.endsWith(".css")).reduce((n, f) => n + gz(f), 0);
    expect(js).toBeLessThan(130 * KB);
    expect(css).toBeLessThan(6 * KB);
  });
});

describe("compression is limited to pages that hold nothing secret", () => {
  it("compresses the catalogue and phone assets when asked, says so with Vary, and leaves a plain response to a client that did not ask", async () => {
    const asked = await get("/shop/budget-shop");
    expect(asked.headers["content-encoding"]).toBe("gzip");
    expect(String(asked.headers["vary"])).toMatch(/Accept-Encoding/i);
    const notAsked = await get("/shop/budget-shop", false);
    expect(notAsked.headers["content-encoding"]).toBeUndefined();
    expect(String(notAsked.headers["vary"])).toMatch(/Accept-Encoding/i);
    expect((await get("/m/app.js")).headers["content-encoding"]).toBe("gzip");
  });

  it("NEVER compresses a page that carries an order link, a pickup code or the basket", async () => {
    for (const path of [`/order/${orderToken}`, `/order/${orderToken}/receipt`, "/basket", "/orders"]) {
      const r = await get(path);
      expect(r.headers["content-encoding"], path).toBeUndefined();
    }
  });

  it("the compressed response decodes to exactly the same page", async () => {
    expect(((await get("/shop/budget-shop")).body as Buffer).toString("utf8")).toBe((await plainBytes("/shop/budget-shop")).text);
  });
});
