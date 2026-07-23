import type { PrismaClient } from "@prisma/client";

export class OutboundSendRefusedError extends Error {}

export interface OutboundGatewayDeps {
  prisma: PrismaClient;
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
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

async function postToGraphApi(deps: OutboundGatewayDeps, body: Record<string, unknown>): Promise<void> {
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
    to: message.toPhoneNumber,
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
    to: message.toPhoneNumber,
    type: "template",
    template: {
      name: message.templateName,
      language: { code: message.templateLanguageCode },
      ...(components.length > 0 ? { components } : {}),
    },
  });
}
