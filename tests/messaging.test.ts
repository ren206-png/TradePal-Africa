import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { CATALOG, LOCALES, localeCoverage, t, type CatalogKey } from "../src/i18n/index.js";
import { MESSAGE_CLASSES, messageClass } from "../src/messaging/registry.js";
import { renderTemplateRegister } from "../src/messaging/registerDoc.js";
import { adminBlock, adminUnblock, applyStart, applyStop, consentKeyword, isBlocked, recordOrderUpdatesConsent } from "../src/messaging/consent.js";
import { sendMessage, templateParamOrder, type MessageTransport } from "../src/messaging/send.js";
import { createOrderUpdateHandler } from "../src/messaging/orderUpdates.js";
import { setOrderEventHandler } from "../src/messaging/orderEvents.js";
import { checkoutBasket, confirmStoreOrder, markStoreOrderReady, cancelStoreOrderBySeller } from "../src/domain/store/orders.js";
import { addToBasket } from "../src/domain/store/basket.js";
import { dispatchInboundMessage, type DispatcherDeps } from "../src/messageDispatcher.js";
import type { InboundMessageJob } from "../src/whatsapp/webhookHandler.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let db: PGlite;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  db = testDb.db;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});
afterEach(() => {
  setOrderEventHandler(null);
  delete process.env["CONSUMER_MESSAGING_ENABLED"];
});

interface Sent { kind: "text" | "template"; to: string; body?: string; template?: string; language?: string; params?: string[] }
function recorder(opts: { failTimes?: number } = {}): { transport: MessageTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  let fails = opts.failTimes ?? 0;
  return {
    sent,
    transport: {
      async sendText(to, body) { if (fails-- > 0) throw new Error("boom"); sent.push({ kind: "text", to, body }); return { providerMessageId: `wamid.T${sent.length}` }; },
      async sendTemplate(to, template, language, params) { if (fails-- > 0) throw new Error("boom"); sent.push({ kind: "template", to, template, language, params }); return { providerMessageId: `wamid.P${sent.length}` }; },
    },
  };
}
const seller = (flags: string[] = []) => makeSeller(prisma, `Msg Shop ${++k}`, { slug: `msg-shop-${k}`, flags });
async function approve(classId: string, name = `tpl_${classId.toLowerCase()}`) {
  const def = messageClass(classId)!;
  await prisma.messageTemplate.upsert({
    where: { messageClass_language: { messageClass: classId, language: "en" } },
    update: { status: "APPROVED", providerTemplateName: name, approvalReference: "meta:test" },
    create: { messageClass: classId, language: "en", category: def.category, status: "APPROVED", providerTemplateName: name, approvalReference: "meta:test", bodyPreview: "x", paramCount: def.paramCount },
  });
}
const PHONE = "2348031234567"; // what the shopper entered as 08031234567

describe("localization framework", () => {
  it("serves English, falls back (and says so) for a language with no reviewed text, and never invents Krio", () => {
    expect(t("confirm.cancelled")).toEqual({ text: "Cancelled. Nothing was saved.", locale: "en", fallbackUsed: false });
    const kri = t("confirm.cancelled", {}, "kri");
    expect(kri.locale).toBe("en");
    expect(kri.fallbackUsed).toBe(true);
    expect(t("confirm.cancelled", {}, "zz").fallbackUsed).toBe(true);
    for (const l of LOCALES.filter((x) => x.code !== "en")) expect(l.status).toBe("MISSING");
  });

  it("serves a translation only when its locale is human-reviewed AND the string names a reviewer", () => {
    const entry = CATALOG["confirm.cancelled"] as { en: string; translations?: Record<string, { text: string; reviewedBy: string }> };
    const fr = LOCALES.find((l) => l.code === "fr")! as { status: string };
    entry.translations = { fr: { text: "TEST-TRANSLATION", reviewedBy: "" } };
    try {
      expect(t("confirm.cancelled", {}, "fr").text).toBe("Cancelled. Nothing was saved."); // locale not reviewed
      fr.status = "HUMAN_REVIEWED";
      expect(t("confirm.cancelled", {}, "fr").fallbackUsed).toBe(true); // string has no reviewer
      entry.translations["fr"] = { text: "TEST-TRANSLATION", reviewedBy: "A. Reviewer" };
      expect(t("confirm.cancelled", {}, "fr")).toEqual({ text: "TEST-TRANSLATION", locale: "fr", fallbackUsed: false });
    } finally {
      fr.status = "MISSING";
      delete entry.translations;
    }
  });

  it("fills parameters and refuses to produce a message with a hole in it", () => {
    expect(t("confirm.proposal", { summary: "Sale 100", minutes: 10 }).text).toContain("Sale 100");
    expect(() => t("confirm.proposal", { summary: "Sale 100" })).toThrow(/minutes/);
  });

  it("reports key coverage honestly: English complete, everything else zero, with the caveat", () => {
    const cov = localeCoverage();
    const keys = Object.keys(CATALOG).length;
    expect(cov.find((c) => c.code === "en")).toMatchObject({ keysServed: keys, keysTotal: keys });
    for (const c of cov.filter((x) => x.code !== "en")) expect(c.keysServed).toBe(0);
    expect(cov.every((c) => /not measured/i.test(c.caveat))).toBe(true);
  });
});

