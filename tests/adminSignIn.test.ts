import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { ADMIN_JWT_AUDIENCE } from "../src/admin/auth.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { buildHarness, secretFor, PW, SECRET, type Harness } from "./helpers/adminConsole.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Staff sign-in (admin-console Phase 2): password, second factor (enrol, challenge, replay, recovery), server-side sessions
 * (absolute, idle, half-open), re-authentication, rate limits, and what the security events do and do not contain.
 */
let testDb: TestDb;
let prisma: PrismaClient;
let h: Harness;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  for (const [email, role] of [["owner@t.test", "SUPER_ADMIN"], ["owner2@t.test", "SUPER_ADMIN"], ["ops@t.test", "OPERATOR"], ["analyst@t.test", "ANALYST"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  h = buildHarness(prisma);
}, 60_000);
afterAll(async () => {
  h.close();
  await testDb.teardown();
});

describe("password sign-in", () => {
  it("answers the same for an unknown email, a wrong password and a disabled account, and records each without the email", async () => {
    await createAdminUser(prisma, { email: "off@t.test", name: "off", role: "SUPPORT", password: PW });
    await prisma.adminUser.update({ where: { email: "off@t.test" }, data: { disabledAt: new Date() } });
    const a = await h.login("nobody@t.test");
    const b = await h.login("ops@t.test", "wrong-password");
    const c = await h.login("off@t.test");
    for (const r of [a, b, c]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "Invalid email or password." });
    }
    const events = await prisma.securityEvent.findMany({ where: { eventType: "LOGIN_FAILED" } });
    expect(events.length).toBeGreaterThanOrEqual(3);
    const blob = JSON.stringify(events);
    expect(blob).not.toContain("nobody@t.test");
    expect(blob).not.toContain("wrong-password");
    expect(events.every((e) => e.subjectHash && e.subjectHash.length === 32)).toBe(true);
  });

  it("opens a server-side session whose id is the token id, with the admin audience, and reports the rules", async () => {
    const res = await h.login("analyst@t.test");
    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.token) as { jti: string; aud: string };
    expect(decoded.aud).toBe(ADMIN_JWT_AUDIENCE);
    const session = await prisma.adminSession.findUniqueOrThrow({ where: { id: decoded.jti } });
    expect(session.audience).toBe("admin");
    expect(session.mfaVerifiedAt).toBeNull(); // the second factor applies (enforced), and it has not been passed yet
    expect(res.body.mfa.state).toBe("ENROLMENT_REQUIRED");
    expect(res.body.session.idleTimeoutSeconds).toBe(1800);
  });

  it("refuses a token for another audience, and a token with no live session when sessions are required", async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: "ops@t.test" } });
    const wrongAud = jwt.sign({ adminUserId: admin.id, email: admin.email, role: admin.role }, SECRET, { expiresIn: 600, jwtid: "11111111-1111-4111-8111-111111111111", audience: "tradepal-merchant" });
    expect((await h.http().get("/admin/me/permissions").set(h.auth(wrongAud))).status).toBe(401);
    const noSession = jwt.sign({ adminUserId: admin.id, email: admin.email, role: admin.role }, SECRET, { expiresIn: 600, jwtid: "22222222-2222-4222-8222-222222222222", audience: ADMIN_JWT_AUDIENCE });
    const res = await h.http().get("/admin/me/permissions").set(h.auth(noSession));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REQUIRED");
  });
});

