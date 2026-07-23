import type { Debt, Transaction } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { recordTransaction } from "./ledger.js";
import { sumMoney } from "./money.js";

export class DebtOverpaymentError extends Error {}

export interface CreateDebtInput {
  businessId: string;
  customerId: string;
  amountMinor: bigint;
  currencyCode: string;
  originTransactionId?: string;
  dueDate?: Date;
}

export async function createDebt(scopedPrisma: TenantScopedClient, input: CreateDebtInput): Promise<Debt> {
  return scopedPrisma.debt.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      originalAmountMinor: input.amountMinor,
      outstandingAmountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      originTransactionId: input.originTransactionId ?? null,
      dueDate: input.dueDate ?? null,
    },
  });
}

export interface RecordDebtNoteInput {
  businessId: string;
  customerId: string;
  customerName: string;
  amountMinor: bigint;
  currencyCode: string;
  whatsappMessageId?: string;
}

/**
 * A debt always has a DEBT_NOTE transaction as its origin (Debt.originTransactionId)
 * so it shows up in `/today`/`/undo` like any other transaction, not just as a
 * standalone Debt row invisible to the ledger.
 */
export async function recordDebtNote(scopedPrisma: TenantScopedClient, input: RecordDebtNoteInput): Promise<Debt> {
  const originTransaction = await recordTransaction(scopedPrisma, {
    businessId: input.businessId,
    type: "DEBT_NOTE",
    amountMinor: input.amountMinor,
    currencyCode: input.currencyCode,
    paymentStatus: "CREDIT",
    customerId: input.customerId,
    description: `Debt recorded for ${input.customerName}`,
    ...(input.whatsappMessageId ? { whatsappMessageId: input.whatsappMessageId } : {}),
  });

  return createDebt(scopedPrisma, {
    businessId: input.businessId,
    customerId: input.customerId,
    amountMinor: input.amountMinor,
    currencyCode: input.currencyCode,
    originTransactionId: originTransaction.id,
  });
}

export interface DebtSettlement {
  debt: Debt;
  transaction: Transaction;
  amountApplied: bigint;
}

/**
 * Pays down a single debt by exactly `amountMinor` (must not exceed what's
 * outstanding — this never clamps or silently ignores an over-payment,
 * since that would be silently wrong money math). Records a
 * PAYMENT_RECEIVED transaction alongside the DebtPayment link so the
 * ledger and the debt book always agree.
 */
async function payDownDebt(
  scopedPrisma: TenantScopedClient,
  businessId: string,
  debt: Debt,
  amountMinor: bigint,
  whatsappMessageId?: string,
): Promise<DebtSettlement> {
  if (amountMinor > debt.outstandingAmountMinor) {
    throw new DebtOverpaymentError(
      `Payment of ${amountMinor} exceeds outstanding balance of ${debt.outstandingAmountMinor} on debt ${debt.id}.`,
    );
  }

  const transaction = await recordTransaction(scopedPrisma, {
    businessId,
    type: "PAYMENT_RECEIVED",
    amountMinor,
    currencyCode: debt.currencyCode,
    paymentStatus: "PAID",
    customerId: debt.customerId,
    ...(whatsappMessageId ? { whatsappMessageId } : {}),
  });

  const outstandingAmountMinor = debt.outstandingAmountMinor - amountMinor;
  const updatedDebt = await scopedPrisma.debt.update({
    where: { id: debt.id },
    data: {
      outstandingAmountMinor,
      status: outstandingAmountMinor === 0n ? "PAID" : "PARTIALLY_PAID",
    },
  });

  await scopedPrisma.debtPayment.create({
    data: { businessId, debtId: debt.id, transactionId: transaction.id, amountMinor },
  });

  return { debt: updatedDebt, transaction, amountApplied: amountMinor };
}

export interface RecordPaymentForCustomerInput {
  businessId: string;
  customerId: string;
  amountMinor: bigint;
  whatsappMessageId?: string;
}

/**
 * `/paid <customer> <amount>`: applies the payment across the customer's
 * open debts oldest-first (FIFO), producing one PAYMENT_RECEIVED
 * transaction per debt touched for a clean per-debt audit trail. Refuses
 * (rather than silently applies as unallocated credit) if the amount
 * exceeds everything the customer currently owes.
 */
export async function recordPaymentForCustomer(
  scopedPrisma: TenantScopedClient,
  input: RecordPaymentForCustomerInput,
): Promise<DebtSettlement[]> {
  const openDebts = await scopedPrisma.debt.findMany({
    where: { customerId: input.customerId, status: { in: ["OPEN", "PARTIALLY_PAID"] } },
    orderBy: { createdAt: "asc" },
  });

  const totalOutstanding = sumMoney(openDebts.map((d) => d.outstandingAmountMinor));
  if (input.amountMinor > totalOutstanding) {
    throw new DebtOverpaymentError(
      `Payment of ${input.amountMinor} exceeds total outstanding debt of ${totalOutstanding} for this customer.`,
    );
  }

  const settlements: DebtSettlement[] = [];
  let remaining = input.amountMinor;

  for (const debt of openDebts) {
    if (remaining <= 0n) break;
    const amountApplied = remaining < debt.outstandingAmountMinor ? remaining : debt.outstandingAmountMinor;
    settlements.push(await payDownDebt(scopedPrisma, input.businessId, debt, amountApplied, input.whatsappMessageId));
    remaining -= amountApplied;
  }

  return settlements;
}

export async function findOrCreateCustomerByName(scopedPrisma: TenantScopedClient, businessId: string, name: string) {
  const existing = await scopedPrisma.customer.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (existing) return existing;

  return scopedPrisma.customer.create({ data: { businessId, name } });
}

/**
 * Non-creating counterpart to findOrCreateCustomerByName, for call sites
 * where auto-creating a customer would be wrong — e.g. /forgetcustomer
 * (commandRouter.ts): a deletion request only makes sense against a customer
 * who already exists, and silently creating a fresh (non-anonymized) row
 * just to immediately flag it for deletion would be a confusing no-op at
 * best and a data-integrity footgun at worst.
 */
export async function findCustomerByName(scopedPrisma: TenantScopedClient, name: string) {
  return scopedPrisma.customer.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
}

export async function listOpenDebtsForCustomer(scopedPrisma: TenantScopedClient, customerId: string) {
  return scopedPrisma.debt.findMany({
    where: { customerId, status: { in: ["OPEN", "PARTIALLY_PAID"] } },
    orderBy: { createdAt: "asc" },
  });
}
