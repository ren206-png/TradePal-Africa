import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { buildHarness, secretFor, PW, type Harness } from "./helpers/adminConsole.js";
import { StaffError, acceptInvitation, changeRole, createInvitation, passwordProblem } from "../src/admin/staffAdmin.js";
import { BootstrapError, bootstrapOwner, resetAdminMfaCommand } from "../src/admin/ownerBootstrap.js";
import { revalidateActor } from "../src/admin/actorRevalidation.js";
import { mountAdminConsole } from "../src/admin/mount.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Staff access (admin-console Phase 2): invitations, role and account changes, session revocation, ownership transfer, the owner
 * bootstrap and second-factor reset commands, the master switch, and re-checking a queued action's actor.
 */
let testDb: TestDb;
let prisma: PrismaClient;
let h: Harness;
const NEW_PW = "a-new-long-password-1";

async function owner(email = "boss@t.test") {
  const t = await h.signedIn(email);
  // a fresh confirmation for the sensitive calls that follow
  return t;
}
async function reauth(email: string, token: string) {
  h.clock.advance(1);
  const secret = await secretFor(prisma, email);
  const r = await h.http().post("/admin/session/reauth").set(h.auth(token)).send({ password: PW, code: await h.code(secret) });
  expect(r.status).toBe(200);
}
const linkToken = (link: string) => link.split("#token=")[1]!;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  for (const [email, role] of [["boss@t.test", "SUPER_ADMIN"], ["boss2@t.test", "SUPER_ADMIN"], ["ops@t.test", "OPERATOR"], ["audit@t.test", "ANALYST"], ["support@t.test", "SUPPORT"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  h = buildHarness(prisma);
}, 60_000);
afterAll(async () => {
  h.close();
  await testDb.teardown();
});

describe("invitations", () => {
  it("is bound to one email, shown once, expiring, and redeemed once; the new account must enrol its second factor", async () => {
    const o = await owner();
    const created = await h.http().post("/admin/staff/invitations").set(h.auth(o.token)).send({ email: "New.Person@T.test", role: "FINANCE_ADMIN" });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe("new.person@t.test"); // normalised
    expect(created.body.link).toMatch(/^https:\/\/admin\.example\.test\/accept-invite#token=/);
    const token = linkToken(created.body.link);
    const stored = JSON.stringify(await prisma.staffInvitation.findMany());
    expect(stored).not.toContain(token); // only the hash is kept

    const accept = await h.http().post("/admin/invitations/accept").send({ token, name: "New Person", password: NEW_PW });
    expect(accept.status).toBe(201);
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: "new.person@t.test" } });
    expect(admin.role).toBe("FINANCE_ADMIN");
    expect(admin.mfaRequiredAt).not.toBeNull();
    expect(await prisma.staffRoleChange.count({ where: { adminUserId: admin.id, fromRole: null, toRole: "FINANCE_ADMIN" } })).toBe(1);

    const again = await h.http().post("/admin/invitations/accept").send({ token, name: "Someone Else", password: NEW_PW });
    expect([again.status, again.body.code]).toEqual([400, "INVITATION_INVALID"]); // single use

    const login = await h.login("new.person@t.test", NEW_PW);
    expect(login.status).toBe(200);
    expect(login.body.mfa.state).toBe("ENROLMENT_REQUIRED");
  });

  it("answers an unknown, used, revoked or expired token the same way, and refuses a weak password without burning the token", async () => {
    const o = await owner();
    const mk = async (email: string) => linkToken((await h.http().post("/admin/staff/invitations").set(h.auth(o.token)).send({ email, role: "SUPPORT" })).body.link);
    const weak = await mk("weak@t.test");
    const w = await h.http().post("/admin/invitations/accept").send({ token: weak, name: "W", password: "short" });
    expect([w.status, w.body.code]).toEqual([400, "WEAK_PASSWORD"]);
    expect((await h.http().post("/admin/invitations/accept").send({ token: weak, name: "W", password: NEW_PW })).status).toBe(201); // still usable

    const revoked = await mk("revoked@t.test");
    const inv = await prisma.staffInvitation.findFirstOrThrow({ where: { email: "revoked@t.test" } });
    expect((await h.http().post(`/admin/staff/invitations/${inv.id}/revoke`).set(h.auth(o.token)).send({})).status).toBe(200);
    const expired = await mk("expired@t.test");
    await prisma.$executeRawUnsafe(`UPDATE "StaffInvitation" SET "expiresAt" = now() - interval '1 minute', "createdAt" = now() - interval '2 days' WHERE "email" = 'expired@t.test'`);
    const unknown = "x".repeat(43);
    const bodies = [];
    for (const token of [unknown, revoked, expired]) {
      const r = await h.http().post("/admin/invitations/accept").send({ token, name: "X", password: NEW_PW });
      bodies.push([r.status, r.body]);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]![0]).toBe(400);
  });

  it("allows one live invitation per address, resend kills the old link, and refuses someone who already has an account", async () => {
    const o = await owner();
    const first = await h.http().post("/admin/staff/invitations").set(h.auth(o.token)).send({ email: "twice@t.test", role: "SUPPORT" });
    expect(first.status).toBe(201);
    expect((await h.http().post("/admin/staff/invitations").set(h.auth(o.token)).send({ email: "twice@t.test", role: "SUPPORT" })).body.code).toBe("INVITATION_EXISTS");
    const resend = await h.http().post(`/admin/staff/invitations/${first.body.id}/resend`).set(h.auth(o.token)).send({});
    expect(resend.status).toBe(201);
    expect((await h.http().post("/admin/invitations/accept").send({ token: linkToken(first.body.link), name: "T", password: NEW_PW })).status).toBe(400); // old link is dead
    expect((await h.http().post("/admin/invitations/accept").send({ token: linkToken(resend.body.link), name: "T", password: NEW_PW })).status).toBe(201);
    expect((await h.http().post("/admin/staff/invitations").set(h.auth(o.token)).send({ email: "ops@t.test", role: "SUPPORT" })).body.code).toBe("ALREADY_STAFF");
  });

  it("is for owners only, and never emails or logs the token", async () => {
    const t = await h.signedIn("ops@t.test");
    expect((await h.http().post("/admin/staff/invitations").set(h.auth(t.token)).send({ email: "x@t.test", role: "SUPPORT" })).status).toBe(403);
    const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { action: { startsWith: "admin.staff." } } }));
    expect(audit).not.toMatch(/token=/);
  });

  it("checks passwords sensibly", () => {
    expect(passwordProblem("short", "a@b.c")).toMatch(/12/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa", "a@b.c")).toMatch(/repetitive/);
    expect(passwordProblem("jane.doe-is-here-1", "jane.doe@t.test")).toMatch(/email name/);
    expect(passwordProblem("a-different-long-pass", "jane@t.test")).toBeNull();
  });
});

