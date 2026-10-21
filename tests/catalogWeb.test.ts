import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, type Seller } from "./helpers/store.js";
import { fakeJpeg } from "./helpers/images.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { createOfflineRouter } from "../src/offline/routes.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { OFFLINE_PAGE, OFFLINE_SCRIPT } from "../src/offline/clientAssets.js";

vi.setConfig({ testTimeout: 60_000 });
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  app = express();
  app.use(createOfflineRouter(prisma, { limiters: { exchange: new InMemoryLoginRateLimiter(1000, 60_000), api: new InMemoryLoginRateLimiter(10_000, 60_000), upload: new InMemoryLoginRateLimiter(1000, 60_000) } }));
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});
afterEach(() => {
  delete process.env["CATALOG_WEB_ENABLED"];
});

interface Biz { s: Seller; ctx: CommandContext }
async function biz(opts: { flag?: boolean; role?: "OWNER" | "STAFF" } = {}): Promise<Biz> {
  const s = await makeSeller(prisma, `Catalog Web ${++k}`, { slug: `cat-web-${k}` });
  if (opts.flag !== false) await enableFlag(prisma, s.businessId, "catalogV2");
  const m = await prisma.merchant.create({ data: { businessId: s.businessId, phoneNumber: `2348066${String(k).padStart(6, "0")}`, onboardingStep: "COMPLETE", role: opts.role ?? "OWNER" } });
  return { s, ctx: { prisma, scopedPrisma: s.scoped, businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: m.id, merchantRole: m.role } };
}
async function connect(b: Biz): Promise<string> {
  process.env["CATALOG_WEB_ENABLED"] = "true";
  const reply = await handleCommand(b.ctx, "/connect");
  const code = /(\d{8})/.exec(reply)?.[1];
  expect(code, reply).toBeDefined();
  const r = await request(app).post("/m/api/session").send({ code });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.features).toMatchObject({ catalog: true });
  return r.body.token as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("the catalog screen is off unless the switch and the business flag are on", () => {
  it("refuses everything otherwise, and /connect stays an unknown command", async () => {
    const b = await biz({ flag: false });
    expect(await handleCommand(b.ctx, "/connect")).toContain('Unrecognized command "/connect"');
    process.env["CATALOG_WEB_ENABLED"] = "true";
    expect(await handleCommand(b.ctx, "/connect")).toContain('Unrecognized command "/connect"'); // switch on, flag off
    expect((await request(app).get("/m/api/catalog")).status).toBe(401);
    expect((await request(app).get("/m/api/catalog").set(auth("0".repeat(64)))).status).toBe(401);
  });

  it("serves the Products section on the phone page without ever using innerHTML", () => {
    expect(OFFLINE_PAGE).toContain('id="catalogBox"');
    expect(OFFLINE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(OFFLINE_SCRIPT).toContain("/catalog/preview");
  });
});

describe("editing products in bulk", () => {
  it("lists the products, reviews a change, saves it once, and a retried save changes nothing", async () => {
    const b = await biz();
    const t = await connect(b);
    const list = await request(app).get("/m/api/catalog").set(auth(t));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ currencyCode: "NGN", can: { edit: true, list: true }, total: 1 });
    const row = list.body.rows[0];
    expect(row).toMatchObject({ sku: "COLA", retailPrice: "100.00", listed: true });

    const body = { rows: [{ sku: "COLA", rev: row.rev, retailPrice: "135" }] };
    const preview = await request(app).post("/m/api/catalog/preview").set(auth(t)).send(body);
    expect(preview.status).toBe(200);
    expect(preview.body.plan.rows[0].changes).toEqual(["price: 100.00 -> 135.00 NGN"]);

    const apply = await request(app).post("/m/api/catalog/apply").set(auth(t)).send({ batchId: "batch-web-0001", ...body });
    expect(apply.body).toMatchObject({ ok: true, replayed: false, updated: 1 });
    const again = await request(app).post("/m/api/catalog/apply").set(auth(t)).send({ batchId: "batch-web-0001", ...body });
    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect((await request(app).get("/m/api/catalog").set(auth(t))).body.rows[0].retailPrice).toBe("135.00");

    // the same screen later: a stale fingerprint is refused, nothing is saved
    const stale = await request(app).post("/m/api/catalog/apply").set(auth(t)).send({ batchId: "batch-web-0002", rows: [{ sku: "COLA", rev: row.rev, retailPrice: "1" }] });
    expect(stale.status).toBe(422);
    expect(stale.body.plan.rows[0].errors.join(" ")).toMatch(/changed after you opened/);
  });

  it("works from a CSV: download, edit, review, save", async () => {
    const b = await biz();
    const t = await connect(b);
    const dl = await request(app).get("/m/api/catalog.csv").set(auth(t));
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toContain("text/csv");
    expect(dl.headers["content-disposition"]).toContain("tradepal-products-");
    const edited = dl.text.replace('"100.00"', '"250"');
    const prev = await request(app).post("/m/api/catalog/preview").set(auth(t)).send({ csv: edited });
    expect(prev.body.plan.counts).toMatchObject({ update: 1, error: 0 });
    const done = await request(app).post("/m/api/catalog/apply").set(auth(t)).send({ batchId: "batch-csv-0001", csv: edited });
    expect(done.body).toMatchObject({ ok: true, updated: 1 });
    const bad = await request(app).post("/m/api/catalog/preview").set(auth(t)).send({ csv: "name,price\nx,1" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/must name the columns/);
  });

  it("rejects unknown fields, oversized bodies and a missing batch id", async () => {
    const b = await biz();
    const t = await connect(b);
    expect((await request(app).post("/m/api/catalog/preview").set(auth(t)).send({ rows: [{ sku: "COLA", costMinor: 5 }] })).status).toBe(400); // no cost field exists
    expect((await request(app).post("/m/api/catalog/apply").set(auth(t)).send({ rows: [{ sku: "COLA", retailPrice: "5" }] })).status).toBe(400);
    expect((await request(app).post("/m/api/catalog/preview").set(auth(t)).send({ csv: "sku\n" + "A".repeat(410_000) })).status).toBe(413);
  });

  it("a clerk can look but not change; a staff phone cannot add photos", async () => {
    const b = await biz({ role: "STAFF" });
    const t = await connect(b);
    expect((await request(app).get("/m/api/catalog").set(auth(t))).body.can).toEqual({ edit: false, list: false });
    expect((await request(app).post("/m/api/catalog/preview").set(auth(t)).send({ rows: [{ sku: "COLA", retailPrice: "5" }] })).status).toBe(403);
    expect((await request(app).post(`/m/api/catalog/photos/${b.s.product.id}`).set(auth(t)).set("Content-Type", "image/jpeg").send(fakeJpeg(900, 900))).status).toBe(403);
  });

  it("one business can never see or change another's products", async () => {
    const a = await biz();
    const other = await biz();
    const t = await connect(a);
    const rows = (await request(app).get("/m/api/catalog").set(auth(t))).body.rows;
    expect(rows).toHaveLength(1);
    const photo = await request(app).post(`/m/api/catalog/photos/${other.s.product.id}`).set(auth(t)).set("Content-Type", "image/jpeg").send(fakeJpeg(900, 900));
    expect(photo.status).toBe(404);
  });
});

