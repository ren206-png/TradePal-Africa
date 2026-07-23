import type { PrismaClient } from "@prisma/client";
import { recordAuditLog } from "./auditLog.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "./featureFlags.js";
import { getWeekBoundsInTimezone, getSummaryForRange, type DailySummary } from "./dailySummary.js";
import { formatMoney } from "./money.js";
import { sendWithRetry } from "./outboundSendRetry.js";
import {
  sendWhatsAppTemplateMessage,
  sendWhatsAppTextMessage,
  type OutboundGatewayDeps,
} from "../whatsapp/outboundGateway.js";

/**
 * Phase 12 — Weekly Business-Health Digest. Every competitor found in
 * PHASE_0_FINDINGS's Phase 12 research is either app-based (Kippa, Bumpa —
 * the merchant has to open a dedicated app to see their numbers) or a
 * customer-facing WhatsApp order-taking bot (ModSapp, Woya, Relay,
 * SmartBizSystems, Intelli — a different product aimed at the merchant's own
 * customers, not the merchant). None of them proactively pushes a merchant's
 * own financial standing back to them inside the same WhatsApp thread they
 * already log sales/expenses in. This module is that push: once a week, for
 * every business that has opted in, it summarizes the week that just ended
 * (sales/expenses/net, mirroring /today's own numbers but for 7 days) plus
 * their single largest open debt, and sends it as a WhatsApp message to every
 * registered Merchant on the business.
 *
 * Deliberately mirrors src/domain/subscriptionExpiry.ts's shape (job-name/
 * flag-key constants, an optional outboundGateway, per-merchant retry +
 * AuditLog rows) since that module already established the "periodic
 * sweep + BullMQ repeatable job + separate worker process" pattern this
 * codebase uses for standing background behavior — see
 * src/businessDigestWorker.ts and src/queue/businessDigestQueue.ts.
 */
export const WEEKLY_DIGEST_JOB_NAME = "weekly-business-digest";

/** Off by default (Non-Negotiable Standard #7) — see prisma/seed.ts. */
export const WEEKLY_DIGEST_FEATURE_FLAG_KEY = "weeklyBusinessDigest";

/**
 * Distinct from every other AuditLog row this codebase writes: those are
 * pure records of something that already happened. This one is also read
 * back (see `alreadyProcessedThisWeek` below) to answer "has this business's
 * digest for this specific week already been handled?" — there is no
 * dedicated schema column for that (unlike Subscription.status, which
 * expireLapsedSubscriptions's own idempotency leans on), so AuditLog is
 * repurposed here as the idempotency ledger too. Disclosed as a deliberate,
 * slightly-unusual reuse of a Standard #8 audit mechanism, not hidden.
 */
const WEEKLY_DIGEST_PERIOD_ENTITY_TYPE = "WeeklyDigestPeriod";
const WEEKLY_DIGEST_PERIOD_PROCESSED_ACTION = "WEEKLY_DIGEST_PERIOD_PROCESSED";

/**
 * Phase 18 gap closure: like Phase 7's lapse notification before it (see
 * subscriptionExpiry.ts's own doc comment on this exact pattern), a weekly
 * digest is a business-initiated send, not a reply inside an open
 * conversation window — by design, it often reaches a merchant who hasn't
 * messaged the bot in days, which Meta's free-form `type: "text"` path can
 * reject outright outside the recipient's 24-hour service window. This was
 * flagged in Phase 12 only as "digest content is fixed and minimal", not as
 * a delivery-risk gap in its own right; investigation for this phase found
 * `subscriptionExpiry.ts` already solved the identical problem in Phase 9 and
 * this module never received the same treatment. `weeklyDigestTemplate`, if
 * supplied, must name a template already created and approved for this
 * WhatsApp Business phone number with exactly 7 body placeholders
 * (`{{1}}`..`{{7}}`), one per line of `buildWeeklyDigestMessage`'s own output
 * in order — see `buildWeeklyDigestTemplateParams` below. When omitted, the
 * digest keeps sending as free-form text exactly as it always has.
 */
export type BusinessDigestOutboundGateway = Omit<OutboundGatewayDeps, "prisma"> & {
  weeklyDigestTemplate?: { name: string; languageCode: string };
};