describe("roles and accounts", () => {
  it("changes a role with a reason, writes the history and audit rows together, and bumps the role version", async () => {
    const o = await owner();
    await reauth("boss@t.test", o.token);
    const target = await prisma.adminUser.findUniqueOrThrow({ where: { email: "support@t.test" } });
    const bad = await h.http().put(`/admin/staff/${target.id}/role`).set(h.auth(o.token)).send({ role: "MODERATOR" });
    expect(bad.status).toBe(400); // a reason is required
    const ok = await h.http().put(`/admin/staff/${target.id}/role`).set(h.auth(o.token)).send({ role: "MODERATOR", reason: "moved to the moderation team" });
    expect(ok.status).toBe(200);
    expect(ok.body.roleVersion).toBe(target.roleVersion + 1);
    expect(await prisma.staffRoleChange.count({ where: { adminUserId: target.id, fromRole: "SUPPORT", toRole: "MODERATOR", reason: "moved to the moderation team" } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "admin.staff.role_changed", entityId: target.id } });
    expect(audit.reason).toBe("moved to the moderation team");
    expect(audit.actorId).toBeTruthy();
    expect(audit.correlationId).toBeTruthy();
  });

  it("refuses to change your own role or disable yourself, and the database keeps the last owner", async () => {
    const o = await owner();
    await reauth("boss@t.test", o.token);
    const me = await prisma.adminUser.findUniqueOrThrow({ where: { email: "boss@t.test" } });
    expect((await h.http().put(`/admin/staff/${me.id}/role`).set(h.auth(o.token)).send({ role: "OPERATOR", reason: "testing" })).body.code).toBe("SELF_CHANGE");
    expect((await h.http().post(`/admin/staff/${me.id}/disable`).set(h.auth(o.token)).send({ reason: "testing" })).body.code).toBe("SELF_CHANGE");
    // someone else cannot demote the only remaining owner either: park every other owner first
    await prisma.adminUser.update({ where: { email: "boss2@t.test" }, data: { role: "OPERATOR" } });
    await expect(changeRole(prisma, { targetId: me.id, role: "OPERATOR", reason: "attempt", byId: "00000000-0000-4000-8000-000000000001" })).rejects.toMatchObject({ code: "LAST_OWNER" });
    await prisma.adminUser.update({ where: { email: "boss2@t.test" }, data: { role: "SUPER_ADMIN" } });
  });

  it("disables an account: its sessions end at once and it cannot sign in; enabling restores sign-in", async () => {
    const victim = await h.signedIn("ops@t.test");
    const o = await owner();
    await reauth("boss@t.test", o.token);
    const target = await prisma.adminUser.findUniqueOrThrow({ where: { email: "ops@t.test" } });
    expect((await h.http().post(`/admin/staff/${target.id}/disable`).set(h.auth(o.token)).send({ reason: "left the company" })).status).toBe(200);
    expect((await h.http().get("/admin/me/permissions").set(h.auth(victim.token))).status).toBe(401);
    expect((await h.login("ops@t.test")).status).toBe(401);
    expect((await h.http().post(`/admin/staff/${target.id}/enable`).set(h.auth(o.token)).send({ reason: "came back" })).status).toBe(200);
    expect((await h.login("ops@t.test")).status).toBe(200);
  });

  it("ends every session of one person on request", async () => {
    const a = await h.signedIn("support@t.test");
    const b = await h.signedIn("support@t.test");
    const o = await owner();
    await reauth("boss@t.test", o.token);
    const target = await prisma.adminUser.findUniqueOrThrow({ where: { email: "support@t.test" } });
    const r = await h.http().post(`/admin/staff/${target.id}/revoke-sessions`).set(h.auth(o.token)).send({ reason: "lost laptop" });
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBeGreaterThanOrEqual(2);
    for (const s of [a, b]) expect((await h.http().get("/admin/me/permissions").set(h.auth(s.token))).status).toBe(401);
  });

  it("lists staff and security events to the auditor only, and never a hash, secret or code", async () => {
    const a = await h.signedIn("audit@t.test");
    const list = await h.http().get("/admin/staff").set(h.auth(a.token));
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    for (const needle of ["passwordHash", "secretCiphertext", "tokenHash", "codeHash", "$2a$", "$2b$"]) expect(text).not.toContain(needle);
    expect(list.body.staff.find((s: { email: string }) => s.email === "boss@t.test").mfa).toBe("ENROLLED");
    const events = await h.http().get("/admin/security-events?result=FAILURE").set(h.auth(a.token));
    expect(events.status).toBe(200);
    expect(events.body.events.every((e: { result: string }) => e.result === "FAILURE")).toBe(true);
    // paging works, and an unknown filter key is refused rather than silently ignored
    expect((await h.http().get("/admin/security-events?take=5&skip=0").set(h.auth(a.token))).status).toBe(200);
    expect((await h.http().get("/admin/security-events?surprise=1").set(h.auth(a.token))).status).toBe(400);
    const sup = await h.signedIn("support@t.test");
    expect((await h.http().get("/admin/staff").set(h.auth(sup.token))).status).toBe(403);
    expect((await h.http().get("/admin/security-events").set(h.auth(sup.token))).status).toBe(403);
  });
});

