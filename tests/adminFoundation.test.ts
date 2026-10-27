import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";

/**
 * Admin-console foundation (Phase 1): what the DATABASE itself guarantees about staff accounts, second factors, invitations,
 * ownership, security events, two-person approvals and complimentary access. Refusals are provoked with raw SQL on the in-process
 * Postgres (the point is that the database refuses, not that application code is careful); setup uses Prisma.
 * The concurrent last-owner race only means something on a real server, so it runs when TEST_PG_ADMIN_URL is set.
 */
const REAL = !!process.env["TEST_PG_ADMIN_URL"];
vi.setConfig({ testTimeout: 120_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let db: PGlite;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  db = testDb.db;
  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({ data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" } });
  await prisma.language.create({ data: { code: "en", name: "English" } });
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

let n = 0;
const HASH = "a".repeat(64);
async function admin(role: "SUPER_ADMIN" | "OPERATOR" | "SUPPORT" | "ANALYST" | "FINANCE_ADMIN" | "MODERATOR" = "SUPPORT") {
  n++;
  return prisma.adminUser.create({ data: { email: `staff${n}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: `Staff ${n}`, role, passwordHash: "x".repeat(60) } });
}
/** Runs a statement that the database must refuse, and checks the reason. */
async function refuses(sql: string, params: unknown[], message: RegExp): Promise<void> {
  await expect(db.query(sql, params as never[])).rejects.toThrow(message);
}
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
const later = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

describe("staff accounts: role version and the last owner", () => {
  it("bumps the role version when (and only when) the role changes", async () => {
    const a = await admin("SUPPORT");
    expect(a.roleVersion).toBe(1);
    await prisma.adminUser.update({ where: { id: a.id }, data: { name: "Renamed" } });
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: a.id } })).roleVersion).toBe(1);
    await prisma.adminUser.update({ where: { id: a.id }, data: { role: "FINANCE_ADMIN" } });
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: a.id } })).roleVersion).toBe(2);
  });

  it("refuses to delete, disable or demote the last active owner, and allows it once a second owner exists", async () => {
    const only = await admin("SUPER_ADMIN");
    // other tests' owners may already exist in this database; remove the ambiguity by making `only` the sole active owner
    await db.exec(`UPDATE "AdminUser" SET "role" = 'SUPPORT' WHERE "role" = 'SUPER_ADMIN' AND "id" <> '${only.id}'`);
    await refuses(`UPDATE "AdminUser" SET "disabledAt" = now() WHERE "id" = $1`, [only.id], /last active platform owner/);
    await refuses(`UPDATE "AdminUser" SET "role" = 'OPERATOR' WHERE "id" = $1`, [only.id], /last active platform owner/);
    await refuses(`DELETE FROM "AdminUser" WHERE "id" = $1`, [only.id], /last active platform owner/);

    const second = await admin("SUPER_ADMIN");
    await db.query(`UPDATE "AdminUser" SET "role" = 'OPERATOR' WHERE "id" = $1`, [only.id]); // now fine: `second` remains
    await refuses(`UPDATE "AdminUser" SET "disabledAt" = now() WHERE "id" = $1`, [second.id], /last active platform owner/);
  });

  it("does not stop an ordinary staff member from being disabled", async () => {
    const owner = await admin("SUPER_ADMIN");
    const staff = await admin("SUPPORT");
    expect(owner.id).not.toBe(staff.id);
    await db.query(`UPDATE "AdminUser" SET "disabledAt" = now() WHERE "id" = $1`, [staff.id]);
  });
});

describe("admin sessions and second factors", () => {
  it("keeps sessions to the admin audience, with a positive lifetime and a reason when revoked", async () => {
    const a = await admin();
    const now = new Date();
    const ok = await prisma.adminSession.create({ data: { adminUserId: a.id, absoluteExpiresAt: new Date(now.getTime() + 3_600_000) } });
    expect(ok.audience).toBe("admin");
    await refuses(`INSERT INTO "AdminSession" ("id","adminUserId","audience","absoluteExpiresAt") VALUES (gen_random_uuid(), $1, 'merchant', $2)`, [a.id, soon()], /AdminSession_values_check/);
    await refuses(`INSERT INTO "AdminSession" ("id","adminUserId","createdAt","absoluteExpiresAt") VALUES (gen_random_uuid(), $1, now(), now() - interval '1 minute')`, [a.id], /AdminSession_values_check/);
    await refuses(`UPDATE "AdminSession" SET "revokedAt" = now() WHERE "id" = $1`, [ok.id], /AdminSession_values_check/);
    await db.query(`UPDATE "AdminSession" SET "revokedAt" = now(), "revokedReason" = 'signed out' WHERE "id" = $1`, [ok.id]);
  });

  it("allows one live second factor per admin and sane TOTP parameters only", async () => {
    const a = await admin();
    const f1 = await prisma.adminMfaFactor.create({ data: { adminUserId: a.id, secretCiphertext: "v1:ciphertext" } });
    await refuses(`INSERT INTO "AdminMfaFactor" ("id","adminUserId","secretCiphertext") VALUES (gen_random_uuid(), $1, 'v1:other')`, [a.id], /AdminMfaFactor_one_live_per_admin|duplicate key/);
    await prisma.adminMfaFactor.update({ where: { id: f1.id }, data: { disabledAt: new Date() } });
    await prisma.adminMfaFactor.create({ data: { adminUserId: a.id, secretCiphertext: "v1:replacement" } }); // a new one after the old is disabled
    const b = await admin();
    await refuses(`INSERT INTO "AdminMfaFactor" ("id","adminUserId","secretCiphertext","digits") VALUES (gen_random_uuid(), $1, 'v1:x', 7)`, [b.id], /AdminMfaFactor_values_check/);
    await refuses(`INSERT INTO "AdminMfaFactor" ("id","adminUserId","secretCiphertext","periodSeconds") VALUES (gen_random_uuid(), $1, 'v1:x', 5)`, [b.id], /AdminMfaFactor_values_check/);
  });
});

describe("staff invitations and ownership transfer", () => {
  it("keeps invitations email-bound (lower case), expiring, single-use, and one live invitation per address", async () => {
    const inviter = await admin("SUPER_ADMIN");
    const mk = (email: string, tokenHash: string, extra = "") =>
      db.query(
        `INSERT INTO "StaffInvitation" ("id","email","role","tokenHash","invitedById","expiresAt" ${extra ? "," + extra.split("=")[0] : ""}) VALUES (gen_random_uuid(), $1, 'SUPPORT', $2, $3, $4 ${extra ? "," + extra.split("=")[1] : ""})`,
        [email, tokenHash, inviter.id, later()],
      );
    await refuses(`INSERT INTO "StaffInvitation" ("id","email","role","tokenHash","invitedById","expiresAt") VALUES (gen_random_uuid(), 'Mixed@Case.test', 'SUPPORT', $1, $2, $3)`, ["h".repeat(40), inviter.id, later()], /StaffInvitation_values_check/);
    await refuses(`INSERT INTO "StaffInvitation" ("id","email","role","tokenHash","invitedById","createdAt","expiresAt") VALUES (gen_random_uuid(), 'old@case.test', 'SUPPORT', $1, $2, now(), now() - interval '1 hour')`, ["h".repeat(40), inviter.id], /StaffInvitation_values_check/);
    await mk("new.person@case.test", "t".repeat(40));
    await expect(mk("new.person@case.test", "u".repeat(40))).rejects.toThrow(/StaffInvitation_one_live_per_email|duplicate key/); // a second live invitation to the same address
    await db.query(`UPDATE "StaffInvitation" SET "revokedAt" = now() WHERE "email" = 'new.person@case.test'`);
    await mk("new.person@case.test", "v".repeat(40)); // fine once the first is revoked
    await refuses(`UPDATE "StaffInvitation" SET "acceptedAt" = now(), "acceptedById" = $1, "revokedAt" = now() WHERE "tokenHash" = $2`, [inviter.id, "v".repeat(40)], /StaffInvitation_values_check/);
  });

  it("makes an ownership transfer two different people, one open at a time, and final once decided", async () => {
    const from = await admin("SUPER_ADMIN");
    const to = await admin("OPERATOR");
    await refuses(`INSERT INTO "OwnershipTransfer" ("id","fromAdminId","toAdminId","expiresAt") VALUES (gen_random_uuid(), $1, $1, $2)`, [from.id, soon()], /OwnershipTransfer_values_check/);
    const t = await prisma.ownershipTransfer.create({ data: { fromAdminId: from.id, toAdminId: to.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    await refuses(`INSERT INTO "OwnershipTransfer" ("id","fromAdminId","toAdminId","expiresAt") VALUES (gen_random_uuid(), $1, $2, $3)`, [from.id, to.id, soon()], /OwnershipTransfer_one_initiated_per_owner|duplicate key/); // one open per owner
    await refuses(`UPDATE "OwnershipTransfer" SET "toAdminId" = $1 WHERE "id" = $2`, [from.id, t.id], /cannot be edited|OwnershipTransfer_values_check/);
    await db.query(`UPDATE "OwnershipTransfer" SET "status" = 'ACCEPTED', "decidedAt" = now() WHERE "id" = $1`, [t.id]);
    await refuses(`UPDATE "OwnershipTransfer" SET "status" = 'CANCELLED', "decidedAt" = now() WHERE "id" = $1`, [t.id], /decided ownership transfer cannot change/);
    await refuses(`DELETE FROM "OwnershipTransfer" WHERE "id" = $1`, [t.id], /never deleted/);
  });
});

describe("security events and role history are append-only", () => {
  it("accepts well-formed events and refuses update, delete, truncate and malformed rows", async () => {
    const a = await admin();
    const ev = await prisma.securityEvent.create({ data: { adminUserId: a.id, eventType: "LOGIN_FAILED", result: "FAILURE", subjectHash: "k".repeat(16) } });
    await refuses(`UPDATE "SecurityEvent" SET "result" = 'SUCCESS' WHERE "id" = $1`, [ev.id], /append-only/);
    await refuses(`DELETE FROM "SecurityEvent" WHERE "id" = $1`, [ev.id], /append-only/);
    await expect(db.exec(`TRUNCATE "SecurityEvent"`)).rejects.toThrow();
    await refuses(`INSERT INTO "SecurityEvent" ("id","eventType","result") VALUES (gen_random_uuid(), 'login failed', 'FAILURE')`, [], /SecurityEvent_values_check/);
    await refuses(`INSERT INTO "SecurityEvent" ("id","eventType","result") VALUES (gen_random_uuid(), 'LOGIN_FAILED', 'MAYBE')`, [], /SecurityEvent_values_check/);
  });

  it("keeps the role history append-only and meaningful", async () => {
    const a = await admin();
    const row = await prisma.staffRoleChange.create({ data: { adminUserId: a.id, fromRole: null, toRole: "SUPPORT", reason: "invited" } });
    await refuses(`UPDATE "StaffRoleChange" SET "reason" = 'edited later' WHERE "id" = $1`, [row.id], /append-only/);
    await refuses(`DELETE FROM "StaffRoleChange" WHERE "id" = $1`, [row.id], /append-only/);
    await refuses(`INSERT INTO "StaffRoleChange" ("id","adminUserId","fromRole","toRole","reason") VALUES (gen_random_uuid(), $1, 'SUPPORT', 'SUPPORT', 'no change')`, [a.id], /StaffRoleChange_values_check/);
  });
});

describe("two-person approval requests", () => {
  async function request(requestedById: string, extra: Record<string, unknown> = {}) {
    return prisma.approvalRequest.create({
      data: { actionType: "REFUND", targetType: "Invoice", targetId: "inv-1", reason: "customer was charged twice", payload: { amountMinor: "50000", currency: "NGN" }, payloadHash: HASH, requestedById, expiresAt: new Date(Date.now() + 3_600_000), ...extra },
    });
  }

  it("never lets the requester approve or reject their own request", async () => {
    const requester = await admin("FINANCE_ADMIN");
    const r = await request(requester.id);
    await refuses(`UPDATE "ApprovalRequest" SET "status" = 'APPROVED', "approvedById" = $1, "decidedAt" = now() WHERE "id" = $2`, [requester.id, r.id], /ApprovalRequest_values_check/);
    await refuses(`UPDATE "ApprovalRequest" SET "status" = 'REJECTED', "rejectedById" = $1, "decidedAt" = now() WHERE "id" = $2`, [requester.id, r.id], /ApprovalRequest_values_check/);
  });

  it("freezes what was asked: the payload, its hash and the target cannot change after the request", async () => {
    const requester = await admin("FINANCE_ADMIN");
    const r = await request(requester.id);
    await refuses(`UPDATE "ApprovalRequest" SET "payload" = '{"amountMinor":"900000","currency":"NGN"}' WHERE "id" = $1`, [r.id], /frozen once made/);
    await refuses(`UPDATE "ApprovalRequest" SET "payloadHash" = $1 WHERE "id" = $2`, ["b".repeat(64), r.id], /frozen once made/);
    await refuses(`UPDATE "ApprovalRequest" SET "targetId" = 'inv-2' WHERE "id" = $1`, [r.id], /frozen once made/);
    await refuses(`UPDATE "ApprovalRequest" SET "expiresAt" = "expiresAt" + interval '1 day' WHERE "id" = $1`, [r.id], /frozen once made/);
    const ins = (hash: string, reason: string) =>
      `INSERT INTO "ApprovalRequest" ("id","actionType","targetType","targetId","reason","payload","payloadHash","requestedById","expiresAt") VALUES (gen_random_uuid(), 'REFUND', 'Invoice', 'inv-9', '${reason}', '{}', '${hash}', '${requester.id}', '${soon()}')`;
    await refuses(ins("not-a-hash", "customer was charged twice"), [], /ApprovalRequest_values_check/);
    await refuses(ins(HASH, "short"), [], /ApprovalRequest_values_check/);
  });

  it("moves forward only: pending, approved, executed; a finished request is final and nothing is deleted", async () => {
    const requester = await admin("OPERATOR");
    const approver = await admin("FINANCE_ADMIN");
    const r = await request(requester.id);
    await refuses(`UPDATE "ApprovalRequest" SET "status" = 'EXECUTED', "approvedById" = $1, "decidedAt" = now(), "executedAt" = now() WHERE "id" = $2`, [approver.id, r.id], /cannot move from PENDING to EXECUTED/);
    await db.query(`UPDATE "ApprovalRequest" SET "status" = 'APPROVED', "approvedById" = $1, "decidedAt" = now() WHERE "id" = $2`, [approver.id, r.id]);
    await refuses(`UPDATE "ApprovalRequest" SET "status" = 'PENDING' WHERE "id" = $1`, [r.id], /cannot move from APPROVED to PENDING/);
    await refuses(`UPDATE "ApprovalRequest" SET "approvedById" = $1 WHERE "id" = $2`, [requester.id, r.id], /approver cannot be changed|ApprovalRequest_values_check/);
    await db.query(`UPDATE "ApprovalRequest" SET "status" = 'EXECUTED', "executedAt" = now() WHERE "id" = $1`, [r.id]);
    await refuses(`UPDATE "ApprovalRequest" SET "status" = 'CANCELLED' WHERE "id" = $1`, [r.id], /final|cannot move/);
    await refuses(`DELETE FROM "ApprovalRequest" WHERE "id" = $1`, [r.id], /never deleted/);
  });

  it("needs a named approver for an approval and a named rejecter for a rejection", async () => {
    const requester = await admin("OPERATOR");
    const r = await request(requester.id);
    await refuses(`UPDATE "ApprovalRequest" SET "status" = 'APPROVED', "decidedAt" = now() WHERE "id" = $1`, [r.id], /ApprovalRequest_values_check/);
    await refuses(`UPDATE "ApprovalRequest" SET "status" = 'REJECTED', "decidedAt" = now() WHERE "id" = $1`, [r.id], /ApprovalRequest_values_check/);
  });
});

describe("complimentary access grants", () => {
  async function biz() {
    return prisma.business.create({ data: { name: `Grant Biz ${++n}`, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" } });
  }

  it("needs a real reason and an end date after the start, and cannot be edited, only revoked", async () => {
    const b = await biz();
    const grantor = await admin("FINANCE_ADMIN");
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 86_400_000);
    const ins = (reason: string, startsAt: Date, expiresAt: Date) =>
      `INSERT INTO "EntitlementGrant" ("id","businessId","planCode","reason","grantedById","startsAt","expiresAt") VALUES (gen_random_uuid(), '${b.id}', 'STARTER', '${reason}', '${grantor.id}', '${startsAt.toISOString()}', '${expiresAt.toISOString()}')`;
    await refuses(ins("short", start, end), [], /EntitlementGrant_values_check/);
    await refuses(ins("pilot partner for one month", end, start), [], /EntitlementGrant_values_check/);
    const g = await prisma.entitlementGrant.create({ data: { businessId: b.id, planCode: "STARTER", reason: "pilot partner for one month", grantedById: grantor.id, startsAt: start, expiresAt: end } });
    await refuses(`UPDATE "EntitlementGrant" SET "expiresAt" = "expiresAt" + interval '365 days' WHERE "id" = $1`, [g.id], /cannot be edited/);
    await refuses(`UPDATE "EntitlementGrant" SET "revokedAt" = now() WHERE "id" = $1`, [g.id], /EntitlementGrant_values_check/); // who revoked it is required
    await db.query(`UPDATE "EntitlementGrant" SET "revokedAt" = now(), "revokedById" = $1 WHERE "id" = $2`, [grantor.id, g.id]);
    await refuses(`UPDATE "EntitlementGrant" SET "revokedAt" = NULL, "revokedById" = NULL WHERE "id" = $1`, [g.id], /revoked grant is final/);
    await refuses(`DELETE FROM "EntitlementGrant" WHERE "id" = $1`, [g.id], /never hard-deleted/);
  });
});

describe("the audit table kept its protection and gained typed columns", () => {
  it("defaults the result, rejects an unknown one, and is still append-only", async () => {
    const row = await prisma.auditLog.create({ data: { actorType: "ADMIN", actorId: "a1", action: "admin.test", entityType: "Test", reason: "because", correlationId: "corr-1" } });
    expect(row.result).toBe("SUCCESS");
    expect(row.reason).toBe("because");
    await refuses(`INSERT INTO "AuditLog" ("id","actorType","action","entityType","result") VALUES (gen_random_uuid(), 'ADMIN', 'x.y', 'T', 'MAYBE')`, [], /AuditLog_result_check/);
    await refuses(`UPDATE "AuditLog" SET "result" = 'FAILURE' WHERE "id" = $1`, [row.id], /append-only/);
    await refuses(`DELETE FROM "AuditLog" WHERE "id" = $1`, [row.id], /append-only/);
  });
});

describe.skipIf(!REAL)("last owner under genuine concurrency (real Postgres)", () => {
  it("two owners demoting each other at the same instant: exactly one succeeds and an owner always remains", async () => {
    // bring the table down to exactly one owner, one demotion at a time (each is allowed while another owner remains)
    for (;;) {
      const owners = await prisma.adminUser.findMany({ where: { role: "SUPER_ADMIN", disabledAt: null }, select: { id: true } });
      if (owners.length <= 1) break;
      await prisma.adminUser.update({ where: { id: owners[0]!.id }, data: { role: "SUPPORT" } });
    }
    for (let round = 0; round < 12; round++) {
      const a = await admin("SUPER_ADMIN");
      const b = await admin("SUPER_ADMIN");
      // the owner left over from the previous round steps aside, so that a and b are now the only two owners
      const leftover = await prisma.adminUser.findMany({ where: { role: "SUPER_ADMIN", disabledAt: null, id: { notIn: [a.id, b.id] } }, select: { id: true } });
      for (const o of leftover) await prisma.adminUser.update({ where: { id: o.id }, data: { role: "SUPPORT" } });
      const results = await Promise.allSettled([
        prisma.adminUser.update({ where: { id: b.id }, data: { role: "OPERATOR" } }),
        prisma.adminUser.update({ where: { id: a.id }, data: { role: "OPERATOR" } }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled").length, `round ${round}`).toBe(1);
      expect(await prisma.adminUser.count({ where: { role: "SUPER_ADMIN", disabledAt: null } }), `round ${round}`).toBe(1);
    }
  });
});
