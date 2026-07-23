import { z } from "zod";

const WhatsAppInboundMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
});

const WhatsAppChangeValueSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({ display_phone_number: z.string(), phone_number_id: z.string() }),
  messages: z.array(WhatsAppInboundMessageSchema).optional(),
});

const WhatsAppWebhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: WhatsAppChangeValueSchema,
          field: z.string(),
        }),
      ),
    }),
  ),
});

export type WhatsAppWebhookPayload = z.infer<typeof WhatsAppWebhookPayloadSchema>;
export type WhatsAppInboundMessage = z.infer<typeof WhatsAppInboundMessageSchema>;

export function parseWhatsAppWebhookPayload(body: unknown) {
  return WhatsAppWebhookPayloadSchema.safeParse(body);
}

export interface ExtractedInboundMessage {
  message: WhatsAppInboundMessage;
  toNumber: string;
}

/**
 * Meta's webhook envelope multiplexes several event kinds (messages, status
 * receipts, template updates...) under `entry[].changes[].field`. Only
 * `"messages"` changes carry inbound merchant messages; everything else is
 * silently ignored here rather than treated as an error.
 */
export function extractInboundMessages(payload: WhatsAppWebhookPayload): ExtractedInboundMessage[] {
  const results: ExtractedInboundMessage[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      for (const message of change.value.messages ?? []) {
        results.push({ message, toNumber: change.value.metadata.display_phone_number });
      }
    }
  }
  return results;
}