describe("ownership transfer", () => {
  it("hands ownership over in one step: the named person accepts and the old owner becomes an operator; nobody else can accept", async () => {
    await createAdminUser(prisma, { email: "heir@t.test", name: "heir", role: "OPERATOR", password: PW });
    const from = await h.signedIn("boss2@t.test");
    await reauth("boss2@t.test", from.token);
    const heir = await prisma.adminUser.findUniqueOrThrow({ where: { email: "heir@t.test" } });
    const boss2 = await prisma.adminUser.findUniqueOrThrow({ where: { email: "boss2@t.test" } });
    const started = await h.http().post("/admin/staff/ownership-transfers").set(h.auth(from.token)).send({ toAdminId: heir.id });
    expect(started.status).toBe(201);
    expect((await h.http().post("/admin/staff/ownership-transfers").set(h.auth(from.token)).send({ toAdminId: heir.id })).body.code).toBe("TRANSFER_OPEN");

    const stranger = await h.signedIn("support@t.test");
    const no = await h.http().post(`/admin/staff/ownership-transfers/${started.body.id}/accept`).set(h.auth(stranger.token)).send({});
    expect([no.status, no.body.code]).toEqual([403, "NOT_YOU"]);

    const to = await h.signedIn("heir@t.test");
    const accepted = await h.http().post(`/admin/staff/ownership-transfers/${started.body.id}/accept`).set(h.auth(to.token)).send({});
    expect(accepted.status).toBe(200);
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: heir.id } })).role).toBe("SUPER_ADMIN");
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: boss2.id } })).role).toBe("OPERATOR");
    expect(await prisma.staffRoleChange.count({ where: { adminUserId: { in: [heir.id, boss2.id] }, reason: { startsWith: "ownership transfer" } } })).toBe(2);
    expect((await prisma.ownershipTransfer.findUniqueOrThrow({ where: { id: started.body.id } })).status).toBe("ACCEPTED");
    // a decided transfer cannot be accepted again
    expect((await h.http().post(`/admin/staff/ownership-transfers/${started.body.id}/accept`).set(h.auth(to.token)).send({})).status).toBe(404);
  });

  it("expires after its time, can be cancelled by either person, and needs the owner role to start", async () => {
    const owner2 = await h.signedIn("heir@t.test"); // now an owner
    await reauth("heir@t.test", owner2.token);
    const target = await prisma.adminUser.findUniqueOrThrow({ where: { email: "boss2@t.test" } });
    const t1 = await h.http().post("/admin/staff/ownership-transfers").set(h.auth(owner2.token)).send({ toAdminId: target.id });
    expect(t1.status).toBe(201);
    h.clock.advance(25 * 60); // a day later every earlier session has expired, so both people sign in again
    const late = await h.signedIn("boss2@t.test");
    await reauth("boss2@t.test", late.token);
    const r = await h.http().post(`/admin/staff/ownership-transfers/${t1.body.id}/accept`).set(h.auth(late.token)).send({});
    expect([r.status, r.body.code]).toEqual([410, "EXPIRED"]);
    const owner2b = await h.signedIn("heir@t.test");
    await reauth("heir@t.test", owner2b.token);
    const t2 = await h.http().post("/admin/staff/ownership-transfers").set(h.auth(owner2b.token)).send({ toAdminId: target.id });
    expect(t2.status).toBe(201);
    expect((await h.http().post(`/admin/staff/ownership-transfers/${t2.body.id}/cancel`).set(h.auth(late.token)).send({})).status).toBe(200);
    const op = await h.signedIn("support@t.test");
    expect((await h.http().post("/admin/staff/ownership-transfers").set(h.auth(op.token)).send({ toAdminId: target.id })).status).toBe(403);
  });
});

