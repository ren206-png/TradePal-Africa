import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MerchantRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { PHONE, billingWorld, makeSlBusiness, publishedPlan, seedSierraLeone } from "./helpers/billing.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { applyBillingDeposit } from "../src/domain/subscriptions/collection.js";
import { setBillingConfig, type BillingConfig } from "../src/domain/subscriptions/common.js";
import type { PawaPayFake } from "./helpers/pawapayFake.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let fake: PawaPayFake;
let cfg: BillingConfig;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  await seedSierraLeone(prisma);
  ({ fake, cfg } = await billingWorld(prisma));
}, 60_000);
afterAll(async () => {
  setBillingConfig(null);
  await testDb.teardown();
});

const ctxFor = (b: Awaited<ReturnType<typeof makeSlBusiness>>, role: MerchantRole = "OWNER"): CommandContext => ({
  prisma, scopedPrisma: b.scoped, businessId: b.businessId, currencyCode: "SLE", minorUnitExp: 2, timezone: "Africa/Freetown", languageCode: "en", merchantId: b.merchantId, merchantRole: role,
});

describe("subscription commands", () => {
  it("answer like any unknown command while the flag is off, and are absent from /help", async () => {
    const b = await makeSlBusiness(prisma, { flags: [] });
    for (const c of ["/plans", "/billing", "/renew 23276123456", "/changeplan PRO", "/cancelplan"]) expect(await handleCommand(ctxFor(b), c), c).toContain("Unrecognized command");
    expect(await handleCommand(ctxFor(b), "/help")).not.toContain("/renew");
    await enableFlag(prisma, b.businessId, "pawapayBilling");
    expect(await handleCommand(ctxFor(b), "/help")).toContain("/renew");
  });

  it("lists only plans with a published price, shows status in plain words, and walks pay -> active -> change -> cancel", async () => {
    const b = await makeSlBusiness(prisma);
    const ctx = ctxFor(b);
    expect(await handleCommand(ctx, "/plans")).toContain("No plans are on offer");
    expect(await handleCommand(ctx, "/billing")).toContain("You are on the FREE plan");
    expect(await handleCommand(ctx, "/renew")).toContain("Give the mobile-money number");
    expect(await handleCommand(ctx, `/renew ${PHONE} STARTER`)).toContain("no plan with a published price");

    await publishedPlan(prisma, "STARTER", { priceMinor: 500_000n, features: ["trade"] });
    await publishedPlan(prisma, "PRO", { priceMinor: 900_000n });
    const list = await handleCommand(ctx, "/plans");
    expect(list).toContain("STARTER (Starter): 5000.00 SLE per 30 days. Includes: trade. 3 day(s) of grace");
    expect(list).toContain("PRO (Pro): 9000.00 SLE");
    expect(await handleCommand(ctx, "/renew abc STARTER")).toContain("valid mobile-money number");
    const sent = await handleCommand(ctx, `/renew ${PHONE} starter`);
    expect(sent).toContain("Orange Money number ending 3456: 5000.00 SLE for STARTER");
    expect(sent).toContain("nothing is ever charged automatically");
    expect(await handleCommand(ctx, `/renew ${PHONE} STARTER`)).toContain("already waiting");
    expect(await handleCommand(ctx, "/billing")).toContain("You are on the FREE plan"); // nothing is active until the provider confirms

    const attempt = await b.scoped.billingAttempt.findFirstOrThrow({ where: {} });
    fake.complete(attempt.id);
    await applyBillingDeposit(prisma, cfg, attempt.id, "CALLBACK", new Date());
    const status = await handleCommand(ctx, "/billing");
    expect(status).toMatch(/Your STARTER plan is active until \d{4}-\d{2}-\d{2}\./);
    expect(status).toMatch(/INV-[A-Z0-9]{8}: 5000\.00 SLE, paid/);
    expect(await handleCommand(ctx, `/renew ${PHONE}`)).toContain("You can renew from"); // too early
    expect(await handleCommand(ctx, `/renew ${PHONE} PRO`)).toContain("/changeplan");
    expect(await handleCommand(ctx, "/changeplan PRO")).toMatch(/from \d{4}-\d{2}-\d{2} you will be on PRO\. Nothing is charged or reduced now/);
    expect(await handleCommand(ctx, "/changeplan NOPE")).toContain("no published price");
    expect(await handleCommand(ctx, "/cancelplan")).toMatch(/will not renew\. You keep everything until/);
    expect(await handleCommand(ctx, "/billing")).toContain("It will not renew.");
  });

  it("only the owner can pay, change or cancel; staff cannot even view", async () => {
    await publishedPlan(prisma, "STARTER");
    const b = await makeSlBusiness(prisma);
    const staff = ctxFor(b, "STAFF");
    for (const c of ["/plans", "/billing", `/renew ${PHONE} STARTER`, "/changeplan PRO", "/cancelplan"]) expect(await handleCommand(staff, c), c).toBe("Only the owner can manage the subscription.");
    expect(await b.scoped.billingAttempt.count()).toBe(0);
  });
});
