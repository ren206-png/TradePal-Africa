import type { Merchant, PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { recordAuditLog } from "./auditLog.js";
import { getEffectivePlan } from "./billing.js";
import { sendWithRetry } from "./outboundSendRetry.js";
import {
  sendWhatsAppTemplateMessage,
  sendWhatsAppTextMessage,
  type OutboundGatewayDeps,
} from "../whatsapp/outboundGateway.js";

export class PhoneNumberAlreadyRegisteredError extends Error {}
export class MerchantNotFoundError extends Error {}
export class CannotRemoveOwnerError extends Error {}
export class MerchantAlreadyRemovedError extends Error {}

export class StaffCapExceededError extends Error {
  constructor(
    public readonly capCount: number,
    public readonly currentStaffCount: number,
  ) {
    super(
      `Staff limit reached: ${currentStaffCount}/${capCount} staff account(s) already active on this business's plan.`,
    );
  }
}

export class StaffNotificationSendFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
  }
}

export interface ChangeMerchantPhoneNumberInput {
  merchantId: string;
  businessId: string;
  newPhoneNumber: string;
  /**
   * Mandatory rather than optional: per Phase 0 KQ6, a WhatsApp-number change
   * (SIM swap, lost phone, etc.) is human-support-assisted, not a self-serve
   * WhatsApp command — this is never called from commandRouter.ts, only from
   * an operator-facing surface (Phase 2 admin dashboard), and a reason string
   * is the paper trail that it actually went through a human.
   */
  reason: string;
  /** The AdminUser.id of the operator performing this change, for AuditLog.actorId — optional
   * only so this function stays callable from a script/console without a real admin session. */
  changedByAdminUserId?: string;
}

/**
 * Re-points a merchant's identity (KQ6: WhatsApp number = merchant identity)
 * to a new phone number. `Merchant.phoneNumber` is `@unique` globally, not
 * per-business, so the availability check below must run on the unscoped
 * `prisma` client — a business-scoped client would only ever see merchants
 * inside its own tenant and could miss a collision with a different
 * business's merchant. The actual update still goes through
 * `getTenantScopedClient`, mirroring the split already used in
 * onboardingFlow.ts.
 */
export async function changeMerchantPhoneNumber(
  prisma: PrismaClient,
  input: ChangeMerchantPhoneNumberInput,
): Promise<Merchant> {
  if (!input.reason.trim()) {
    throw new Error("changeMerchantPhoneNumber requires a non-empty reason (KQ6: human-support-assisted only).");
  }

  const collision = await prisma.merchant.findUnique({ where: { phoneNumber: input.newPhoneNumber } });
  if (collision && collision.id !== input.merchantId) {
    throw new PhoneNumberAlreadyRegisteredError(
      `Phone number ${input.newPhoneNumber} is already registered to another merchant.`,
    );
  }

  const scoped = getTenantScopedClient(prisma, input.businessId);
  const merchant = await scoped.merchant.findUnique({ where: { id: input.merchantId } });
  if (!merchant) {
    throw new MerchantNotFoundError(`Merchant ${input.merchantId} not found in business ${input.businessId}.`);
  }

  const previousPhoneNumber = merchant.phoneNumber;
  const updated = await scoped.merchant.update({
    where: { id: input.merchantId },
    data: { phoneNumber: input.newPhoneNumber },
  });

  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "ADMIN",
    ...(input.changedByAdminUserId ? { actorId: input.changedByAdminUserId } : {}),
    action: "MERCHANT_PHONE_NUMBER_CHANGED",
    entityType: "Merchant",
    entityId: merchant.id,
    metadata: { reason: input.reason, previousPhoneNumber, newPhoneNumber: input.newPhoneNumber },
  });

  return updated;
}

export interface AddStaffMerchantInput {
  businessId: string;
  /** Digits-only WhatsApp number (same convention as onboardingFlow.ts's phoneNumber), not including a leading "+". */
  phoneNumber: string;
  /** The Merchant.id of the OWNER issuing the invite, for AuditLog.actorId. */
  invitedByMerchantId: string;
}

/**
 * Phase 14: optional dep so addStaffMerchant stays callable exactly as
 * before (tests, or any process without WhatsApp send credentials
 * configured) without a proactive notification — mirrors every other
 * optional-outboundGateway call site in this codebase (subscriptionExpiry.ts,
 * businessDigest.ts).
 *
 * Phase 21 gap closure: was text-only through Phase 20, unlike the other
 * three proactive sends in this codebase (subscription-lapse, weekly digest,
 * deletion-resolution), which all already had a Meta-approved-template
 * fallback for delivery outside the recipient's 24-hour WhatsApp service
 * window. `staffAddedTemplate`, if supplied, must name a template already
 * created and approved for this WhatsApp Business phone number — the
 * message itself carries no per-invite dynamic data (no name, no business
 * name is fetched here), so unlike the other three templates this one needs
 * no body placeholders at all. When omitted, the notification keeps sending
 * as free-form text exactly as it always has.
 */
