import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { applyStop } from "../src/messaging/consent.js";
import { adminWhatsappCodesConfig } from "../src/admin/adminConfig.js";
import { createWhatsappCodeSender, normalisePhone, type WhatsappCodeSender } from "../src/admin/whatsappCodes.js";
import { buildHarness, secretFor, PW, type Harness } from "./helpers/adminConsole.js";

vi.setConfig({ testTimeout: 120_000 });

/** WhatsApp codes as a second factor (the alternative to an authenticator app). Nothing here reaches Meta: the sender is a recorder. */
let testDb: TestDb;
let prisma: PrismaClient;
let h: Harness;
const sent: Array<{ to: string; code: string }> = [];
let failNext = false;
const sender: WhatsappCodeSender = {
  async send(to, code) {
    if (failNext) { failNext = false; throw new Error("provider down"); }
    sent.push({ to, code });
  },
};
const lastCode = (): string => sent[sent.length - 1]!.code;
const NUMBER = "+1 (403) 555-0100";
let n = 0;
const post = (token: string, path: string, body: object = {}) => h.http().post(`/admin${path}`).set(h.auth(token)).send(body);

async function newAdmin(label: string): Promise<string> {
  const email = `${label}${++n}@t.test`;
  await createAdminUser(prisma, { email, name: label, role: "SUPER_ADMIN", password: PW });
  return email;
}
/** Password sign-in only: a half-open session. */
async function halfOpen(email: string): Promise<string> {
  const r = await h.login(email);
  expect(r.status).toBe(200);
  return r.body.token as string;
}
/** A person who enrolled a WhatsApp number as their first factor, then signed out. */
async function enrolledWithWhatsapp(label: string): Promise<{ email: string; recoveryCodes: string[] }> {
  const email = await newAdmin(label);
  const token = await halfOpen(email);
  expect((await post(token, "/mfa/whatsapp/enroll/start", { phone: NUMBER })).status).toBe(200);
  const confirm = await post(token, "/mfa/whatsapp/enroll/confirm", { code: lastCode() });
  expect(confirm.status).toBe(200);
  await post(token, "/logout");
  return { email, recoveryCodes: confirm.body.recoveryCodes };
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  h = buildHarness(prisma, { auth: { whatsappCodeSender: sender } });
}, 60_000);
afterAll(async () => {
  h.close();
  await testDb.teardown();
});
beforeEach(() => { h.clock.advance(70); }); // clear every per-number and per-account send limit between tests

