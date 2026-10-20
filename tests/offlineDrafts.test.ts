import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, type Seller } from "./helpers/store.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { createOfflineRouter } from "../src/offline/routes.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { OFFLINE_PAGE, OFFLINE_SCRIPT, OFFLINE_SERVICE_WORKER } from "../src/offline/clientAssets.js";
import { issueConnectCode, exchangeConnectCode, SHARED_SESSION_HOURS } from "../src/offline/devices.js";

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
  app.use(createOfflineRouter(prisma, { limiters: { exchange: new InMemoryLoginRateLimiter(1000, 60_000), api: new InMemoryLoginRateLimiter(10_000, 60_000) } }));
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});
afterEach(() => {
  delete process.env["OFFLINE_DRAFTS_ENABLED"];
});

interface Biz { s: Seller; phone: string; merchantId: string; ctx: CommandContext }
async function biz(opts: { flag?: boolean; role?: "OWNER" | "STAFF" } = {}): Promise<Biz> {
  const s = await makeSeller(prisma, `Offline Shop ${++k}`, { slug: `off-shop-${k}` });
  if (opts.flag !== false) await enableFlag(prisma, s.businessId, "offlineDrafts");
  const phone = `2348077${String(k).padStart(6, "0")}`;
  const m = await prisma.merchant.create({ data: { businessId: s.businessId, phoneNumber: phone, onboardingStep: "COMPLETE", role: opts.role ?? "OWNER" } });
  const ctx: CommandContext = { prisma, scopedPrisma: s.scoped, businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: m.id, merchantRole: m.role };
  return { s, phone, merchantId: m.id, ctx };
}
async function connect(b: Biz, shared = false): Promise<string> {
  process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
  const reply = await handleCommand(b.ctx, shared ? "/connect shared" : "/connect");
  const code = /code to connect this phone is (\d{8})/.exec(reply)?.[1];
  expect(code, reply).toBeDefined();
  const r = await request(app).post("/m/api/session").send({ code });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.token as string;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const draft = (over: Record<string, unknown> = {}) => ({ clientId: `c-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`, kind: "SALE", amountMinor: 150_000, capturedAt: new Date().toISOString(), paymentStatus: "PAID", ...over });
const sync = (token: string, drafts: unknown[]) => request(app).post("/m/api/drafts/sync").set(auth(token)).send({ drafts });
const txCount = (businessId: string) => prisma.transaction.count({ where: { businessId } });

describe("connecting a phone", () => {
  it("is off: /connect answers like an unknown command without the switch or the flag, and the API refuses", async () => {
    const b = await biz({ flag: false });
    expect(await handleCommand(b.ctx, "/connect")).toContain('Unrecognized command "/connect"');
    process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
    expect(await handleCommand(b.ctx, "/connect")).toContain('Unrecognized command "/connect"'); // switch on, business flag off
    await enableFlag(prisma, b.s.businessId, "offlineDrafts");
    delete process.env["OFFLINE_DRAFTS_ENABLED"];
    expect(await handleCommand(b.ctx, "/connect")).toContain('Unrecognized command "/connect"'); // flag on, switch off
    expect((await handleCommand(b.ctx, "/help"))).not.toContain("/connect");
    expect((await request(app).get("/m/api/drafts")).status).toBe(401);
  });

  it("gives a one-time code that works once, then a token; the code and token are stored only as hashes", async () => {
    const b = await biz();
    process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
    const reply = await handleCommand(b.ctx, "/connect");
    const code = /(\d{8})/.exec(reply)![1]!;
    const first = await request(app).post("/m/api/session").send({ code });
    expect(first.status).toBe(200);
    expect(first.body.currencyCode).toBe("NGN");
    expect((await request(app).post("/m/api/session").send({ code })).status).toBe(401); // used
    const rows = await prisma.deviceSession.findMany({ where: { merchantId: b.merchantId } });
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain(first.body.token);
  });

  it("expires an unused code after ten minutes, and a newer code replaces an older unused one", async () => {
    const b = await biz();
    const old = await issueConnectCode(prisma, { businessId: b.s.businessId, merchantId: b.merchantId, shared: false, now: new Date(Date.now() - 11 * 60_000) });
    expect(await exchangeConnectCode(prisma, old.code)).toBeNull();
    const a = await issueConnectCode(prisma, { businessId: b.s.businessId, merchantId: b.merchantId, shared: false });
    const c = await issueConnectCode(prisma, { businessId: b.s.businessId, merchantId: b.merchantId, shared: false });
    expect(await exchangeConnectCode(prisma, a.code)).toBeNull();
    expect(await exchangeConnectCode(prisma, c.code)).not.toBeNull();
  });

  it("a shared phone gets a short session; disconnect and logout end sessions at once", async () => {
    const b = await biz();
    const token = await connect(b, true);
    const session = await prisma.deviceSession.findFirstOrThrow({ where: { merchantId: b.merchantId, shared: true } });
    expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(SHARED_SESSION_HOURS * 3_600_000 + 5000);
    expect((await request(app).get("/m/api/drafts").set(auth(token))).status).toBe(200);
    expect(await handleCommand(b.ctx, "/disconnect")).toContain("disconnected");
    expect((await request(app).get("/m/api/drafts").set(auth(token))).status).toBe(401);
    const t2 = await connect(b);
    expect((await request(app).post("/m/api/logout").set(auth(t2)).send({})).status).toBe(200);
    expect((await request(app).get("/m/api/drafts").set(auth(t2))).status).toBe(401);
  });

  it("stops working when the person is removed, even with a valid token", async () => {
    const b = await biz();
    const token = await connect(b);
    await prisma.merchant.update({ where: { id: b.merchantId }, data: { removedAt: new Date() } });
    expect((await sync(token, [draft()])).status).toBe(401);
  });
});

describe("drafts (scenario 17)", () => {
  it("a draft is only a note: syncing records nothing, and confirming records exactly one entry", async () => {
    const b = await biz();
    const token = await connect(b);
    const d = draft();
    const r = await sync(token, [d]);
    expect(r.body.results[0]).toMatchObject({ clientId: d.clientId, status: "PENDING_REVIEW", duplicate: false, conflicts: [] });
    expect(await txCount(b.s.businessId)).toBe(0);
    const id = r.body.results[0].id as string;
    const ok = await request(app).post(`/m/api/drafts/${id}/confirm`).set(auth(token)).send({});
    expect(ok.status).toBe(200);
    expect(await txCount(b.s.businessId)).toBe(1);
    const tx = await prisma.transaction.findFirstOrThrow({ where: { businessId: b.s.businessId } });
    expect(tx.amountMinor).toBe(150_000n);
    expect(tx.whatsappMessageId).toBe(`draft:${d.clientId}`);
    // confirming again, or syncing the same draft again, creates nothing new
    expect((await request(app).post(`/m/api/drafts/${id}/confirm`).set(auth(token)).send({})).body.transactionId).toBe(tx.id);
    expect((await sync(token, [d])).body.results[0]).toMatchObject({ status: "CONFIRMED", duplicate: true });
    expect(await txCount(b.s.businessId)).toBe(1);
    expect(await prisma.offlineDraft.count({ where: { businessId: b.s.businessId } })).toBe(1);
  });

  it("syncing the same batch twice (a dropped connection and a retry) makes one draft each", async () => {
    const b = await biz();
    const token = await connect(b);
    const batch = [draft(), draft({ kind: "EXPENSE", amountMinor: 20_000, description: "Fuel" })];
    await sync(token, batch);
    const again = await sync(token, batch);
    expect(again.body.results.map((x: { duplicate: boolean }) => x.duplicate)).toEqual([true, true]);
    expect(await prisma.offlineDraft.count({ where: { businessId: b.s.businessId } })).toBe(2);
    expect(await txCount(b.s.businessId)).toBe(0);
  });

  it("shows a changed price or short stock as a conflict that must be accepted knowingly", async () => {
    const b = await biz();
    const token = await connect(b);
    const stalePrice = draft({ amountMinor: 90_000, items: [{ itemName: "Cola can", quantity: 10, unitPriceMinor: 9_000, sku: "COLA", expectedUnitPriceMinor: 9_000 }] });
    const r = await sync(token, [stalePrice]);
    const row = r.body.results[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.conflicts[0]).toMatchObject({ code: "PRICE_CHANGED", expectedMinor: "9000", currentMinor: "10000" });
    const refused = await request(app).post(`/m/api/drafts/${row.id}/confirm`).set(auth(token)).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.conflicts[0].code).toBe("PRICE_CHANGED");
    expect(await txCount(b.s.businessId)).toBe(0);
    expect((await request(app).post(`/m/api/drafts/${row.id}/confirm`).set(auth(token)).send({ acceptConflicts: true })).status).toBe(200);
    expect(await txCount(b.s.businessId)).toBe(1);

    const short = await sync(token, [draft({ amountMinor: 600_000, items: [{ itemName: "Cola can", quantity: 60, unitPriceMinor: 10_000, sku: "COLA", expectedUnitPriceMinor: 10_000 }] })]);
    expect(short.body.results[0].conflicts.map((c: { code: string }) => c.code)).toEqual(["STOCK_SHORT"]);
    expect(short.body.results[0].conflicts[0].available).toBe(40); // 10 cans left with the price-change draft accepted above
  });

  it("re-checks at confirmation: stock that sold out after the sync is caught then", async () => {
    const b = await biz();
    const token = await connect(b);
    const ok = await sync(token, [draft({ amountMinor: 400_000, items: [{ itemName: "Cola can", quantity: 40, unitPriceMinor: 10_000, sku: "COLA", expectedUnitPriceMinor: 10_000 }] })]);
    expect(ok.body.results[0].status).toBe("PENDING_REVIEW");
    const { reserveStock } = await import("../src/domain/stock.js");
    await reserveStock(b.s.scoped, { businessId: b.s.businessId, shopId: b.s.shopId, variantId: b.s.variant.id, quantity: 30, reference: "other", idempotencyKey: `rv-${k}`, expiresAt: new Date(Date.now() + 3_600_000), now: new Date() });
    const r = await request(app).post(`/m/api/drafts/${ok.body.results[0].id}/confirm`).set(auth(token)).send({});
    expect(r.status).toBe(409);
    expect(r.body.conflicts[0]).toMatchObject({ code: "STOCK_SHORT", available: 20 });
    expect(await txCount(b.s.businessId)).toBe(0);
  });

  it("confirming a catalog-line sale takes the stock out in the same transaction; a shortage the person accepts is allowed and recorded", async () => {
    const b = await biz();
    const token = await connect(b);
    const { getStockLevel } = await import("../src/domain/stock.js");
    const level = () => getStockLevel(b.s.scoped, b.s.shopId, b.s.variant.id);
    const line = (qty: number) => ({ itemName: "Cola can", quantity: qty, unitPriceMinor: 10_000, sku: "COLA", expectedUnitPriceMinor: 10_000 });
    const free = await sync(token, [draft({ amountMinor: 50_000, items: [line(5)] })]);
    await request(app).post(`/m/api/drafts/${free.body.results[0].id}/confirm`).set(auth(token)).send({});
    expect((await level()).onHand).toBe(45);
    const confirm2 = await request(app).post(`/m/api/drafts/${(await sync(token, [draft({ amountMinor: 50_000, items: [line(5)] })])).body.results[0].id}/confirm`).set(auth(token)).send({});
    expect(confirm2.status).toBe(200);
    expect((await level()).onHand).toBe(40);

    const short = await sync(token, [draft({ amountMinor: 500_000, items: [line(50)] })]);
    expect(short.body.results[0].status).toBe("CONFLICT");
    expect((await request(app).post(`/m/api/drafts/${short.body.results[0].id}/confirm`).set(auth(token)).send({})).status).toBe(409);
    expect((await level()).onHand).toBe(40); // nothing moved
    expect((await request(app).post(`/m/api/drafts/${short.body.results[0].id}/confirm`).set(auth(token)).send({ acceptConflicts: true })).status).toBe(200);
    expect((await level()).onHand).toBe(-10); // knowingly oversold, recorded as approved by the person
    const move = await prisma.stockMovement.findFirstOrThrow({ where: { businessId: b.s.businessId, sourceType: "OFFLINE_DRAFT" }, orderBy: { createdAt: "desc" } });
    expect(move.note).toContain("negative stock approved by");
  });

  it("flags a total that is not the sum of its lines, a phone clock ahead, and an old draft; rejects credit with no customer and unreadable drafts", async () => {
    const b = await biz();
    const token = await connect(b);
    const r = await sync(token, [
      draft({ amountMinor: 5, items: [{ itemName: "x", quantity: 2, unitPriceMinor: 100 }] }),
      draft({ capturedAt: new Date(Date.now() + 3_600_000).toISOString() }),
      draft({ capturedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }),
      draft({ paymentStatus: "CREDIT" }),
      { clientId: "x", kind: "SALE" },
    ]);
    const codes = r.body.results.map((x: { status: string; conflicts: { code: string }[] }) => [x.status, x.conflicts[0]?.code]);
    expect(codes).toEqual([["CONFLICT", "AMOUNT_MISMATCH"], ["CONFLICT", "CLOCK_AHEAD"], ["CONFLICT", "STALE_CAPTURE"], ["REJECTED", "AMOUNT_MISMATCH"], ["REJECTED", "AMOUNT_MISMATCH"]]);
  });

  it("one business's phone can never see or settle another business's drafts", async () => {
    const a = await biz();
    const c = await biz();
    const ta = await connect(a);
    const tc = await connect(c);
    const id = (await sync(ta, [draft()])).body.results[0].id as string;
    expect((await request(app).get("/m/api/drafts").set(auth(tc))).body.drafts).toEqual([]);
    expect((await request(app).post(`/m/api/drafts/${id}/confirm`).set(auth(tc)).send({})).status).toBe(404);
    expect((await request(app).post(`/m/api/drafts/${id}/discard`).set(auth(tc)).send({})).status).toBe(404);
    expect(await txCount(a.s.businessId)).toBe(0);
  });

  it("discard is final, and a confirmed draft cannot be discarded or changed", async () => {
    const b = await biz();
    const token = await connect(b);
    const id = (await sync(token, [draft()])).body.results[0].id as string;
    expect((await request(app).post(`/m/api/drafts/${id}/discard`).set(auth(token)).send({})).status).toBe(200);
    expect((await request(app).post(`/m/api/drafts/${id}/confirm`).set(auth(token)).send({})).status).toBe(409);
    const id2 = (await sync(token, [draft()])).body.results[0].id as string;
    await request(app).post(`/m/api/drafts/${id2}/confirm`).set(auth(token)).send({});
    expect((await request(app).post(`/m/api/drafts/${id2}/discard`).set(auth(token)).send({})).status).toBe(409);
    await expect(testDb.db.query(`UPDATE "OfflineDraft" SET "status"='DISCARDED' WHERE "id"=$1`, [id2])).rejects.toThrow(/final/);
    await expect(testDb.db.query(`DELETE FROM "OfflineDraft" WHERE "id"=$1`, [id2])).rejects.toThrow(/not permitted/);
  });

  it("limits a batch to 50 and rejects a bad body", async () => {
    const b = await biz();
    const token = await connect(b);
    expect((await sync(token, Array.from({ length: 51 }, () => draft()))).status).toBe(400);
    expect((await request(app).post("/m/api/drafts/sync").set(auth(token)).send({ drafts: "no" })).status).toBe(400);
  });
});

