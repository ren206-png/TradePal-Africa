import type { PrismaClient } from "@prisma/client";
import type { CallbackHandler } from "./callbackInbox.js";
import type { OutboxHandler } from "./outbox.js";
import { buildTradeCallbackHandlers, buildTradeOutboxHandlers } from "./trade/handlers.js";

/**
 * Registries of outbox event handlers (keyed by eventType) and provider-callback handlers (keyed by provider).
 * Handlers must be idempotent: delivery is at-least-once. Phase 3 registers the B2B trade document sync and the simulator
 * payment callback; later phases add payment settlement (5-6) and notifications (7).
 */
export function buildOutboxHandlers(prisma: PrismaClient): Readonly<Record<string, OutboxHandler>> {
  return { ...buildTradeOutboxHandlers(prisma) };
}

export function buildCallbackHandlers(prisma: PrismaClient): Readonly<Record<string, CallbackHandler>> {
  return { ...buildTradeCallbackHandlers(prisma) };
}
