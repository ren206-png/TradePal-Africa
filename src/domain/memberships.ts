import type { Membership, Merchant, PrismaClient, Shop } from "@prisma/client";
import { membershipRoleForLegacyMerchantRole } from "../auth/permissions.js";

/**
 * Shops, memberships and the explicit "active organization/shop" (expansion Phase 1, decision P4).
 *
 * The legacy `Merchant` row (phone, OWNER/STAFF, removedAt) remains the source of truth for the WhatsApp
 * conversation and every existing flow; a `Membership` mirrors it (and can also exist on its own for a person who
 * belongs to several businesses). `syncMembershipFromMerchant` keeps the mirror current; `findMembershipDrift`
 * proves it. Nothing here changes how existing messages are routed.
 */
export const DEFAULT_SHOP_NAME = "Main shop";

/** E.164-style digits only: "+232 76 123456" and "23276123456" name the same person. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Returns the business's default shop, creating "Main shop" if the business has none yet. Idempotent. */
export async function ensureDefaultShop(prisma: PrismaClient, businessId: string): Promise<Shop> {
  const existing = await prisma.shop.findFirst({ where: { businessId, isDefault: true } });
  if (existing) return existing;
  try {
    return await prisma.shop.create({ data: { businessId, name: DEFAULT_SHOP_NAME, isDefault: true } });
  } catch (error) {
    // A concurrent caller created it first (unique index on the default shop): read theirs.
    const raced = await prisma.shop.findFirst({ where: { businessId, isDefault: true } });
    if (raced) return raced;
    throw error;
  }
}

/**
 * Mirrors a legacy merchant row into a membership: created on first sight, revoked when the merchant is removed,
 * re-activated when reactivated. A role someone was given manually is never downgraded by a sync.
 */
export async function syncMembershipFromMerchant(prisma: PrismaClient, merchant: Merchant): Promise<Membership> {
  const phoneNumber = normalizePhone(merchant.phoneNumber);
  const shop = await ensureDefaultShop(prisma, merchant.businessId);
  const status = merchant.removedAt ? "REVOKED" : "ACTIVE";
  const revokedAt = merchant.removedAt ?? null;

  const existing = await prisma.membership.findUnique({
    where: { businessId_phoneNumber: { businessId: merchant.businessId, phoneNumber } },
  });
  if (!existing) {
    return prisma.membership.create({
      data: {
        businessId: merchant.businessId,
        shopId: shop.id,
        phoneNumber,
        role: membershipRoleForLegacyMerchantRole(merchant.role),
        status,
        revokedAt,
      },
    });
  }
  return prisma.membership.update({ where: { id: existing.id }, data: { status, revokedAt } });
}

/** Changes the phone number a membership is keyed on (a merchant changed number); keeps history by updating in place. */
export async function renameMembershipPhone(
  prisma: PrismaClient,
  businessId: string,
  oldPhone: string,
  newPhone: string,
): Promise<void> {
  await prisma.membership.updateMany({
    where: { businessId, phoneNumber: normalizePhone(oldPhone) },
    data: { phoneNumber: normalizePhone(newPhone) },
  });
}

export async function listActiveMemberships(prisma: PrismaClient, phone: string) {
  return prisma.membership.findMany({
    where: { phoneNumber: normalizePhone(phone), status: "ACTIVE" },
    include: { business: { select: { id: true, name: true, status: true } }, shop: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export type ActiveContextResolution =
  | { kind: "none" }
  | { kind: "resolved"; businessId: string; shopId: string | null; how: "only_membership" | "explicit_selection" }
  | { kind: "ambiguous"; options: Array<{ businessId: string; businessName: string; shopId: string | null; shopName: string | null }> };

/**
 * Which business/shop is this person acting in? With one active membership the answer is that one. With several it is
 * the explicit selection they made, if it is still a valid active membership, otherwise "ambiguous": the caller must ask
 * the person (never guess from the number or the last conversation).
 */
export async function resolveActiveContext(prisma: PrismaClient, phone: string): Promise<ActiveContextResolution> {
  const memberships = await listActiveMemberships(prisma, phone);
  if (memberships.length === 0) return { kind: "none" };

  const only = memberships.length === 1 ? memberships[0] : undefined;
  if (only) return { kind: "resolved", businessId: only.businessId, shopId: only.shopId, how: "only_membership" };

  const selected = await prisma.activeContext.findUnique({ where: { phoneNumber: normalizePhone(phone) } });
  const valid = selected
    ? memberships.find((m) => m.businessId === selected.businessId && (m.shopId === null || m.shopId === selected.shopId || selected.shopId === null))
    : undefined;
  if (selected && valid) {
    return { kind: "resolved", businessId: selected.businessId, shopId: selected.shopId, how: "explicit_selection" };
  }
  return {
    kind: "ambiguous",
    options: memberships.map((m) => ({
      businessId: m.businessId,
      businessName: m.business.name,
      shopId: m.shopId,
      shopName: m.shop?.name ?? null,
    })),
  };
}

export class NotAMemberError extends Error {}

/** Records the person's explicit choice. Refuses unless they hold an active membership in that business (and shop). */
export async function setActiveContext(prisma: PrismaClient, phone: string, businessId: string, shopId: string | null = null): Promise<void> {
  const phoneNumber = normalizePhone(phone);
  const membership = await prisma.membership.findUnique({ where: { businessId_phoneNumber: { businessId, phoneNumber } } });
  if (!membership || membership.status !== "ACTIVE") throw new NotAMemberError(`No active membership for this number in business ${businessId}.`);
  if (shopId && membership.shopId && membership.shopId !== shopId) throw new NotAMemberError("That membership is limited to a different shop.");
  if (shopId) {
    const shop = await prisma.shop.findFirst({ where: { id: shopId, businessId } });
    if (!shop) throw new NotAMemberError("That shop does not belong to the business.");
  }
  await prisma.activeContext.upsert({
    where: { phoneNumber },
    update: { businessId, shopId },
    create: { phoneNumber, businessId, shopId },
  });
}

export interface MembershipDrift {
  merchantsWithoutMembership: string[];
  mismatchedStatus: string[];
  businessesWithoutDefaultShop: string[];
}

/** Read-only consistency check between legacy merchants and memberships/shops (used by tests and the admin health view). */
export async function findMembershipDrift(prisma: PrismaClient): Promise<MembershipDrift> {
  const merchants = await prisma.merchant.findMany({ select: { id: true, businessId: true, phoneNumber: true, removedAt: true } });
  const memberships = await prisma.membership.findMany({ select: { businessId: true, phoneNumber: true, status: true } });
  const byKey = new Map(memberships.map((m) => [`${m.businessId}|${m.phoneNumber}`, m]));

  const merchantsWithoutMembership: string[] = [];
  const mismatchedStatus: string[] = [];
  for (const m of merchants) {
    const membership = byKey.get(`${m.businessId}|${normalizePhone(m.phoneNumber)}`);
    if (!membership) merchantsWithoutMembership.push(m.id);
    else if ((membership.status === "REVOKED") !== (m.removedAt !== null)) mismatchedStatus.push(m.id);
  }

  const businesses = await prisma.business.findMany({ select: { id: true, shops: { where: { isDefault: true }, select: { id: true } } } });
  const businessesWithoutDefaultShop = businesses.filter((b) => b.shops.length === 0).map((b) => b.id);
  return { merchantsWithoutMembership, mismatchedStatus, businessesWithoutDefaultShop };
}