export interface TopDebtor {
  customerId: string;
  customerName: string;
  outstandingAmountMinor: bigint;
}

export interface WeeklyDigest {
  weekStart: Date;
  weekEnd: Date;
  summary: DailySummary;
  topDebtor: TopDebtor | null;
  /**
   * Phase 14 gap closure: the immediately preceding Mon-Sun week's summary,
   * for a "vs last week" trend line — closing Phase 12's own disclosed gap
   * ("digest content is fixed and minimal, no trends/comparisons"). Computed
   * unconditionally (always exactly 7 days before `weekStart`, since no
   * launch country observes DST — see getWeekBoundsInTimezone's own doc
   * comment), never null: a business with no transactions the week before
   * simply gets an all-zero summary, which buildWeeklyDigestMessage renders
   * as "no data to compare" rather than a misleading "0% change".
   */
  previousWeekSummary: DailySummary;
}

/**
 * Computes the completed-week summary plus the single largest open (or
 * partially paid) debt for one business — the same two numbers a merchant
 * could otherwise only get by running `/today` seven times and adding a
 * `/debt` lookup themselves. Also computes the prior week's summary for the
 * "vs last week" trend line (see WeeklyDigest.previousWeekSummary).
 */
export async function computeWeeklyDigest(
  scopedPrisma: ReturnType<typeof getTenantScopedClient>,
  timezone: string,
  now: Date = new Date(),
): Promise<WeeklyDigest> {
  const { start, end } = getWeekBoundsInTimezone(now, timezone);
  const summary = await getSummaryForRange(scopedPrisma, start, end);

  const previousWeekStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
  const previousWeekSummary = await getSummaryForRange(scopedPrisma, previousWeekStart, start);

  const topDebt = await scopedPrisma.debt.findFirst({
    where: { status: { in: ["OPEN", "PARTIALLY_PAID"] } },
    orderBy: { outstandingAmountMinor: "desc" },
    include: { customer: true },
  });

  return {
    weekStart: start,
    weekEnd: end,
    summary,
    previousWeekSummary,
    topDebtor: topDebt
      ? {
          customerId: topDebt.customerId,
          customerName: topDebt.customer.name,
          outstandingAmountMinor: topDebt.outstandingAmountMinor,
        }
      : null,
  };
}

function formatWeekLabel(weekStart: Date, weekEnd: Date, timeZone: string): string {
  const lastDayOfWeek = new Date(weekEnd.getTime() - 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });
  return `${formatter.format(weekStart)} - ${formatter.format(lastDayOfWeek)}`;
}

/**
 * Renders the net-change-vs-last-week line. When the prior week had zero
 * transactions at all (a brand-new business, or one that simply logged
 * nothing that week), a delta would be misleading — "+100.00 NGN" reads as
 * "up from something" when there was really nothing to compare against — so
 * this reports "no data from the previous week to compare" instead.
 */
function formatWeekOverWeekLine(
  summary: DailySummary,
  previousWeekSummary: DailySummary,
  currencyCode: string,
  minorUnitExp: number,
): string {
  if (previousWeekSummary.transactionCount === 0) {
    return "vs last week: no data from the previous week to compare.";
  }
  const deltaMinor = summary.netMinor - previousWeekSummary.netMinor;
  const sign = deltaMinor >= 0n ? "+" : "";
  return (
    `vs last week: ${sign}${formatMoney(deltaMinor, minorUnitExp)} ${currencyCode} ` +
    `(last week's net was ${formatMoney(previousWeekSummary.netMinor, minorUnitExp)} ${currencyCode})`
  );
}

/**
 * Shared by buildWeeklyDigestMessage (joined with newlines, for the free-form
 * text send path) and buildWeeklyDigestTemplateParams (kept as separate
 * array entries, one per Meta template body placeholder) below, so the two
 * send paths can never drift apart on what content a merchant actually sees.
 */
