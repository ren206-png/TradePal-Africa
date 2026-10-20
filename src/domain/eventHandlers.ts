import type { CallbackHandler } from "./callbackInbox.js";
import type { OutboxHandler } from "./outbox.js";

/**
 * Registries of outbox event handlers (keyed by eventType) and provider-callback handlers (keyed by provider).
 * Empty on purpose in Phase 1: later phases register theirs here (payment settlement in Phases 5-6, notifications in 7).
 * Handlers must be idempotent: delivery is at-least-once.
 */
export const OUTBOX_HANDLERS: Readonly<Record<string, OutboxHandler>> = {};
export const CALLBACK_HANDLERS: Readonly<Record<string, CallbackHandler>> = {};
