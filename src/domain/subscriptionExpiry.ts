import type { PrismaClient } from "@prisma/client";
import { recordAuditLog } from "./auditLog.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "./featureFlags.js";
import { sendWithRetry } from "./outboundSendRetry.js";
import {
  sendWhatsAppTemplateMessage,
  sendWhatsAppTextMessage,
  type OutboundGatewayDeps,
} from "../whatsapp/outboundGateway.js";

/**
 * Phase 6: closes the gap disclosed in Phases 4 and 5 — "nothing in this
 * codebase transitions a Subscription out of ACTIVE when its period lapses
 * (no cron/worker does it)". billing.ts's `getEffectivePlan` already stops
 * *treating* a lapsed ACTIVE row as entitled the moment its period ends
 * (read-time fix, effective immediately, independent of this job ever
 * running). This module is the complementary write-time fix: it keeps the
 * *stored* `Subscription.status` honest for anything that reads it directly
 * rather than through `getEffectivePlan` — most notably the admin
 * subscriptions list (`GET /admin/businesses/:id`), which would otherwise
 * keep showing a lapsed row as "ACTIVE" forever.
 *
 * Lapsed rows are moved to `PAST_DUE`, not `CANCELED`: `CANCELED` already
 * means "an admin deliberately ended this," which isn't true here — nobody
 * asked for this subscription to stop, its period simply ran out with no
 * renewal recorded (there is still no payment collection, so there is
 * nothing that could have renewed it). `PAST_DUE` was already sitting unused
 * in the schema's `SubscriptionStatus` enum for exactly this shape of state,
 * so no migration is needed here.
 */
export const SUBSCRIPTION_EXPIRY_JOB_NAME = "subscription-expiry-sweep";

/**
 * Off by default (Non-Negotiable Standard #7) — see prisma/seed.ts. This is
 * the newly-disclosed gap from Phase 6's own report: a business silently
 * falling back to FREE with nobody told why. Distinct from KQ2's "customer
 * reminder" policy concern (PHASE_0_FINDINGS.md) — that concern is about
 * messaging a merchant's *customer* without the customer's own opt-in; this
 * sends to the business's own registered Merchant.phoneNumber about their
 * own subscription, which is exactly the case sendWhatsAppTextMessage (and
 * Non-Negotiable Standard #9) already permits.
 *
 * Originally sent only as free-form `type: "text"` (Phase 7), which Meta can
 * reject outright if the merchant hasn't messaged the bot within the
 * preceding 24 hours — a subscription lapsing is a business-initiated event,
 * not a reply inside an open conversation window. `expireLapsedSubscriptions`
 * now accepts an optional `lapseNotificationTemplate` (Phase 9) so a
 * deployment that has created and had a template approved in WhatsApp
 * Business Manager can send via `sendWhatsAppTemplateMessage` instead, which
 * Meta accepts outside the 24-hour window. When no template is configured,
 * behavior falls back to Phase 7's original free-form text send — this
 * remains the default because TradePal has no way to create or verify a
 * template itself; someone has to set one up in Meta's console first.
 * Whichever path is used, a failed send is retried a bounded number of times
 * for likely-transient errors (429/5xx/network) before being audited as
 * failed (see `sendLapseNotificationWithRetry` below) — failures are caught
 * per-merchant and never abort the sweep for other businesses.
 */
export const SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY = "subscriptionLapseNotification";

export interface ExpireLapsedSubscriptionsResult {
  expiredCount: number;
  expiredSubscriptionIds: string[];
}

/**
 * Optional outbound-send configuration for the Phase 7 lapse notification.
 * `lapseNotificationTemplate`, if supplied, must name a template already
 * created and approved for this WhatsApp Business phone number — see the doc
 * comment on `sendWhatsAppTemplateMessage`. The template is assumed to have
 * exactly one body placeholder (`{{1}}`), filled with the lapsed plan's code,
 * mirroring `buildLapseNotificationMessage`'s free-form fallback content.
 */
export type SubscriptionExpiryOutboundGateway = Omit<OutboundGatewayDeps, "prisma"> & {
  lapseNotificationTemplate?: { name: string; languageCode: string };
};

function buildLapseNotificationMessage(planCode: string): string {
  return (
    `Your TradePal subscription (plan: ${planCode}) has expired and your account has been moved to the Free plan. ` +
    `Contact support to renew your subscription and restore full access.`
  );
}

export class NotificationSendFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
  }
}

/**
 * Retry policy for a lapse notification send now lives in
 * outboundSendRetry.ts (Phase 14 — this was previously a byte-for-byte
 * duplicate of businessDigest.ts's own copy of the same logic, disclosed as
 * a follow-up in Phase 12). `sendLapseNotificationWithRetry` below is a thin
 * wrapper so every existing call site and `instanceof NotificationSendFailedError`
 * check keeps working completely unchanged.
 */
function sendLapseNotificationWithRetry(sendFn: () => Promise<void>): Promise<number> {
  return sendWithRetry(sendFn, (message, attempts) => new NotificationSendFailedError(message, attempts));
}

