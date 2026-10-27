import type { CatalogKey } from "../i18n/index.js";

/**
 * Every outbound WhatsApp message class TradePal can send (expansion Phase 7, master prompt sections 14-16). A class that is
 * not in this list cannot be sent through the messaging pipeline. `docs/expansion/message-template-register.md` is GENERATED
 * from this list (`npx tsx scripts/genTemplateRegister.ts`) and a test fails if the two drift.
 *
 * Three kinds of entry:
 *  - `pipeline: "ENFORCED"`  new in Phase 7. Sent only through `sendMessage`, which checks the class, template approval,
 *                             the recipient's consent, the block list, the 24-hour window and the platform switch, and
 *                             writes `OutboundMessageLog`.
 *  - `pipeline: "REPLY"`     new in Phase 7. A free-text answer to the registered merchant who has just written, sent by
 *                             `messageDispatcher.reply` (registered-merchant guard, inside the window the merchant opened).
 *                             Not written to `OutboundMessageLog`.
 *  - `pipeline: "LEGACY"`    existed before Phase 7 and still sends through its own module. Documented here so the register is
 *                             complete; the new checks are NOT applied to it (stated in self-check-phase-7.md). All legacy
 *                             classes go only to registered merchants.
 */
export type Audience = "MERCHANT" | "CONSUMER" | "PARTNER" | "STAFF";
export type TemplateCategoryName = "UTILITY" | "MARKETING" | "AUTHENTICATION" | "SERVICE";
export type ConsentBasis =
  | "MERCHANT_RELATIONSHIP" // the merchant is a TradePal customer who messaged first / signed up
  | "ORDER_UPDATES_OPT_IN" // the shopper ticked the order-update box at checkout
  | "ONE_OFF_REPLY" // answering the person who just wrote to us
  | "PARTNER_AGREEMENT"
  | "STAFF_ENROLMENT"; // a TradePal staff member gave this number to receive their own sign-in codes and proved they control it
export type WindowRule = "SESSION_ONLY" | "TEMPLATE_REQUIRED" | "TEMPLATE_OUTSIDE_WINDOW";

export interface MessageClassDef {
  id: string;
  audience: Audience;
  category: TemplateCategoryName;
  pipeline: "ENFORCED" | "REPLY" | "LEGACY";
  /** What causes the message, in one line. */
  trigger: string;
  consentBasis: ConsentBasis;
  /** Consent purpose that must be OPTED_IN for a CONSUMER class. */
  consentPurpose?: "ORDER_UPDATES" | "MARKETING";
  windowRule: WindowRule;
  /** Catalog key of the body text (enforced classes). */
  bodyKey?: CatalogKey;
  /** Number of {{n}} body parameters in the provider template (enforced classes). */
  paramCount: number;
  /** Name of the environment variable holding the provider template name (legacy classes). */
  legacyTemplateEnv?: string;
  notes: string;
}