describe("second factor", () => {
  it("holds a half-open session to enrolment, sign-out and its own state until the factor is done", async () => {
    const login = await h.login("owner@t.test");
    const t = login.body.token as string;
    expect(login.body.mfa.state).toBe("ENROLMENT_REQUIRED");
    const blocked = await h.http().get("/admin/businesses").set(h.auth(t));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("MFA_ENROLMENT_REQUIRED");
    const info = await h.http().get("/admin/session").set(h.auth(t));
    expect(info.status).toBe(200);
    expect(info.body.permissions).toEqual([]); // nothing is granted before the factor
    expect(info.body.mfa.state).toBe("ENROLMENT_REQUIRED");
  });

  it("enrols with a first valid code, keeps the secret encrypted and the recovery codes hashed, and opens everything", async () => {
    const t = (await h.login("owner@t.test")).body.token as string;
    const start = await h.http().post("/admin/mfa/enroll/start").set(h.auth(t)).send({});
    expect(start.status).toBe(200);
    expect(start.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/TradePal%20Admin:owner%40t\.test\?secret=/);
    const wrong = await h.http().post("/admin/mfa/enroll/confirm").set(h.auth(t)).send({ code: "000000" });
    expect(wrong.status).toBe(400);
    const ok = await h.http().post("/admin/mfa/enroll/confirm").set(h.auth(t)).send({ code: await h.code(start.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(8);
    expect(ok.body.recoveryCodes.every((c: string) => /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/.test(c))).toBe(true);
    expect((await h.http().get("/admin/businesses").set(h.auth(t))).status).toBe(200);

    const factor = await prisma.adminMfaFactor.findFirstOrThrow({ where: { disabledAt: null } });
    expect(factor.secretCiphertext.startsWith("v1:")).toBe(true);
    expect(factor.secretCiphertext).not.toContain(start.body.secret);
    const stored = JSON.stringify(await prisma.adminRecoveryCode.findMany());
    for (const code of ok.body.recoveryCodes as string[]) expect(stored).not.toContain(code.replace("-", ""));
    // enrolling again with a factor in place is refused
    const again = await h.http().post("/admin/mfa/enroll/start").set(h.auth(t)).send({});
    expect(again.status).toBe(409);
  });

  it("challenges the next sign-in, refuses a wrong code, and refuses the same code twice (replay)", async () => {
    const login = await h.login("owner@t.test");
    expect(login.body.mfa.state).toBe("CHALLENGE_REQUIRED");
    const t = login.body.token as string;
    h.clock.advance(1);
    const secret = await secretFor(prisma, "owner@t.test");
    const bad = await h.http().post("/admin/mfa/challenge").set(h.auth(t)).send({ code: "123456" });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "That code is not right.", code: "BAD_CODE" });
    const code = await h.code(secret);
    expect((await h.http().post("/admin/mfa/challenge").set(h.auth(t)).send({ code })).status).toBe(200);
    expect((await h.http().get("/admin/businesses").set(h.auth(t))).status).toBe(200);
    // a second sign-in in the same time step cannot use that code again
    const t2 = (await h.login("owner@t.test")).body.token as string;
    const replay = await h.http().post("/admin/mfa/challenge").set(h.auth(t2)).send({ code });
    expect(replay.status).toBe(401);
    const events = await prisma.securityEvent.findMany({ where: { eventType: "MFA_FAILED" } });
    expect(events.some((e) => (e.metadata as { replay?: boolean } | null)?.replay === true)).toBe(true);
  });

  it("accepts a recovery code once, counts down, and refuses it afterwards", async () => {
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: "owner2@t.test" } });
    const login = await h.login("owner2@t.test");
    const t = login.body.token as string;
    const start = await h.http().post("/admin/mfa/enroll/start").set(h.auth(t)).send({});
    const conf = await h.http().post("/admin/mfa/enroll/confirm").set(h.auth(t)).send({ code: await h.code(start.body.secret) });
    const codes = conf.body.recoveryCodes as string[];
    const t2 = (await h.login("owner2@t.test")).body.token as string;
    const used = await h.http().post("/admin/mfa/recovery").set(h.auth(t2)).send({ code: codes[0]!.toLowerCase() }); // case does not matter
    expect(used.status).toBe(200);
    expect(used.body.recoveryCodesRemaining).toBe(7);
    expect((await h.http().get("/admin/businesses").set(h.auth(t2))).status).toBe(200);
    const t3 = (await h.login("owner2@t.test")).body.token as string;
    expect((await h.http().post("/admin/mfa/recovery").set(h.auth(t3)).send({ code: codes[0] })).status).toBe(401);
    expect((await prisma.adminRecoveryCode.count({ where: { adminUserId: owner.id, usedAt: null } }))).toBe(7);
    expect((await prisma.securityEvent.count({ where: { eventType: "RECOVERY_CODE_USED", adminUserId: owner.id } }))).toBe(1);
  });

  it("limits guesses: after five wrong codes even the right one is refused with 429", async () => {
    await createAdminUser(prisma, { email: "guess@t.test", name: "guess", role: "OPERATOR", password: PW });
    await h.signedIn("guess@t.test"); // enrol, so a real code exists
    const t = (await h.login("guess@t.test")).body.token as string;
    h.clock.advance(1);
    for (let i = 0; i < 5; i++) expect((await h.http().post("/admin/mfa/challenge").set(h.auth(t)).send({ code: "654321" })).status).toBe(401);
    const secret = await secretFor(prisma, "guess@t.test");
    const blocked = await h.http().post("/admin/mfa/challenge").set(h.auth(t)).send({ code: await h.code(secret) });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(await prisma.securityEvent.count({ where: { eventType: "MFA_RATE_LIMITED" } })).toBeGreaterThan(0);
  });
});

