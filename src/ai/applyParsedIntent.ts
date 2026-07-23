import type { InventoryItem } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { DebtOverpaymentError, findOrCreateCustomerByName, recordDebtNote, recordPaymentForCustomer } from "../domain/debtBook.js";
import { applyStockMovement, findOrCreateInventoryItem, recordStockAdjustment } from "../domain/inventory.js";
import type { TransactionItemInput } from "../domain/ledger.js";
import { recordTransaction } from "../domain/ledger.js";
import { formatMoney, sumMoney } from "../domain/money.js";
import type { ParsedIntent } from "./schema.js";

export interface ApplyIntentContext {
  scopedPrisma: TenantScopedClient;
  businessId: string;
  currencyCode: string;
  minorUnitExp: number;
  whatsappMessageId?: string;
  /**
   * Phase 15: resolved by the caller from the `stockTracking` FeatureFlag
   * (mirrors how `messageDispatcher.ts` already resolved it for the
   * STOCK_ADJUSTMENT intent in Phase 14). Defaults to `false` so every
   * existing caller/test that doesn't set it keeps today's behavior — a
   * SALE/PURCHASE with line items never touches InventoryItem unless a
   * business has explicitly opted in.
   */
  stockTrackingEnabled?: boolean;
  /**
   * Phase 19: the merchant's business name, used only to head the itemized
   * sale receipt block (see `buildSaleReceipt` below). Optional — and falls
   * back to a generic label when absent — purely so existing tests/callers
   * that construct an `ApplyIntentContext` without it (this field didn't
   * exist before Phase 19) don't need updating. `messageDispatcher.ts`
   * already has `business.name` in scope from the same `findUniqueOrThrow`
   * it reads `currencyCode`/`minorUnitExp` from, so the real dispatch path
   * always supplies it.
   */
  businessName?: string;
}

/**
 * Resolves (find-or-create) an `InventoryItem` for each line item up front,
 * sequentially (not `Promise.all`) so two lines naming the same new item in
 * one message ("2 bread, 1 bread") resolve to a single created row rather
 * than racing each other — mirrors `findOrCreateInventoryItem`'s own
 * case-insensitive-match doc comment about this being a known, accepted
 * check-then-write race, not one this loop should add a second instance of.
 */
async function resolveInventoryItemsForLines(
  ctx: ApplyIntentContext,
  items: { itemName: string }[],
): Promise<InventoryItem[]> {
  const resolved: InventoryItem[] = [];
  for (const line of items) {
    resolved.push(await findOrCreateInventoryItem(ctx.scopedPrisma, ctx.businessId, line.itemName));
  }
  return resolved;
}

/** The subset of ParsedIntent that applyLoggableIntent knows how to turn into ledger effects. */
export type LoggableParsedIntent = Extract<
  ParsedIntent,
  { intent: "SALE" | "PURCHASE" | "EXPENSE" | "PAYMENT_RECEIVED" | "DEBT_NOTE" | "STOCK_ADJUSTMENT" }
>;

async function findOrCreateSupplierByName(ctx: ApplyIntentContext, name: string) {
  const existing = await ctx.scopedPrisma.supplier.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (existing) return existing;

  return ctx.scopedPrisma.supplier.create({ data: { businessId: ctx.businessId, name } });
}

interface ParsedLineItem {
  itemName: string;
  quantity: number;
  unitPriceMinor: number;
}

interface PreparedLineItems {
  transactionItems: TransactionItemInput[];
  /** Only populated when `stockTrackingEnabled` — each entry's InventoryItem is already resolved/created. */
  stockLines: { item: InventoryItem; quantityDelta: number }[];
}

/**
 * Shared by `applySale`/`applyPurchase` (Phase 15). `quantitySign` is `-1`
 * for a SALE (stock goes down) and `+1` for a PURCHASE (stock goes up). When
 * `stockTrackingEnabled` is off, behaves exactly as before this phase: plain
 * `TransactionItem` rows with no `inventoryItemId`, no `InventoryItem`
 * touched at all.
 */
async function prepareLineItems(
  ctx: ApplyIntentContext,
  items: ParsedLineItem[] | undefined,
  quantitySign: 1 | -1,
): Promise<PreparedLineItems> {
  if (!items || items.length === 0) return { transactionItems: [], stockLines: [] };

  if (!ctx.stockTrackingEnabled) {
    return {
      transactionItems: items.map((item) => ({
        itemName: item.itemName,
        quantity: item.quantity,
        unitPriceMinor: BigInt(item.unitPriceMinor),
      })),
      stockLines: [],
    };
  }

  const resolvedItems = await resolveInventoryItemsForLines(ctx, items);
  return {
    transactionItems: items.map((item, i) => ({
      itemName: item.itemName,
      quantity: item.quantity,
      unitPriceMinor: BigInt(item.unitPriceMinor),
      inventoryItemId: resolvedItems[i]!.id,
    })),
    stockLines: items.map((item, i) => ({ item: resolvedItems[i]!, quantityDelta: quantitySign * item.quantity })),
  };
}

