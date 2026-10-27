import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference, makeBusiness } from "./helpers/phase2.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { buildHarness, PW, type Harness } from "./helpers/adminConsole.js";
import { aiProviderStatus, configurationPresence } from "../src/admin/adminHealth.js";

vi.setConfig({ testTimeout: 120_000 });

/** Admin-console Phase 3: the system-health view's AI and configuration sections, and the audit log filters. */
let testDb: TestDb;
let prisma: PrismaClient;
let h: Harness;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  for (const [email, role] of [["owner@t.test", "SUPER_ADMIN"], ["ops@t.test", "OPERATOR"], ["mod@t.test", "MODERATOR"], ["fin@t.test", "FINANCE_ADMIN"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  h = buildHarness(prisma, { enforceMfa: false });
}, 60_000);
afterAll(async () => {
  h.close();
  await testDb.teardown();
});

describe("AI providers in system health", () => {
  it("counts a rejected key, a missing balance and other refusals separately, per provider, for the last 24 hours only", async () => {
    const { businessId } = await makeBusiness(prisma);
    const now = new Date();
    const old = new Date(now.getTime() - 48 * 3600_000);
    const row = (provider: "ANTHROPIC" | "DEEPSEEK", phase: "COMMIT" | "RELEASE", httpStatus: number | null, errorClass: string | null, createdAt = now) => ({
      requestId: `${provider}-${Math.random()}`, phase, businessId, feature: "parse", provider, requestedModel: "m", resolvedModel: "m", promptHash: "h".repeat(64),
      idempotencyKey: `${Math.random()}`, httpStatus, errorClass, createdAt,
    });
    await prisma.aiUsageLedger.createMany({
      data: [
        row("ANTHROPIC", "COMMIT", 200, null),
        row("ANTHROPIC", "RELEASE", 401, "APIError"),
        row("ANTHROPIC", "RELEASE", 400, "APIError"),
        row("ANTHROPIC", "RELEASE", 401, "APIError", old), // too old to count
        row("DEEPSEEK", "RELEASE", 402, "DeepSeekHttpError"),
        row("DEEPSEEK", "RELEASE", 402, "DeepSeekHttpError"),
        row("DEEPSEEK", "RELEASE", 500, "DeepSeekHttpError"),
      ],
    });
    const status = await aiProviderStatus(prisma, now);
    const a = status.find((s) => s.provider === "ANTHROPIC")!;
    const d = status.find((s) => s.provider === "DEEPSEEK")!;
    expect([a.authRefusals24h, a.billingRefusals24h, a.otherRefusals24h]).toEqual([1, 0, 1]);
    expect([d.authRefusals24h, d.billingRefusals24h, d.otherRefusals24h]).toEqual([0, 2, 1]);
    expect(a.lastSuccessfulCallAt).not.toBeNull();
    expect(d.lastSuccessfulCallAt).toBeNull();
  });

  it("reaches the console through GET /admin/system-health for those allowed, and shows configuration as yes/no only", async () => {
    const real = { ...process.env };
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-this-must-never-appear";
    process.env["ALERT_EMAIL_API_KEY"] = "re_this_must_never_appear";
    process.env["ALERT_EMAIL_TO"] = "ops@example.com";
    try {
      const { token } = await h.signedIn("owner@t.test");
      const res = await h.http().get("/admin/system-health").set(h.auth(token));
      expect(res.status).toBe(200);
      expect(res.body.aiProviders.map((p: { provider: string }) => p.provider).sort()).toEqual(["ANTHROPIC", "DEEPSEEK"]);
      expect(res.body.configuration).toMatchObject({ anthropic: true, alertEmail: true });
      const text = JSON.stringify(res.body);
      for (const secret of ["sk-ant-this-must-never-appear", "re_this_must_never_appear", "ops@example.com"]) expect(text).not.toContain(secret);
      // roles without the health permission cannot see it
      for (const email of ["mod@t.test", "fin@t.test"]) {
        const t = (await h.signedIn(email)).token;
        expect((await h.http().get("/admin/system-health").set(h.auth(t))).status, email).toBe(403);
      }
    } finally {
      for (const k of ["ANTHROPIC_API_KEY", "ALERT_EMAIL_API_KEY", "ALERT_EMAIL_TO"]) { if (real[k] === undefined) delete process.env[k]; else process.env[k] = real[k]!; }
    }
  });

  it("shows the activation switch for real subscription charges but offers no way to change it here", () => {
    expect(configurationPresence({ PAWAPAY_BILLING_PRODUCTION_ACTIVATED: "true" } as NodeJS.ProcessEnv)["pawapayBillingProductionActivated"]).toBe(true);
    expect(configurationPresence({} as NodeJS.ProcessEnv)["pawapayBillingProductionActivated"]).toBe(false);
  });
});

describe("audit log filters", () => {
  it("filters by actor, action (prefix or exact), target, outcome, request id and date, and shows reason and result", async () => {
    await prisma.auditLog.createMany({
      data: [
        { actorType: "ADMIN", actorId: "admin-a", action: "admin.refund.requested", entityType: "ApprovalRequest", entityId: "e1", reason: "twice charged", result: "SUCCESS", correlationId: "corr-aaaaaaaa" },
        { actorType: "ADMIN", actorId: "admin-b", action: "admin.refund.approved", entityType: "ApprovalRequest", entityId: "e1", result: "SUCCESS", correlationId: "corr-bbbbbbbb" },
        { actorType: "ADMIN", actorId: "admin-b", action: "admin.staff.role_changed", entityType: "AdminUser", entityId: "e2", result: "DENIED" },
        { actorType: "SYSTEM", actorId: "system:bootstrap", action: "admin.staff.owner_bootstrapped", entityType: "AdminUser", entityId: "e3" },
      ],
    });
    const { token } = await h.signedIn("owner@t.test");
    const q = async (query: string) => (await h.http().get(`/admin/audit-logs?${query}`).set(h.auth(token))).body.auditLogs as { action: string; reason: string | null; result: string; correlationId: string | null }[];
    expect((await q("actorId=admin-b")).map((r) => r.action).sort()).toEqual(["admin.refund.approved", "admin.staff.role_changed"]);
    expect((await q("action=admin.refund")).length).toBe(2);
    expect((await q("action=admin.refund&actionMode=exact")).length).toBe(0);
    expect((await q("action=admin.refund.approved&actionMode=exact")).length).toBe(1);
    expect((await q("entityType=ApprovalRequest&entityId=e1")).length).toBe(2);
    expect((await q("result=DENIED")).map((r) => r.action)).toEqual(["admin.staff.role_changed"]);
    expect((await q("correlationId=corr-aaaaaaaa"))[0]).toMatchObject({ reason: "twice charged", result: "SUCCESS", correlationId: "corr-aaaaaaaa" });
    expect((await q("actorType=SYSTEM")).length).toBe(1);
    expect((await q(`from=${new Date(Date.now() + 3600_000).toISOString()}`)).length).toBe(0);
    expect((await h.http().get("/admin/audit-logs?result=NOPE").set(h.auth(token))).status).toBe(400);
    expect((await h.http().get("/admin/audit-logs?from=yesterday").set(h.auth(token))).status).toBe(400);
  });

  it("is closed to the roles added after the original four unless they hold the audit permission", async () => {
    for (const email of ["mod@t.test", "fin@t.test"]) {
      const t = (await h.signedIn(email)).token;
      expect((await h.http().get("/admin/audit-logs").set(h.auth(t))).status, email).toBe(403);
    }
    const ops = (await h.signedIn("ops@t.test")).token;
    expect((await h.http().get("/admin/audit-logs").set(h.auth(ops))).status).toBe(200);
  });
});