describe("owner bootstrap and second-factor reset commands", () => {
  const env = (extra: Record<string, string> = {}) => ({ ADMIN_BOOTSTRAP_ALLOWED: "true", ...extra }) as NodeJS.ProcessEnv;

  it("refuses unless allowed, unless the identity is repeated, and for an unknown or disabled account", async () => {
    await createAdminUser(prisma, { email: "cand@t.test", name: "cand", role: "SUPPORT", password: PW });
    await expect(bootstrapOwner(prisma, { identity: "cand@t.test", confirm: "cand@t.test", env: {} as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: "DISABLED" });
    await expect(bootstrapOwner(prisma, { identity: "cand@t.test", confirm: "other@t.test", env: env() })).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });
    await expect(bootstrapOwner(prisma, { identity: "ghost@t.test", confirm: "ghost@t.test", env: env() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.adminUser.update({ where: { email: "cand@t.test" }, data: { disabledAt: new Date() } });
    await expect(bootstrapOwner(prisma, { identity: "cand@t.test", confirm: "cand@t.test", env: env() })).rejects.toBeInstanceOf(BootstrapError);
    await prisma.adminUser.update({ where: { email: "cand@t.test" }, data: { disabledAt: null } });
  });

  it("promotes once, is a no-op the second time, requires the second factor, and leaves an audit row by system:bootstrap", async () => {
    const out = await bootstrapOwner(prisma, { identity: "cand@t.test", confirm: "CAND@t.test", env: env() });
    expect(out.status).toBe("PROMOTED");
    const row = await prisma.adminUser.findUniqueOrThrow({ where: { email: "cand@t.test" } });
    expect([row.role, row.mfaRequiredAt !== null]).toEqual(["SUPER_ADMIN", true]);
    expect((await bootstrapOwner(prisma, { identity: row.id, confirm: row.id, env: env() })).status).toBe("ALREADY_OWNER");
    const audits = await prisma.auditLog.findMany({ where: { action: "admin.staff.owner_bootstrapped" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe("system:bootstrap");
    expect(await prisma.securityEvent.count({ where: { eventType: "OWNER_BOOTSTRAPPED", adminUserId: row.id } })).toBe(1);
    expect(await prisma.staffRoleChange.count({ where: { adminUserId: row.id, changedById: null, toRole: "SUPER_ADMIN" } })).toBe(1);
  });

  it("removes a locked-out person's second factor and sessions, audited, and makes them enrol again", async () => {
    const victim = await h.signedIn("audit@t.test");
    const row = await prisma.adminUser.findUniqueOrThrow({ where: { email: "audit@t.test" } });
    await expect(resetAdminMfaCommand(prisma, { identity: "audit@t.test", confirm: "audit@t.test", env: {} as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: "DISABLED" });
    const out = await resetAdminMfaCommand(prisma, { identity: "audit@t.test", confirm: "audit@t.test", env: env() });
    expect(out.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect((await h.http().get("/admin/me/permissions").set(h.auth(victim.token))).status).toBe(401);
    expect(await prisma.adminMfaFactor.count({ where: { adminUserId: row.id, disabledAt: null } })).toBe(0);
    expect(await prisma.adminRecoveryCode.count({ where: { adminUserId: row.id } })).toBe(0);
    expect((await h.login("audit@t.test")).body.mfa.state).toBe("ENROLMENT_REQUIRED");
    expect(await prisma.auditLog.count({ where: { action: "admin.staff.mfa_reset", entityId: row.id, actorId: "system:bootstrap" } })).toBe(1);
  });
});

describe("the master switch and cache headers", () => {
  function appWith(env: NodeJS.ProcessEnv) {
    const app = express();
    app.use(express.json());
    const mounted = mountAdminConsole(app, { prisma, jwtSecret: "s".repeat(32), env, allowedOrigins: [] });
    return { app, mounted };
  }

  it("answers every /admin path like a route that does not exist while the switch is off", async () => {
    for (const env of [{}, { ADMIN_CONSOLE_ENABLED: "false" }, { ADMIN_CONSOLE_ENABLED: "1" }, { ADMIN_CONSOLE_ENABLED: "TRUE" }] as NodeJS.ProcessEnv[]) {
      const { app, mounted } = appWith(env);
      expect(mounted).toBe(false);
      for (const [method, path] of [["get", "/admin/login"], ["post", "/admin/login"], ["get", "/admin/businesses"], ["post", "/admin/invitations/accept"], ["get", "/admin/staff"]] as const) {
        const r = await request(app)[method](path).send({});
        const missing = await request(app)[method]("/nothing-here").send({}); // the same method on a path that never existed
        // Express echoes the path in its 404 page, so compare with the path masked
        const mask = (text: string, p: string) => text.split(p).join("<path>");
        expect([r.status, mask(r.text, path)]).toEqual([missing.status, mask(missing.text, "/nothing-here")]);
        expect(r.headers["www-authenticate"]).toBeUndefined();
      }
    }
  });

  it("serves the console when on, and forbids caching on every admin response", async () => {
    const { app, mounted } = appWith({ ADMIN_CONSOLE_ENABLED: "true", ADMIN_MFA_ENFORCE: "false" } as NodeJS.ProcessEnv);
    expect(mounted).toBe(true);
    const r = await request(app).post("/admin/login").send({ email: "nobody@t.test", password: "x" });
    expect(r.status).toBe(401);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.headers["pragma"]).toBe("no-cache");
  });
});

describe("re-checking the actor of a queued action", () => {
  it("lets it run only while the account is active, still holds the permission, and its role is unchanged since queueing", async () => {
    await createAdminUser(prisma, { email: "queued@t.test", name: "q", role: "FINANCE_ADMIN", password: PW });
    const a = await prisma.adminUser.findUniqueOrThrow({ where: { email: "queued@t.test" } });
    expect(await revalidateActor(prisma, { adminUserId: a.id, permission: "admin:approve_refund", roleVersionAtQueue: a.roleVersion })).toMatchObject({ ok: true });
    expect(await revalidateActor(prisma, { adminUserId: a.id, permission: "admin:manage_admins" })).toEqual({ ok: false, reason: "PERMISSION_LOST" });
    await prisma.adminUser.update({ where: { id: a.id }, data: { role: "SUPPORT" } });
    expect(await revalidateActor(prisma, { adminUserId: a.id, permission: "admin:approve_refund", roleVersionAtQueue: a.roleVersion })).toEqual({ ok: false, reason: "ROLE_CHANGED" });
    expect(await revalidateActor(prisma, { adminUserId: a.id, permission: "admin:approve_refund" })).toEqual({ ok: false, reason: "PERMISSION_LOST" });
    await prisma.adminUser.update({ where: { id: a.id }, data: { disabledAt: new Date() } });
    expect(await revalidateActor(prisma, { adminUserId: a.id, permission: "admin:view_overview" })).toEqual({ ok: false, reason: "DISABLED" });
    expect(await revalidateActor(prisma, { adminUserId: "00000000-0000-4000-8000-0000000000ff", permission: "admin:view_overview" })).toEqual({ ok: false, reason: "NOT_FOUND" });
  });
});

describe("domain guards", () => {
  it("keeps staff errors typed", async () => {
    await expect(createInvitation(prisma, { email: "boss@t.test", role: "SUPPORT", invitedById: "x" })).rejects.toBeInstanceOf(StaffError);
    await expect(acceptInvitation(prisma, { token: "nope", name: "n", password: NEW_PW })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });
});