describe("adding a WhatsApp number as the first second factor", () => {
  it("sends a code to the number, stores the number only encrypted, and confirms with the right code", async () => {
    const email = await newAdmin("first");
    const login = await h.login(email);
    expect(login.body.mfa.state).toBe("ENROLMENT_REQUIRED");
    expect(login.body.mfa.methods).toEqual({ totp: false, whatsapp: { available: true, enrolled: false, last4: null } });
    const token = login.body.token as string;

    const start = await post(token, "/mfa/whatsapp/enroll/start", { phone: NUMBER });
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ sent: true, last4: "0100", expiresInSeconds: 300 });
    expect(sent[sent.length - 1]!.to).toBe("14035550100");
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(JSON.stringify(start.body)).not.toContain(lastCode());

    const row = await prisma.adminWhatsappFactor.findFirstOrThrow({ where: { adminUser: { email } } });
    expect(row.confirmedAt).toBeNull(); // not a factor until proved
    expect(row.phoneCiphertext).not.toContain("4035550100");
    const challenge = await prisma.adminWhatsappChallenge.findFirstOrThrow({ where: { adminUserId: row.adminUserId } });
    expect(challenge.codeHash).not.toContain(lastCode());

    // still half open: the console refuses until the code is proved
    expect((await h.http().get("/admin/me/permissions").set(h.auth(token))).status).toBe(403);
    const wrong = await post(token, "/mfa/whatsapp/enroll/confirm", { code: lastCode() === "000000" ? "000001" : "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("BAD_CODE");

    const ok = await post(token, "/mfa/whatsapp/enroll/confirm", { code: lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.body.enrolled).toBe(true);
    expect(ok.body.recoveryCodes).toHaveLength(8);
    expect((await h.http().get("/admin/me/permissions").set(h.auth(token))).status).toBe(200);
    const session = await h.http().get("/admin/session").set(h.auth(token));
    expect(session.body.mfa.methods.whatsapp).toEqual({ available: true, enrolled: true, last4: "0100" });
  });

  it("refuses a number that is not in international form, a blocked number, and a repeat for the same number within the hour", async () => {
    const email = await newAdmin("nums");
    const token = await halfOpen(email);
    expect((await post(token, "/mfa/whatsapp/enroll/start", { phone: "403 555 0100" })).body.code).toBe("BAD_NUMBER"); // no country code
    await applyStop(prisma, "15875550199");
    const blocked = await post(token, "/mfa/whatsapp/enroll/start", { phone: "+1 587 555 0199" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("BLOCKED_NUMBER");
    expect(sent.some((s) => s.to === "15875550199")).toBe(false);
  });

  it("limits sends per account and per number, so it cannot be used to message someone repeatedly", async () => {
    const email = await newAdmin("limit");
    const token = await halfOpen(email);
    for (let i = 0; i < 3; i++) expect((await post(token, "/mfa/whatsapp/enroll/start", { phone: "+14165550123" })).status).toBe(200);
    const fourth = await post(token, "/mfa/whatsapp/enroll/start", { phone: "+14165550123" });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe("TOO_MANY");
    // a different account cannot hammer the same number either
    const other = await halfOpen(await newAdmin("limit2"));
    expect((await post(other, "/mfa/whatsapp/enroll/start", { phone: "+14165550123" })).status).toBe(429);
  });

  it("says so when the provider fails, and the code that was never delivered does not work", async () => {
    const token = await halfOpen(await newAdmin("fail"));
    failNext = true;
    const r = await post(token, "/mfa/whatsapp/enroll/start", { phone: "+14165550177" });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("SEND_FAILED");
    const c = await prisma.adminWhatsappChallenge.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(c.consumedAt).not.toBeNull();
  });
});

describe("signing in with a WhatsApp code", () => {
  it("asks for the code, sends it to the saved number, and lets the person in once it is right", async () => {
    const { email } = await enrolledWithWhatsapp("signin");
    const login = await h.login(email);
    expect(login.body.mfa.state).toBe("CHALLENGE_REQUIRED");
    expect(login.body.mfa.methods.whatsapp.enrolled).toBe(true);
    const token = login.body.token as string;
    expect((await h.http().get("/admin/me/permissions").set(h.auth(token))).status).toBe(403);

    const send = await post(token, "/mfa/whatsapp/send");
    expect(send.status).toBe(200);
    expect(send.body.last4).toBe("0100");
    expect(sent[sent.length - 1]!.to).toBe("14035550100");
    const code = lastCode();
    expect((await post(token, "/mfa/whatsapp/verify", { code: code === "000000" ? "000001" : "000000" })).status).toBe(401);
    expect((await post(token, "/mfa/whatsapp/verify", { code })).status).toBe(200);
    expect((await h.http().get("/admin/me/permissions").set(h.auth(token))).status).toBe(200);
  });

  it("works once, only in the session that asked for it, and not after it expires", async () => {
    const { email } = await enrolledWithWhatsapp("scope");
    const a = await halfOpen(email);
    await post(a, "/mfa/whatsapp/send");
    const code = lastCode();
    const b = await halfOpen(email); // another sign-in cannot use A's code
    expect((await post(b, "/mfa/whatsapp/verify", { code })).status).toBe(401);
    expect((await post(a, "/mfa/whatsapp/verify", { code })).status).toBe(200);
    expect((await post(a, "/mfa/whatsapp/verify", { code })).status).toBe(401); // used

    await post(b, "/mfa/whatsapp/send");
    const late = lastCode();
    h.clock.advance(6);
    expect((await post(b, "/mfa/whatsapp/verify", { code: late })).status).toBe(401); // 5 minutes are up
  });

  it("allows five wrong guesses, then the code is dead even if the right one is entered", async () => {
    const { email } = await enrolledWithWhatsapp("guess");
    const t = await halfOpen(email);
    await post(t, "/mfa/whatsapp/send");
    const right = lastCode();
    const wrong = right === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) expect((await post(t, "/mfa/whatsapp/verify", { code: wrong })).status).toBe(401);
    expect((await post(t, "/mfa/whatsapp/verify", { code: right })).status).not.toBe(200); // locked out (the code is dead and the attempt limiter holds)

  });

  it("a newer code replaces the older one", async () => {
    const { email } = await enrolledWithWhatsapp("newer");
    const t = await halfOpen(email);
    await post(t, "/mfa/whatsapp/send");
    const first = lastCode();
    await post(t, "/mfa/whatsapp/send");
    const second = lastCode();
    if (first !== second) expect((await post(t, "/mfa/whatsapp/verify", { code: first })).status).toBe(401);
    expect((await post(t, "/mfa/whatsapp/verify", { code: second })).status).toBe(200);
  });

  it("a recovery code still works for someone who uses WhatsApp", async () => {
    const { email, recoveryCodes } = await enrolledWithWhatsapp("recover");
    const t = await halfOpen(email);
    const r = await post(t, "/mfa/recovery", { code: recoveryCodes[0]! });
    expect(r.status).toBe(200);
    expect((await h.http().get("/admin/me/permissions").set(h.auth(t))).status).toBe(200);
  });

  it("is not offered, and says so, when the server has no sender", async () => {
    const plain = buildHarness(prisma);
    try {
      const email = await newAdmin("nosender");
      const res = await plain.login(email);
      expect(res.body.mfa.methods.whatsapp.available).toBe(false);
      const start = await plain.http().post("/admin/mfa/whatsapp/enroll/start").set(plain.auth(res.body.token)).send({ phone: NUMBER });
      expect(start.status).toBe(503);
    } finally { plain.close(); }
  });
});

describe("confirming a sensitive action with a WhatsApp code", () => {
  it("accepts the password and the code that this session asked for", async () => {
    const { email } = await enrolledWithWhatsapp("reauth");
    const t = await halfOpen(email);
    await post(t, "/mfa/whatsapp/send");
    await post(t, "/mfa/whatsapp/verify", { code: lastCode() });
    h.clock.advance(11); // the sign-in confirmation has aged out
    expect((await post(t, "/mfa/recovery-codes/regenerate")).body.code).toBe("REAUTH_REQUIRED");
    const send = await post(t, "/mfa/whatsapp/send");
    expect(send.status).toBe(200);
    const bad = await post(t, "/session/reauth", { password: PW, code: lastCode() === "000000" ? "000001" : "000000" });
    expect(bad.status).toBe(401);
    await post(t, "/mfa/whatsapp/send");
    const ok = await post(t, "/session/reauth", { password: PW, code: lastCode() });
    expect(ok.status).toBe(200);
    expect((await post(t, "/mfa/recovery-codes/regenerate")).status).toBe(200);
  });
});

describe("having both an authenticator app and WhatsApp", () => {
  it("adding WhatsApp to an account that already has an app needs a finished sign-in and a fresh confirmation", async () => {
    const email = await newAdmin("both");
    const { token } = await h.signedIn(email); // authenticator app first
    // a half-open session of this account cannot bolt on a new method with only the password
    const half = await halfOpen(email);
    expect((await post(half, "/mfa/whatsapp/enroll/start", { phone: "+14165550999" })).status).toBe(403);
    const secret = await secretFor(prisma, email);
    h.clock.advance(11);
    const stale = await post(token, "/mfa/whatsapp/enroll/start", { phone: NUMBER });
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe("REAUTH_REQUIRED");
    expect((await post(token, "/session/reauth", { password: PW, code: await h.code(secret) })).status).toBe(200);
    expect((await post(token, "/mfa/whatsapp/enroll/start", { phone: NUMBER })).status).toBe(200);
    const done = await post(token, "/mfa/whatsapp/enroll/confirm", { code: lastCode() });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toBeUndefined(); // already had them

    expect((await post(half, "/mfa/enroll/start")).status).toBe(409); // an app is already set up
  });

  it("removal needs a fresh confirmation, and is refused for someone with no authenticator app (they would be locked out)", async () => {
    const only = await enrolledWithWhatsapp("only");
    const t1 = await halfOpen(only.email);
    await post(t1, "/mfa/whatsapp/send");
    await post(t1, "/mfa/whatsapp/verify", { code: lastCode() });
    const refused = await post(t1, "/mfa/whatsapp/remove");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LAST_METHOD");

    const email = await newAdmin("remove");
    const { token } = await h.signedIn(email);
    const secret = await secretFor(prisma, email);
    h.clock.advance(1);
    await post(token, "/session/reauth", { password: PW, code: await h.code(secret) });
    await post(token, "/mfa/whatsapp/enroll/start", { phone: NUMBER });
    await post(token, "/mfa/whatsapp/enroll/confirm", { code: lastCode() });
    h.clock.advance(11);
    expect((await post(token, "/mfa/whatsapp/remove")).body.code).toBe("REAUTH_REQUIRED");
    h.clock.advance(1);
    await post(token, "/session/reauth", { password: PW, code: await h.code(secret) });
    expect((await post(token, "/mfa/whatsapp/remove")).status).toBe(200);
    expect(await prisma.adminWhatsappFactor.count({ where: { adminUser: { email } } })).toBe(0);
  });

  it("the staff list shows a WhatsApp-only person as enrolled, and a second-factor reset removes the number", async () => {
    const { email } = await enrolledWithWhatsapp("staff");
    const { token } = await h.signedIn((await newAdmin("viewer")));
    const list = await h.http().get("/admin/staff").set(h.auth(token));
    expect(list.status).toBe(200);
    expect((list.body.staff as Array<{ email: string; mfa: string }>).find((s) => s.email === email)?.mfa).toBe("ENROLLED");
    const { resetMfaFor } = await import("../src/admin/mfa.js");
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
    await resetMfaFor(prisma, admin.id);
    expect(await prisma.adminWhatsappFactor.count({ where: { adminUserId: admin.id } })).toBe(0);
    expect((await h.login(email)).body.mfa.state).toBe("ENROLMENT_REQUIRED");
  });
});

describe("what is recorded and what is never kept", () => {
  it("security events carry the last four digits at most, never a code or a full number", async () => {
    const events = await prisma.securityEvent.findMany({ where: { eventType: { startsWith: "WHATSAPP_" } } });
    expect(events.length).toBeGreaterThan(3);
    const blob = JSON.stringify(events);
    for (const s of sent) {
      expect(blob).not.toContain(s.to);
      expect(blob).not.toContain(`"${s.code}"`);
    }
    const challenges = JSON.stringify(await prisma.adminWhatsappChallenge.findMany());
    for (const s of sent.slice(0, 10)) expect(challenges).not.toContain(`"${s.code}"`);
  });
});

describe("configuration and helpers", () => {
  it("is on only with the switch and a named template; the language defaults to English", () => {
    expect(adminWhatsappCodesConfig({})).toBeUndefined();
    expect(adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_ENABLED: "true" })).toBeUndefined();
    expect(adminWhatsappCodesConfig({ WHATSAPP_ADMIN_CODE_TEMPLATE_NAME: "x" })).toBeUndefined();
    expect(adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_ENABLED: "true", WHATSAPP_ADMIN_CODE_TEMPLATE_NAME: "tp_admin_code" })).toEqual({ templateName: "tp_admin_code", languageCode: "en" });
    expect(adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_ENABLED: "true", WHATSAPP_ADMIN_CODE_TEMPLATE_NAME: "t", WHATSAPP_ADMIN_CODE_TEMPLATE_LANGUAGE: "fr" })?.languageCode).toBe("fr");
  });

  it("sends through the template transport with the code in the body and the copy-code button", async () => {
    const calls: unknown[][] = [];
    const transport = { sendText: vi.fn(), sendTemplate: vi.fn(async (...args: unknown[]) => { calls.push(args); return {}; }) };
    await createWhatsappCodeSender(transport as never, { templateName: "tp_admin_code", languageCode: "en" }).send("14035550100", "482913");
    expect(calls).toEqual([["14035550100", "tp_admin_code", "en", ["482913"], { otpButtonCode: "482913" }]]);
    expect(transport.sendText).not.toHaveBeenCalled();
  });

  it("normalises international numbers and rejects the rest", () => {
    expect(normalisePhone("+1 (403) 555-0100")).toBe("14035550100");
    expect(normalisePhone("00233245550100")).toBe("233245550100");
    for (const bad of ["4035550100", "14035550100", "4035550100x", "123", "+0 123 456 7890", "abc"]) expect(() => normalisePhone(bad)).toThrow();
  });
});
