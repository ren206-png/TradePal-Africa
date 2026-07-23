import type { DeletionRequest, DeletionRequestorType } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { recordAuditLog } from "./auditLog.js";
import { sendWithRetry } from "./outboundSendRetry.js";
import {
  sendWhatsAppTemplateMessage,
  sendWhatsAppTextMessage,
  type OutboundGatewayDeps,
} from "../whatsapp/outboundGateway.js";

export class DeletionRequestNotFoundError extends Error {}
export class DeletionRequestAlreadyResolvedError extends Error {}

/**
 * Phase 18 gap closure: before this, a deletion request's resolution (via the
 * admin dashboard) was silent from the requesting business's point of view —
 * a merchant who filed a customer-deletion request (or had one filed on
 * their behalf) had no way to learn it was actioned short of asking support
 * directly. Every registered Merchant on the business is notified, mirroring
 * `businessDigest.ts`/`subscriptionExpiry.ts`'s existing "notify every
 * registered Merchant" recipient model rather than inventing a new one.
 *
 * Deliberately the full `OutboundGatewayDeps` (including `prisma`), not the
 * `Omit<OutboundGatewayDeps, "prisma">` shape `BusinessDigestOutboundGateway`/
 * `SubscriptionExpiryOutboundGateway` use: those two modules' entry points
 * already take a raw `PrismaClient` as their own first parameter (they sweep
 * every business), so they can assemble `{ prisma, ...outboundGateway }`
 * internally. `completeDeletionRequest`/`rejectDeletionRequest` intentionally
 * keep `scopedPrisma: TenantScopedClient` as their first parameter instead —
 * changing it to a raw `PrismaClient` would have meant re-deriving the tenant
 * scope from a businessId that isn't known until *after* the very lookup
 * that needs to be tenant-scoped in the first place (`loadPendingRequest`).
 * The caller (an admin route, which already has a raw `PrismaClient` in
 * scope to build the `TenantScopedClient` it passes in) simply supplies the
 * full deps object instead.
 *
 * Phase 20 gap closure: was text-only through Phase 18/19, unlike the lapse
 * notification (Phase 9) and weekly digest (Phase 18) sends, which both
 * already had a Meta-approved-template fallback — disclosed at the time as
 * an honest gap ("a resolution notification sent outside the merchant's
 * 24-hour WhatsApp service window can silently fail to deliver"). `
 * resolutionTemplate`, if supplied, must name a template already created and
 * approved for this WhatsApp Business phone number with exactly two body
 * placeholders: `{{1}}` (the outcome — `"completed"` or `"not approved"`)
 * and `{{2}}` (the resolution note, or a fixed fallback string when none was
 * given — see `buildDeletionResolutionTemplateParams` below for why neither
 * placeholder is ever sent empty). One template covers both COMPLETED and
 * REJECTED outcomes, distinguished only by `{{1}}`'s value, rather than
 * requiring two separately-approved templates. When omitted, resolution
 * notifications keep sending as free-form text exactly as they always have.
 */
export type DeletionResolutionOutboundGateway = OutboundGatewayDeps & {
  resolutionTemplate?: { name: string; languageCode: string };
};

export class DeletionNotificationSendFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
  }
}

/** Thin wrapper over the shared retry policy — see outboundSendRetry.ts's own doc comment
 * on why this per-feature wrapper exists (keeps `instanceof` checks feature-specific). */
function sendDeletionNotificationWithRetry(sendFn: () => Promise<void>): Promise<number> {
  return sendWithRetry(sendFn, (message, attempts) => new DeletionNotificationSendFailedError(message, attempts));
}

function buildDeletionResolutionMessage(status: "COMPLETED" | "REJECTED", resolutionNote: string | null): string {
  const noteLine = resolutionNote ? `\nNote: ${resolutionNote}` : "";
  return status === "COMPLETED"
    ? `Your data deletion request has been completed.${noteLine}`
    : `Your data deletion request was not approved.${noteLine}`;
}

