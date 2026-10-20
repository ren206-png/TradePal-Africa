import type { PrismaClient } from "@prisma/client";
import { parseTestRecipientTrunkPrefixCallingCodesFromEnv } from "../config/outboundGatewayEnv.js";
import { setOrderEventHandler } from "./orderEvents.js";
import { createOrderUpdateHandler } from "./orderUpdates.js";
import { consumerMessagingSwitchOn } from "./send.js";
import { whatsappTransport } from "./transport.js";

/**
 * Connects order status changes to shopper updates. Called by the API server and the worker at start-up. Does nothing (and
 * registers nothing) unless CONSUMER_MESSAGING_ENABLED=true AND WhatsApp send credentials exist; even then each seller must
 * have the `consumerMessaging` flag on, each message class needs an APPROVED template, and each shopper needs to have opted in.
 */
export function wireConsumerMessaging(prisma: PrismaClient): boolean {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!consumerMessagingSwitchOn() || !accessToken || !phoneNumberId) return false;
  const trunk = parseTestRecipientTrunkPrefixCallingCodesFromEnv();
  setOrderEventHandler(createOrderUpdateHandler(prisma, whatsappTransport({ prisma, accessToken, phoneNumberId, ...(trunk ? { testRecipientTrunkPrefixCallingCodes: trunk } : {}) })));
  return true;
}
