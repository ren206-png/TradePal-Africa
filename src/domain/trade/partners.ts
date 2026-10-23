import type { BusinessLink, PrismaClient, TradePartner, TradePartnerRole } from "@prisma/client";
import { getTenantScopedClient, type TenantScopedClient } from "../../db/tenantScope.js";
import { normalizeKey } from "../catalog.js";
import { resolvePrice, PriceError, type ResolvedPrice } from "../pricing.js";
import { TradeError, newToken, sha256 } from "./common.js";

/**
 * Trade counterparties, explicit reversible links between two businesses, and the wholesale price lists a seller shares
 * with a linked buyer. Linking shares NOTHING by itself: only a shared price list (published fields) and the documents
 * both sides take part in are ever visible to the other business.
 */
const LINK_TTL_DAYS = 7;

export interface CreatePartnerInput {
  businessId: string;
  name: string;
  role?: TradePartnerRole;
  phone?: string;
  paymentTermsDays?: number;
  creditLimitMinor?: bigint;
  blockWhenOverdueDays?: number;
  note?: string;
}

export async function createPartner(scoped: TenantScopedClient, input: CreatePartnerInput): Promise<TradePartner> {
  const name = input.name.trim();
  if (!name) throw new TradeError("INVALID", "A trade partner needs a name.");
  const normalizedName = normalizeKey(name);
  if (await scoped.tradePartner.findFirst({ where: { normalizedName } })) throw new TradeError("DUPLICATE", `You already have a partner called '${name}'.`);
  return scoped.tradePartner.create({
    data: {
      businessId: input.businessId, name, normalizedName, role: input.role ?? "SUPPLIER", phone: input.phone ?? null,
      paymentTermsDays: input.paymentTermsDays ?? null, creditLimitMinor: input.creditLimitMinor ?? null,
      blockWhenOverdueDays: input.blockWhenOverdueDays ?? null, note: input.note ?? null,
    },
  });
}

/** Credit limits and overdue rules are set by an authorized merchant user (the caller checks the permission). TradePal does not score. */
export async function setPartnerTerms(
  scoped: TenantScopedClient,
  partnerId: string,
  terms: { paymentTermsDays?: number | null; creditLimitMinor?: bigint | null; blockWhenOverdueDays?: number | null },
): Promise<TradePartner> {
  if (!(await scoped.tradePartner.findUnique({ where: { id: partnerId } }))) throw new TradeError("NOT_FOUND", "Partner not found.");
  return scoped.tradePartner.update({ where: { id: partnerId }, data: { ...terms } });
}

export async function listPartners(scoped: TenantScopedClient): Promise<TradePartner[]> {
  return scoped.tradePartner.findMany({ orderBy: { name: "asc" } });
}

// ---------------------------------------------------------------------------------------- linking

const inverseRole = (r: TradePartnerRole): TradePartnerRole => (r === "SUPPLIER" ? "CUSTOMER" : r === "CUSTOMER" ? "SUPPLIER" : "BOTH");

/** Starts a link to a partner. The returned one-time token is for the inviter to pass to the partner themselves. */
export async function inviteLink(
  prisma: PrismaClient,
  input: { inviterBusinessId: string; partnerId: string; createdBy?: string; now?: Date },
): Promise<{ link: BusinessLink; token: string }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.inviterBusinessId);
  const partner = await scoped.tradePartner.findUnique({ where: { id: input.partnerId } });
  if (!partner) throw new TradeError("NOT_FOUND", "Partner not found.");
  if (partner.linkStatus === "LINKED" || partner.linkStatus === "INVITED") throw new TradeError("DUPLICATE", `This partner is already ${partner.linkStatus.toLowerCase()}.`);
  const token = newToken();
  const link = await prisma.$transaction(async (tx) => {
    const created = await tx.businessLink.create({
      data: {
        inviterBusinessId: input.inviterBusinessId, inviterPartnerId: partner.id, tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000), createdBy: input.createdBy ?? null,
      },
    });
    await tx.tradePartner.updateMany({ where: { id: partner.id, businessId: input.inviterBusinessId }, data: { linkStatus: "INVITED", linkId: created.id } });
    return created;
  });
  return { link, token };
}

/**
 * The invited business accepts with the token it was handed. It gets its own partner record for the inviter (a new
 * one, or an existing partner of its own that it names), and the link becomes ACTIVE on both sides.
 */
