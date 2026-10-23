import type { PaymentStatus, Transaction, TransactionType } from "@prisma/client";
import { withScopedTransaction, type TenantScopedClient } from "../db/tenantScope.js";
import { journalLegacyTransactionIfEnabled } from "./accounting.js";
import { applyStockMovement } from "./inventory.js";

export class TransactionAlreadyReversedError extends Error {}
/** A debt that has payments recorded cannot be taken back until those payments are taken back first. */
export class DebtHasPaymentsError extends Error {}

export interface TransactionItemInput {
  itemName: string;
  quantity: number;
  unitPriceMinor: bigint;
  inventoryItemId?: string;
}

export interface RecordTransactionInput {
  businessId: string;
  type: TransactionType;
  amountMinor: bigint;
  currencyCode: string;
  paymentStatus: PaymentStatus;
  customerId?: string;
  supplierId?: string;
  description?: string;
  rawMerchantText?: string;
  whatsappMessageId?: string;
  items?: TransactionItemInput[];
}

export async function recordTransaction(
  scopedPrisma: TenantScopedClient,
  input: RecordTransactionInput,
): Promise<Transaction> {
  const created = await scopedPrisma.transaction.create({
    data: {
      businessId: input.businessId,
      type: input.type,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      paymentStatus: input.paymentStatus,
      customerId: input.customerId ?? null,
      supplierId: input.supplierId ?? null,
      description: input.description ?? null,
      rawMerchantText: input.rawMerchantText ?? null,
      whatsappMessageId: input.whatsappMessageId ?? null,
      ...(input.items
        ? {
            items: {
              create: input.items.map((item) => ({
                businessId: input.businessId,
                itemName: item.itemName,
                quantity: item.quantity,
                unitPriceMinor: item.unitPriceMinor,
                lineTotalMinor: item.unitPriceMinor * BigInt(item.quantity),
                ...(item.inventoryItemId ? { inventoryItemId: item.inventoryItemId } : {}),
              })),
            },
          }
        : {}),
    },
  });
  // Expansion Phase 2: balanced journal entry (OFF unless the accountingJournals flag is on; never throws).
  await journalLegacyTransactionIfEnabled(scopedPrisma, created);
  return created;
}

/**
 * The only way to correct a posted transaction: a new row with the amount
 * negated and `reversalOfTransactionId` set, so `Transaction` never needs an
 * UPDATE/DELETE (both are blocked by TenantScopedClient regardless). Summing
 * a transaction and its reversal always nets to zero.
 */
export async function reverseTransaction(
  scopedPrisma: TenantScopedClient,
  transactionId: string,
  reason?: string,
): Promise<Transaction> {
  // One database transaction: the reversal, the stock it puts back and the debt book move together or not at all.
  return withScopedTransaction(scopedPrisma, (db) => reverseWithin(db, transactionId, reason));
}

async function reverseWithin(scopedPrisma: TenantScopedClient, transactionId: string, reason?: string): Promise<Transaction> {
  const original = await scopedPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });

  if (original.reversalOfTransactionId) {
    throw new TransactionAlreadyReversedError(
      `Transaction ${transactionId} is itself a reversal and cannot be reversed again.`,
    );
  }

  const existingReversal = await scopedPrisma.transaction.findUnique({
    where: { reversalOfTransactionId: transactionId },
  });
  if (existingReversal) {
    throw new TransactionAlreadyReversedError(
      `Transaction ${transactionId} has already been reversed by ${existingReversal.id}.`,
    );
  }

  // The debt book must follow the ledger. A debt note that is taken back removes that debt; a payment that is taken back puts the amount back
  // on the debt it paid down. (Before this, /undo of a debt or a payment reversed only the ledger entry and the customer still showed the
  // old balance.) Checked BEFORE anything is written so a refusal leaves nothing half-done.
  const debtToVoid = original.type === "DEBT_NOTE" ? await scopedPrisma.debt.findFirst({ where: { originTransactionId: original.id } }) : null;
  if (debtToVoid) {
    const live = await scopedPrisma.debtPayment.count({ where: { debtId: debtToVoid.id, transaction: { reversedBy: null } } });
    if (live > 0) throw new DebtHasPaymentsError("This debt already has payments recorded. Undo those payments first, then undo the debt.");
  }
  const paymentLink = original.type === "PAYMENT_RECEIVED" ? await scopedPrisma.debtPayment.findFirst({ where: { transactionId: original.id } }) : null;

  const reversal = await scopedPrisma.transaction.create({
    data: {
      businessId: original.businessId,
      type: original.type,
      amountMinor: -original.amountMinor,
      currencyCode: original.currencyCode,
      paymentStatus: original.paymentStatus,
      customerId: original.customerId,
      supplierId: original.supplierId,
      description: reason ?? `Reversal of: ${original.description ?? original.id}`,
      reversalOfTransactionId: original.id,
    },
  });

  if (debtToVoid) {
    // The debt was a mistake: it no longer counts. (There is no separate "cancelled" state; written off with nothing outstanding is the closest.)
    await scopedPrisma.debt.update({ where: { id: debtToVoid.id }, data: { outstandingAmountMinor: 0n, status: "WRITTEN_OFF" } });
  }
  if (paymentLink) {
    const debt = await scopedPrisma.debt.findUniqueOrThrow({ where: { id: paymentLink.debtId } });
    const outstanding = debt.outstandingAmountMinor + paymentLink.amountMinor;
    if (outstanding > debt.originalAmountMinor) throw new Error("Taking this payment back would put more on the debt than it was for.");
    await scopedPrisma.debt.update({ where: { id: debt.id }, data: { outstandingAmountMinor: outstanding, status: outstanding === debt.originalAmountMinor ? "OPEN" : "PARTIALLY_PAID" } });
  }

  // Undoing a sale or purchase must also undo what it did to stock: put back (or take back) exactly the
  // quantities the original moved, as new ADJUSTMENT movements tied to the reversal. Without this the
  // money nets to zero but the stock count stays permanently wrong (seen live: undo of a 2-bag sale left
  // the shelf count at -2).
  const movements = await scopedPrisma.inventoryMovement.findMany({ where: { transactionId: original.id } });
  for (const movement of movements) {
    const item = await scopedPrisma.inventoryItem.findUniqueOrThrow({ where: { id: movement.inventoryItemId } });
    await applyStockMovement(scopedPrisma, original.businessId, item, -movement.quantityDelta, "ADJUSTMENT", reversal.id);
  }

  await journalLegacyTransactionIfEnabled(scopedPrisma, reversal);
  return reversal;
}
