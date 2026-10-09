import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  OutboundSendRefusedError,
  sendWhatsAppTemplateMessage,
  sendWhatsAppTextMessage,
} from "../src/whatsapp/outboundGateway.js";

let testDb: TestDb;
let prisma: PrismaClient;
let merchantPhoneNumber: string;
let slMerchantPhoneNumber: string;
let slMerchantLocalFormatPhoneNumber: string;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  const business = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });

  merchantPhoneNumber = "2348012345678";
  await prisma.merchant.create({ data: { businessId: business.id, phoneNumber: merchantPhoneNumber } });

  // Second merchant, Sierra Leone (calling code 232), for the
  // testRecipientTrunkPrefixCallingCodes workaround tests below — see
  // OutboundGatewayDeps's doc comment in ../src/whatsapp/outboundGateway.ts.
  await prisma.currency.create({ data: { code: "SLE", name: "Sierra Leonean Leone", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "SL", name: "Sierra Leone", callingCode: "232", defaultCurrency: "SLE", defaultTimezone: "Africa/Freetown" },
  });
  const slBusiness = await prisma.business.create({
    data: { name: "Shop B", countryCode: "SL", currencyCode: "SLE", languageCode: "en", timezone: "Africa/Freetown" },
  });

  slMerchantPhoneNumber = "23280462524"; // wa_id format — no trunk "0" after the calling code.
  await prisma.merchant.create({ data: { businessId: slBusiness.id, phoneNumber: slMerchantPhoneNumber } });

  slMerchantLocalFormatPhoneNumber = "232090462524"; // already local-format (has a trunk "0"), different merchant.
  await prisma.merchant.create({ data: { businessId: slBusiness.id, phoneNumber: slMerchantLocalFormatPhoneNumber } });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("sendWhatsAppTextMessage", () => {
  it("sends to a registered merchant's phone number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTextMessage(
      { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
      { toPhoneNumber: merchantPhoneNumber, body: "Your daily summary is ready." },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-1/messages");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: merchantPhoneNumber,
      type: "text",
      text: { body: "Your daily summary is ready." },
    });
  });

  it("refuses to send to a phone number that isn't a registered merchant", async () => {
    const fetchImpl = vi.fn();

    await expect(
      sendWhatsAppTextMessage(
        { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
        { toPhoneNumber: "2349999999999", body: "This should never be sent." },
      ),
    ).rejects.toThrow(OutboundSendRefusedError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an error when the Meta API responds with a non-2xx status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      sendWhatsAppTextMessage(
        { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
        { toPhoneNumber: merchantPhoneNumber, body: "Hello" },
      ),
    ).rejects.toThrow(/WhatsApp send failed \(429\)/);
  });
});

describe("sendWhatsAppTemplateMessage", () => {
  it("sends a template message with body params to a registered merchant's phone number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTemplateMessage(
      { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
      {
        toPhoneNumber: merchantPhoneNumber,
        templateName: "subscription_lapse_notice",
        templateLanguageCode: "en_US",
        bodyParams: ["PRO"],
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-1/messages");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: merchantPhoneNumber,
      type: "template",
      template: {
        name: "subscription_lapse_notice",
        language: { code: "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: "PRO" }] }],
      },
    });
  });

  it("omits components entirely when no body params are given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTemplateMessage(
      { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
      { toPhoneNumber: merchantPhoneNumber, templateName: "generic_notice", templateLanguageCode: "en_US" },
    );

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.template).toEqual({ name: "generic_notice", language: { code: "en_US" } });
  });

  it("refuses to send to a phone number that isn't a registered merchant", async () => {
    const fetchImpl = vi.fn();

    await expect(
      sendWhatsAppTemplateMessage(
        { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
        { toPhoneNumber: "2349999999999", templateName: "generic_notice", templateLanguageCode: "en_US" },
      ),
    ).rejects.toThrow(OutboundSendRefusedError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an error when the Meta API responds with a non-2xx status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("template not approved", { status: 400 }));

    await expect(
      sendWhatsAppTemplateMessage(
        { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
        { toPhoneNumber: merchantPhoneNumber, templateName: "generic_notice", templateLanguageCode: "en_US" },
      ),
    ).rejects.toThrow(/WhatsApp send failed \(400\)/);
  });
});

describe("testRecipientTrunkPrefixCallingCodes workaround", () => {
  it("leaves the Graph API `to` value untouched when unset (the default)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTextMessage(
      { prisma, accessToken: "test-token", phoneNumberId: "pn-1", fetchImpl },
      { toPhoneNumber: slMerchantPhoneNumber, body: "Welcome to TradePal!" },
    );

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.to).toBe(slMerchantPhoneNumber);
  });

  it("inserts a trunk \"0\" after an opted-in calling code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTextMessage(
      {
        prisma,
        accessToken: "test-token",
        phoneNumberId: "pn-1",
        fetchImpl,
        testRecipientTrunkPrefixCallingCodes: new Set(["232"]),
      },
      { toPhoneNumber: slMerchantPhoneNumber, body: "Welcome to TradePal!" },
    );

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.to).toBe("232080462524");
  });

  it("does not double-insert the trunk \"0\" for a number already in local format", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTextMessage(
      {
        prisma,
        accessToken: "test-token",
        phoneNumberId: "pn-1",
        fetchImpl,
        testRecipientTrunkPrefixCallingCodes: new Set(["232"]),
      },
      { toPhoneNumber: slMerchantLocalFormatPhoneNumber, body: "Welcome to TradePal!" },
    );

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.to).toBe(slMerchantLocalFormatPhoneNumber);
  });

  it("leaves a number untouched when its calling code isn't in the opt-in set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTextMessage(
      {
        prisma,
        accessToken: "test-token",
        phoneNumberId: "pn-1",
        fetchImpl,
        testRecipientTrunkPrefixCallingCodes: new Set(["234"]), // Nigeria only, not Sierra Leone.
      },
      { toPhoneNumber: slMerchantPhoneNumber, body: "Welcome to TradePal!" },
    );

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.to).toBe(slMerchantPhoneNumber);
  });

  it("also applies to template sends", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));

    await sendWhatsAppTemplateMessage(
      {
        prisma,
        accessToken: "test-token",
        phoneNumberId: "pn-1",
        fetchImpl,
        testRecipientTrunkPrefixCallingCodes: new Set(["232"]),
      },
      { toPhoneNumber: slMerchantPhoneNumber, templateName: "generic_notice", templateLanguageCode: "en_US" },
    );

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.to).toBe("232080462524");
  });
});