export type AddStaffMerchantOutboundGateway = Omit<OutboundGatewayDeps, "prisma"> & {
  staffAddedTemplate?: { name: string; languageCode: string };
};

function sendStaffAddedNotificationWithRetry(sendFn: () => Promise<void>): Promise<number> {
  return sendWithRetry(sendFn, (message, attempts) => new StaffNotificationSendFailedError(message, attempts));
}

function buildStaffAddedNotificationMessage(): string {
  return (
    "You've been added as staff on a TradePal business account. " +
    "Message this WhatsApp number to finish setup — you'll be asked to accept the terms first."
  );
}

/**
 * Phase 13 (multi-staff support, KQ6): provisions a new STAFF Merchant row on
 * an already-existing business, via the `/addstaff` command (commandRouter.ts).
 * This deliberately bypasses two steps of the normal onboarding flow
 * (Business creation and AWAITING_BUSINESS_NAME) since this business already
 * exists and already has a name — but it does NOT bypass consent: the new row
 * is created with onboardingStep `AWAITING_CONSENT` (not `COMPLETE`), so the
 * very next inbound WhatsApp message from this phone number walks it through
 * the same ONBOARDING_TERMS_TEXT / ConsentLog capture that a brand-new
 * merchant gets (see onboardingFlow.ts's `continueOnboarding` /
 * `handleAwaitingConsent`). Reusing this existing OnboardingStep value (rather
 * than introducing a new one, e.g. some AWAITING_STAFF_CONSENT) means this
 * feature needs zero schema migration.
 *
 * `Merchant.phoneNumber` is `@unique` globally, not per-business (KQ6), so the
 * availability check below must run on the unscoped `prisma` client, exactly
 * like `changeMerchantPhoneNumber` above — a business-scoped client would only
 * ever see merchants inside its own tenant and could miss a collision with a
 * different business's merchant (including, notably, this same phone number
 * already being someone else's OWNER, or already staff, elsewhere).
 *
 * Phase 14 gap closures (both disclosed in Phase 13):
 *  - a staff-count cap: if the business's currently-effective Plan
 *    (getEffectivePlan, billing.ts) has a non-null `staffCapCount`, this
 *    counts existing *active* (removedAt: null) STAFF rows and refuses to
 *    add another once the cap is reached. The OWNER row is never counted.
 *    Checked after the phone-collision check (a doomed request should fail
 *    for the more specific reason first) but before creating the row.
 *  - a proactive WhatsApp notification to the new staff member themselves,
 *    once the row exists (so Standard #9's registered-merchant send guard
 *    passes) — previously the OWNER had to manually forward the news.
 *    `outboundGateway` is optional and best-effort: a send failure is
 *    audited (STAFF_MERCHANT_ADD_NOTIFICATION_FAILED) but never thrown, so
 *    a WhatsApp outage can never turn a successful /addstaff into a
 *    reported failure — the staff row itself is already committed by then.
 *
 * Phase 17 gap closure (disclosed in Phase 14): reactivates a previously
 * `/removestaff`-removed number for the *same* business instead of always
 * refusing. Before this, the unscoped collision check below found the old
 * (removed) row and threw PhoneNumberAlreadyRegisteredError unconditionally
 * — a removed staff member could never rejoin without a human-support
 * phone-number-change workaround, even though the OWNER re-inviting the
 * same number for the same business is an entirely reasonable, common case.
 * A collision on a number that's removed but belongs to a *different*
 * business (or one that's still active anywhere) still refuses exactly as
 * before — reactivation only ever applies to "this business's own,
 * previously-removed staff row." Reactivation clears `removedAt`, resets
 * `onboardingStep` back to `AWAITING_CONSENT` (fresh consent capture, same
 * as brand-new staff — the old ConsentLog history stays but doesn't imply
 * ongoing consent), and re-applies the same staff-cap check a brand-new add
 * would face, since a removed slot doesn't pre-reserve cap headroom.
 */