export async function acceptLink(
  prisma: PrismaClient,
  input: { inviteeBusinessId: string; token: string; acceptedBy?: string; existingPartnerId?: string; now?: Date },
): Promise<BusinessLink> {
  const now = input.now ?? new Date();
  const link = await prisma.businessLink.findUnique({ where: { tokenHash: sha256(input.token) } });
  if (!link) throw new TradeError("NOT_FOUND", "That invitation is not valid.");
  if (link.status !== "INVITED") throw new TradeError("WRONG_STATE", `This invitation is ${link.status.toLowerCase()}.`);
  if (link.expiresAt <= now) throw new TradeError("EXPIRED", "This invitation has expired. Ask for a new one.");
  if (link.inviterBusinessId === input.inviteeBusinessId) throw new TradeError("FORBIDDEN_PARTY", "You cannot accept your own invitation.");
  const existingActive = await prisma.businessLink.findFirst({
    where: {
      status: "ACTIVE",
      OR: [
        { inviterBusinessId: link.inviterBusinessId, inviteeBusinessId: input.inviteeBusinessId },
        { inviterBusinessId: input.inviteeBusinessId, inviteeBusinessId: link.inviterBusinessId },
      ],
    },
  });
  if (existingActive) throw new TradeError("DUPLICATE", "These two businesses are already linked.");

  return prisma.$transaction(async (tx) => {
    const inviterBusiness = await tx.business.findUniqueOrThrow({ where: { id: link.inviterBusinessId }, select: { name: true } });
    const inviterPartner = await tx.tradePartner.findFirstOrThrow({ where: { id: link.inviterPartnerId, businessId: link.inviterBusinessId } });
    let inviteePartnerId = input.existingPartnerId;
    if (inviteePartnerId) {
      const own = await tx.tradePartner.findFirst({ where: { id: inviteePartnerId, businessId: input.inviteeBusinessId } });
      if (!own) throw new TradeError("NOT_FOUND", "That partner is not in your records.");
      if (own.linkStatus === "LINKED" || own.linkStatus === "INVITED") throw new TradeError("DUPLICATE", "That partner is already linked to someone.");
    } else {
      let name = inviterBusiness.name;
      let n = 1;
      while (await tx.tradePartner.findFirst({ where: { businessId: input.inviteeBusinessId, normalizedName: normalizeKey(name) } })) name = `${inviterBusiness.name} (${++n})`;
      inviteePartnerId = (
        await tx.tradePartner.create({
          data: { businessId: input.inviteeBusinessId, name, normalizedName: normalizeKey(name), role: inverseRole(inviterPartner.role) },
        })
      ).id;
    }
    await tx.tradePartner.updateMany({
      where: { id: inviteePartnerId, businessId: input.inviteeBusinessId },
      data: { linkStatus: "LINKED", linkedBusinessId: link.inviterBusinessId, linkId: link.id },
    });
    await tx.tradePartner.updateMany({
      where: { id: link.inviterPartnerId, businessId: link.inviterBusinessId },
      data: { linkStatus: "LINKED", linkedBusinessId: input.inviteeBusinessId, linkId: link.id },
    });
    return tx.businessLink.update({
      where: { id: link.id },
      data: { status: "ACTIVE", inviteeBusinessId: input.inviteeBusinessId, inviteePartnerId, acceptedBy: input.acceptedBy ?? null, acceptedAt: now },
    });
  });
}

/** Either party can end a link. New orders stop; documents already agreed stay visible to both. Shared price lists stop being shared. */
export async function revokeLink(prisma: PrismaClient, input: { businessId: string; linkId: string; by?: string; now?: Date }): Promise<BusinessLink> {
  const now = input.now ?? new Date();
  const link = await prisma.businessLink.findUnique({ where: { id: input.linkId } });
  if (!link || (link.inviterBusinessId !== input.businessId && link.inviteeBusinessId !== input.businessId)) throw new TradeError("NOT_FOUND", "Link not found.");
  if (link.status === "REVOKED") return link;
  return prisma.$transaction(async (tx) => {
    for (const [partnerId, businessId] of [[link.inviterPartnerId, link.inviterBusinessId], [link.inviteePartnerId, link.inviteeBusinessId]] as const) {
      if (partnerId && businessId) await tx.tradePartner.updateMany({ where: { id: partnerId, businessId }, data: { linkStatus: "REVOKED" } });
    }
    await tx.priceListShare.updateMany({ where: { linkId: link.id, revokedAt: null }, data: { revokedAt: now } });
    return tx.businessLink.update({ where: { id: link.id }, data: { status: "REVOKED", revokedAt: now, revokedBy: input.by ?? null } });
  });
}

