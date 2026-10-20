import type { PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import type { OrderStatusEvent } from "./orderEvents.js";
import { FLAG_CONSUMER_MESSAGING, consumerMessagingSwitchOn, sendMessage, type MessageTransport } from "./send.js";

const CLASS_BY_STATUS: Record<string, string> = {
  CONFIRMED: "CONSUMER_ORDER_CONFIRMED",
  READY: "CONSUMER_ORDER_READY",
  OUT_FOR_DELIVERY: "CONSUMER_ORDER_DISPATCHED",
  CANCELLED: "CONSUMER_ORDER_CANCELLED",
  EXPIRED: "CONSUMER_ORDER_CANCELLED",
};

/**
 * Turns an order status change into a shopper update. Does nothing unless the platform switch and the seller's flag are on and
 * the status has a registered class. Whether the shopper actually receives it is `sendMessage`'s decision (consent, block list,
 * approved template, identity); every attempt that gets that far is recorded.
 */
export function createOrderUpdateHandler(prisma: PrismaClient, transport: MessageTransport) {
  return async (event: OrderStatusEvent): Promise<void> => {
    const classId = CLASS_BY_STATUS[event.status];
    if (!classId || !consumerMessagingSwitchOn()) return;
    const scoped = getTenantScopedClient(prisma, event.businessId);
    if (!(await isFeatureEnabled(scoped, event.businessId, FLAG_CONSUMER_MESSAGING))) return;
    const order = await scoped.storeOrder.findUnique({ where: { id: event.orderId } });
    if (!order) return;
    const storefront = await scoped.storefront.findFirst({ where: {} });
    const seller = storefront?.title ?? "";
    // EXPIRED and CANCELLED share a class, so they share a key: the shopper hears "cancelled" once.
    const keyStatus = event.status === "EXPIRED" ? "CANCELLED" : event.status;
    await sendMessage(prisma, transport, {
      classId,
      toPhone: order.buyerPhone,
      businessId: event.businessId,
      params: { seller, reference: order.reference },
      idempotencyKey: `order:${order.id}:${keyStatus}`,
      related: { type: "StoreOrder", id: order.id },
    });
  };
}