/**
 * The template-send counterpart to `buildDeletionResolutionMessage` — see
 * `DeletionResolutionOutboundGateway`'s `resolutionTemplate` doc comment for
 * the exact two-placeholder contract this depends on. Neither param is ever
 * an empty string: Meta's template API rejects (or at best silently drops)
 * empty body parameters, so a missing resolution note is rendered as an
 * explicit "No additional note provided." rather than `""`, mirroring
 * `businessDigest.ts`'s own "no data to compare" fallback for the same
 * class of problem.
 */
function buildDeletionResolutionTemplateParams(status: "COMPLETED" | "REJECTED", resolutionNote: string | null): string[] {
  return [status === "COMPLETED" ? "completed" : "not approved", resolutionNote ?? "No additional note provided."];
}

/**
 * Sends the resolution notification to every registered Merchant on the
 * business, auditing a sent/failed row per merchant exactly like
 * `addStaffMerchant`'s own notification block — a send failure is audited,
 * never thrown, so a WhatsApp outage can never turn an already-committed
 * resolution into a reported error.
 */
async function notifyResolution(
  scopedPrisma: TenantScopedClient,
  request: DeletionRequest,
  status: "COMPLETED" | "REJECTED",
  outboundGateway: DeletionResolutionOutboundGateway,
): Promise<void> {
  const message = buildDeletionResolutionMessage(status, request.resolutionNote);
  const merchants = await scopedPrisma.merchant.findMany({ where: { businessId: request.businessId } });
  const sentAction = status === "COMPLETED" ? "DELETION_REQUEST_COMPLETION_NOTIFICATION_SENT" : "DELETION_REQUEST_REJECTION_NOTIFICATION_SENT";
  const failedAction = status === "COMPLETED" ? "DELETION_REQUEST_COMPLETION_NOTIFICATION_FAILED" : "DELETION_REQUEST_REJECTION_NOTIFICATION_FAILED";
  const template = outboundGateway.resolutionTemplate;
  const sendMethod = template ? "template" : "text";

  for (const merchant of merchants) {
    try {
      const attempts = await sendDeletionNotificationWithRetry(() =>
        template
          ? sendWhatsAppTemplateMessage(outboundGateway, {
              toPhoneNumber: merchant.phoneNumber,
              templateName: template.name,
              templateLanguageCode: template.languageCode,
              bodyParams: buildDeletionResolutionTemplateParams(status, request.resolutionNote),
            })
          : sendWhatsAppTextMessage(outboundGateway, { toPhoneNumber: merchant.phoneNumber, body: message }),
      );
      await recordAuditLog(scopedPrisma, {
        businessId: request.businessId,
        actorType: "SYSTEM",
        action: sentAction,
        entityType: "DeletionRequest",
        entityId: request.id,
        metadata: { merchantId: merchant.id, attempts, sendMethod },
      });
    } catch (error) {
      const attempts = error instanceof DeletionNotificationSendFailedError ? error.attempts : 1;
      await recordAuditLog(scopedPrisma, {
        businessId: request.businessId,
        actorType: "SYSTEM",
        action: failedAction,
        entityType: "DeletionRequest",
        entityId: request.id,
        metadata: { merchantId: merchant.id, attempts, sendMethod, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

/** Placeholder written over Customer.name once a deletion request is completed — never blank,
 * since a blank name reads as a data-integrity bug rather than an intentional redaction. */
const ANONYMIZED_CUSTOMER_NAME = "[deleted customer]";

export interface CreateDeletionRequestInput {
  businessId: string;
  customerId?: string;
  requestorType: DeletionRequestorType;
  description: string;
}

export async function createDeletionRequest(
  scopedPrisma: TenantScopedClient,
  input: CreateDeletionRequestInput,
): Promise<DeletionRequest> {
  const request = await scopedPrisma.deletionRequest.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId ?? null,
      requestorType: input.requestorType,
      description: input.description,
    },
  });

  await recordAuditLog(scopedPrisma, {
    businessId: input.businessId,
    actorType: "MERCHANT",
    action: "DELETION_REQUEST_CREATED",
    entityType: "DeletionRequest",
    entityId: request.id,
  });

  return request;
}

async function loadPendingRequest(scopedPrisma: TenantScopedClient, requestId: string): Promise<DeletionRequest> {
  const request = await scopedPrisma.deletionRequest.findUnique({ where: { id: requestId } });
  if (!request) {
    throw new DeletionRequestNotFoundError(`DeletionRequest ${requestId} not found.`);
  }
  if (request.status !== "PENDING") {
    throw new DeletionRequestAlreadyResolvedError(
      `DeletionRequest ${requestId} was already resolved as ${request.status}.`,
    );
  }
  return request;
}

/**
 * Resolves a pending deletion request by anonymizing the linked Customer
 * (see the DeletionRequest model docstring / Phase 0 KQ5): Transaction and
 * Debt rows are append-only and can never be deleted, so the compliant
 * action is destroying the identifying label (`Customer.name`) rather than
 * the financial history itself. A request with no linked customer (e.g. a
 * merchant-account-level request with nothing to anonymize) can still be
 * completed — it's just a no-op against Customer.
 */
export async function completeDeletionRequest(
  scopedPrisma: TenantScopedClient,
  requestId: string,
  resolutionNote?: string,
  /**
   * The AdminUser.id of the operator resolving this request, for
   * AuditLog.actorId — optional, exactly like changeMerchantPhoneNumber's
   * `changedByAdminUserId` (merchantIdentity.ts), so this stays callable from
   * a script/console/test without a real admin session. When provided,
   * attribution flips from "MERCHANT" to "ADMIN" (an admin dashboard resolved
   * it), mirroring that same function's conditional actorType.
   */
  resolvedByAdminUserId?: string,
  /** Phase 18 gap closure — see DeletionResolutionOutboundGateway's doc comment. Optional,
   * exactly like every other outboundGateway param in this codebase: when omitted (WhatsApp
   * send credentials not configured for this process), resolution still proceeds, it just
   * doesn't notify anyone. */
  outboundGateway?: DeletionResolutionOutboundGateway,
): Promise<DeletionRequest> {
  const request = await loadPendingRequest(scopedPrisma, requestId);

  if (request.customerId) {
    await scopedPrisma.customer.update({
      where: { id: request.customerId },
      data: { name: ANONYMIZED_CUSTOMER_NAME, isAnonymized: true },
    });
  }

  const resolved = await scopedPrisma.deletionRequest.update({
    where: { id: requestId },
    data: { status: "COMPLETED", resolutionNote: resolutionNote ?? null, resolvedAt: new Date() },
  });

  await recordAuditLog(scopedPrisma, {
    businessId: request.businessId,
    actorType: resolvedByAdminUserId ? "ADMIN" : "MERCHANT",
    ...(resolvedByAdminUserId ? { actorId: resolvedByAdminUserId } : {}),
    action: "DELETION_REQUEST_COMPLETED",
    entityType: "DeletionRequest",
    entityId: request.id,
    ...(request.customerId ? { metadata: { anonymizedCustomerId: request.customerId } } : {}),
  });

  if (outboundGateway) {
    await notifyResolution(scopedPrisma, resolved, "COMPLETED", outboundGateway);
  }

  return resolved;
}

export async function rejectDeletionRequest(
  scopedPrisma: TenantScopedClient,
  requestId: string,
  resolutionNote: string,
  /** See completeDeletionRequest's identical parameter doc comment above. */
  resolvedByAdminUserId?: string,
  /** See completeDeletionRequest's identical parameter doc comment above. */
  outboundGateway?: DeletionResolutionOutboundGateway,
): Promise<DeletionRequest> {
  const request = await loadPendingRequest(scopedPrisma, requestId);

  const resolved = await scopedPrisma.deletionRequest.update({
    where: { id: requestId },
    data: { status: "REJECTED", resolutionNote, resolvedAt: new Date() },
  });

  await recordAuditLog(scopedPrisma, {
    businessId: request.businessId,
    actorType: resolvedByAdminUserId ? "ADMIN" : "MERCHANT",
    ...(resolvedByAdminUserId ? { actorId: resolvedByAdminUserId } : {}),
    action: "DELETION_REQUEST_REJECTED",
    entityType: "DeletionRequest",
    entityId: request.id,
  });

  if (outboundGateway) {
    await notifyResolution(scopedPrisma, resolved, "REJECTED", outboundGateway);
  }

  return resolved;
}