export interface ActiveLink {
  link: BusinessLink;
  /** The other business. */
  counterpartBusinessId: string;
  /** This business's partner row for the other party, and the other party's partner row for this business. */
  ownPartnerId: string;
  counterpartPartnerId: string;
}

export async function getActiveLink(prisma: PrismaClient, businessId: string, partnerId: string): Promise<ActiveLink> {
  const partner = await prisma.tradePartner.findFirst({ where: { id: partnerId, businessId } });
  if (!partner) throw new TradeError("NOT_FOUND", "Partner not found.");
  if (partner.linkStatus === "REVOKED") throw new TradeError("LINK_REVOKED", "The link with this partner has been ended.");
  if (partner.linkStatus !== "LINKED" || !partner.linkId) throw new TradeError("NOT_LINKED", "This partner is not linked to a TradePal business.");
  const link = await prisma.businessLink.findUniqueOrThrow({ where: { id: partner.linkId } });
  if (link.status !== "ACTIVE") throw new TradeError("LINK_REVOKED", "The link with this partner is not active.");
  const iAmInviter = link.inviterBusinessId === businessId;
  const counterpartBusinessId = iAmInviter ? link.inviteeBusinessId : link.inviterBusinessId;
  const counterpartPartnerId = iAmInviter ? link.inviteePartnerId : link.inviterPartnerId;
  if (!counterpartBusinessId || !counterpartPartnerId) throw new TradeError("NOT_LINKED", "The link is incomplete.");
  return { link, counterpartBusinessId, ownPartnerId: partner.id, counterpartPartnerId };
}

// -------------------------------------------------------------------------------- shared price lists

/** A seller shares one of its WHOLESALE price lists with a linked buyer. */
export async function shareWholesaleList(prisma: PrismaClient, input: { businessId: string; priceListId: string; linkId: string }) {
  const link = await prisma.businessLink.findUnique({ where: { id: input.linkId } });
  if (!link || link.status !== "ACTIVE" || (link.inviterBusinessId !== input.businessId && link.inviteeBusinessId !== input.businessId)) {
    throw new TradeError("NOT_LINKED", "There is no active link to share through.");
  }
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const list = await scoped.priceList.findUnique({ where: { id: input.priceListId } });
  if (!list) throw new TradeError("NOT_FOUND", "Price list not found.");
  if (list.kind !== "WHOLESALE") throw new TradeError("INVALID", "Only a wholesale price list can be shared with a trade partner.");
  if (list.status !== "ACTIVE") throw new TradeError("INVALID", "That price list is not active.");
  const existing = await scoped.priceListShare.findFirst({ where: { priceListId: list.id, linkId: link.id } });
  if (existing) return existing.revokedAt ? scoped.priceListShare.update({ where: { id: existing.id }, data: { revokedAt: null } }) : existing;
  return scoped.priceListShare.create({ data: { businessId: input.businessId, priceListId: list.id, linkId: link.id } });
}

export async function unshareWholesaleList(prisma: PrismaClient, input: { businessId: string; priceListId: string; linkId: string; now?: Date }) {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const share = await scoped.priceListShare.findFirst({ where: { priceListId: input.priceListId, linkId: input.linkId, revokedAt: null } });
  if (!share) return false;
  await scoped.priceListShare.update({ where: { id: share.id }, data: { revokedAt: input.now ?? new Date() } });
  return true;
}

export interface SharedCatalogItem {
  sellerVariantId: string;
  sku: string;
  productName: string;
  variantName: string;
  baseUnit: string;
  packs: { name: string; baseQuantity: number }[];
  priceListId: string;
  priceListName: string;
  currencyCode: string;
  prices: { unit: string; minQuantity: number; unitPriceMinor: string; validFrom: Date | null; validTo: Date | null }[];
}