/** Applies every prepared stock line's movement against the now-created transaction, sequentially. */
async function applyStockLines(
  ctx: ApplyIntentContext,
  transactionId: string,
  source: "SALE" | "PURCHASE",
  stockLines: PreparedLineItems["stockLines"],
): Promise<void> {
  for (const { item, quantityDelta } of stockLines) {
    await applyStockMovement(ctx.scopedPrisma, ctx.businessId, item, quantityDelta, source, transactionId);
  }
}

/**
 * Phase 19: an itemized, forwardable receipt block for a SALE — the
 * merchant-relay pattern `src/domain/reminders.ts`'s `generateReminderForCustomer`
 * already established for customer-facing content (Standard #9: TradePal
 * never messages a customer directly, so the merchant must copy/forward this
 * themselves). Only built when there's something worth itemizing — see the
 * call site in `applySale` for the `items.length > 0 || customerName` gate;
 * a bare "sold rice 5000" with neither stays the original one-line reply so
 * routine, no-detail sales don't turn into a wall of text on every message.
 */
function buildSaleReceipt(
  ctx: ApplyIntentContext,
  parsed: Extract<ParsedIntent, { intent: "SALE" }>,
  transaction: { amountMinor: bigint; createdAt: Date },
  customerName: string | null,
): string {
  const lines: string[] = [];
  lines.push(`Receipt — ${ctx.businessName ?? "Your business"}`);
  lines.push(transaction.createdAt.toISOString().slice(0, 10));
  if (customerName) lines.push(`Customer: ${customerName}`);

  if (parsed.items && parsed.items.length > 0) {
    lines.push("");
    for (const item of parsed.items) {
      const lineTotalMinor = BigInt(item.quantity * item.unitPriceMinor);
      lines.push(
        `${item.quantity} x ${item.itemName} @ ${formatMoney(BigInt(item.unitPriceMinor), ctx.minorUnitExp)} = ${formatMoney(lineTotalMinor, ctx.minorUnitExp)}`,
      );
    }
  }

  lines.push("");
  lines.push(`Total: ${formatMoney(transaction.amountMinor, ctx.minorUnitExp)} ${ctx.currencyCode}`);
  return lines.join("\n");
}

async function applySale(ctx: ApplyIntentContext, parsed: Extract<ParsedIntent, { intent: "SALE" }>): Promise<string> {
  const customer = parsed.customerName
    ? await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, parsed.customerName)
    : null;
  const { transactionItems, stockLines } = await prepareLineItems(ctx, parsed.items, -1);

  const transaction = await recordTransaction(ctx.scopedPrisma, {
    businessId: ctx.businessId,
    type: "SALE",
    amountMinor: BigInt(parsed.amountMinor),
    currencyCode: ctx.currencyCode,
    paymentStatus: parsed.paymentStatus,
    ...(customer ? { customerId: customer.id } : {}),
    ...(ctx.whatsappMessageId ? { whatsappMessageId: ctx.whatsappMessageId } : {}),
    ...(transactionItems.length > 0 ? { items: transactionItems } : {}),
  });

  await applyStockLines(ctx, transaction.id, "SALE", stockLines);

  const summary = `Logged sale of ${formatMoney(transaction.amountMinor, ctx.minorUnitExp)} ${ctx.currencyCode}.`;

  const receiptWorthy = (parsed.items && parsed.items.length > 0) || customer !== null;
  if (!receiptWorthy) return summary;

  const receipt = buildSaleReceipt(ctx, parsed, transaction, customer?.name ?? null);
  return [
    summary,
    "",
    receipt,
    "",
    "Forward this receipt to your customer yourself — TradePal cannot message customers directly.",
  ].join("\n");
}

async function applyPurchase(ctx: ApplyIntentContext, parsed: Extract<ParsedIntent, { intent: "PURCHASE" }>): Promise<string> {
  const supplier = parsed.supplierName ? await findOrCreateSupplierByName(ctx, parsed.supplierName) : null;
  const { transactionItems, stockLines } = await prepareLineItems(ctx, parsed.items, 1);

  const transaction = await recordTransaction(ctx.scopedPrisma, {
    businessId: ctx.businessId,
    type: "PURCHASE",
    amountMinor: BigInt(parsed.amountMinor),
    currencyCode: ctx.currencyCode,
    paymentStatus: "PAID",
    ...(supplier ? { supplierId: supplier.id } : {}),
    ...(ctx.whatsappMessageId ? { whatsappMessageId: ctx.whatsappMessageId } : {}),
    ...(transactionItems.length > 0 ? { items: transactionItems } : {}),
  });

  await applyStockLines(ctx, transaction.id, "PURCHASE", stockLines);

  return `Logged purchase of ${formatMoney(transaction.amountMinor, ctx.minorUnitExp)} ${ctx.currencyCode}.`;
}

