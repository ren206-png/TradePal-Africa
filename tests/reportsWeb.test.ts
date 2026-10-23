import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { confirmStoreOrder, completeStoreOrder } from "../src/domain/store/orders.js";
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
  app.use(createOfflineRouter(prisma, { limiters: { exchange: new InMemoryLoginRateLimiter(1000, 60_000), api: new InMemoryLoginRateLimiter(10_000, 60_000) } }));
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});
afterEach(() => {
  delete process.env["REPORTS_WEB_ENABLED"];
  delete process.env["OFFLINE_DRAFTS_ENABLED"];
});

async function biz(role: "OWNER" | "STAFF" = "OWNER", flag = true) {
  const s = await makeSeller(prisma, `Reports Web ${++k}`, { slug: `reports-web-${k}`, flags: flag ? ["reportsV2"] : [] });
  const m = await prisma.merchant.create({ data: { businessId: s.businessId, phoneNumber: `2348055${String(k).padStart(6, "0")}`, onboardingStep: "COMPLETE", role } });
  const ctx: CommandContext = { prisma, scopedPrisma: s.scoped, businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: m.id, merchantRole: m.role };
  return { s, ctx };
}
async function connect(ctx: CommandContext, cmd = "/report link"): Promise<string> {
  process.env["REPORTS_WEB_ENABLED"] = "true";
  const reply = await handleCommand(ctx, cmd);
  const code = /code to open reports on a phone is (\d{8})/.exec(reply)?.[1] ?? /(\d{8})/.exec(reply)?.[1];
  expect(code, reply).toBeDefined();
  const r = await request(app).post("/m/api/session").send({ code });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.token as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function sell(s: Seller) {
  const { order } = await placeStoreOrder(prisma, s, { qty: 3 });
  await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
  await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: order.pickupCode, collect: { method: "CASH" } });
}

describe("reports on a phone", () => {
  it("are off without the switch and the flag", async () => {
    const off = await biz("OWNER", false);
    process.env["REPORTS_WEB_ENABLED"] = "true";
    expect(await handleCommand(off.ctx, "/report link")).toContain('Unrecognized command "/report"');
    const on = await biz();
    delete process.env["REPORTS_WEB_ENABLED"];
    expect(await handleCommand(on.ctx, "/report link")).toContain("not switched on yet");
    expect((await request(app).get("/m/api/reports/sales")).status).toBe(401);
  });

  it("returns JSON with provenance, warnings and notice, and a CSV only to someone allowed to export", async () => {
    const owner = await biz();
    await sell(owner.s);
    const token = await connect(owner.ctx);
    const j = await request(app).get("/m/api/reports/sales?period=month").set(auth(token));
    expect(j.status).toBe(200);
    expect(j.headers["cache-control"]).toBe("no-store");
    expect(j.body.meta).toMatchObject({ report: "sales", currencyCode: "NGN", timezone: "Africa/Lagos" });
    expect(j.body.meta.notice).toContain("not a tax filing");
    expect(j.body.data.totals.netSalesMinor).toBe("30000");
    const csv = await request(app).get("/m/api/reports/sales.csv").set(auth(token));
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.text).toContain("net_sales_minor");
    expect(csv.text).toContain('"notice"');
    // a sales clerk can read reports but is refused the download (they can't even get a link, so use the owner's code path for a clerk-role business)
    const clerk = await biz("STAFF");
    const clerkToken = await (async () => {
      const { issueConnectCode, exchangeConnectCode } = await import("../src/offline/devices.js");
      const { code } = await issueConnectCode(prisma, { businessId: clerk.s.businessId, merchantId: clerk.ctx.merchantId, shared: false });
      process.env["REPORTS_WEB_ENABLED"] = "true";
      return (await exchangeConnectCode(prisma, code))!.token;
    })();
    expect((await request(app).get("/m/api/reports/sales").set(auth(clerkToken))).status).toBe(200);
    expect((await request(app).get("/m/api/reports/sales.csv").set(auth(clerkToken))).status).toBe(403);
    for (const r of ["gross-margin", "inventory-valuation", "cash-flow", "payment-reconciliation"]) expect((await request(app).get(`/m/api/reports/${r}`).set(auth(clerkToken))).status, r).toBe(403);
  });

  it("only ever shows the connected business's own numbers", async () => {
    const a = await biz();
    const c = await biz();
    await sell(a.s);
    const ta = await connect(a.ctx);
    const tc = await connect(c.ctx);
    expect((await request(app).get("/m/api/reports/sales").set(auth(ta))).body.data.totals.netSalesMinor).toBe("30000");
    expect((await request(app).get("/m/api/reports/sales").set(auth(tc))).body.data.totals.netSalesMinor).toBe("0");
    // a business id in the query is ignored: there is no such parameter
    expect((await request(app).get(`/m/api/reports/sales?businessId=${a.s.businessId}`).set(auth(tc))).body.data.totals.netSalesMinor).toBe("0");
  });

  it("rejects an unknown report, a bad range and a draft call on a reports-only session, and explains an unsupported report", async () => {
    const b = await biz();
    const token = await connect(b.ctx);
    expect((await request(app).get("/m/api/reports/payroll").set(auth(token))).status).toBe(404);
    expect((await request(app).get("/m/api/reports/sales?from=2026-02-31&to=2026-03-01").set(auth(token))).status).toBe(400);
    expect((await request(app).get("/m/api/drafts").set(auth(token))).status).toBe(401); // drafts need their own switch
    await enableFlag(prisma, b.s.businessId, "accountingJournals", false);
    const r = await request(app).get("/m/api/reports/cash-flow").set(auth(token));
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("will not guess");
  });

  it("the phone page offers reports with the same caveats and never builds HTML from data", () => {
    expect(OFFLINE_PAGE).toContain('id="reportsBox"');
    expect(OFFLINE_SCRIPT).toContain("r.meta.warnings.forEach");
    expect(OFFLINE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
