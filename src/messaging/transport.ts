import { sendTemplateUnchecked, sendTextUnchecked, type OutboundGatewayDeps } from "../whatsapp/outboundGateway.js";
import type { MessageTransport } from "./send.js";

/** The production transport: the WhatsApp gateway's unchecked senders. Only `send.ts` decides what may go through it. */
export function whatsappTransport(deps: OutboundGatewayDeps): MessageTransport {
  return {
    sendText: (toPhone, body) => sendTextUnchecked(deps, { toPhoneNumber: toPhone, body }),
    sendTemplate: (toPhone, templateName, languageCode, bodyParams, options) =>
      sendTemplateUnchecked(deps, { toPhoneNumber: toPhone, templateName, templateLanguageCode: languageCode, bodyParams, ...(options?.otpButtonCode ? { otpButtonCode: options.otpButtonCode } : {}) }),
  };
}