describe("photos from the phone", () => {
  it("adds, lists, serves to its owner, makes one the main photo and removes one", async () => {
    const b = await biz();
    const t = await connect(b);
    const pid = b.s.product.id;
    const up = (buf: Buffer, type = "image/jpeg") => request(app).post(`/m/api/catalog/photos/${pid}`).set(auth(t)).set("Content-Type", type).send(buf);
    const one = await up(fakeJpeg(900, 900, 1));
    expect(one.status).toBe(201);
    expect((await up(fakeJpeg(900, 900, 1))).status).toBe(200); // same picture again
    const two = await up(fakeJpeg(900, 900, 2));
    expect(two.status).toBe(201);
    const list = await request(app).get(`/m/api/catalog/photos/${pid}`).set(auth(t));
    expect(list.body.photos.map((p: { id: string }) => p.id)).toEqual([one.body.photo.id, two.body.photo.id]);
    const bytes = await request(app).get(`/m/api/catalog/photo/${one.body.photo.id}`).set(auth(t));
    expect(bytes.status).toBe(200);
    expect(bytes.headers["content-type"]).toBe("image/jpeg");
    expect(bytes.headers["cache-control"]).toContain("no-store");
    expect((await request(app).get(`/m/api/catalog/photo/${one.body.photo.id}`)).status).toBe(401);
    expect((await request(app).post(`/m/api/catalog/photo/${two.body.photo.id}/main`).set(auth(t))).status).toBe(200);
    expect((await request(app).get(`/m/api/catalog/photos/${pid}`).set(auth(t))).body.photos[0].id).toBe(two.body.photo.id);
    expect((await request(app).delete(`/m/api/catalog/photo/${one.body.photo.id}`).set(auth(t))).status).toBe(200);
    expect((await request(app).get(`/m/api/catalog/photo/${one.body.photo.id}`).set(auth(t))).status).toBe(404);
    expect((await request(app).get("/m/api/catalog").set(auth(t))).body.rows[0].photos).toBe(1);
  });

  it("refuses text, SVG, oversized and wrong-type uploads", async () => {
    const b = await biz();
    const t = await connect(b);
    const pid = b.s.product.id;
    const post = (type: string, buf: Buffer) => request(app).post(`/m/api/catalog/photos/${pid}`).set(auth(t)).set("Content-Type", type).send(buf);
    expect((await post("image/svg+xml", Buffer.from("<svg onload=alert(1)/>"))).status).toBe(415);
    expect((await post("text/html", Buffer.from("<script>alert(1)</script>"))).status).toBe(415);
    const liar = await post("image/jpeg", Buffer.from("<html>pretending</html>" + " ".repeat(60)));
    expect(liar.status).toBe(422);
    expect(liar.body.code).toBe("NOT_AN_IMAGE");
    expect((await post("image/jpeg", Buffer.concat([fakeJpeg(900, 900), Buffer.alloc(420 * 1024)]))).status).toBe(413);
  });
});
