import type { OfflineDraft, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { applyLoggableIntent, type LoggableParsedIntent } from "../ai/applyParsedIntent.js";
import { asTenantScoped, getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../db/tenantScope.js";
import { canMerchant, membershipRoleForLegacyMerchantRole } from "../auth/permissions.js";
import { QuotaExceededError, assertWithinQuotaIfEnabled } from "../domain/billing.js";
import { resolvePrice } from "../domain/pricing.js";
import { ensureDefaultShopFor } from "../domain/shops.js";
import { fulfilSale, getStockLevel } from "../domain/stock.js";
import type { AuthedDevice } from "./devices.js";

/**
 * Offline drafts (expansion Phase 7). A draft is a LABELLED NOTE made without a connection; it is not a transaction and changes no
 * money, stock or ledger until a person confirms it online. The device picks a stable `clientId` per draft, so a sync that is retried
 * (a dropped connection, a double tap) never creates a second draft. Prices and stock are checked again on the server at sync AND at
 * confirmation, and anything that changed is shown as a conflict the person must accept knowingly.
 */
const STALE_CAPTURE_DAYS = 7;
const MAX_BATCH = 50;

const ItemSchema = z.object({
  itemName: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive().max(100_000),
  unitPriceMinor: z.number().int().nonnegative().max(1e12),
  /** Catalog SKU, when the person picked a product from the synced list: enables the price and stock re-check. */
  sku: z.string().trim().min(1).max(60).optional(),
  expectedUnitPriceMinor: z.number().int().nonnegative().max(1e12).optional(),
});
export const DraftInputSchema = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  kind: z.enum(["SALE", "EXPENSE"]),
  capturedAt: z.string().datetime(),
  amountMinor: z.number().int().nonnegative().max(1e12),
  paymentStatus: z.enum(["PAID", "CREDIT"]).optional(),
  customerName: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(200).optional(),
  items: z.array(ItemSchema).max(50).optional(),
});
export type DraftInput = z.infer<typeof DraftInputSchema>;

export interface Conflict {
  code: "PRICE_CHANGED" | "STOCK_SHORT" | "UNKNOWN_SKU" | "NO_PRICE" | "AMOUNT_MISMATCH" | "STALE_CAPTURE" | "CLOCK_AHEAD";
  detail: string;
  itemName?: string;
  expectedMinor?: string;
  currentMinor?: string;
  available?: number;
}

export interface DraftResult {
  clientId: string;
  id?: string;
  status: string;
  duplicate: boolean;
  conflicts: Conflict[];
}

function toParsed(input: DraftInput): LoggableParsedIntent {
  if (input.kind === "EXPENSE") return { intent: "EXPENSE", confidence: 1, amountMinor: input.amountMinor, ...(input.description ? { description: input.description } : {}) };
  return {
    intent: "SALE", confidence: 1, amountMinor: input.amountMinor, paymentStatus: input.paymentStatus ?? "PAID",
    ...(input.customerName ? { customerName: input.customerName } : {}),
    ...(input.items?.length ? { items: input.items.map((i) => ({ itemName: i.itemName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor })) } : {}),
  };
}