describe("message registry and the generated template register", () => {
  it("has unique ids, real catalog bodies, and template parameters that match the body", () => {
    expect(new Set(MESSAGE_CLASSES.map((c) => c.id)).size).toBe(MESSAGE_CLASSES.length);
    for (const c of MESSAGE_CLASSES) {
      if (c.bodyKey) expect(CATALOG[c.bodyKey as CatalogKey], c.id).toBeDefined();
      if (c.pipeline === "ENFORCED" && c.windowRule !== "SESSION_ONLY") expect(templateParamOrder(c).length, c.id).toBe(c.paramCount);
    }
  });

  it("has no marketing class, no collection class, and every shopper class is about orders and names the seller", () => {
    expect(MESSAGE_CLASSES.filter((c) => c.category === "MARKETING")).toEqual([]);
    for (const c of MESSAGE_CLASSES.filter((x) => x.audience === "CONSUMER" && x.consentPurpose)) {
      expect(c.consentPurpose).toBe("ORDER_UPDATES");
      expect(templateParamOrder(c), c.id).toContain("seller");
    }
  });

  it("contains no debt-collection, lending, promotional or secret-bearing wording in any enforced shopper body", () => {
    const banned = /\b(owe|owed|debt|overdue|loan|credit|collect|discount|offer|promo|sale|buy now|pay now|code|link)\b/i;
    for (const c of MESSAGE_CLASSES.filter((x) => x.audience === "CONSUMER" && x.pipeline === "ENFORCED" && x.bodyKey)) expect(CATALOG[c.bodyKey!].en, c.id).not.toMatch(banned);
  });

  it("matches docs/expansion/message-template-register.md exactly", () => {
    expect(readFileSync(join(process.cwd(), "docs/expansion/message-template-register.md"), "utf8")).toBe(renderTemplateRegister());
  });

  it("lets only messaging/send.ts reach the unchecked WhatsApp senders (Standard #9)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /sendTextUnchecked|sendTemplateUnchecked/.test(readFileSync(p, "utf8"))) hits.push(p.replace(process.cwd() + "/", ""));
      }
    };
    walk(join(process.cwd(), "src"));
    expect(hits.sort()).toEqual(["src/messaging/transport.ts", "src/whatsapp/outboundGateway.ts"]);
  });
});