function buildDigestLines(
  digest: WeeklyDigest,
  timezone: string,
  currencyCode: string,
  minorUnitExp: number,
): string[] {
  const { summary, previousWeekSummary, topDebtor, weekStart, weekEnd } = digest;

  return [
    `Your weekly business summary (${formatWeekLabel(weekStart, weekEnd, timezone)}):`,
    `Transactions: ${summary.transactionCount}`,
    `Sales: ${formatMoney(summary.totalSalesMinor, minorUnitExp)} ${currencyCode}`,
    `Expenses: ${formatMoney(summary.totalExpensesMinor, minorUnitExp)} ${currencyCode}`,
    `Net: ${formatMoney(summary.netMinor, minorUnitExp)} ${currencyCode}`,
    formatWeekOverWeekLine(summary, previousWeekSummary, currencyCode, minorUnitExp),
    topDebtor
      ? `Top outstanding debt: ${topDebtor.customerName} owes ${formatMoney(topDebtor.outstandingAmountMinor, minorUnitExp)} ${currencyCode}`
      : "No outstanding debts.",
  ];
}

/** Plain-text, no-emoji formatting to match handleToday's own convention in commandRouter.ts. */
export function buildWeeklyDigestMessage(
  digest: WeeklyDigest,
  timezone: string,
  currencyCode: string,
  minorUnitExp: number,
): string {
  return buildDigestLines(digest, timezone, currencyCode, minorUnitExp).join("\n");
}

/**
 * The template-send counterpart to buildWeeklyDigestMessage — same 7 lines,
 * kept as separate array entries for `sendWhatsAppTemplateMessage`'s
 * `bodyParams` (one Meta template body placeholder per entry) instead of
 * being joined into one block of text. See BusinessDigestOutboundGateway's
 * `weeklyDigestTemplate` doc comment for the exact placeholder-count contract
 * this depends on.
 */
export function buildWeeklyDigestTemplateParams(
  digest: WeeklyDigest,
  timezone: string,
  currencyCode: string,
  minorUnitExp: number,
): string[] {
  return buildDigestLines(digest, timezone, currencyCode, minorUnitExp);
}

export class DigestSendFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
  }
}

/**
 * Retry policy now lives in outboundSendRetry.ts (Phase 14 — this was
 * previously a byte-for-byte duplicate of subscriptionExpiry.ts's own copy
 * of the same logic, disclosed as a follow-up in this same Phase 12
 * section). `sendDigestWithRetry` below is a thin wrapper so the existing
 * `instanceof DigestSendFailedError` check further down keeps working
 * completely unchanged.
 */
function sendDigestWithRetry(sendFn: () => Promise<void>): Promise<number> {
  return sendWithRetry(sendFn, (message, attempts) => new DigestSendFailedError(message, attempts));
}

export interface SendWeeklyBusinessDigestsResult {
  /** Businesses for which a digest was actually sent (or attempted, if all sends failed) this run. */
  processedBusinessIds: string[];
}

/**
 * The weekly sweep: for every business with `weeklyBusinessDigest` enabled,
 * computes and sends the completed-week digest to every registered
 * Merchant on that business.
 *
 * Two guards run before anything is sent:
 *  - "too new" — if the business didn't exist yet for the whole week being
 *    summarized (`business.createdAt >= weekEnd`), it's skipped entirely
 *    (no AuditLog row written), so a day-1 signup never gets an empty,
 *    confusing "you sold nothing this week" message on their very first
 *    Monday. It will get its first real digest the following week.
 *  - idempotency — if a `WEEKLY_DIGEST_PERIOD_PROCESSED` AuditLog row
 *    already exists for this business + this exact week-start instant, the
 *    business is skipped: this run (or an earlier one) already handled this
 *    week. This matters because, unlike `expireLapsedSubscriptions`, there is
 *    no schema column recording "which week was this business's digest last
 *    sent for" — see the module doc comment above.
 *
 * `outboundGateway` is optional, exactly like subscriptionExpiry.ts's own
 * parameter: when omitted (WhatsApp send credentials not configured for this
 * process), a business that passes both guards is simply skipped without
 * writing the idempotency marker — so once credentials are configured, the
 * very next sweep still sends that week's digest rather than having silently
 * "used up" the week with nothing sent.
 *
 * Phase 14 gap closure — the idempotency marker is now written *before* the
 * per-merchant send loop runs, not after it completes. Phase 12 originally
 * wrote it last, which meant a crash mid-loop (e.g. after successfully
 * messaging merchant #1 of a 3-merchant business, but before reaching
 * merchant #3) left no marker at all, so the *next* sweep tick would resend
 * to every merchant on that business, including ones already notified —a
 * disclosed double-send risk. Writing the marker first converts that failure
 * mode into the opposite (and, for a notification, much safer) one: a crash
 * mid-loop now means some merchants simply never got that week's digest,
 * rather than some getting it twice. The trade-off is deliberate — an
 * occasional missed weekly summary is a far smaller problem than a merchant
 * getting spammed twice in one run.
 */