/** Everything that may be different now from when the draft was written. Pure reading: changes nothing. */
export async function revalidate(scoped: TenantScopedClient, businessId: string, input: DraftInput, now: Date): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  const captured = new Date(input.capturedAt);
  if (captured.getTime() > now.getTime() + 5 * 60_000) conflicts.push({ code: "CLOCK_AHEAD", detail: "The phone's clock was ahead of the server's when this was written." });
  if (now.getTime() - captured.getTime() > STALE_CAPTURE_DAYS * 86_400_000) conflicts.push({ code: "STALE_CAPTURE", detail: `This was written more than ${STALE_CAPTURE_DAYS} days ago.` });
  if (input.items?.length) {
    const total = input.items.reduce((n, i) => n + i.quantity * i.unitPriceMinor, 0);
    if (total !== input.amountMinor) conflicts.push({ code: "AMOUNT_MISMATCH", detail: "The total is not the sum of the lines.", expectedMinor: String(total), currentMinor: String(input.amountMinor) });
    const list = await scoped.priceList.findFirst({ where: { kind: "RETAIL", status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
    const shop = await ensureDefaultShopFor(scoped, businessId);
    for (const item of input.items) {
      if (!item.sku) continue;
      const variant = await scoped.productVariant.findFirst({ where: { sku: item.sku } });
      if (!variant) { conflicts.push({ code: "UNKNOWN_SKU", detail: `${item.sku} is not in the catalog any more.`, itemName: item.itemName }); continue; }
      if (list && item.expectedUnitPriceMinor !== undefined) {
        try {
          const current = (await resolvePrice(scoped, { priceListId: list.id, variantId: variant.id, unit: variant.baseUnit, quantity: item.quantity, at: now })).unitPriceMinor;
          if (current !== BigInt(item.expectedUnitPriceMinor) || current !== BigInt(item.unitPriceMinor)) {
            conflicts.push({ code: "PRICE_CHANGED", detail: `The price of ${item.itemName} is not what the phone showed.`, itemName: item.itemName, expectedMinor: String(item.expectedUnitPriceMinor), currentMinor: current.toString() });
          }
        } catch {
          conflicts.push({ code: "NO_PRICE", detail: `${item.itemName} has no valid price right now.`, itemName: item.itemName });
        }
      }
      if (variant.trackStock && input.kind === "SALE") {
        const level = await getStockLevel(scoped, shop.id, variant.id);
        if (level.available < item.quantity) conflicts.push({ code: "STOCK_SHORT", detail: `Only ${level.available} of ${item.itemName} available.`, itemName: item.itemName, available: level.available });
      }
    }
  }
  return conflicts;
}

function permitted(dev: AuthedDevice, kind: "SALE" | "EXPENSE"): boolean {
  return canMerchant(membershipRoleForLegacyMerchantRole(dev.merchant.role), kind === "SALE" ? "sales:create" : "expenses:create");
}

export async function syncDrafts(prisma: PrismaClient, dev: AuthedDevice, raw: unknown[], now: Date = new Date()): Promise<DraftResult[]> {
  if (raw.length > MAX_BATCH) throw new DraftError("TOO_MANY", `Send at most ${MAX_BATCH} drafts at a time.`);
  const scoped = getTenantScopedClient(prisma, dev.business.id);
  const out: DraftResult[] = [];
  for (const item of raw) {
    const parsed = DraftInputSchema.safeParse(item);
    const clientId = (item as { clientId?: unknown } | null)?.clientId;
    if (!parsed.success) { out.push({ clientId: typeof clientId === "string" ? clientId.slice(0, 64) : "?", status: "REJECTED", duplicate: false, conflicts: [{ code: "AMOUNT_MISMATCH", detail: "This draft could not be read." }] }); continue; }
    const input = parsed.data;
    const existing = await scoped.offlineDraft.findFirst({ where: { clientId: input.clientId } });
    if (existing) { out.push({ clientId: input.clientId, id: existing.id, status: existing.status, duplicate: true, conflicts: (existing.conflicts as unknown as Conflict[] | null) ?? [] }); continue; }
    if (!permitted(dev, input.kind)) { out.push({ clientId: input.clientId, status: "REJECTED", duplicate: false, conflicts: [{ code: "AMOUNT_MISMATCH", detail: "You do not have permission to record this." }] }); continue; }
    if (input.kind === "SALE" && input.paymentStatus === "CREDIT" && !input.customerName) { out.push({ clientId: input.clientId, status: "REJECTED", duplicate: false, conflicts: [{ code: "AMOUNT_MISMATCH", detail: "A sale on credit needs a customer name." }] }); continue; }
    const conflicts = await revalidate(scoped, dev.business.id, input, now);
    const status = conflicts.length ? "CONFLICT" : "PENDING_REVIEW";
    // skipDuplicates + the (businessId, clientId) unique key: two syncs of the same draft arriving together still make one row
    const created = await scoped.offlineDraft.createMany({
      skipDuplicates: true,
      data: [{ businessId: dev.business.id, merchantId: dev.merchant.id, clientId: input.clientId, kind: input.kind, payload: input as unknown as Prisma.InputJsonValue, capturedAt: new Date(input.capturedAt), status, conflicts: conflicts as unknown as Prisma.InputJsonValue }],
    });
    const row = await scoped.offlineDraft.findFirstOrThrow({ where: { clientId: input.clientId } });
    out.push({ clientId: input.clientId, id: row.id, status: row.status, duplicate: created.count === 0, conflicts: created.count === 0 ? ((row.conflicts as unknown as Conflict[] | null) ?? []) : conflicts });
  }
  return out;
}

export class DraftError extends Error {
  readonly code: string;
  readonly conflicts: Conflict[] | undefined;
  constructor(code: string, message: string, conflicts?: Conflict[]) {
    super(message);
    this.code = code;
    this.conflicts = conflicts;
  }
}

export async function listDrafts(prisma: PrismaClient, dev: AuthedDevice): Promise<OfflineDraft[]> {
  const scoped = getTenantScopedClient(prisma, dev.business.id);
  // a clerk sees their own drafts; the owner sees everyone's
  const own = dev.merchant.role === "OWNER" ? {} : { merchantId: dev.merchant.id };
  return scoped.offlineDraft.findMany({ where: { ...own }, orderBy: { capturedAt: "desc" }, take: 200 });
}

async function loadOwn(scoped: TenantScopedClient, dev: AuthedDevice, id: string): Promise<OfflineDraft> {
  const row = await scoped.offlineDraft.findUnique({ where: { id } });
  if (!row) throw new DraftError("NOT_FOUND", "Draft not found.");
  if (row.merchantId !== dev.merchant.id && dev.merchant.role !== "OWNER") throw new DraftError("NOT_FOUND", "Draft not found.");
  return row;
}

export async function discardDraft(prisma: PrismaClient, dev: AuthedDevice, id: string, now: Date = new Date()): Promise<void> {
  const scoped = getTenantScopedClient(prisma, dev.business.id);
  const row = await loadOwn(scoped, dev, id);
  const r = await scoped.offlineDraft.updateMany({ where: { id: row.id, status: { in: ["PENDING_REVIEW", "CONFLICT"] } }, data: { status: "DISCARDED" } });
  if (r.count !== 1) throw new DraftError("WRONG_STATE", `This draft is already ${row.status.toLowerCase().replace("_", " ")}.`);
  void now;
}

/** Confirming is the moment a draft becomes a real entry. Everything is checked again; conflicts need an explicit "accept". */
export async function confirmDraft(prisma: PrismaClient, dev: AuthedDevice, id: string, opts: { acceptConflicts?: boolean; now?: Date } = {}): Promise<{ reply: string; transactionId: string | null }> {
  const now = opts.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, dev.business.id);
  const row = await loadOwn(scoped, dev, id);
  if (row.status === "CONFIRMED") return { reply: "Already recorded.", transactionId: row.transactionId };
  if (row.status !== "PENDING_REVIEW" && row.status !== "CONFLICT") throw new DraftError("WRONG_STATE", `This draft is ${row.status.toLowerCase().replace("_", " ")}.`);
  const input = DraftInputSchema.parse(row.payload);
  if (!permitted(dev, input.kind)) throw new DraftError("NOT_ALLOWED", "You do not have permission to record this.");
  const conflicts = await revalidate(scoped, dev.business.id, input, now);
  if (conflicts.length && !opts.acceptConflicts) {
    await scoped.offlineDraft.updateMany({ where: { id: row.id, status: { in: ["PENDING_REVIEW", "CONFLICT"] } }, data: { status: "CONFLICT", conflicts: conflicts as unknown as Prisma.InputJsonValue } });
    throw new DraftError("CONFLICT", "Something changed since this was written. Review it, then accept or discard.", conflicts);
  }
  try {
    await assertWithinQuotaIfEnabled(scoped, dev.business.id, dev.business.timezone);
  } catch (error) {
    if (error instanceof QuotaExceededError) throw new DraftError("QUOTA", error.message);
    throw error;
  }
  const sourceId = `draft:${row.clientId}`;
  const reply = await withScopedTransaction(scoped, async (tx) => {
    const claim = await tx.offlineDraft.updateMany({ where: { id: row.id, status: { in: ["PENDING_REVIEW", "CONFLICT"] } }, data: { status: "CONFIRMED", conflicts: conflicts as unknown as Prisma.InputJsonValue } });
    if (claim.count !== 1) throw new DraftError("WRONG_STATE", "Someone else just settled this draft.");
    const scopedTx = asTenantScoped(tx);
    const replyText = await applyLoggableIntent(
      { scopedPrisma: scopedTx, businessId: dev.business.id, currencyCode: dev.business.currencyCode, minorUnitExp: dev.business.currency.minorUnitExp, whatsappMessageId: sourceId, stockTrackingEnabled: false, businessName: dev.business.name },
      toParsed(input),
    );
    // Catalog (SKU) lines take their stock out in the SAME transaction, so the books and the stock cannot disagree. Lines without a SKU are
    // free text and touch no stock, as with any sale typed in chat. A shortage the person knowingly accepted is allowed through, recorded with who approved it.
    if (input.kind === "SALE" && input.items?.length) {
      const shop = await ensureDefaultShopFor(scopedTx, dev.business.id);
      let n = 0;
      for (const item of input.items) {
        if (!item.sku) continue;
        const variant = await scopedTx.productVariant.findFirst({ where: { sku: item.sku } });
        if (!variant || !variant.trackStock) continue;
        n++;
        await fulfilSale(scopedTx, {
          businessId: dev.business.id, shopId: shop.id, variantId: variant.id, quantity: item.quantity, sourceType: "OFFLINE_DRAFT", sourceId: row.id,
          idempotencyKey: `draft:${row.clientId}:${n}`, actor: { type: "MERCHANT", id: dev.merchant.id },
          ...(opts.acceptConflicts && conflicts.some((c) => c.code === "STOCK_SHORT") ? { approvedBy: dev.merchant.id } : { requireAvailable: true }),
        });
      }
    }
    return replyText;
  });
  const txn = await scoped.transaction.findFirst({ where: { whatsappMessageId: sourceId }, select: { id: true }, orderBy: { createdAt: "desc" } });
  if (txn) await scoped.offlineDraft.updateMany({ where: { id: row.id }, data: { transactionId: txn.id } });
  return { reply, transactionId: txn?.id ?? null };
}
