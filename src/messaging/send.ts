import type { OutboundDecision, PrismaClient } from "@prisma/client";
import { t, CATALOG } from "../i18n/index.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { digitsOnly, isBlocked, phoneHash, phoneLast4 } from "./consent.js";
import { messageClass, type MessageClassDef } from "./registry.js";

export const FLAG_CONSUMER_MESSAGING = "consumerMessaging";
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Platform switch for any message to a person who is not a registered merchant. Off unless explicitly set. */
export function consumerMessagingSwitchOn(): boolean {
  return process.env["CONSUMER_MESSAGING_ENABLED"] === "true";
}

/** The transport. Production wires this to the WhatsApp gateway's unchecked senders; tests use a recorder. */
export interface MessageTransport {
  sendText(toPhone: string, body: string): Promise<{ providerMessageId?: string }>;
  sendTemplate(toPhone: string, templateName: string, languageCode: string, bodyParams: string[]): Promise<{ providerMessageId?: string }>;
}

export interface SendRequest {
  classId: string;
  toPhone: string;
  /** Required for a CONSUMER class: whose consent applies and whose name the message must carry. */
  businessId?: string;
  params?: Record<string, string | number>;
  locale?: string;
  /** One key per real-world event ("order:<id>:confirmed"). A repeat of the same key never sends twice. */
  idempotencyKey: string;
  related?: { type: string; id: string };
  /** When the recipient last wrote to us. Free text is allowed only within 24 hours of it. */
  lastInboundAt?: Date | null;
  now?: Date;
}

export type SuppressionReason =
  | "UNREGISTERED_CLASS" | "NOT_ENFORCED_CLASS" | "SWITCH_OFF" | "FLAG_OFF" | "BLOCKED" | "NO_CONSENT" | "TEMPLATE_NOT_APPROVED"
  | "OUTSIDE_WINDOW" | "MISSING_BUSINESS" | "MISSING_IDENTITY" | "BAD_RECIPIENT";

export interface SendOutcome {
  decision: OutboundDecision;
  reason?: SuppressionReason | "TRANSPORT_ERROR";
  deduped?: boolean;
  providerMessageId?: string;
}

/** Body parameters in the order the provider template numbers them ({{1}}, {{2}}…): the order the placeholders first appear in the English text. */
export function templateParamOrder(def: MessageClassDef): string[] {
  if (!def.bodyKey) return [];
  const names: string[] = [];
  for (const m of CATALOG[def.bodyKey].en.matchAll(/\{(\w+)\}/g)) if (!names.includes(m[1]!)) names.push(m[1]!);
  return names;
}

async function record(
  prisma: PrismaClient,
  req: SendRequest,
  def: MessageClassDef | undefined,
  decision: OutboundDecision,
  reason: string | undefined,
  extra: { templateKey?: string; providerMessageId?: string; keyed: boolean },
): Promise<void> {
  const to = digitsOnly(req.toPhone);
  await prisma.outboundMessageLog.createMany({
    skipDuplicates: true,
    data: [{
      businessId: req.businessId ?? null,
      messageClass: req.classId,
      audience: def?.audience ?? "CONSUMER",
      toPhoneHash: phoneHash(to),
      toPhoneLast4: phoneLast4(to),
      decision,
      reason: reason ?? null,
      templateKey: extra.templateKey ?? null,
      providerMessageId: extra.providerMessageId ?? null,
      relatedType: req.related?.type ?? null,
      relatedId: req.related?.id ?? null,
      // A failed attempt carries no key so that a retry of the same event can be recorded and sent again.
      idempotencyKey: extra.keyed ? req.idempotencyKey : null,
    }],
  });
}

/**
 * The only way a message to a non-merchant leaves TradePal. Every refusal is recorded with its reason; nothing is sent unless
 * every check passes: the class is registered, the platform switch and the business flag are on (consumer classes), the number
 * is not blocked, the person has opted in for this purpose with this seller, the template is APPROVED (or the 24-hour window
 * is open for a free-text reply), and the message names the seller.
 */