describe("consent, block list and the send pipeline", () => {
  it("recognises STOP and START only as the whole message", () => {
    expect(consentKeyword(" Stop. ")).toBe("STOP");
    expect(consentKeyword("UNSUBSCRIBE")).toBe("STOP");
    expect(consentKeyword("start")).toBe("START");
    expect(consentKeyword("please stop the delivery")).toBeNull();
    expect(consentKeyword("stop 5 cartons")).toBeNull();
  });

  it("suppresses, with a recorded reason, at every missing precondition and sends only when all hold", async () => {
    const s = await seller();
    const { transport, sent } = recorder();
    const base = { classId: "CONSUMER_ORDER_CONFIRMED", toPhone: PHONE, businessId: s.businessId, params: { seller: "Msg Shop", reference: "ORD-1" }, lastInboundAt: null };
    const attempt = (key: string) => sendMessage(prisma, transport, { ...base, idempotencyKey: key });

    expect((await attempt("t:1")).reason).toBe("SWITCH_OFF");
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    expect((await attempt("t:2")).reason).toBe("FLAG_OFF");
    await enableFlag(prisma, s.businessId, "consumerMessaging");
    expect((await attempt("t:3")).reason).toBe("NO_CONSENT");
    await recordOrderUpdatesConsent(prisma, { businessId: s.businessId, phone: PHONE });
    expect((await attempt("t:4")).reason).toBe("TEMPLATE_NOT_APPROVED");
    expect(sent).toEqual([]);

    await approve("CONSUMER_ORDER_CONFIRMED", "order_confirmed_v1");
    const ok = await attempt("t:5");
    expect(ok).toMatchObject({ decision: "SENT", providerMessageId: "wamid.P1" });
    expect(sent).toEqual([{ kind: "template", to: PHONE, template: "order_confirmed_v1", language: "en", params: ["Msg Shop", "ORD-1"] }]);

    const log = await prisma.outboundMessageLog.findMany({ where: { businessId: s.businessId }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => l.reason ?? l.decision)).toEqual(["SWITCH_OFF", "FLAG_OFF", "NO_CONSENT", "TEMPLATE_NOT_APPROVED", "SENT"]);
    expect(JSON.stringify(log)).not.toContain(PHONE); // only a hash and the last four digits
    expect(log.every((l) => l.toPhoneLast4 === "4567" && l.toPhoneHash.length === 64)).toBe(true);
  });

  it("never sends twice for the same event, and retries a failed send", async () => {
    const s = await seller(["consumerMessaging"]);
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    await recordOrderUpdatesConsent(prisma, { businessId: s.businessId, phone: PHONE });
    await approve("CONSUMER_ORDER_READY");
    const { transport, sent } = recorder({ failTimes: 1 });
    const req = { classId: "CONSUMER_ORDER_READY", toPhone: PHONE, businessId: s.businessId, params: { seller: "S", reference: "R" }, idempotencyKey: `ready:${s.businessId}` };
    expect((await sendMessage(prisma, transport, req)).decision).toBe("FAILED");
    expect((await sendMessage(prisma, transport, req)).decision).toBe("SENT"); // the failed attempt left no key, so the retry goes
    const again = await sendMessage(prisma, transport, req);
    expect(again).toMatchObject({ decision: "SENT", deduped: true });
    expect(sent).toHaveLength(1);
  });

  it("refuses an unregistered class, a legacy class, a bad number, and a shopper message that does not name the seller", async () => {
    const s = await seller(["consumerMessaging"]);
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    await recordOrderUpdatesConsent(prisma, { businessId: s.businessId, phone: PHONE });
    await approve("CONSUMER_ORDER_CONFIRMED");
    const { transport, sent } = recorder();
    const go = (over: object, key: string) => sendMessage(prisma, transport, { classId: "CONSUMER_ORDER_CONFIRMED", toPhone: PHONE, businessId: s.businessId, params: { seller: "S", reference: "R" }, idempotencyKey: key, ...over });
    expect((await go({ classId: "PROMO_BLAST" }, "u:1")).reason).toBe("UNREGISTERED_CLASS");
    expect((await go({ classId: "MERCHANT_WEEKLY_DIGEST" }, "u:2")).reason).toBe("NOT_ENFORCED_CLASS");
    expect((await go({ toPhone: "12" }, "u:3")).reason).toBe("BAD_RECIPIENT");
    expect((await go({ params: { seller: " ", reference: "R" } }, "u:4")).reason).toBe("MISSING_IDENTITY");
    expect(sent).toEqual([]);
  });

  it("STOP blocks the number everywhere, START restores only what STOP withdrew, and an operator block outlasts START", async () => {
    const a = await seller(["consumerMessaging"]);
    const b = await seller(["consumerMessaging"]);
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    const phone = "2348099990001";
    for (const biz of [a, b]) await recordOrderUpdatesConsent(prisma, { businessId: biz.businessId, phone });
    await approve("CONSUMER_ORDER_CONFIRMED");
    const { transport, sent } = recorder();
    const confirm = (biz: Seller, key: string) => sendMessage(prisma, transport, { classId: "CONSUMER_ORDER_CONFIRMED", toPhone: phone, businessId: biz.businessId, params: { seller: "S", reference: "R" }, idempotencyKey: key });

    expect((await applyStop(prisma, phone)).withdrawn).toBe(2);
    expect(await isBlocked(prisma, phone)).toBe(true);
    expect((await confirm(a, "s:1")).reason).toBe("BLOCKED");
    expect((await confirm(b, "s:2")).reason).toBe("BLOCKED");
    // the one reply allowed after STOP: the confirmation, inside the window the person just opened
    const bye = await sendMessage(prisma, transport, { classId: "CONSUMER_OPT_OUT_CONFIRMATION", toPhone: phone, idempotencyKey: "s:3", lastInboundAt: new Date() });
    expect(bye.decision).toBe("SENT");
    expect(sent.at(-1)?.body).toContain("will not get any more order messages");

    expect(await applyStart(prisma, phone)).toEqual({ restored: 2, lifted: true });
    expect((await confirm(a, "s:4")).decision).toBe("SENT");

    // an operator block cannot be lifted by the person's own START, and unblocking never re-opts anyone in
    await applyStop(prisma, phone);
    await adminBlock(prisma, { phone, reason: "abuse report", adminUserId: "adm-1" });
    expect(await applyStart(prisma, phone)).toEqual({ restored: 0, lifted: false });
    expect(await isBlocked(prisma, phone)).toBe(true);
    expect(await adminUnblock(prisma, { phone, reason: "resolved", adminUserId: "adm-1" })).toBe(true);
    expect(await isBlocked(prisma, phone)).toBe(false);
    expect((await confirm(b, "s:5")).reason).toBe("NO_CONSENT");

    const events = await prisma.contactConsentEvent.findMany({ where: { businessId: a.businessId }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.event)).toEqual(["OPT_IN", "GLOBAL_STOP", "GLOBAL_START", "GLOBAL_STOP"]);
  });

  it("free text is allowed only inside the 24-hour window the person opened", async () => {
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    const { transport, sent } = recorder();
    const phone = "2348066660001";
    const reply = (key: string, lastInboundAt: Date | null) => sendMessage(prisma, transport, { classId: "CONSUMER_OPT_OUT_CONFIRMATION", toPhone: phone, idempotencyKey: key, lastInboundAt });
    expect((await reply("w:1", null)).reason).toBe("OUTSIDE_WINDOW");
    expect((await reply("w:2", new Date(Date.now() - 25 * 3600_000))).reason).toBe("OUTSIDE_WINDOW");
    expect((await reply("w:3", new Date(Date.now() + 3600_000))).reason).toBe("OUTSIDE_WINDOW"); // a timestamp in the future is not a window
    expect((await reply("w:4", new Date(Date.now() - 3600_000))).decision).toBe("SENT");
    expect(sent).toHaveLength(1);
  });

  it("keeps the log and consent history append-only, refuses marketing consent from a checkout box, and refuses an approval with no reference", async () => {
    const s = await seller();
    await recordOrderUpdatesConsent(prisma, { businessId: s.businessId, phone: "2348077770001" });
    const consent = await prisma.contactConsent.findFirstOrThrow({ where: { businessId: s.businessId } });
    await expect(db.query(`UPDATE "ContactConsentEvent" SET "event"='x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM "OutboundMessageLog"`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM "ContactConsent"`)).rejects.toThrow(/not permitted/);
    await expect(db.query(`INSERT INTO "ContactConsent" ("id","businessId","phone","purpose","status","basis","textVersion") VALUES ('c-m',$1,'2348077770002','MARKETING','OPTED_IN','ORDER_CHECKOUT','v1')`, [s.businessId])).rejects.toThrow(/ContactConsent_values_check/);
    await expect(db.query(`INSERT INTO "MessageTemplate" ("id","messageClass","category","status","bodyPreview") VALUES ('t-x','X','UTILITY','APPROVED','b')`)).rejects.toThrow(/MessageTemplate_approved_check/);
    expect(consent.purpose).toBe("ORDER_UPDATES");
  });
});

describe("order updates to a shopper", () => {
  async function buy(s: Seller, opts: { updates: boolean; fulfilment?: "PICKUP" | "DELIVERY" }) {
    const t0 = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: 2 });
    const zone = await s.scoped.deliveryZone.findFirst({ where: {} });
    const r = await checkoutBasket(prisma, {
      basketToken: t0.token, allowOnline: false,
      buyer: { name: "Amaka Obi", phone: "08031234567", contactConsent: true, orderUpdatesConsent: opts.updates },
      sellers: [{ businessId: s.businessId, fulfilment: opts.fulfilment ?? "PICKUP", paymentMethod: "PAY_ON_COLLECTION", ...(opts.fulfilment === "DELIVERY" ? { zoneId: zone!.id, address: { landmark: "Gate" } } : {}) }],
    });
    const o = r.outcomes[0]!;
    if (!o.ok) throw new Error(o.error);
    return o.order;
  }

  it("with everything off, nothing is recorded and nothing is sent (behaviour identical to before)", async () => {
    const s = await seller();
    const { transport, sent } = recorder();
    setOrderEventHandler(createOrderUpdateHandler(prisma, transport));
    const order = await buy(s, { updates: true });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    expect(await prisma.contactConsent.count({ where: { businessId: s.businessId } })).toBe(0);
    expect(await prisma.outboundMessageLog.count({ where: { businessId: s.businessId } })).toBe(0);
    expect(sent).toEqual([]);
  });

  it("records the consent only when the shopper ticked the separate box, and messages each step once with the seller named", async () => {
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    const s = await seller(["consumerMessaging"]);
    for (const c of ["CONSUMER_ORDER_CONFIRMED", "CONSUMER_ORDER_READY", "CONSUMER_ORDER_CANCELLED"]) await approve(c);
    const { transport, sent } = recorder();
    setOrderEventHandler(createOrderUpdateHandler(prisma, transport));

    const notTicked = await buy(s, { updates: false });
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: notTicked.id });
    expect(sent).toEqual([]); // contactConsent ("seller may contact me") is not consent to TradePal messages
    expect((await prisma.outboundMessageLog.findFirstOrThrow({ where: { relatedId: notTicked.id } })).reason).toBe("NO_CONSENT");

    const order = await buy(s, { updates: true });
    expect(await prisma.contactConsent.count({ where: { businessId: s.businessId, phone: PHONE, purpose: "ORDER_UPDATES", status: "OPTED_IN" } })).toBe(1);
    await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: order.id });
    await cancelStoreOrderBySeller(prisma, { businessId: s.businessId, orderId: order.id, reason: "Out of stock" });
    expect(sent.map((m) => m.template)).toEqual(["tpl_consumer_order_confirmed", "tpl_consumer_order_ready", "tpl_consumer_order_cancelled"]);
    for (const m of sent) {
      expect(m.params![0]).toBe(s.business.name);
      expect(m.params![1]).toBe(order.reference);
      expect(m.params!.join(" ")).not.toContain(order.pickupCode); // never the handover code
    }
  });

  it("a failing handler never fails or rolls back the order change", async () => {
    setOrderEventHandler(async () => { throw new Error("handler exploded"); });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await seller();
    const order = await buy(s, { updates: false });
    const confirmed = await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
    expect(confirmed.status).toBe("CONFIRMED");
    quiet.mockRestore();
  });
});

describe("a shopper's STOP through the inbound dispatcher", () => {
  function deps(fetchImpl: ReturnType<typeof vi.fn>): DispatcherDeps {
    return { prisma, aiProvider: { parseTransactionText: vi.fn() } as never, outboundGateway: { accessToken: "tok", phoneNumberId: "pn", fetchImpl } };
  }
  async function inbound(from: string, text: string, id: string): Promise<InboundMessageJob> {
    const payload = { object: "whatsapp_business_account", entry: [{ id: "e", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: "pn" }, messages: [{ id, from, timestamp: "1700000000", type: "text", text: { body: text } }] } }] }] };
    const ev = await prisma.webhookEvent.create({ data: { waMessageId: id, payload } });
    return { webhookEventId: ev.id, waMessageId: id, fromNumber: from, toNumber: "1", messageType: "text" };
  }
  const okFetch = () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

  it("records the opt-out, confirms once, and never signs the shopper up as a merchant", async () => {
    process.env["CONSUMER_MESSAGING_ENABLED"] = "true";
    const s = await seller(["consumerMessaging"]);
    const phone = "2348055550001";
    await recordOrderUpdatesConsent(prisma, { businessId: s.businessId, phone });
    const fetchImpl = okFetch();
    await dispatchInboundMessage(deps(fetchImpl), await inbound(phone, "STOP", "wamid.stop.1"));
    expect(await isBlocked(prisma, phone)).toBe(true);
    expect(await prisma.merchant.findUnique({ where: { phoneNumber: phone } })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string).text.body).toContain("will not get any more order messages");
    // a second STOP (a new message) changes nothing further: already withdrawn, already blocked
    await dispatchInboundMessage(deps(fetchImpl), await inbound(phone, "STOP", "wamid.stop.1b"));
    expect(await prisma.blockedNumber.count({ where: { phone } })).toBe(1);
    const row = await prisma.contactConsent.findFirstOrThrow({ where: { phone } });
    expect(row.status).toBe("OPTED_OUT");
  });

  it("leaves a STOP from a stranger with no consent record exactly as before (it enters the old path)", async () => {
    const fetchImpl = okFetch();
    await dispatchInboundMessage(deps(fetchImpl), await inbound("2348055550999", "STOP", "wamid.stop.stranger"));
    expect(await prisma.blockedNumber.findUnique({ where: { phone: "2348055550999" } })).toBeNull();
    expect(await prisma.merchant.findUnique({ where: { phoneNumber: "2348055550999" } })).not.toBeNull(); // old behaviour: onboarding starts
  });
});