async function sellerOfLinkFor(prisma: PrismaClient, buyerBusinessId: string, linkId: string): Promise<string> {
  const link = await prisma.businessLink.findUnique({ where: { id: linkId } });
  if (!link || link.status !== "ACTIVE" || (link.inviterBusinessId !== buyerBusinessId && link.inviteeBusinessId !== buyerBusinessId)) {
    throw new TradeError("NOT_LINKED", "There is no active link with this partner.");
  }
  const seller = link.inviterBusinessId === buyerBusinessId ? link.inviteeBusinessId : link.inviterBusinessId;
  if (!seller) throw new TradeError("NOT_LINKED", "The link is incomplete.");
  return seller;
}

/**
 * What a linked supplier has chosen to show a buyer: PUBLISHED variants on shared wholesale lists, with pack sizes and
 * price breaks. This projection is the ONLY thing read across businesses and it contains no cost, margin, stock level,
 * private price list, customer or note.
 */
export async function getSharedCatalog(prisma: PrismaClient, input: { buyerBusinessId: string; linkId: string; at?: Date }): Promise<SharedCatalogItem[]> {
  const at = input.at ?? new Date();
  const sellerId = await sellerOfLinkFor(prisma, input.buyerBusinessId, input.linkId);
  const seller = getTenantScopedClient(prisma, sellerId);
  const shares = await seller.priceListShare.findMany({ where: { linkId: input.linkId, revokedAt: null }, include: { priceList: true } });
  const items: SharedCatalogItem[] = [];
  for (const share of shares) {
    const list = share.priceList;
    if (list.status !== "ACTIVE" || (list.validFrom && list.validFrom > at) || (list.validTo && list.validTo <= at)) continue;
    const rules = await seller.priceRule.findMany({ where: { priceListId: list.id, status: "ACTIVE" }, include: { packConversion: true } });
    const byVariant = new Map<string, typeof rules>();
    for (const r of rules) {
      if ((r.validFrom && r.validFrom > at) || (r.validTo && r.validTo <= at)) continue;
      byVariant.set(r.variantId, [...(byVariant.get(r.variantId) ?? []), r]);
    }
    for (const [variantId, vr] of byVariant) {
      const variant = await seller.productVariant.findUnique({ where: { id: variantId }, include: { product: true, packs: true } });
      if (!variant || variant.status !== "PUBLISHED") continue;
      items.push({
        sellerVariantId: variant.id, sku: variant.sku, productName: variant.product.name, variantName: variant.name, baseUnit: variant.baseUnit,
        packs: variant.packs.map((p) => ({ name: p.name, baseQuantity: p.baseQuantity })), priceListId: list.id, priceListName: list.name, currencyCode: list.currencyCode,
        prices: vr
          .map((r) => ({ unit: r.packConversion?.normalizedName ?? variant.baseUnit, minQuantity: r.minQuantity, unitPriceMinor: r.unitPriceMinor.toString(), validFrom: r.validFrom, validTo: r.validTo }))
          .sort((a, b) => a.unit.localeCompare(b.unit) || a.minQuantity - b.minQuantity),
      });
    }
  }
  return items.sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Price for a buyer's request against a seller's shared lists; the first shared list that can price it wins, in a stable order. */
export async function resolveSharedPrice(
  prisma: PrismaClient,
  input: { buyerBusinessId: string; linkId: string; sellerVariantId: string; quantity: number; unit?: string | null; at?: Date; currencyCode?: string },
): Promise<ResolvedPrice> {
  const sellerId = await sellerOfLinkFor(prisma, input.buyerBusinessId, input.linkId);
  const seller = getTenantScopedClient(prisma, sellerId);
  const variant = await seller.productVariant.findUnique({ where: { id: input.sellerVariantId } });
  if (!variant || variant.status !== "PUBLISHED") throw new PriceError("NOT_FOUND", "That item is not offered by this supplier.");
  const shares = await seller.priceListShare.findMany({ where: { linkId: input.linkId, revokedAt: null }, orderBy: { createdAt: "asc" } });
  if (shares.length === 0) throw new PriceError("NO_PRICE", "This supplier has not shared a price list with you.");
  let last: unknown;
  for (const share of shares) {
    try {
      return await resolvePrice(seller, {
        priceListId: share.priceListId, variantId: input.sellerVariantId, quantity: input.quantity,
        ...(input.unit ? { unit: input.unit } : {}), ...(input.at ? { at: input.at } : {}), ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}),
      });
    } catch (error) {
      if (!(error instanceof PriceError)) throw error;
      last = error;
    }
  }
  throw last;
}

export { sellerOfLinkFor };