export const MESSAGE_CLASSES: readonly MessageClassDef[] = [
  // ------------------------------------------------------------------ enforced (Phase 7)
  {
    id: "CONSUMER_ORDER_CONFIRMED", audience: "CONSUMER", category: "UTILITY", pipeline: "ENFORCED",
    trigger: "The seller confirms a shopper's order.", consentBasis: "ORDER_UPDATES_OPT_IN", consentPurpose: "ORDER_UPDATES",
    windowRule: "TEMPLATE_REQUIRED", bodyKey: "order.confirmed", paramCount: 2,
    notes: "Names the seller and the order reference. Carries no order link, pickup code or amount. Never marketing.",
  },
  {
    id: "CONSUMER_ORDER_READY", audience: "CONSUMER", category: "UTILITY", pipeline: "ENFORCED",
    trigger: "The seller marks a pickup order ready.", consentBasis: "ORDER_UPDATES_OPT_IN", consentPurpose: "ORDER_UPDATES",
    windowRule: "TEMPLATE_REQUIRED", bodyKey: "order.ready", paramCount: 2,
    notes: "Never contains the handover code.",
  },
  {
    id: "CONSUMER_ORDER_DISPATCHED", audience: "CONSUMER", category: "UTILITY", pipeline: "ENFORCED",
    trigger: "The seller dispatches a delivery order.", consentBasis: "ORDER_UPDATES_OPT_IN", consentPurpose: "ORDER_UPDATES",
    windowRule: "TEMPLATE_REQUIRED", bodyKey: "order.dispatched", paramCount: 2,
    notes: "Never contains the handover code.",
  },
  {
    id: "CONSUMER_ORDER_CANCELLED", audience: "CONSUMER", category: "UTILITY", pipeline: "ENFORCED",
    trigger: "An order is cancelled by the seller, by the shopper, or by hold expiry.", consentBasis: "ORDER_UPDATES_OPT_IN", consentPurpose: "ORDER_UPDATES",
    windowRule: "TEMPLATE_REQUIRED", bodyKey: "order.cancelled", paramCount: 2,
    notes: "Says only that the order was cancelled. Refund amounts and debt or collection language are never included.",
  },
  {
    id: "CONSUMER_OPT_OUT_CONFIRMATION", audience: "CONSUMER", category: "SERVICE", pipeline: "ENFORCED",
    trigger: "A shopper replies STOP.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", bodyKey: "consent.optedOut", paramCount: 0,
    notes: "A reply inside the window the shopper just opened. Sent even though the number is now blocked: it is the only message allowed after STOP.",
  },
  {
    id: "CONSUMER_OPT_IN_CONFIRMATION", audience: "CONSUMER", category: "SERVICE", pipeline: "ENFORCED",
    trigger: "A shopper replies START after STOP.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", bodyKey: "consent.optedIn", paramCount: 0,
    notes: "A reply inside the window the shopper just opened.",
  },
  {
    id: "CONSUMER_UPDATES_STARTED", audience: "CONSUMER", category: "SERVICE", pipeline: "ENFORCED",
    trigger: "A shopper sends UPDATES <code> from the number they gave at checkout.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", bodyKey: "consent.updatesStarted", paramCount: 0,
    notes: "A reply inside the window the shopper just opened. It is what makes the consent VERIFIED. Names the seller and the order reference.",
  },
  {
    id: "CONSUMER_UPDATES_UNMATCHED", audience: "CONSUMER", category: "SERVICE", pipeline: "ENFORCED",
    trigger: "A shopper sends UPDATES <code> and the code does not match that number.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", bodyKey: "consent.updatesUnmatched", paramCount: 0,
    notes: "A reply inside the window the sender just opened; reveals nothing about any order.",
  },
  {
    id: "CONSUMER_UPDATES_BLOCKED", audience: "CONSUMER", category: "SERVICE", pipeline: "ENFORCED",
    trigger: "A shopper who sent STOP earlier sends UPDATES <code>.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", bodyKey: "consent.updatesBlocked", paramCount: 0,
    notes: "Tells them to send START first. A STOP is never undone by a link.",
  },
  {
    id: "MERCHANT_CONFIRMATION_REPLY", audience: "MERCHANT", category: "SERVICE", pipeline: "REPLY",
    trigger: "A merchant answers YES, NO or a number to a pending confirmation or clarification.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", paramCount: 0,
    notes: "Free text inside the 24-hour window the merchant just opened. Text comes from the i18n catalog (confirm.*, clarify.*).",
  },
  {
    id: "MERCHANT_DEVICE_CODE", audience: "MERCHANT", category: "AUTHENTICATION", pipeline: "REPLY",
    trigger: "A merchant sends /connect to link a phone for offline drafts.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", bodyKey: "device.code", paramCount: 0,
    notes: "One-time code, single use, short expiry. Sent only as a reply to the merchant's own command.",
  },
  // ------------------------------------------------------------------ legacy (before Phase 7)
  {
    id: "MERCHANT_REPLY", audience: "MERCHANT", category: "SERVICE", pipeline: "LEGACY",
    trigger: "Any reply to a merchant's message (commands, parsed entries, errors).", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", paramCount: 0,
    notes: "Free text from `messageDispatcher.reply`. Registered merchants only.",
  },
  {
    id: "MERCHANT_SUBSCRIPTION_LAPSE", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY",
    trigger: "A paid subscription lapses.", consentBasis: "MERCHANT_RELATIONSHIP",
    windowRule: "TEMPLATE_OUTSIDE_WINDOW", paramCount: 0, legacyTemplateEnv: "WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME",
    notes: "Account status notice to the merchant. Not debt collection.",
  },
  {
    id: "MERCHANT_RENEWAL_REMINDER", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY",
    trigger: "An admin sends a renewal reminder (Phase 6 admin action).", consentBasis: "MERCHANT_RELATIONSHIP",
    windowRule: "SESSION_ONLY", paramCount: 0,
    notes: "Plain text; Meta may refuse it outside the 24-hour window. Not recorded anywhere except the admin audit log.",
  },
  {
    id: "MERCHANT_WEEKLY_DIGEST", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY",
    trigger: "The weekly business digest.", consentBasis: "MERCHANT_RELATIONSHIP",
    windowRule: "TEMPLATE_OUTSIDE_WINDOW", paramCount: 0, legacyTemplateEnv: "WHATSAPP_WEEKLY_DIGEST_TEMPLATE_NAME",
    notes: "The merchant's own numbers only.",
  },
  {
    id: "MERCHANT_PAYMENT_RECEIVED", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY",
    trigger: "A payment request the merchant created is paid.", consentBasis: "MERCHANT_RELATIONSHIP",
    windowRule: "TEMPLATE_OUTSIDE_WINDOW", paramCount: 0, legacyTemplateEnv: "WHATSAPP_PAYMENT_RECEIVED_TEMPLATE_NAME",
    notes: "To the merchant, never to the payer.",
  },
  {
    id: "MERCHANT_PAYMENT_CONFIRMED", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY",
    trigger: "A collection is confirmed.", consentBasis: "MERCHANT_RELATIONSHIP",
    windowRule: "TEMPLATE_OUTSIDE_WINDOW", paramCount: 0, legacyTemplateEnv: "WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_NAME",
    notes: "To the merchant, never to the payer.",
  },
  {
    id: "MERCHANT_STAFF_ADDED", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY",
    trigger: "An owner adds a staff member.", consentBasis: "MERCHANT_RELATIONSHIP",
    windowRule: "TEMPLATE_OUTSIDE_WINDOW", paramCount: 0, legacyTemplateEnv: "WHATSAPP_STAFF_ADDED_TEMPLATE_NAME",
    notes: "Goes to the new staff member's number, which is registered as a merchant row when it is added.",
  },
  {
    id: "MERCHANT_DELETION_RESOLUTION", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY",
    trigger: "A data-deletion request is resolved.", consentBasis: "MERCHANT_RELATIONSHIP",
    windowRule: "TEMPLATE_OUTSIDE_WINDOW", paramCount: 0, legacyTemplateEnv: "WHATSAPP_DELETION_RESOLUTION_TEMPLATE_NAME",
    notes: "Answer to the merchant's own request.",
  },
  {
    id: "STAFF_SIGNIN_CODE", audience: "STAFF", category: "AUTHENTICATION", pipeline: "LEGACY",
    trigger: "A signed-in-with-password TradePal staff member asks for a WhatsApp code (to add the number, to finish signing in, or to confirm a sensitive action).", consentBasis: "STAFF_ENROLMENT",
    windowRule: "TEMPLATE_REQUIRED", paramCount: 1, legacyTemplateEnv: "WHATSAPP_ADMIN_CODE_TEMPLATE_NAME",
    notes: "A one-time six-digit code, valid 5 minutes, usable once, bound to the sign-in session that asked for it. Sent by `src/admin/whatsappCodes.ts` through the WhatsApp transport, only while `ADMIN_WHATSAPP_CODES_ENABLED=true`. The first code to a new number proves the staff member controls it. Limited per account and per number; never sent to a number on the block list. Needs a Meta AUTHENTICATION template with a copy-code button.",
  },
  {
    id: "UNSUPPORTED_COUNTRY_NOTICE", audience: "CONSUMER", category: "SERVICE", pipeline: "LEGACY",
    trigger: "Someone outside the launch countries messages TradePal first.", consentBasis: "ONE_OFF_REPLY",
    windowRule: "SESSION_ONLY", paramCount: 0,
    notes: "One fixed reply to a person who wrote first. Nothing stored about the sender.",
  },
] as const;

export function messageClass(id: string): MessageClassDef | undefined {
  return MESSAGE_CLASSES.find((c) => c.id === id);
}
