import type { Prisma, PrismaClient } from "@prisma/client";

export const REDACTED_PAYER_NUMBER = "[number removed]";

/**
 * Standard #9: TradePal never stores a customer's phone number. `/collect` makes the merchant type
 * the customer's mobile-money number into WhatsApp, and the webhook route stores every inbound
 * payload verbatim (WebhookEvent.payload) before the worker reads it back. So once the command has
 * been handled, this overwrites the number — the last whitespace-separated word of the message
 * text — in the stored copy. Best-effort: a failure here is logged and never fails the message.
 */
export async function redactPayerNumberInStoredMessage(prisma: PrismaClient, waMessageId: string): Promise<void> {
  try {
    const event = await prisma.webhookEvent.findUnique({ where: { waMessageId } });
    if (!event) return;

    const payload = JSON.parse(JSON.stringify(event.payload)) as unknown;
    if (!redactInPayload(payload, waMessageId)) return;

    await prisma.webhookEvent.update({ where: { id: event.id }, data: { payload: payload as Prisma.InputJsonValue } });
  } catch (error) {
    console.error(`Could not redact the payer number in stored webhook event for ${waMessageId} (non-fatal):`, error);
  }
}

/** Mutates `payload` in place; returns whether anything was changed. Exported for tests. */
export function redactInPayload(payload: unknown, waMessageId: string): boolean {
  let changed = false;
  const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, unknown>> } }> }> })?.entry;
  for (const entry of entries ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message["id"] !== waMessageId) continue;
        const text = message["text"] as { body?: unknown } | undefined;
        if (!text || typeof text.body !== "string") continue;
        const body = text.body.trimEnd();
        const lastSpace = body.lastIndexOf(" ");
        if (lastSpace === -1) continue;
        text.body = `${body.slice(0, lastSpace)} ${REDACTED_PAYER_NUMBER}`;
        changed = true;
      }
    }
  }
  return changed;
}
