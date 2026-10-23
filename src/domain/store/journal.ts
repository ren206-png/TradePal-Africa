import type { StoreOrder, TradePaymentMethod } from "@prisma/client";
import type { TenantScopedClient } from "../../db/tenantScope.js";
import { accountForMethod, postJournal, type PaymentMethod, type SystemAccountKey } from "../accounting.js";
import { isFeatureEnabled } from "../featureFlags.js";

/**
 * Store-order accounting (flag `accountingJournals`). Every payment is booked FIRST as a customer advance (a liability: the
 * seller has not yet delivered), whenever it arrives. Revenue is recognised only at hand-over (collected or delivered):
 *
 *   payment in            Dr cash / wallet / bank (or Provider clearing if a provider collected it)   Cr Customer advances
 *   hand-over             Dr Customer advances (total)   Cr Sales (items)   Cr Delivery fees (fee)        [+ COGS from stock]
 *   refund before hand-over   Dr Customer advances   Cr cash / wallet / bank (or Provider clearing)
 *   refund after hand-over    Dr Sales returns        Cr cash / wallet / bank (or Provider clearing)       [+ restock, Dr Inventory Cr COGS]
 *
 * A payment held as an exception is still money the seller holds, so it is booked as an advance too; it simply is not applied
 * to the order until resolved.
 */
const enabled = (tx: TenantScopedClient, businessId: string) => isFeatureEnabled(tx, businessId, "accountingJournals");

const methodAccount = (method: TradePaymentMethod, clearing: boolean): SystemAccountKey => (clearing ? "PROVIDER_CLEARING" : accountForMethod(method as PaymentMethod));

export async function journalStorePaymentIn(
  tx: TenantScopedClient,
  input: { businessId: string; currencyCode: string; amountMinor: bigint; method: TradePaymentMethod; clearing: boolean; paymentId: string; now: Date; evidenceRef?: string | null },
): Promise<void> {
  if (!(await enabled(tx, input.businessId))) return;
  await postJournal(tx, {
    businessId: input.businessId, currencyCode: input.currencyCode, kind: "CUSTOMER_ADVANCE", occurredAt: input.now, idempotencyKey: `store-pay:${input.paymentId}`,
    source: { type: "STORE_PAYMENT", id: input.paymentId }, memo: "Payment received on a store order", ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
    lines: [{ account: methodAccount(input.method, input.clearing), debitMinor: input.amountMinor }, { account: "CUSTOMER_ADVANCES", creditMinor: input.amountMinor }],
  });
}

export async function journalStoreHandover(tx: TenantScopedClient, order: StoreOrder, now: Date): Promise<void> {
  if (!(await enabled(tx, order.businessId))) return;
  await postJournal(tx, {
    businessId: order.businessId, currencyCode: order.currencyCode, kind: "SALE", occurredAt: now, idempotencyKey: `store-sale:${order.id}`,
    source: { type: "STORE_ORDER", id: order.id }, memo: `Order ${order.reference} handed over`,
    lines: [
      { account: "CUSTOMER_ADVANCES", debitMinor: order.totalMinor },
      { account: "SALES_REVENUE", creditMinor: order.subtotalMinor },
      ...(order.deliveryFeeMinor > 0n ? [{ account: "DELIVERY_FEES" as const, creditMinor: order.deliveryFeeMinor }] : []),
    ],
  });
}

export async function journalStoreRefund(
  tx: TenantScopedClient,
  input: { order: StoreOrder; amountMinor: bigint; method: TradePaymentMethod; clearing: boolean; paymentId: string; now: Date; afterHandover: boolean },
): Promise<void> {
  if (!(await enabled(tx, input.order.businessId))) return;
  await postJournal(tx, {
    businessId: input.order.businessId, currencyCode: input.order.currencyCode, kind: "REFUND", occurredAt: input.now, idempotencyKey: `store-refund:${input.paymentId}`,
    source: { type: "STORE_PAYMENT", id: input.paymentId }, memo: `Refund on order ${input.order.reference}`,
    lines: [
      { account: input.afterHandover ? "SALES_RETURNS" : "CUSTOMER_ADVANCES", debitMinor: input.amountMinor },
      { account: methodAccount(input.method, input.clearing), creditMinor: input.amountMinor },
    ],
  });
}