export async function sendWeeklyBusinessDigests(
  prisma: PrismaClient,
  now: Date = new Date(),
  outboundGateway?: BusinessDigestOutboundGateway,
): Promise<SendWeeklyBusinessDigestsResult> {
  const businesses = await prisma.business.findMany({ include: { currency: true } });

  const processedBusinessIds: string[] = [];

  for (const business of businesses) {
    const scoped = getTenantScopedClient(prisma, business.id);

    const enabled = await isFeatureEnabled(scoped, business.id, WEEKLY_DIGEST_FEATURE_FLAG_KEY);
    if (!enabled) continue;

    const digest = await computeWeeklyDigest(scoped, business.timezone, now);
    if (business.createdAt >= digest.weekEnd) continue;

    const alreadyProcessed = await scoped.auditLog.findFirst({
      where: {
        businessId: business.id,
        action: WEEKLY_DIGEST_PERIOD_PROCESSED_ACTION,
        entityType: WEEKLY_DIGEST_PERIOD_ENTITY_TYPE,
        entityId: digest.weekStart.toISOString(),
      },
    });
    if (alreadyProcessed) continue;

    if (!outboundGateway) continue;

    const message = buildWeeklyDigestMessage(digest, business.timezone, business.currencyCode, business.currency.minorUnitExp);
    const merchants = await scoped.merchant.findMany({ where: { businessId: business.id } });
    const gatewayDeps = { prisma, ...outboundGateway };
    const template = outboundGateway.weeklyDigestTemplate;
    const sendMethod = template ? "template" : "text";

    await recordAuditLog(scoped, {
      businessId: business.id,
      actorType: "SYSTEM",
      actorId: WEEKLY_DIGEST_JOB_NAME,
      action: WEEKLY_DIGEST_PERIOD_PROCESSED_ACTION,
      entityType: WEEKLY_DIGEST_PERIOD_ENTITY_TYPE,
      entityId: digest.weekStart.toISOString(),
      metadata: { weekEnd: digest.weekEnd.toISOString(), merchantCount: merchants.length },
    });
    processedBusinessIds.push(business.id);

    for (const merchant of merchants) {
      try {
        const attempts = await sendDigestWithRetry(() =>
          template
            ? sendWhatsAppTemplateMessage(gatewayDeps, {
                toPhoneNumber: merchant.phoneNumber,
                templateName: template.name,
                templateLanguageCode: template.languageCode,
                bodyParams: buildWeeklyDigestTemplateParams(
                  digest,
                  business.timezone,
                  business.currencyCode,
                  business.currency.minorUnitExp,
                ),
              })
            : sendWhatsAppTextMessage(gatewayDeps, { toPhoneNumber: merchant.phoneNumber, body: message }),
        );
        await recordAuditLog(scoped, {
          businessId: business.id,
          actorType: "SYSTEM",
          actorId: WEEKLY_DIGEST_JOB_NAME,
          action: "WEEKLY_DIGEST_SENT",
          entityType: "Merchant",
          entityId: merchant.id,
          metadata: { weekStart: digest.weekStart.toISOString(), weekEnd: digest.weekEnd.toISOString(), sendMethod, attempts },
        });
      } catch (error) {
        const attempts = error instanceof DigestSendFailedError ? error.attempts : 1;
        await recordAuditLog(scoped, {
          businessId: business.id,
          actorType: "SYSTEM",
          actorId: WEEKLY_DIGEST_JOB_NAME,
          action: "WEEKLY_DIGEST_SEND_FAILED",
          entityType: "Merchant",
          entityId: merchant.id,
          metadata: {
            weekStart: digest.weekStart.toISOString(),
            weekEnd: digest.weekEnd.toISOString(),
            sendMethod,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  return { processedBusinessIds };
}