export async function sendMessage(prisma: PrismaClient, transport: MessageTransport, req: SendRequest): Promise<SendOutcome> {
  const now = req.now ?? new Date();
  const def = messageClass(req.classId);

  const prior = await prisma.outboundMessageLog.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
  if (prior) return { decision: prior.decision, ...(prior.reason ? { reason: prior.reason as SuppressionReason } : {}), deduped: true, ...(prior.providerMessageId ? { providerMessageId: prior.providerMessageId } : {}) };

  const suppress = async (reason: SuppressionReason): Promise<SendOutcome> => {
    await record(prisma, req, def, "SUPPRESSED", reason, { keyed: true });
    return { decision: "SUPPRESSED", reason };
  };

  if (!def) return suppress("UNREGISTERED_CLASS");
  if (def.pipeline !== "ENFORCED" || !def.bodyKey) return suppress("NOT_ENFORCED_CLASS");
  const to = digitsOnly(req.toPhone);
  if (!/^[0-9]{8,15}$/.test(to)) return suppress("BAD_RECIPIENT");

  const isReply = def.windowRule === "SESSION_ONLY";
  const windowOpen = !!req.lastInboundAt && now.getTime() - req.lastInboundAt.getTime() < SESSION_WINDOW_MS && req.lastInboundAt.getTime() <= now.getTime() + 60_000;

  if (def.audience === "CONSUMER") {
    if (!consumerMessagingSwitchOn()) return suppress("SWITCH_OFF");
    if (!req.businessId && def.consentPurpose) return suppress("MISSING_BUSINESS");
    if (req.businessId && !(await isFeatureEnabled(getTenantScopedClient(prisma, req.businessId), req.businessId, FLAG_CONSUMER_MESSAGING))) return suppress("FLAG_OFF");
  }

  // A block overrides everything except the one reply to the person's own STOP/START, which is inside the window they just opened.
  if ((await isBlocked(prisma, to)) && !(isReply && windowOpen)) return suppress("BLOCKED");

  if (def.consentPurpose) {
    const consent = await getTenantScopedClient(prisma, req.businessId!).contactConsent.findFirst({ where: { phone: to, purpose: def.consentPurpose } });
    if (!consent || consent.status !== "OPTED_IN") return suppress("NO_CONSENT");
  }

  // A message to a shopper always names the seller it is about.
  if (def.audience === "CONSUMER" && def.consentPurpose && !String(req.params?.["seller"] ?? "").trim()) return suppress("MISSING_IDENTITY");

  const locale = req.locale ?? "en";
  const useTemplate = def.windowRule === "TEMPLATE_REQUIRED" || (def.windowRule === "TEMPLATE_OUTSIDE_WINDOW" && !windowOpen);
  if (!useTemplate && !windowOpen) return suppress("OUTSIDE_WINDOW");

  try {
    if (useTemplate) {
      const tpl = await prisma.messageTemplate.findUnique({ where: { messageClass_language: { messageClass: def.id, language: "en" } } });
      if (!tpl || tpl.status !== "APPROVED" || !tpl.providerTemplateName) return suppress("TEMPLATE_NOT_APPROVED");
      const values = templateParamOrder(def).map((n) => String(req.params?.[n] ?? ""));
      const sent = await transport.sendTemplate(to, tpl.providerTemplateName, tpl.language, values);
      await record(prisma, req, def, "SENT", undefined, { templateKey: tpl.providerTemplateName, ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}), keyed: true });
      return { decision: "SENT", ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) };
    }
    const body = t(def.bodyKey, req.params ?? {}, locale).text;
    const sent = await transport.sendText(to, body);
    await record(prisma, req, def, "SENT", undefined, { ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}), keyed: true });
    return { decision: "SENT", ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) };
  } catch (error) {
    // Only the error's class and message are kept (never the body). A failed attempt is unkeyed so a later retry can try again.
    await record(prisma, req, def, "FAILED", `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300), { keyed: false });
    return { decision: "FAILED", reason: "TRANSPORT_ERROR" };
  }
}
