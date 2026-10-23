import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller } from "./helpers/store.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { STEP_UP_HEADER } from "../src/admin/platformGuards.js";
import { enableMarketplace, fileReport, getMarketplaceListing, publishMarketplaceListing } from "../src/domain/marketplace.js";
import { fileAppeal } from "../src/domain/moderation.js";

vi.setConfig({ testTimeout: 60_000 });

const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let seller: Awaited<ReturnType<typeof makeSeller>>;
let listingId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginAs = async (email: string) => (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
const setFlag = (key: string, on: boolean) => prisma.featureFlag.update({ where: { key }, data: { enabledByDefault: on } });

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  seller = await makeSeller(prisma, "Moderated Shop", { slug: "moderated-shop" });
  await enableFlag(prisma, seller.businessId, "marketplace");
  await publishMarketplaceListing(prisma, seller.businessId, seller.variant.id, "Food and drink");
  await enableMarketplace(prisma, seller.businessId);
  listingId = (await seller.scoped.listing.findFirstOrThrow({ where: { channel: "MARKETPLACE" } })).id;
  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, SECRET));
}, 90_000);
afterAll(async () => {
  await testDb.teardown();
});
beforeEach(async () => {
  await setFlag("adminStepUp", false);
  await setFlag("adminSupportAccessRequired", false);
});

