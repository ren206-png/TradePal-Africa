import type { PrismaClient, SupportCase, SupportCaseType, SupportOpenedBy, SupportParty } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import { StoreError } from "./common.js";

/**
 * Support cases (expansion Phase 4, section 10). Every case names who is responsible for sorting it out:
 *   delivery, product complaints and refunds: the SELLER (they are responsible for goods and fulfilment);
 *   a payment dispute: the PROVIDER when the money moved through one, otherwise the SELLER;
 *   anything else: the PLATFORM.
 * A platform admin can reassign. The notes are append-only.
 */
export function responsibleParty(type: SupportCaseType, moneyMovedThroughProvider: boolean): SupportParty {
  switch (type) {
    case "DELIVERY":
    case "PRODUCT_COMPLAINT":
    case "REFUND": return "SELLER";
    case "PAYMENT_DISPUTE": return moneyMovedThroughProvider ? "PROVIDER" : "SELLER";
    default: return "PLATFORM";
  }
}

export const PARTY_LABEL: Record<SupportParty, string> = { SELLER: "the seller", PLATFORM: "TradePal support", PROVIDER: "the payment provider" };

export async function openSupportCase(
  prisma: PrismaClient,
  input: { businessId: string; orderId?: string; type: SupportCaseType; openedBy: SupportOpenedBy; summary: string; contactName?: string; contactPhone?: string; authorId?: string },
): Promise<SupportCase> {
  const summary = input.summary.trim();
  if (summary.length < 10) throw new StoreError("INVALID", "Describe the problem in a sentence or two.");
  if (summary.length > 1_000) throw new StoreError("INVALID", "Please keep it under 1,000 characters.");
  const scoped = getTenantScopedClient(prisma, input.businessId);
  let provider = false;
  if (input.orderId) {
    if (!(await scoped.storeOrder.findUnique({ where: { id: input.orderId } }))) throw new StoreError("NOT_FOUND", "Order not found.");
    provider = (await scoped.storePayment.count({ where: { orderId: input.orderId, direction: "IN", evidence: { not: "MERCHANT_RECORDED" } } })) > 0;
  }
  const open = input.orderId ? await scoped.supportCase.count({ where: { orderId: input.orderId, status: { not: "CLOSED" } } }) : 0;
  if (open >= 5) throw new StoreError("DUPLICATE", "There are already several open reports on this order; the seller will respond.");
  const c = await scoped.supportCase.create({
    data: {
      businessId: input.businessId, orderId: input.orderId ?? null, type: input.type, handledBy: responsibleParty(input.type, provider), openedBy: input.openedBy, summary,
      contactName: input.contactName?.trim().slice(0, 80) ?? null, contactPhone: input.contactPhone ?? null,
    },
  });
  await scoped.supportCaseNote.create({ data: { businessId: input.businessId, caseId: c.id, authorType: input.openedBy === "CONSUMER" ? "CONSUMER" : input.openedBy === "SELLER" ? "SELLER" : "ADMIN", ...(input.authorId ? { authorId: input.authorId } : {}), body: summary } });
  return c;
}