async function applyExpense(ctx: ApplyIntentContext, parsed: Extract<ParsedIntent, { intent: "EXPENSE" }>): Promise<string> {
  const transaction = await recordTransaction(ctx.scopedPrisma, {
    businessId: ctx.businessId,
    type: "EXPENSE",
    amountMinor: BigInt(parsed.amountMinor),
    currencyCode: ctx.currencyCode,
    paymentStatus: "PAID",
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(ctx.whatsappMessageId ? { whatsappMessageId: ctx.whatsappMessageId } : {}),
  });

  return `Logged expense of ${formatMoney(transaction.amountMinor, ctx.minorUnitExp)} ${ctx.currencyCode}.`;
}

async function applyPaymentReceived(
  ctx: ApplyIntentContext,
  parsed: Extract<ParsedIntent, { intent: "PAYMENT_RECEIVED" }>,
): Promise<string> {
  const customer = await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, parsed.customerName);

  try {
    const settlements = await recordPaymentForCustomer(ctx.scopedPrisma, {
      businessId: ctx.businessId,
      customerId: customer.id,
      amountMinor: BigInt(parsed.amountMinor),
      ...(ctx.whatsappMessageId ? { whatsappMessageId: ctx.whatsappMessageId } : {}),
    });

    if (settlements.length === 0) {
      return `${customer.name} has no open debt to pay down.`;
    }

    const remaining = sumMoney(settlements.map((s) => s.debt.outstandingAmountMinor));
    return `Applied ${formatMoney(BigInt(parsed.amountMinor), ctx.minorUnitExp)} ${ctx.currencyCode} to ${customer.name}'s debt. Remaining owed: ${formatMoney(remaining, ctx.minorUnitExp)} ${ctx.currencyCode}.`;
  } catch (error) {
    if (error instanceof DebtOverpaymentError) return error.message;
    throw error;
  }
}

async function applyDebtNote(ctx: ApplyIntentContext, parsed: Extract<ParsedIntent, { intent: "DEBT_NOTE" }>): Promise<string> {
  const customer = await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, parsed.customerName);

  const debt = await recordDebtNote(ctx.scopedPrisma, {
    businessId: ctx.businessId,
    customerId: customer.id,
    customerName: customer.name,
    amountMinor: BigInt(parsed.amountMinor),
    currencyCode: ctx.currencyCode,
    ...(ctx.whatsappMessageId ? { whatsappMessageId: ctx.whatsappMessageId } : {}),
  });

  return `Recorded: ${customer.name} owes ${formatMoney(debt.outstandingAmountMinor, ctx.minorUnitExp)} ${ctx.currencyCode}.`;
}

/**
 * Phase 14: turns a direct "sold 2 bread from stock" / "found 3 extra rice"
 * style declaration into an InventoryMovement + updated estimatedStockQty.
 * Unlike `applySale`/`applyPurchase` (which, as of Phase 15, link their
 * stock movements to the Transaction that caused them via source
 * "SALE"/"PURCHASE"), this is a standalone adjustment never tied to a
 * logged Transaction — there isn't one to tie it to — so it always uses
 * source "ADJUSTMENT".
 */
async function applyStockAdjustment(
  ctx: ApplyIntentContext,
  parsed: Extract<ParsedIntent, { intent: "STOCK_ADJUSTMENT" }>,
): Promise<string> {
  const { item, quantityDelta } = await recordStockAdjustment(
    ctx.scopedPrisma,
    ctx.businessId,
    parsed.itemName,
    parsed.quantityDelta,
    "ADJUSTMENT",
  );

  const verb = quantityDelta >= 0 ? "Added" : "Removed";
  const preposition = quantityDelta >= 0 ? "to" : "from";
  return `${verb} ${Math.abs(quantityDelta)} ${item.name} ${preposition} stock. Estimated stock now: ${item.estimatedStockQty}.`;
}

/** Turns a HIGH-confidence, validated transaction intent into ledger/debt-book/inventory effects and a merchant-facing reply. */
export async function applyLoggableIntent(ctx: ApplyIntentContext, parsed: LoggableParsedIntent): Promise<string> {
  switch (parsed.intent) {
    case "SALE":
      return applySale(ctx, parsed);
    case "PURCHASE":
      return applyPurchase(ctx, parsed);
    case "EXPENSE":
      return applyExpense(ctx, parsed);
    case "PAYMENT_RECEIVED":
      return applyPaymentReceived(ctx, parsed);
    case "DEBT_NOTE":
      return applyDebtNote(ctx, parsed);
    case "STOCK_ADJUSTMENT":
      return applyStockAdjustment(ctx, parsed);
  }
}
