import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { adminWhatsappCodesConfig } from "../src/admin/adminConfig.js";
import { createWhatsappCodeSender, handleAdminCodeMessage, codeReplyText, type WhatsappCodeDeps, type WhatsappCodeSender } from "../src/admin/whatsappCodes.js";
import { processIncomingWebhook } from "../src/whatsapp/webhookHandler.js";
import { buildHarness, MFA_KEY, PW, SECRET, type Harness } from "./helpers/adminConsole.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * WhatsApp codes WITHOUT an approved template: the person asks in the console, sends "ADMIN CODE" to TradePal's WhatsApp number from their own
 * WhatsApp, and TradePal replies with the code as an ordinary message. Nothing here reaches Meta: the sender is a recorder.
 */
let testDb: TestDb;
let prisma: PrismaClient;
let h: Harness;
const replies: Array<{ to: string; code: string }> = [];
let failNext = false;
const sender: WhatsappCodeSender = {
  mode: "message",
  chatNumber: "18258239920",
  async send(to, code) {
    if (failNext) { failNext = false; throw new Error("provider down"); }
    replies.push({ to, code });
  },
};
const lastCode = (): string => replies[replies.length - 1]!.code;
const NUMBER = "+1 (403) 555-0100";
const WA_ID = "14035550100";
let n = 0;
const post = (token: string, path: string, body: object = {}) => h.http().post(`/admin${path}`).set(h.auth(token)).send(body);
const deps = (): WhatsappCodeDeps => ({ prisma, jwtSecret: SECRET, key: MFA_KEY, sender, now: h.clock.now });
const inbound = (from: string, text: string) => handleAdminCodeMessage(deps(), { from, text });