describe("admin listings and moderation panel", () => {
  it("shows the report queue with how many open reports a seller has; support can view but not decide", async () => {
    const r1 = await fileReport(prisma, { listingId, reason: "SCAM", details: "<b>They took my money</b> and never delivered", contact: "08030000000" });
    await fileReport(prisma, { listingId, reason: "COUNTERFEIT", details: "These look like fake branded drinks" });
    for (const email of ["super@t.test", "op@t.test", "support@t.test"]) {
      const q = await request(app).get("/admin/moderation/queue").set(auth(await loginAs(email)));
      expect(q.status, email).toBe(200);
      const row = q.body.reports.find((r: { id: string }) => r.id === r1.id);
      expect(row).toMatchObject({ reason: "SCAM", status: "OPEN", openReportsAboutSeller: 2, seller: { name: expect.stringContaining("Moderated Shop"), marketplaceStatus: "ACTIVE" }, listing: { id: listingId, sku: "COLA" } });
    }
    expect((await request(app).get("/admin/moderation/queue").set(auth(await loginAs("analyst@t.test")))).status).toBe(403);
    expect((await request(app).post(`/admin/moderation/listings/${listingId}/unpublish`).set(auth(await loginAs("support@t.test"))).send({ reason: "Looks counterfeit to me" })).status).toBe(403);
    expect((await request(app).get("/admin/moderation/queue")).status).toBe(401);
  });

  it("unpublishes a listing with a reason (audited), closes the report it came from, and the listing is gone publicly; reinstating restores it", async () => {
    const tok = await loginAs("op@t.test");
    const report = (await request(app).get("/admin/moderation/queue").set(auth(tok))).body.reports[0];
    expect((await request(app).post(`/admin/moderation/listings/${listingId}/unpublish`).set(auth(tok)).send({ reason: "short" })).status).toBe(400);
    const done = await request(app).post(`/admin/moderation/listings/${listingId}/unpublish`).set(auth(tok)).set("x-correlation-id", "corr-unpublish-1").send({ reason: "Counterfeit goods confirmed by the report", reportId: report.id });
    expect(done.status).toBe(200);
    expect(await getMarketplaceListing(prisma, listingId)).toBeNull();
    expect((await prisma.marketplaceReport.findUniqueOrThrow({ where: { id: report.id } })).status).toBe("ACTIONED");
    expect((await request(app).post(`/admin/moderation/listings/${listingId}/unpublish`).set(auth(tok)).send({ reason: "Unpublishing it a second time" })).status).toBe(409);
    expect((await request(app).get("/admin/moderation/listings?moderation=UNPUBLISHED").set(auth(tok))).body.listings.map((l: { id: string }) => l.id)).toContain(listingId);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "Moderation", entityId: listingId } });
    expect(audits).toHaveLength(1); // the refused second attempt leaves none
    expect(audits.some((a) => (a.metadata as { correlationId?: string })?.correlationId === "corr-unpublish-1")).toBe(true);
    expect(await seller.scoped.moderationAction.count({ where: { type: "UNPUBLISH_LISTING" } })).toBe(1);

    expect((await request(app).post(`/admin/moderation/listings/${listingId}/reinstate`).set(auth(tok)).send({ reason: "Checked again: goods are genuine" })).status).toBe(200);
    expect((await getMarketplaceListing(prisma, listingId))?.listingId).toBe(listingId);
  });

  it("suspends and reinstates a seller, dismisses a report, and decides an appeal", async () => {
    const tok = await loginAs("super@t.test");
    const sus = await request(app).post(`/admin/moderation/sellers/${seller.businessId}/suspend`).set(auth(tok)).send({ reason: "Several confirmed scam reports" });
    expect(sus.status).toBe(200);
    expect((await request(app).post(`/admin/moderation/sellers/${seller.businessId}/suspend`).set(auth(tok)).send({ reason: "Suspending twice by mistake" })).status).toBe(409);
    expect((await request(app).get("/admin/moderation/sellers").set(auth(tok))).body.sellers.find((x: { businessId: string }) => x.businessId === seller.businessId)).toMatchObject({ marketplaceStatus: "SUSPENDED", note: "Several confirmed scam reports" });
    expect(await getMarketplaceListing(prisma, listingId)).toBeNull();

    const appeal = await fileAppeal(prisma, { businessId: seller.businessId, text: "The scam reports came from a rival; here is my evidence." });
    const open = await request(app).get("/admin/moderation/appeals").set(auth(tok));
    expect(open.body.appeals[0]).toMatchObject({ id: appeal.id, status: "OPEN", action: { type: "SUSPEND_SELLER" } });
    expect((await request(app).post(`/admin/moderation/appeals/${appeal.id}/decide`).set(auth(tok)).send({ outcome: "MAYBE", reason: "Not a real outcome" })).status).toBe(400);
    const decided = await request(app).post(`/admin/moderation/appeals/${appeal.id}/decide`).set(auth(tok)).send({ outcome: "OVERTURNED", reason: "Evidence shows the reports were retaliatory" });
    expect(decided.body.status).toBe("OVERTURNED");
    expect((await seller.scoped.storefront.findFirstOrThrow({ where: {} })).marketplaceStatus).toBe("ACTIVE");
    expect((await getMarketplaceListing(prisma, listingId))?.listingId).toBe(listingId);
    expect((await request(app).post(`/admin/moderation/appeals/${appeal.id}/decide`).set(auth(tok)).send({ outcome: "UPHELD", reason: "Deciding it a second time" })).status).toBe(409);

    const rep = await fileReport(prisma, { listingId, reason: "OTHER", details: "I just do not like this seller very much" });
    expect((await request(app).post(`/admin/moderation/reports/${rep.id}/dismiss`).set(auth(tok)).send({ reason: "No policy breach found" })).status).toBe(200);
    expect((await request(app).post(`/admin/moderation/reports/${rep.id}/dismiss`).set(auth(tok)).send({ reason: "No policy breach found" })).status).toBe(409);
    expect((await request(app).get("/admin/moderation/actions").set(auth(tok))).body.actions.map((a: { type: string }) => a.type)).toEqual(expect.arrayContaining(["SUSPEND_SELLER", "REINSTATE_SELLER"]));
    expect((await request(app).delete(`/admin/moderation/listings/${listingId}`).set(auth(tok))).status).toBe(404);
  });

  it("every decision needs step-up when it is enabled", async () => {
    await setFlag("adminStepUp", true);
    const tok = await loginAs("op@t.test");
    const blocked = await request(app).post(`/admin/moderation/listings/${listingId}/unpublish`).set(auth(tok)).send({ reason: "Needs step-up before this works" });
    expect(blocked.body.code).toBe("STEP_UP_REQUIRED");
    const su = await request(app).post("/admin/step-up").set(auth(tok)).send({ password: PW });
    expect((await request(app).post(`/admin/moderation/listings/${listingId}/unpublish`).set(auth(tok)).set(STEP_UP_HEADER, su.body.stepUpToken).send({ reason: "Step-up satisfied, now it works" })).status).toBe(200);
  });
});
