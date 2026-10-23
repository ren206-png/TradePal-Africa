import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller } from "./helpers/store.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { runIntegrityChecks } from "../src/ops/integrity.js";
import { runOperationsSweep } from "../src/queue/operationsSweep.js";

vi.setConfig({ testTimeout: 60_000 });
let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

describe("scheduled data-integrity checks", () => {
  it("find nothing on a consistent world, then each kind of drift, without changing anything", async () => {
    const s = await makeSeller(prisma, "Integrity Shop", { slug: "integrity-shop" });
    const m = await prisma.merchant.create({ data: { businessId: s.businessId, phoneNumber: "2348033300001", onboardingStep: "COMPLETE", role: "OWNER" } });
    const mine = (r: Awaited<ReturnType<typeof runIntegrityChecks>>) => r.findings.filter((f) => f.businessId === s.businessId || f.check === "MEMBERSHIP_DRIFT");
    expect(await runIntegrityChecks(prisma)).toMatchObject({ truncated: false });
    // a merchant row with no membership (the mirror failed)
    expect(mine(await runIntegrityChecks(prisma)).map((f) => f.check)).toContain("MEMBERSHIP_DRIFT");
    await prisma.membership.create({ data: { businessId: s.businessId, phoneNumber: "2348033300001", role: "OWNER", status: "ACTIVE" } });
    expect(mine(await runIntegrityChecks(prisma))).toEqual([]);

    // a chat entry written without its journal entry
    await s.scoped.transaction.create({ data: { businessId: s.businessId, type: "SALE", amountMinor: 5000n, currencyCode: "NGN", paymentStatus: "PAID" } });
    const unj = mine(await runIntegrityChecks(prisma)).find((f) => f.check === "UNJOURNALED_TRANSACTIONS");
    expect(unj).toMatchObject({ businessId: s.businessId, count: 1 });

    // a running balance that disagrees with its movements
    await testDb.db.query(`UPDATE "StockBalance" SET "onHand" = "onHand" + 3 WHERE "variantId" = $1`, [s.variant.id]);
    const stock = mine(await runIntegrityChecks(prisma)).find((f) => f.check === "STOCK_BALANCE_MISMATCH");
    expect(stock).toMatchObject({ businessId: s.businessId, count: 1 });
    expect(await prisma.transaction.count({ where: { businessId: s.businessId } })).toBe(1); // read-only: nothing was "fixed"
    void m;
  });

  it("honours the business cap and says it was truncated", async () => {
    await makeSeller(prisma, "Second Shop", { slug: "second-shop" });
    expect((await runIntegrityChecks(prisma, new Date(), 1)).truncated).toBe(true);
  });

  it("runs as a step of the operations sweep only when asked, and an admin can read the result (cached, refreshable)", async () => {
    expect((await runOperationsSweep(prisma)).integrity).toBeUndefined();
    const withIt = await runOperationsSweep(prisma, new Date(), { integrity: true });
    expect(withIt.failures).toEqual([]);
    expect(withIt.integrity?.findings.length).toBeGreaterThan(0);

    await createAdminUser(prisma, { email: "ops@t.test", name: "o", role: "OPERATOR", password: "correct-horse" });
    await createAdminUser(prisma, { email: "analyst@t.test", name: "a", role: "ANALYST", password: "correct-horse" });
    const app = express();
    app.use(express.json());
    app.use("/admin", createAdminRouter(prisma, "test-secret-do-not-use-in-production"));
    const tok = async (email: string) => (await request(app).post("/admin/login").send({ email, password: "correct-horse" })).body.token as string;
    const r = await request(app).get("/admin/system/integrity").set("Authorization", `Bearer ${await tok("ops@t.test")}`);
    expect(r.status).toBe(200);
    expect(r.body.findings.length).toBeGreaterThan(0);
    expect((await request(app).get("/admin/system/integrity?refresh=1").set("Authorization", `Bearer ${await tok("analyst@t.test")}`)).status).toBe(200);
  });
});