describe("session lifetime", () => {
  it("ends an idle session, an over-long session, and a sign-in whose second factor was never completed", async () => {
    await createAdminUser(prisma, { email: "life@t.test", name: "life", role: "OPERATOR", password: PW });
    await h.signedIn("life@t.test"); // enrol once

    const idle = await h.signedIn("life@t.test");
    h.clock.advance(31);
    const r1 = await h.http().get("/admin/me/permissions").set(h.auth(idle.token));
    expect([r1.status, r1.body.code]).toEqual([401, "SESSION_IDLE"]);

    const live = await h.signedIn("life@t.test");
    let endedAtMinutes = 0;
    for (let minutes = 25; minutes <= 800; minutes += 25) { // active every 25 minutes keeps it from idling, but never past 12 hours
      h.clock.advance(25);
      const r = await h.http().get("/admin/me/permissions").set(h.auth(live.token));
      if (r.status === 401) { expect(r.body.code).toBe("SESSION_EXPIRED"); endedAtMinutes = minutes; break; }
    }
    expect(endedAtMinutes).toBeGreaterThanOrEqual(720); // not before 12 hours
    expect(endedAtMinutes).toBeLessThanOrEqual(750);
    expect((await h.http().get("/admin/me/permissions").set(h.auth(live.token))).body.code).toBe("SESSION_EXPIRED");

    const half = (await h.login("life@t.test")).body.token as string;
    h.clock.advance(16);
    const r3 = await h.http().get("/admin/session").set(h.auth(half));
    expect([r3.status, r3.body.code]).toEqual([401, "SIGN_IN_EXPIRED"]);
  });

  it("ends a session at sign-out, and the same token is dead afterwards", async () => {
    const s = await h.signedIn("life@t.test");
    expect((await h.http().post("/admin/logout").set(h.auth(s.token)).send({})).status).toBe(200);
    const after = await h.http().get("/admin/me/permissions").set(h.auth(s.token));
    expect(after.status).toBe(401);
    expect((await prisma.adminSession.findUniqueOrThrow({ where: { id: s.sessionId } })).revokedAt).not.toBeNull();
  });
});

describe("re-authentication and denied access", () => {
  it("asks for a fresh confirmation after the window, and accepts password plus a new code", async () => {
    const s = await h.signedIn("life@t.test");
    h.clock.advance(11);
    const need = await h.http().post("/admin/staff/invitations").set(h.auth(s.token)).send({ email: "new@t.test", role: "ANALYST" });
    // life@t.test is an operator, so this is refused on permission first; use an owner for the re-auth rule itself
    expect(need.status).toBe(403);
    const o = await h.signedIn("owner@t.test");
    h.clock.advance(11);
    const stale = await h.http().post("/admin/staff/invitations").set(h.auth(o.token)).send({ email: "fresh@t.test", role: "ANALYST" });
    expect([stale.status, stale.body.code]).toEqual([403, "REAUTH_REQUIRED"]);
    const secret = await secretFor(prisma, "owner@t.test");
    h.clock.advance(1);
    const wrongPw = await h.http().post("/admin/session/reauth").set(h.auth(o.token)).send({ password: "nope-nope-nope", code: await h.code(secret) });
    expect(wrongPw.status).toBe(401);
    h.clock.advance(1);
    const good = await h.http().post("/admin/session/reauth").set(h.auth(o.token)).send({ password: PW, code: await h.code(secret) });
    expect(good.status).toBe(200);
    const fine = await h.http().post("/admin/staff/invitations").set(h.auth(o.token)).send({ email: "fresh@t.test", role: "ANALYST" });
    expect(fine.status).toBe(201);
  });

  it("records a denied request as a security event without the token or the body", async () => {
    const before = await prisma.securityEvent.count({ where: { eventType: "ACCESS_DENIED" } });
    await h.http().get("/admin/businesses");
    await h.http().get("/admin/businesses").set({ Authorization: "Bearer not-a-token" });
    const after = await prisma.securityEvent.findMany({ where: { eventType: "ACCESS_DENIED" } });
    expect(after.length).toBe(before + 2);
    expect(JSON.stringify(after)).not.toContain("not-a-token");
  });

  it("limits sign-in attempts per caller address as well as per email", async () => {
    const small = buildHarness(prisma, { auth: { loginIpRateLimiter: new InMemoryLoginRateLimiter(4, 60_000) } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await small.login(`nobody${i}@t.test`)).status);
      expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
      expect(codes.slice(4)).toEqual([429, 429]);
    } finally { small.close(); }
  });
});

describe("what the security trail never holds", () => {
  it("contains no password, code, token, secret or recovery code in any row", async () => {
    const rows = JSON.stringify(await prisma.securityEvent.findMany());
    for (const needle of [PW, "wrong-password", "eyJ", "Bearer", "secretCiphertext", "otpauth"]) expect(rows).not.toContain(needle);
  });
});