/**
 * Finds every ACTIVE Subscription whose currentPeriodEnd is at or before
 * `now` and flips it to PAST_DUE, with one AuditLog row per business
 * attributing the change to this job (actorType SYSTEM, actorId the job
 * name — exactly the "job name" case the AuditLog.actorId doc comment on
 * the Prisma schema already anticipates). Idempotent: rows already
 * PAST_DUE/CANCELED are excluded from the query in the first place, so
 * running this repeatedly (as the periodic worker does) never re-expires or
 * double-audits the same row.
 *
 * Uses the raw PrismaClient for the initial scan (Subscription rows across
 * every business need to be found in one query — there is no single
 * business to scope to yet), then updates/audits each row through
 * getTenantScopedClient for its own business, matching the tenant-isolation
 * convention every other write in this codebase follows.
 *
 * `outboundGateway` is optional and omitted entirely in most tests / the
 * admin manual-trigger route when WhatsApp credentials aren't configured for
 * that process — when omitted, the status/audit transition still happens
 * exactly as before, notifications are just skipped (checked per-business,
 * after the feature-flag check, so "flag on but gateway not wired up" fails
 * safe rather than throwing). One AuditLog row is written per merchant
 * notified (or per failed attempt), separate from the SUBSCRIPTION_EXPIRED
 * row, since the send is a distinct, independently-failable side effect
 * (Non-Negotiable Standard #8: one row per state-changing action/effect).
 */
export async function expireLapsedSubscriptions(
  prisma: PrismaClient,
  now: Date = new Date(),
  outboundGateway?: SubscriptionExpiryOutboundGateway,
): Promise<ExpireLapsedSubscriptionsResult> {
  const lapsed = await prisma.subscription.findMany({
    where: { status: "ACTIVE", currentPeriodEnd: { lte: now } },
    orderBy: { createdAt: "asc" },
  });

  const expiredSubscriptionIds: string[] = [];
  for (const subscription of lapsed) {
    const scoped = getTenantScopedClient(prisma, subscription.businessId);
    await scoped.subscription.update({
      where: { id: subscription.id },
      data: { status: "PAST_DUE" },
    });
    await recordAuditLog(scoped, {
      businessId: subscription.businessId,
      actorType: "SYSTEM",
      actorId: SUBSCRIPTION_EXPIRY_JOB_NAME,
      action: "SUBSCRIPTION_EXPIRED",
      entityType: "Subscription",
      entityId: subscription.id,
      metadata: { planCode: subscription.planCode, currentPeriodEnd: subscription.currentPeriodEnd.toISOString() },
    });
    expiredSubscriptionIds.push(subscription.id);

    const notificationsEnabled = await isFeatureEnabled(
      scoped,
      subscription.businessId,
      SUBSCRIPTION_LAPSE_NOTIFICATION_FEATURE_FLAG_KEY,
    );
    if (notificationsEnabled && outboundGateway) {
      const merchants = await scoped.merchant.findMany({ where: { businessId: subscription.businessId } });
      const gatewayDeps = { prisma, ...outboundGateway };
      const template = outboundGateway.lapseNotificationTemplate;
      const sendMethod = template ? "template" : "text";

      for (const merchant of merchants) {
        try {
          const attempts = await sendLapseNotificationWithRetry(() =>
            template
              ? sendWhatsAppTemplateMessage(gatewayDeps, {
                  toPhoneNumber: merchant.phoneNumber,
                  templateName: template.name,
                  templateLanguageCode: template.languageCode,
                  bodyParams: [subscription.planCode],
                })
              : sendWhatsAppTextMessage(gatewayDeps, {
                  toPhoneNumber: merchant.phoneNumber,
                  body: buildLapseNotificationMessage(subscription.planCode),
                }),
          );
          await recordAuditLog(scoped, {
            businessId: subscription.businessId,
            actorType: "SYSTEM",
            actorId: SUBSCRIPTION_EXPIRY_JOB_NAME,
            action: "SUBSCRIPTION_LAPSE_NOTIFICATION_SENT",
            entityType: "Merchant",
            entityId: merchant.id,
            metadata: { subscriptionId: subscription.id, planCode: subscription.planCode, sendMethod, attempts },
          });
        } catch (error) {
          const attempts = error instanceof NotificationSendFailedError ? error.attempts : 1;
          await recordAuditLog(scoped, {
            businessId: subscription.businessId,
            actorType: "SYSTEM",
            actorId: SUBSCRIPTION_EXPIRY_JOB_NAME,
            action: "SUBSCRIPTION_LAPSE_NOTIFICATION_FAILED",
            entityType: "Merchant",
            entityId: merchant.id,
            metadata: {
              subscriptionId: subscription.id,
              planCode: subscription.planCode,
              sendMethod,
              attempts,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }
  }

  return { expiredCount: expiredSubscriptionIds.length, expiredSubscriptionIds };
}
