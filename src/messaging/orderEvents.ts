/**
 * A tiny seam between the order lifecycle and the messaging layer. The store domain calls `emitOrderStatusEvent` AFTER a status
 * change has committed; if nothing is registered (the default, and always the case while consumer messaging is off) it does
 * nothing at all. A failing handler never fails or rolls back the order change.
 */
export interface OrderStatusEvent {
  businessId: string;
  orderId: string;
  status: string;
}

type Handler = (event: OrderStatusEvent) => Promise<void>;
let handler: Handler | null = null;

export function setOrderEventHandler(next: Handler | null): void {
  handler = next;
}

export async function emitOrderStatusEvent(event: OrderStatusEvent): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch (error) {
    console.error(`[messaging] order update handler failed for ${event.orderId}:`, (error as Error).message);
  }
}
