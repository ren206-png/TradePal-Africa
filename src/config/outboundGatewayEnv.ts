import type { SubscriptionExpiryOutboundGateway } from "../domain/subscriptionExpiry.js";
import type { BusinessDigestOutboundGateway } from "../domain/businessDigest.js";
import type { DeletionResolutionOutboundGateway } from "../domain/deletion.js";

/**
 * Shared by src/server.ts and src/subscriptionExpiryWorker.ts — both need the
 * same optional WhatsApp send configuration for the Phase 7 subscription-
 * lapse notification, and duplicating this logic in each entrypoint (rather
 * than sharing it) risked the two processes silently drifting apart on which
 * env vars they read or how they're combined.
 *
 * All four vars are optional: WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID
 * gate whether any notification can be sent at all (omitted entirely if
 * either is missing — see subscriptionExpiry.ts's `outboundGateway`
 * parameter doc comment). WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME/
 * _LANGUAGE (Phase 9) are a further, independent opt-in on top of that: when
 * both are set, the notification is sent as that Meta-approved template
 * (works outside the merchant's 24-hour service window); when either is
 * missing, it falls back to Phase 7's original free-form text send.
 */
export function buildSubscriptionExpiryOutboundGatewayFromEnv(): SubscriptionExpiryOutboundGateway | undefined {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!accessToken || !phoneNumberId) return undefined;

  const templateName = process.env["WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME"];
  const templateLanguageCode = process.env["WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_LANGUAGE"];
  const lapseNotificationTemplate =
    templateName && templateLanguageCode ? { name: templateName, languageCode: templateLanguageCode } : undefined;

  return {
    accessToken,
    phoneNumberId,
    ...(lapseNotificationTemplate ? { lapseNotificationTemplate } : {}),
  };
}

/**
 * Same WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID env vars as
 * buildSubscriptionExpiryOutboundGatewayFromEnv — both a WhatsApp Business
 * phone number's send credentials authorize any outbound send from that
 * number, so there is no separate credential to configure for the weekly
 * digest. Kept as its own function (rather than reusing the subscription-
 * expiry one directly) so src/businessDigestWorker.ts doesn't have to depend
 * on subscriptionExpiry.ts's module, and so the two features' env wiring can
 * diverge later without one accidentally affecting the other.
 *
 * Phase 18: WHATSAPP_WEEKLY_DIGEST_TEMPLATE_NAME/_LANGUAGE, mirroring
 * WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME/_LANGUAGE above exactly (same
 * both-or-neither-set contract), are the opt-in this doc comment previously
 * anticipated — when both are set, the weekly digest is sent as that
 * Meta-approved template (works outside the merchant's 24-hour service
 * window) instead of free-form text. The template is a distinct env var pair
 * from the lapse notification's own, since the two features can be
 * configured independently (a deployment might have one template approved
 * but not the other) and require different template bodies (7 placeholders
 * for the digest vs. 1 for the lapse notification — see
 * businessDigest.ts's `buildWeeklyDigestTemplateParams`).
 */
export function buildBusinessDigestOutboundGatewayFromEnv(): BusinessDigestOutboundGateway | undefined {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!accessToken || !phoneNumberId) return undefined;

  const templateName = process.env["WHATSAPP_WEEKLY_DIGEST_TEMPLATE_NAME"];
  const templateLanguageCode = process.env["WHATSAPP_WEEKLY_DIGEST_TEMPLATE_LANGUAGE"];
  const weeklyDigestTemplate =
    templateName && templateLanguageCode ? { name: templateName, languageCode: templateLanguageCode } : undefined;

  return {
    accessToken,
    phoneNumberId,
    ...(weeklyDigestTemplate ? { weeklyDigestTemplate } : {}),
  };
}

/**
 * Phase 18: the WhatsApp-notification counterpart for deletion-request
 * resolution (src/domain/deletion.ts). Same WHATSAPP_ACCESS_TOKEN/
 * WHATSAPP_PHONE_NUMBER_ID as the two builders above — again, a WhatsApp
 * Business phone number's send credentials are the only credential a send
 * needs, so there's nothing feature-specific to configure.
 *
 * Deliberately returns `Omit<DeletionResolutionOutboundGateway, "prisma">`,
 * not the full type: unlike `SubscriptionExpiryOutboundGateway`/
 * `BusinessDigestOutboundGateway` (which omit `prisma` because their
 * consuming functions already take a raw `PrismaClient` as their own first
 * parameter and can merge it in internally), `DeletionResolutionOutboundGateway`
 * is the *full* `OutboundGatewayDeps` type including `prisma` — see that
 * type's own doc comment in deletion.ts for why `completeDeletionRequest`/
 * `rejectDeletionRequest` need the caller to supply `prisma` directly instead.
 * The caller (src/admin/adminRoutes.ts, which already has a raw `PrismaClient`
 * in scope) merges it in: `{ prisma, ...buildDeletionResolutionOutboundGatewayFromEnv() }`.
 *
 * Phase 20: WHATSAPP_DELETION_RESOLUTION_TEMPLATE_NAME/_LANGUAGE, mirroring
 * WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME/_LANGUAGE and
 * WHATSAPP_WEEKLY_DIGEST_TEMPLATE_NAME/_LANGUAGE above exactly (same
 * both-or-neither-set contract), close the gap this doc comment previously
 * flagged — when both are set, the deletion-resolution notice is sent as
 * that Meta-approved template (works outside the merchant's 24-hour service
 * window) instead of free-form text. Distinct env var pair from the other
 * two features' own, since deployments configure/approve each template
 * independently and the body shape differs (2 placeholders here — outcome
 * and resolution note — vs. 1 for the lapse notification and 7 for the
 * digest; see deletion.ts's `buildDeletionResolutionTemplateParams`).
 */
export function buildDeletionResolutionOutboundGatewayFromEnv(): Omit<DeletionResolutionOutboundGateway, "prisma"> | undefined {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!accessToken || !phoneNumberId) return undefined;

  const templateName = process.env["WHATSAPP_DELETION_RESOLUTION_TEMPLATE_NAME"];
  const templateLanguageCode = process.env["WHATSAPP_DELETION_RESOLUTION_TEMPLATE_LANGUAGE"];
  const resolutionTemplate =
    templateName && templateLanguageCode ? { name: templateName, languageCode: templateLanguageCode } : undefined;

  return {
    accessToken,
    phoneNumberId,
    ...(resolutionTemplate ? { resolutionTemplate } : {}),
  };
}