describe("what the phone is served", () => {
  it("never makes API responses cacheable, and the page has a strict content policy", async () => {
    const page = await request(app).get("/m/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect(page.text).toBe(OFFLINE_PAGE);
    expect(page.text).not.toMatch(/<script>[^<]/); // no inline script
    const api = await request(app).get("/m/api/drafts");
    expect(api.headers["cache-control"]).toBe("no-store");
  });

  it("the service worker caches only the two shell files and never answers an API request", async () => {
    const sw = await request(app).get("/m/sw.js");
    expect(sw.text).toBe(OFFLINE_SERVICE_WORKER);
    expect(sw.headers["service-worker-allowed"]).toBe("/m/");
    expect(sw.text).toContain('var SHELL = ["/m/", "/m/app.js"]');
    expect(OFFLINE_SERVICE_WORKER.replace(/\/\/.*$/gm, "")).not.toMatch(/api|authorization|token|cache\.put/i);
    expect(OFFLINE_SERVICE_WORKER).toContain("SHELL.indexOf(url.pathname) === -1) return;");
  });

  it("the script writes with textContent only, labels drafts as not recorded, and clears everything on logout", async () => {
    expect(OFFLINE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(OFFLINE_SCRIPT).toContain("DRAFT, not recorded yet");
    expect(OFFLINE_SCRIPT).toContain("indexedDB.deleteDatabase");
    expect(OFFLINE_SCRIPT).toContain("caches.delete");
    expect(OFFLINE_SCRIPT).toContain("unregister()");
    expect(OFFLINE_SCRIPT).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    // the token lives in the local database that logout deletes, and a 401 wipes it too
    expect(OFFLINE_SCRIPT).toMatch(/status === 401\) \{ return wipe\(\)/);
  });
});
