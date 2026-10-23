import type { Appeal, ModerationAction, PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { StoreError } from "./store/common.js";

/**
 * Marketplace moderation (expansion sections 10 and 18). Every decision is made by a person, recorded with the admin and a reason in an
 * append-only table, and can be appealed. Reports never act by themselves (no automatic takedown: that would let anyone remove a
 * competitor by filing reports); the queue orders reports by how many independent open reports a target has so the likeliest
 * problems are seen first.
 *
 * Suspension rules: a platform admin may unpublish a listing, or suspend a seller. Suspending removes the shop, its listings and its
 * checkout from every public surface. It never touches orders already placed: the seller can still confirm, hand over, cancel and
 * refund them, and the shopper's order page keeps working. Reinstating reverses it.
 */
const need = (reason: string, min = 10) => {
  const r = reason.trim();
  if (r.length < min) throw new StoreError("INVALID", `Give a reason of at least ${min} characters.`);
  return r.slice(0, 500);
};

async function record(prisma: PrismaClient, a: { businessId: string; type: ModerationAction["type"]; reason: string; adminUserId: string; listingId?: string | null; reportId?: string | null }): Promise<ModerationAction> {
  return getTenantScopedClient(prisma, a.businessId).moderationAction.create({
    data: { businessId: a.businessId, type: a.type, reason: a.reason, adminUserId: a.adminUserId, listingId: a.listingId ?? null, reportId: a.reportId ?? null },
  });
}

async function closeReport(prisma: PrismaClient, reportId: string | undefined, adminUserId: string, outcome: "ACTIONED" | "DISMISSED", note: string): Promise<void> {
  if (!reportId) return;
  await prisma.marketplaceReport.updateMany({ where: { id: reportId, status: "OPEN" }, data: { status: outcome, resolvedBy: adminUserId, resolutionNote: note.slice(0, 300), resolvedAt: new Date() } });
}

/** Unpublishes the item (every channel of that variant) everywhere public. The seller's own setting is untouched. */
export async function unpublishListing(prisma: PrismaClient, input: { listingId: string; adminUserId: string; reason: string; reportId?: string }): Promise<ModerationAction> {
  const reason = need(input.reason);
  const l = await prisma.listing.findUnique({ where: { id: input.listingId } });
  if (!l) throw new StoreError("NOT_FOUND", "No such listing.");
  const moved = await prisma.listing.updateMany({ where: { businessId: l.businessId, variantId: l.variantId, moderation: "VISIBLE" }, data: { moderation: "UNPUBLISHED", moderationReason: reason } });
  if (moved.count === 0) throw new StoreError("WRONG_STATE", "That listing is already unpublished.");
  const action = await record(prisma, { businessId: l.businessId, type: "UNPUBLISH_LISTING", reason, adminUserId: input.adminUserId, listingId: l.id, ...(input.reportId ? { reportId: input.reportId } : {}) });
  await closeReport(prisma, input.reportId, input.adminUserId, "ACTIONED", `Listing unpublished: ${reason}`);
  return action;
}

export async function reinstateListing(prisma: PrismaClient, input: { listingId: string; adminUserId: string; reason: string }): Promise<ModerationAction> {
  const reason = need(input.reason);
  const l = await prisma.listing.findUnique({ where: { id: input.listingId } });
  if (!l) throw new StoreError("NOT_FOUND", "No such listing.");
  const moved = await prisma.listing.updateMany({ where: { businessId: l.businessId, variantId: l.variantId, moderation: "UNPUBLISHED" }, data: { moderation: "VISIBLE", moderationReason: null } });
  if (moved.count === 0) throw new StoreError("WRONG_STATE", "That listing is not unpublished.");
  return record(prisma, { businessId: l.businessId, type: "REINSTATE_LISTING", reason, adminUserId: input.adminUserId, listingId: l.id });
}

export async function suspendSeller(prisma: PrismaClient, input: { businessId: string; adminUserId: string; reason: string; reportId?: string }): Promise<ModerationAction> {
  const reason = need(input.reason);
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const sf = await scoped.storefront.findFirst({ where: {} });
  if (!sf) throw new StoreError("NOT_FOUND", "That business has no shop.");
  const moved = await scoped.storefront.updateMany({ where: { id: sf.id, marketplaceStatus: { not: "SUSPENDED" } }, data: { marketplaceStatus: "SUSPENDED", marketplaceNote: reason } });
  if (moved.count !== 1) throw new StoreError("WRONG_STATE", "That seller is already suspended.");
  const action = await record(prisma, { businessId: input.businessId, type: "SUSPEND_SELLER", reason, adminUserId: input.adminUserId, ...(input.reportId ? { reportId: input.reportId } : {}) });
  await closeReport(prisma, input.reportId, input.adminUserId, "ACTIONED", `Seller suspended: ${reason}`);
  return action;
}

export async function reinstateSeller(prisma: PrismaClient, input: { businessId: string; adminUserId: string; reason: string }): Promise<ModerationAction> {
  const reason = need(input.reason);
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const moved = await scoped.storefront.updateMany({ where: { marketplaceStatus: "SUSPENDED" }, data: { marketplaceStatus: "ACTIVE", marketplaceNote: null } });
  if (moved.count !== 1) throw new StoreError("WRONG_STATE", "That seller is not suspended.");
  return record(prisma, { businessId: input.businessId, type: "REINSTATE_SELLER", reason, adminUserId: input.adminUserId });
}

export async function resolveReport(prisma: PrismaClient, input: { reportId: string; adminUserId: string; outcome: "DISMISSED"; note: string }): Promise<void> {
  const note = need(input.note, 5);
  const r = await prisma.marketplaceReport.updateMany({ where: { id: input.reportId, status: "OPEN" }, data: { status: input.outcome, resolvedBy: input.adminUserId, resolutionNote: note, resolvedAt: new Date() } });
  if (r.count !== 1) throw new StoreError("WRONG_STATE", "That report is not open.");
}

// ------------------------------------------------------------------------------------ appeals

/** A seller appeals their most recent takedown (or a named one). One open appeal per action. */
export async function fileAppeal(prisma: PrismaClient, input: { businessId: string; text: string; actionId?: string }): Promise<Appeal> {
  const text = input.text.trim();
  if (text.length < 10) throw new StoreError("INVALID", "Say why the decision was wrong, in a sentence or two.");
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const action = input.actionId
    ? await scoped.moderationAction.findUnique({ where: { id: input.actionId } })
    : await scoped.moderationAction.findFirst({ where: { type: { in: ["UNPUBLISH_LISTING", "SUSPEND_SELLER"] } }, orderBy: { createdAt: "desc" } });
  if (!action || (action.type !== "UNPUBLISH_LISTING" && action.type !== "SUSPEND_SELLER")) throw new StoreError("NOT_FOUND", "There is no moderation decision of yours to appeal.");
  if (await scoped.appeal.findFirst({ where: { actionId: action.id, status: "OPEN" } })) throw new StoreError("DUPLICATE", "You have already appealed that decision; a person will answer.");
  // an appeal against an action that has since been reversed has nothing left to decide
  const later = await scoped.moderationAction.findFirst({ where: { createdAt: { gt: action.createdAt }, type: action.type === "SUSPEND_SELLER" ? "REINSTATE_SELLER" : "REINSTATE_LISTING", ...(action.listingId ? { listingId: action.listingId } : {}) } });
  if (later) throw new StoreError("WRONG_STATE", "That decision has already been reversed.");
  return scoped.appeal.create({ data: { businessId: input.businessId, actionId: action.id, text: text.slice(0, 1_000) } });
}

export async function decideAppeal(prisma: PrismaClient, input: { appealId: string; adminUserId: string; outcome: "UPHELD" | "OVERTURNED"; note: string }): Promise<Appeal> {
  const note = need(input.note);
  const appeal = await prisma.appeal.findUnique({ where: { id: input.appealId }, include: { action: true } });
  if (!appeal) throw new StoreError("NOT_FOUND", "No such appeal.");
  const decided = await prisma.appeal.updateMany({ where: { id: appeal.id, status: "OPEN" }, data: { status: input.outcome, decidedBy: input.adminUserId, decisionNote: note, decidedAt: new Date() } });
  if (decided.count !== 1) throw new StoreError("WRONG_STATE", "That appeal has already been decided.");
  if (input.outcome === "OVERTURNED") {
    const reason = `Appeal overturned: ${note}`;
    if (appeal.action.type === "SUSPEND_SELLER") await reinstateSeller(prisma, { businessId: appeal.businessId, adminUserId: input.adminUserId, reason });
    else if (appeal.action.listingId) await reinstateListing(prisma, { listingId: appeal.action.listingId, adminUserId: input.adminUserId, reason });
  }
  return prisma.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
}

/** What the seller sees about their own moderation status. */
export async function moderationStatusFor(prisma: PrismaClient, businessId: string) {
  const scoped = getTenantScopedClient(prisma, businessId);
  const sf = await scoped.storefront.findFirst({ where: {} });
  const unpublished = await scoped.listing.findMany({ where: { moderation: "UNPUBLISHED" }, include: { variant: { select: { sku: true } } } });
  const actions = await scoped.moderationAction.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  const appeals = await scoped.appeal.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  return { marketplaceStatus: sf?.marketplaceStatus ?? "OFF", note: sf?.marketplaceNote ?? null, unpublished: unpublished.map((l) => ({ sku: l.variant.sku, reason: l.moderationReason })), actions, appeals };
}
