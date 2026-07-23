import type { PaymentStatus, Transaction, TransactionType } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";

export class TransactionAlreadyReversedError extends Error {}

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
  return scopedPrisma.transaction.create({
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

  return scopedPrisma.transaction.create({
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
}
