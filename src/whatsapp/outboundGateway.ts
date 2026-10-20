import type { PrismaClient } from "@prisma/client";
import { SUPPORTED_COUNTRIES, getCountryByPhoneNumber } from "../config/countries.js";

export class OutboundSendRefusedError extends Error {}

export interface OutboundGatewayDeps {
  prisma: PrismaClient;
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  /**
   * Workaround for a Meta WhatsApp Cloud API *test/free-number* quirk
   * (discovered live-debugging a Sierra Leone merchant stuck unable to
   * receive any reply): the test number's "allowed recipients" list is
   * matched against the recipient's *local national dialing format*
   * (calling code + trunk "0" + subscriber number, e.g. "232080462524" for
   * Sierra Leone) — NOT the wa_id format WhatsApp's own webhook delivers as
   * `message.from` and that this app uses everywhere else (`Merchant.
   * phoneNumber`, `InboundMessageJob.fromNumber`, etc: "23280462524", no
   * trunk "0"). A number can therefore be genuinely verified on the
   * allowlist and every send to it still get rejected with `(#131030)
   * Recipient phone number not in allowed list`, because the two strings
   * don't match even though they resolve to the same WhatsApp account
   * (confirmed directly against the Graph API: sending "to":
   * "232080462524" succeeds and Meta echoes back "wa_id": "23280462524",
   * while "to": "23280462524" for the identical account is rejected).
   *
   * A real (non-test) WhatsApp Business number has no recipient allowlist
   * at all, so this mismatch can only ever surface while sending from
   * Meta's free test number — a deliberately temporary stopgap. Rather than
   * changing the canonical wa_id format this app stores/looks merchants up
   * by everywhere else (which is correct, and matches what Meta's webhook
   * actually delivers), this reformats only the outbound Graph API `to`
   * value, and only for calling codes explicitly opted in here. Unset (the
   * default) means no behavior change, so this can't silently affect a real
   * production number or a country that doesn't need it. Populated from
   * `WHATSAPP_TEST_RECIPIENT_TRUNK_PREFIX_CALLING_CODES` — see
   * `config/outboundGatewayEnv.ts`.
   */
  testRecipientTrunkPrefixCallingCodes?: ReadonlySet<string>;
}

/**
 * See `OutboundGatewayDeps.testRecipientTrunkPrefixCallingCodes`'s doc
 * comment for why this exists. Only rewrites `toPhoneNumber` when it starts
 * with one of the opted-in calling codes and doesn't already have the trunk
 * "0" (so it's a no-op if a caller already passes the local-format string,
 * and a no-op entirely when no calling codes are configured).
 */
function applyTestRecipientTrunkPrefixWorkaround(
  toPhoneNumber: string,
  trunkPrefixCallingCodes: ReadonlySet<string> | undefined,
): string {
  if (!trunkPrefixCallingCodes) return toPhoneNumber;

  for (const callingCode of trunkPrefixCallingCodes) {
    if (toPhoneNumber.startsWith(callingCode) && !toPhoneNumber.startsWith(`${callingCode}0`)) {
      return `${callingCode}0${toPhoneNumber.slice(callingCode.length)}`;
    }
  }

  return toPhoneNumber;
}

export interface OutboundTextMessage {
  toPhoneNumber: string;
  body: string;
}

/**
 * A Meta-approved WhatsApp message template send. Unlike `type: "text"`,
 * template sends are accepted by Meta even outside the recipient's 24-hour
 * customer-service window (the window only restricts free-form text) — the
 * reason this exists at all is Phase 7's disclosed gap: a proactive,
 * system-initiated notification (e.g. subscription-lapse) can't rely on the
 * merchant having messaged the bot recently. `templateName` and
 * `templateLanguageCode` must match a template already created and approved
 * in the WhatsApp Business Manager for this phone number; TradePal has no
 * way to create or verify templates itself, so a caller supplying a
 * name/language that doesn't exist or isn't approved will simply get a
 * non-2xx response from Meta like any other bad request. `bodyParams`, if
 * given, fill the template's `{{1}}`, `{{2}}`, ... body placeholders in
 * order — TradePal doesn't validate the count/order matches what the
 * template actually expects (it can't know that without querying Meta's
 * template catalog, which this integration doesn't do).
 */
export interface OutboundTemplateMessage {
  toPhoneNumber: string;
  templateName: string;
  templateLanguageCode: string;
  bodyParams?: string[];
}

async function assertRegisteredMerchant(deps: OutboundGatewayDeps, phoneNumber: string): Promise<void> {
  const merchant = await deps.prisma.merchant.findUnique({ where: { phoneNumber } });
  if (!merchant) {
    throw new OutboundSendRefusedError(
      `Refusing to send WhatsApp message to '${phoneNumber}': not a registered merchant number.`,
    );
  }
}

