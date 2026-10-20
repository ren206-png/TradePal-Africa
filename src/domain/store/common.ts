import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { TenantScopedClient } from "../../db/tenantScope.js";
import { isFeatureEnabled } from "../featureFlags.js";

/**
 * B2C storefront (expansion Phase 4). The seller is responsible for goods and fulfilment; TradePal provides the
 * storefront, the order record and the accounting. A shopper's only credential is an unguessable token (never a sequential
 * id and never a phone number alone).
 */
export const FLAG_STOREFRONT = "storefront";
export const FLAG_ONLINE_PAYMENT = "storefrontOnlinePayment";

export type StoreErrorCode =
  | "NOT_FOUND" | "INVALID" | "WRONG_STATE" | "UNAVAILABLE" | "NOT_ALLOWED" | "OVER_QUANTITY" | "PAYMENT_REQUIRED" | "OVER_PAYMENT" | "BAD_CODE"
  | "REFUND_LIMIT" | "FEATURE_OFF" | "SIMULATOR_FORBIDDEN" | "DUPLICATE" | "NOT_READY" | "SUSPENDED" | "NOT_LISTED" | "UNPUBLISHED" | "BUSY";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details: unknown;
  constructor(code: StoreErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const newToken = (): string => randomBytes(24).toString("hex");
export const newPickupCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/**
 * E.164 digits (no '+') for a shopper's phone. A leading '+' or '00' means the number already carries its country code; a
 * single leading '0' is the national trunk prefix and is replaced with the seller's country calling code. Anything that is
 * not 8 to 15 digits is refused. A phone prefix is never treated as proof of the shopper's country: it is only a contact number.
 */
export function toE164(input: string, defaultCallingCode: string): string | null {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  let full: string;
  if (raw.startsWith("+")) full = digits;
  else if (digits.startsWith("00")) full = digits.slice(2);
  else if (digits.startsWith("0")) full = defaultCallingCode + digits.slice(1);
  else full = digits.startsWith(defaultCallingCode) ? digits : defaultCallingCode + digits;
  return full.length >= 8 && full.length <= 15 ? full : null;
}

/** Is the seller allowed to be public right now? Enabled storefront, flag on, business not suspended. */
export async function loadPublicStorefront(prisma: PrismaClient, slug: string) {
  const sf = await prisma.storefront.findUnique({ where: { slug: slug.toLowerCase() }, include: { business: { include: { country: true } } } });
  if (!sf || !sf.enabled || sf.marketplaceStatus === "SUSPENDED" || sf.business.status !== "ACTIVE") return null;
  const scoped = (await import("../../db/tenantScope.js")).getTenantScopedClient(prisma, sf.businessId);
  if (!(await isFeatureEnabled(scoped, sf.businessId, FLAG_STOREFRONT))) return null;
  return sf;
}

/** Same check by business id (used when a basket line or order is acted on after the shopper first saw the shop). */
export async function loadPublicStorefrontById(prisma: PrismaClient, businessId: string) {
  const sf = await prisma.storefront.findFirst({ where: { businessId }, include: { business: { include: { country: true } } } });
  if (!sf || !sf.enabled || sf.marketplaceStatus === "SUSPENDED" || sf.business.status !== "ACTIVE") return null;
  const scoped = (await import("../../db/tenantScope.js")).getTenantScopedClient(prisma, businessId);
  if (!(await isFeatureEnabled(scoped, businessId, FLAG_STOREFRONT))) return null;
  return sf;
}

export async function nextStoreReference(scoped: TenantScopedClient): Promise<string> {
  const rows = await scoped.storeOrder.findMany({ where: { reference: { startsWith: "ORD-" } }, select: { reference: true } });
  let max = 0;
  for (const r of rows) {
    const n = Number(r.reference.slice(4));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `ORD-${String(max + 1).padStart(6, "0")}`;
}

export const isUniqueViolation = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";

/**
 * The payment simulator may take a checkout only outside production. It moves no money, but a "pay" button that marks an order
 * paid must never exist on the live site, whatever the flags say.
 */
export function simulatedPaymentsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NODE_ENV"] !== "production" && env["STOREFRONT_SIMULATOR_ENABLED"] === "true";
}