async function newAdmin(label: string): Promise<string> {
  const email = `${label}${++n}@m.test`;
  await createAdminUser(prisma, { email, name: label, role: "SUPER_ADMIN", password: PW });
  return email;
}
async function halfOpen(email: string): Promise<string> {
  const r = await h.login(email);
  expect(r.status).toBe(200);
  return r.body.token as string;
}
/** Ask for a code in the console, write "ADMIN CODE" from the number, and return the code that comes back. */
async function enrolledWithWhatsapp(label: string): Promise<{ email: string }> {
  const email = await newAdmin(label);
  const token = await halfOpen(email);
  expect((await post(token, "/mfa/whatsapp/enroll/start", { phone: NUMBER })).status).toBe(200);
  expect(await inbound(WA_ID, "ADMIN CODE")).toBe(true);
  expect((await post(token, "/mfa/whatsapp/enroll/confirm", { code: lastCode() })).status).toBe(200);
  await post(token, "/logout");
  return { email };
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
beforeEach(() => { h.clock.advance(70); });

describe("getting a code by writing to TradePal first", () => {
  it("sends nothing when the code is asked for, tells the person what to send, and replies only after they write", async () => {
    const email = await newAdmin("first");
    const login = await h.login(email);
    expect(login.body.mfa.methods.whatsapp).toEqual({ available: true, enrolled: false, last4: null, mode: "message" });
    const token = login.body.token as string;
    const before = replies.length;

    const start = await post(token, "/mfa/whatsapp/enroll/start", { phone: NUMBER });
    expect(start.status).toBe(200);
    expect(start.body.sent).toBe(false);
    expect(start.body.mode).toBe("message");
    expect(start.body.last4).toBe("0100");
    expect(start.body.message).toEqual({ to: "18258239920", text: "ADMIN CODE", url: "https://wa.me/18258239920?text=ADMIN%20CODE" });
    expect(replies.length).toBe(before); // nothing was sent: they have not written yet

    // no code exists yet, so nothing can be entered
    expect((await post(token, "/mfa/whatsapp/enroll/confirm", { code: "123456" })).status).toBe(401);

    expect(await inbound(WA_ID, "admin code")).toBe(true); // case and spacing do not matter
    expect(replies.length).toBe(before + 1);
    expect(replies[before]!.to).toBe(WA_ID);
    expect(lastCode()).toMatch(/^\d{6}$/);

    const ok = await post(token, "/mfa/whatsapp/enroll/confirm", { code: lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(8);
    expect((await h.http().get("/admin/me/permissions").set(h.auth(token))).status).toBe(200);
  });

  it("signs in the same way later, with the code working once", async () => {
    const { email } = await enrolledWithWhatsapp("signin");
    const login = await h.login(email);
    expect(login.body.mfa.state).toBe("CHALLENGE_REQUIRED");
    expect(login.body.mfa.methods.whatsapp.mode).toBe("message");
    const token = login.body.token as string;
    const send = await post(token, "/mfa/whatsapp/send");
    expect(send.status).toBe(200);
    expect(send.body.sent).toBe(false);
    expect(send.body.message.text).toBe("ADMIN CODE");
    expect(await inbound(WA_ID, "ADMIN CODE")).toBe(true);
    const code = lastCode();
    expect((await post(token, "/mfa/whatsapp/verify", { code: code === "000000" ? "000001" : "000000" })).status).toBe(401);
    expect((await post(token, "/mfa/whatsapp/verify", { code })).status).toBe(200);
    expect((await post(token, "/mfa/whatsapp/verify", { code })).status).toBe(401);
  });

  it("does not answer a message that nobody asked for, or one from another number, or other text", async () => {
    const before = replies.length;
    expect(await inbound("14035559999", "ADMIN CODE")).toBe(false); // no pending request for this number
    const email = await newAdmin("other");
    const token = await halfOpen(email);
    await post(token, "/mfa/whatsapp/enroll/start", { phone: "+14165550123" });
    expect(await inbound(WA_ID, "ADMIN CODE")).toBe(false); // a different number than the one asked about
    expect(await inbound("14165550123", "hello")).toBe(false); // not the phrase
    expect(await inbound("14165550123", "ADMIN CODE please")).toBe(false);
    expect(replies.length).toBe(before);
  });

  it("answers once: a repeat of the message, or a second one, gets nothing and falls through", async () => {
    const email = await newAdmin("once");
    const token = await halfOpen(email);
    await post(token, "/mfa/whatsapp/enroll/start", { phone: "+14165550188" });
    expect(await inbound("14165550188", "ADMIN CODE")).toBe(true);
    const count = replies.length;
    expect(await inbound("14165550188", "ADMIN CODE")).toBe(false);
    expect(replies.length).toBe(count);
  });

  it("gives ten minutes to write, then five to use the code", async () => {
    const email = await newAdmin("timing");
    const token = await halfOpen(email);
    await post(token, "/mfa/whatsapp/enroll/start", { phone: "+14165550166" });
    h.clock.advance(11);
    expect(await inbound("14165550166", "ADMIN CODE")).toBe(false); // too late: the request lapsed

    h.clock.advance(60); // clear the send limits
    const t2 = await halfOpen(await newAdmin("timing2"));
    await post(t2, "/mfa/whatsapp/enroll/start", { phone: "+14165550155" });
    h.clock.advance(9);
    expect(await inbound("14165550155", "ADMIN CODE")).toBe(true);
    h.clock.advance(6);
    expect((await post(t2, "/mfa/whatsapp/enroll/confirm", { code: lastCode() })).status).toBe(401); // the code itself lasts 5 minutes
  });

  it("a failed reply leaves no usable code", async () => {
    const t = await halfOpen(await newAdmin("fail"));
    await post(t, "/mfa/whatsapp/enroll/start", { phone: "+14165550144" });
    failNext = true;
    expect(await inbound("14165550144", "ADMIN CODE")).toBe(true);
    const c = await prisma.adminWhatsappChallenge.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(c.consumedAt).not.toBeNull();
  });

  it("never replies to a number that did not write: a pending request is not a send", async () => {
    const t = await halfOpen(await newAdmin("silent"));
    const before = replies.length;
    for (let i = 0; i < 2; i++) await post(t, "/mfa/whatsapp/enroll/start", { phone: "+14165550133" });
    expect(replies.length).toBe(before);
  });

  it("re-confirmation accepts the code that came back to the session that asked", async () => {
    const { email } = await enrolledWithWhatsapp("reauth");
    const t = await halfOpen(email);
    await post(t, "/mfa/whatsapp/send");
    await inbound(WA_ID, "ADMIN CODE");
    await post(t, "/mfa/whatsapp/verify", { code: lastCode() });
    h.clock.advance(11);
    expect((await post(t, "/mfa/recovery-codes/regenerate")).body.code).toBe("REAUTH_REQUIRED");
    const send = await post(t, "/mfa/whatsapp/send");
    expect(send.status).toBe(200);
    await inbound(WA_ID, "ADMIN CODE");
    expect((await post(t, "/session/reauth", { password: PW, code: lastCode() })).status).toBe(200);
    expect((await post(t, "/mfa/recovery-codes/regenerate")).status).toBe(200);
  });
});

describe("the webhook", () => {
  const payload = (id: string, from: string, text: string) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "w1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "18258239920", phone_number_id: "p1" }, messages: [{ id, from, timestamp: "1", type: "text", text: { body: text } }] } }] }],
  });

  it("handles the request itself, records it as processed, and does not queue it", async () => {
    const t = await halfOpen(await newAdmin("hook"));
    await post(t, "/mfa/whatsapp/enroll/start", { phone: "+14165550122" });
    const enqueue = vi.fn(async () => undefined);
    const before = replies.length;
    const res = await processIncomingWebhook({ prisma, enqueueInboundMessage: enqueue, interceptInbound: (m) => handleAdminCodeMessage(deps(), m) }, payload("wamid.A1", "14165550122", "ADMIN CODE"));
    expect(res).toEqual({ accepted: true, messagesEnqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(replies.length).toBe(before + 1);
    const ev = await prisma.webhookEvent.findUniqueOrThrow({ where: { waMessageId: "wamid.A1" } });
    expect(ev.status).toBe("PROCESSED");
    // Meta delivers the same message again: not answered twice, not queued
    const again = await processIncomingWebhook({ prisma, enqueueInboundMessage: enqueue, interceptInbound: (m) => handleAdminCodeMessage(deps(), m) }, payload("wamid.A1", "14165550122", "ADMIN CODE"));
    expect(again.messagesEnqueued).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(replies.length).toBe(before + 1);
  });

  it("queues every other message exactly as before, and survives the interceptor failing", async () => {
    const enqueue = vi.fn(async () => undefined);
    const hook = (m: { from: string; text: string }) => handleAdminCodeMessage(deps(), m);
    const a = await processIncomingWebhook({ prisma, enqueueInboundMessage: enqueue, interceptInbound: hook }, payload("wamid.B1", "14165550999", "hi"));
    const b = await processIncomingWebhook({ prisma, enqueueInboundMessage: enqueue, interceptInbound: hook }, payload("wamid.B2", "14165550999", "ADMIN CODE")); // nobody asked
    const c = await processIncomingWebhook({ prisma, enqueueInboundMessage: enqueue, interceptInbound: async () => { throw new Error("boom"); } }, payload("wamid.B3", "14165550999", "ADMIN CODE"));
    expect([a.messagesEnqueued, b.messagesEnqueued, c.messagesEnqueued]).toEqual([1, 1, 1]);
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
});

describe("configuration", () => {
  it("message-first needs only the chat number; a template wins when both are set", () => {
    expect(adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_ENABLED: "true" })).toBeUndefined();
    expect(adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_ENABLED: "true", ADMIN_WHATSAPP_CODES_CHAT_NUMBER: "+1 825-823-9920" })).toEqual({ languageCode: "en", chatNumber: "18258239920" });
    expect(adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_ENABLED: "true", ADMIN_WHATSAPP_CODES_CHAT_NUMBER: "123" })).toBeUndefined();
    expect(adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_CHAT_NUMBER: "18258239920" })).toBeUndefined();
    const both = adminWhatsappCodesConfig({ ADMIN_WHATSAPP_CODES_ENABLED: "true", ADMIN_WHATSAPP_CODES_CHAT_NUMBER: "18258239920", WHATSAPP_ADMIN_CODE_TEMPLATE_NAME: "t" })!;
    expect(createWhatsappCodeSender({ sendText: vi.fn(), sendTemplate: vi.fn(async () => ({})) } as never, both).mode).toBe("template");
  });

  it("replies with plain text carrying the code and the safety line", async () => {
    const transport = { sendText: vi.fn(async () => ({})), sendTemplate: vi.fn() };
    const s = createWhatsappCodeSender(transport as never, { languageCode: "en", chatNumber: "18258239920" });
    await s.send("14035550100", "482913");
    expect(transport.sendText).toHaveBeenCalledWith("14035550100", codeReplyText("482913"));
    expect(codeReplyText("482913")).toContain("482913");
    expect(codeReplyText("482913")).toContain("do not share");
    expect(transport.sendTemplate).not.toHaveBeenCalled();
  });
});