async function postToGraphApi(deps: OutboundGatewayDeps, body: Record<string, unknown>): Promise<string | undefined> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${deps.apiVersion ?? "v21.0"}/${deps.phoneNumberId}/messages`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WhatsApp send failed (${response.status}): ${errorBody}`);
  }
  // The provider's message id, when the response carries one. Tolerant: a response without a JSON body is still a success.
  try {
    const json = (await response.json()) as { messages?: { id?: string }[] };
    return json.messages?.[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * The free-form-text outbound send path (Non-Negotiable Standard #9,
 * PHASE_0_FINDINGS KQ2): sending to a WhatsApp number that isn't a registered
 * `merchants.phoneNumber` is refused before any network call is made, so a
 * feature can never message a merchant's customer directly, even by
 * accident — only the merchant themselves. Only deliverable within the
 * recipient's 24-hour service window; for a proactive send that might fall
 * outside that window, use `sendWhatsAppTemplateMessage` instead.
 */
export async function sendWhatsAppTextMessage(
  deps: OutboundGatewayDeps,
  message: OutboundTextMessage,
): Promise<void> {
  await assertRegisteredMerchant(deps, message.toPhoneNumber);

  await postToGraphApi(deps, {
    messaging_product: "whatsapp",
    to: applyTestRecipientTrunkPrefixWorkaround(message.toPhoneNumber, deps.testRecipientTrunkPrefixCallingCodes),
    type: "text",
    text: { body: message.body },
  });
}

/**
 * The template-message outbound send path — same Standard #9 registered-
 * merchant guard as `sendWhatsAppTextMessage`, since a template send is still
 * capable of reaching an arbitrary phone number if that guard weren't here.
 */
export async function sendWhatsAppTemplateMessage(
  deps: OutboundGatewayDeps,
  message: OutboundTemplateMessage,
): Promise<void> {
  await assertRegisteredMerchant(deps, message.toPhoneNumber);

  const components =
    message.bodyParams && message.bodyParams.length > 0
      ? [{ type: "body", parameters: message.bodyParams.map((text) => ({ type: "text", text })) }]
      : [];

  await postToGraphApi(deps, {
    messaging_product: "whatsapp",
    to: applyTestRecipientTrunkPrefixWorkaround(message.toPhoneNumber, deps.testRecipientTrunkPrefixCallingCodes),
    type: "template",
    template: {
      name: message.templateName,
      language: { code: message.templateLanguageCode },
      ...(components.length > 0 ? { components } : {}),
    },
  });
}

/** The one fixed reply sent to someone outside the launch countries who messages TradePal first. */
export const UNSUPPORTED_COUNTRY_NOTICE_BODY = `TradePal Africa isn't available in your country yet. We're currently open to shop owners in ${SUPPORTED_COUNTRIES.map((c) => c.name).join(", ")}. Thanks for your interest!`;

/**
 * The ONE deliberate exception to the registered-merchant guard above (Standard #9), narrowly
 * scoped so it can't become a way to message anyone: it sends only the fixed
 * UNSUPPORTED_COUNTRY_NOTICE_BODY (no caller-supplied text), only to a number that is NOT in a
 * launch country (so it can never reach a merchant's customers in a country TradePal serves),
 * and only as a free-form reply to someone who has just messaged us first (the 24-hour service
 * window), so nothing is ever sent unprompted. Nothing is stored about the recipient.
 */
export async function sendUnsupportedCountryNotice(deps: OutboundGatewayDeps, toPhoneNumber: string): Promise<void> {
  if (getCountryByPhoneNumber(toPhoneNumber)) {
    throw new OutboundSendRefusedError(
      `Refusing to send the unsupported-country notice to '${toPhoneNumber}': it is in a supported country.`,
    );
  }
  const merchant = await deps.prisma.merchant.findUnique({ where: { phoneNumber: toPhoneNumber } });
  if (merchant) {
    throw new OutboundSendRefusedError(
      `Refusing to send the unsupported-country notice to '${toPhoneNumber}': it is a registered merchant number.`,
    );
  }

  await postToGraphApi(deps, {
    messaging_product: "whatsapp",
    to: toPhoneNumber,
    type: "text",
    text: { body: UNSUPPORTED_COUNTRY_NOTICE_BODY },
  });
}

/**
 * Sends WITHOUT the registered-merchant guard. This exists for exactly one caller: `messaging/send.ts`, which has already
 * checked the message class, template approval, the recipient's consent, the block list, the 24-hour window and the platform
 * switch before it gets here. Anything else that imports these two functions defeats Standard #9; a test searches the source
 * tree and fails if another file does.
 */
export async function sendTextUnchecked(deps: OutboundGatewayDeps, message: OutboundTextMessage): Promise<{ providerMessageId?: string }> {
  const id = await postToGraphApi(deps, {
    messaging_product: "whatsapp",
    to: applyTestRecipientTrunkPrefixWorkaround(message.toPhoneNumber, deps.testRecipientTrunkPrefixCallingCodes),
    type: "text",
    text: { body: message.body },
  });
  return id ? { providerMessageId: id } : {};
}

export async function sendTemplateUnchecked(deps: OutboundGatewayDeps, message: OutboundTemplateMessage): Promise<{ providerMessageId?: string }> {
  const components =
    message.bodyParams && message.bodyParams.length > 0
      ? [{ type: "body", parameters: message.bodyParams.map((text) => ({ type: "text", text })) }]
      : [];
  const id = await postToGraphApi(deps, {
    messaging_product: "whatsapp",
    to: applyTestRecipientTrunkPrefixWorkaround(message.toPhoneNumber, deps.testRecipientTrunkPrefixCallingCodes),
    type: "template",
    template: { name: message.templateName, language: { code: message.templateLanguageCode }, ...(components.length > 0 ? { components } : {}) },
  });
  return id ? { providerMessageId: id } : {};
}
