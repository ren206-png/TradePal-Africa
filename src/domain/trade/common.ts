import { createHash, randomBytes } from "node:crypto";
import type { TradeSide } from "@prisma/client";
import type { TenantScopedClient } from "../../db/tenantScope.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { divRoundHalfUp } from "../rounding.js";

/**
 * B2B trade (expansion Phase 3). Every business owns its OWN row of each document; the buyer's purchase order and the
 * seller's sales order are linked by counterpart ids and kept in step by outbox events that copy agreed fields only.
 * A business never reads the other's books. Cost prices are never part of any shared document.
 */
export const FLAG_TRADE = "tradeOrders";
export const FLAG_STOCK = "stockV2";
export const FLAG_JOURNALS = "accountingJournals";

export type TradeErrorCode =
  | "FEATURE_OFF" | "NOT_FOUND" | "INVALID" | "WRONG_STATE" | "NOT_LINKED" | "LINK_REVOKED" | "FORBIDDEN_PARTY" | "DUPLICATE"
  | "EXPIRED" | "CREDIT_BLOCKED" | "REQUIRES_STOCK" | "RESERVATION_CLOSED" | "OVER_QUANTITY" | "OVER_PAYMENT" | "CURRENCY_MISMATCH" | "UNPRICED" | "DUPLICATE_SUSPECTED";

export class TradeError extends Error {
  readonly code: TradeErrorCode;
  readonly details: unknown;
  constructor(code: TradeErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export async function requireTradeEnabled(scoped: TenantScopedClient, businessId: string): Promise<void> {
  if (!(await isFeatureEnabled(scoped, businessId, FLAG_TRADE))) throw new TradeError("FEATURE_OFF", "Trade orders are not turned on for this business.");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Value of the first `cumBase` base units of a line whose full quantity is `orderedBase` and full value `lineTotal`,
 * rounded half away from zero. Charging each shipment (or booking each receipt) as value(cum_k) - value(cum_{k-1})
 * makes the parts add up to the line total EXACTLY once everything has moved: totals can never drift by a minor unit.
 */
export function cumulativeValue(lineTotalMinor: bigint, orderedBase: number, cumBase: number): bigint {
  if (cumBase <= 0) return 0n;
  if (cumBase >= orderedBase) return lineTotalMinor;
  return divRoundHalfUp(lineTotalMinor * BigInt(cumBase), BigInt(orderedBase));
}

/** Next document number for a business: PREFIX-000001, one higher than the highest in use. */
export async function nextReference(scoped: TenantScopedClient, side: TradeSide, kind: "order" | "invoice" | "credit"): Promise<string> {
  const prefix = kind === "order" ? (side === "BUY" ? "PO" : "SO") : kind === "invoice" ? (side === "SELL" ? "INV" : "BILL") : side === "SELL" ? "CN" : "CNR";
  const rows =
    kind === "order"
      ? await scoped.tradeOrder.findMany({ where: { reference: { startsWith: `${prefix}-` } }, select: { reference: true } })
      : kind === "invoice"
        ? await scoped.tradeInvoice.findMany({ where: { number: { startsWith: `${prefix}-` } }, select: { number: true } })
        : await scoped.creditNote.findMany({ where: { number: { startsWith: `${prefix}-` } }, select: { number: true } });
  let max = 0;
  for (const r of rows) {
    const text = "reference" in r ? r.reference : r.number;
    const n = Number(text.slice(prefix.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(6, "0")}`;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