export async function addStaffMerchant(
  prisma: PrismaClient,
  input: AddStaffMerchantInput,
  outboundGateway?: AddStaffMerchantOutboundGateway,
): Promise<Merchant> {
  const collision = await prisma.merchant.findUnique({ where: { phoneNumber: input.phoneNumber } });
  const reactivating = collision !== null && collision.businessId === input.businessId && collision.removedAt !== null;
  if (collision && !reactivating) {
    throw new PhoneNumberAlreadyRegisteredError(
      `Phone number ${input.phoneNumber} is already registered to another merchant.`,
    );
  }

  const scoped = getTenantScopedClient(prisma, input.businessId);

  const plan = await getEffectivePlan(scoped, input.businessId);
  if (plan.staffCapCount !== null) {
    const currentStaffCount = await scoped.merchant.count({
      where: { businessId: input.businessId, role: "STAFF", removedAt: null },
    });
    if (currentStaffCount >= plan.staffCapCount) {
      throw new StaffCapExceededError(plan.staffCapCount, currentStaffCount);
    }
  }

  const staff = reactivating
    ? await scoped.merchant.update({
        where: { id: collision.id },
        data: { removedAt: null, onboardingStep: "AWAITING_CONSENT" },
      })
    : await scoped.merchant.create({
        data: {
          businessId: input.businessId,
          phoneNumber: input.phoneNumber,
          role: "STAFF",
          onboardingStep: "AWAITING_CONSENT",
        },
      });

  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "MERCHANT",
    actorId: input.invitedByMerchantId,
    action: reactivating ? "STAFF_MERCHANT_REACTIVATED" : "STAFF_MERCHANT_ADDED",
    entityType: "Merchant",
    entityId: staff.id,
    metadata: { phoneNumber: input.phoneNumber },
  });

  if (outboundGateway) {
    const gatewayDeps = { prisma, ...outboundGateway };
    const template = outboundGateway.staffAddedTemplate;
    const sendMethod = template ? "template" : "text";
    try {
      const attempts = await sendStaffAddedNotificationWithRetry(() =>
        template
          ? sendWhatsAppTemplateMessage(gatewayDeps, {
              toPhoneNumber: staff.phoneNumber,
              templateName: template.name,
              templateLanguageCode: template.languageCode,
            })
          : sendWhatsAppTextMessage(gatewayDeps, {
              toPhoneNumber: staff.phoneNumber,
              body: buildStaffAddedNotificationMessage(),
            }),
      );
      await recordAuditLog(scoped, {
        businessId: input.businessId,
        actorType: "SYSTEM",
        actorId: input.invitedByMerchantId,
        action: "STAFF_MERCHANT_ADD_NOTIFICATION_SENT",
        entityType: "Merchant",
        entityId: staff.id,
        metadata: { attempts, sendMethod },
      });
    } catch (error) {
      const attempts = error instanceof StaffNotificationSendFailedError ? error.attempts : 1;
      await recordAuditLog(scoped, {
        businessId: input.businessId,
        actorType: "SYSTEM",
        actorId: input.invitedByMerchantId,
        action: "STAFF_MERCHANT_ADD_NOTIFICATION_FAILED",
        entityType: "Merchant",
        entityId: staff.id,
        metadata: { attempts, sendMethod, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return staff;
}

export interface RemoveStaffMerchantInput {
  businessId: string;
  /** Digits-only WhatsApp number identifying the staff Merchant to remove — same lookup convention as /addstaff's input. */
  phoneNumber: string;
  /** The Merchant.id of the OWNER issuing the removal, for AuditLog.actorId. */
  removedByMerchantId: string;
}

/**
 * Phase 14 gap closure (disclosed in Phase 13): the counterpart to
 * addStaffMerchant. Soft-deactivates a STAFF Merchant row by setting
 * `removedAt` rather than deleting it — preserves AuditLog/ConsentLog
 * history and keeps the row around for any FK referencing it (see the
 * `removedAt` doc comment on the Merchant model in prisma/schema.prisma).
 * The OWNER row can never be removed this way (CannotRemoveOwnerError) —
 * there is deliberately no self-serve way to remove the one merchant every
 * other business operation (including this one) is gated by.
 *
 * Once `removedAt` is set, messageDispatcher.ts's own gate (added alongside
 * this function) refuses that phone number's inbound WhatsApp traffic
 * entirely, independent of anything else in this function.
 *
 * Phase 17 update: a removed phone number CAN return via a brand-new
 * `/addstaff` call for the *same* business — see the reactivation branch in
 * `addStaffMerchant` above, which was the disclosed gap this comment used to
 * describe. Reusing the number for a *different* business (or while it's
 * still active anywhere) still requires a human/support-assisted
 * phone-number change, same as any other phone-number collision.
 */
export async function removeStaffMerchant(prisma: PrismaClient, input: RemoveStaffMerchantInput): Promise<Merchant> {
  const scoped = getTenantScopedClient(prisma, input.businessId);

  const merchant = await scoped.merchant.findFirst({
    where: { businessId: input.businessId, phoneNumber: input.phoneNumber },
  });
  if (!merchant) {
    throw new MerchantNotFoundError(
      `No merchant with phone number ${input.phoneNumber} found in business ${input.businessId}.`,
    );
  }
  if (merchant.role === "OWNER") {
    throw new CannotRemoveOwnerError("The business owner cannot be removed via /removestaff.");
  }
  if (merchant.removedAt) {
    throw new MerchantAlreadyRemovedError(`${input.phoneNumber} has already been removed from this business.`);
  }

  const updated = await scoped.merchant.update({
    where: { id: merchant.id },
    data: { removedAt: new Date() },
  });

  await recordAuditLog(scoped, {
    businessId: input.businessId,
    actorType: "MERCHANT",
    actorId: input.removedByMerchantId,
    action: "STAFF_MERCHANT_REMOVED",
    entityType: "Merchant",
    entityId: merchant.id,
    metadata: { phoneNumber: merchant.phoneNumber },
  });

  return updated;
}
