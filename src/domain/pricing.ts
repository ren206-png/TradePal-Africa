import type { PriceRule } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { normalizeKey } from "./catalog.js";

/**
 * Deterministic price resolution (expansion Phase 2). Given a price list, a variant, a unit and a quantity it
 * returns exactly one unit price or throws a typed PriceError: never a guess, never a silent fallback to another list.
 *
 * Rules:
 *  1. The list must be ACTIVE and inside its validity window at `at`; otherwise LIST_INACTIVE.
 *  2. Only ACTIVE rules inside their own window count. If the variant has rules but none is currently valid: EXPIRED.
 *  3. Quantity breaks: among valid rules for the SAME unit whose minQuantity <= quantity, the one with the highest
 *     minQuantity wins (ties: lower price, then id). The line total is quantity x unit price, exact integer math.
 *  4. A pack with no rule of its own may be priced from a base-unit rule (unit price x pack size, flagged
 *     derivedFromBase), measuring the break against the quantity in BASE units. The reverse is never derived.
 *  5. Below the smallest minimum: BELOW_MINIMUM with the minimum stated (this is how wholesale minimums are enforced).
 *  6. Nothing applies at all: NO_PRICE. A unit with no declared conversion: UNIT_NOT_DECLARED.
 */
export class PriceError extends Error {
  readonly code: "NO_PRICE" | "BELOW_MINIMUM" | "EXPIRED" | "LIST_INACTIVE" | "CURRENCY_MISMATCH" | "UNIT_NOT_DECLARED" | "INVALID_QUANTITY" | "NOT_FOUND";
  readonly minimumQuantity: number | undefined;
  constructor(code: PriceError["code"], message: string, minimumQuantity?: number) {
    super(message);
    this.code = code;
    this.minimumQuantity = minimumQuantity;
  }
}

export interface ResolvedPrice {
  priceListId: string;
  ruleId: string;
  currencyCode: string;
  unit: string;
  quantity: number;
  baseQuantity: number;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
  derivedFromBase: boolean;
  /** The minQuantity of the break that applied (in the unit that was priced). */
  breakMinQuantity: number;
}

function inWindow(from: Date | null, to: Date | null, at: Date): boolean {
  return (!from || from <= at) && (!to || to > at);
}

function bestRule(rules: readonly PriceRule[], quantity: number): PriceRule | undefined {
  return rules
    .filter((r) => r.minQuantity <= quantity)
    .sort((a, b) => b.minQuantity - a.minQuantity || (a.unitPriceMinor < b.unitPriceMinor ? -1 : a.unitPriceMinor > b.unitPriceMinor ? 1 : 0) || (a.id < b.id ? -1 : 1))[0];
}

export interface ResolvePriceInput {
  priceListId: string;
  variantId: string;
  quantity: number;
  /** Pack name (carton, bag...) or the base unit; omitted = base unit. */
  unit?: string | null;
  at?: Date;
  /** When given, the list's currency must match (a stale or mixed-currency basket is refused). */
  currencyCode?: string;
}

export async function resolvePrice(scoped: TenantScopedClient, input: ResolvePriceInput): Promise<ResolvedPrice> {
  const at = input.at ?? new Date();
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new PriceError("INVALID_QUANTITY", "Quantity must be a positive whole number.");

  const list = await scoped.priceList.findUnique({ where: { id: input.priceListId } });
  const variant = await scoped.productVariant.findUnique({ where: { id: input.variantId } });
  if (!list || !variant) throw new PriceError("NOT_FOUND", "Price list or variant not found.");
  if (list.status !== "ACTIVE" || !inWindow(list.validFrom, list.validTo, at)) {
    throw new PriceError("LIST_INACTIVE", `Price list '${list.name}' is not active right now.`);
  }
  if (input.currencyCode && input.currencyCode !== list.currencyCode) {
    throw new PriceError("CURRENCY_MISMATCH", `Price list '${list.name}' is in ${list.currencyCode}, not ${input.currencyCode}.`);
  }

  const wanted = input.unit ? normalizeKey(input.unit) : variant.baseUnit;
  const pack = wanted === variant.baseUnit ? null : await scoped.packConversion.findFirst({ where: { variantId: variant.id, normalizedName: wanted } });
  if (wanted !== variant.baseUnit && !pack) {
    throw new PriceError("UNIT_NOT_DECLARED", `'${input.unit}' has no declared conversion to ${variant.baseUnit}.`);
  }
  const baseQuantity = input.quantity * (pack?.baseQuantity ?? 1);

  const allRules = await scoped.priceRule.findMany({ where: { priceListId: list.id, variantId: variant.id } });
  const valid = allRules.filter((r) => r.status === "ACTIVE" && inWindow(r.validFrom, r.validTo, at));
  if (allRules.length > 0 && valid.length === 0) {
    throw new PriceError("EXPIRED", `Every price for ${variant.sku} on '${list.name}' has expired or been retired.`);
  }

  const ownUnit = valid.filter((r) => (r.packConversionId ?? null) === (pack?.id ?? null));
  const direct = bestRule(ownUnit, input.quantity);
  let chosen: PriceRule | undefined = direct;
  let unitPrice = direct?.unitPriceMinor;
  let derived = false;
  if (!direct && pack) {
    const baseRules = valid.filter((r) => r.packConversionId === null);
    const fromBase = bestRule(baseRules, baseQuantity);
    if (fromBase) {
      chosen = fromBase;
      unitPrice = fromBase.unitPriceMinor * BigInt(pack.baseQuantity);
      derived = true;
    }
  }

  if (!chosen || unitPrice === undefined) {
    // Is there a rule that would apply at a higher quantity? Then the order is below the minimum.
    const minima: number[] = [];
    for (const r of ownUnit) minima.push(r.minQuantity);
    if (pack) for (const r of valid.filter((x) => x.packConversionId === null)) minima.push(Math.ceil(r.minQuantity / pack.baseQuantity));
    const above = minima.filter((m) => m > input.quantity);
    if (above.length > 0) {
      const minimum = Math.min(...above);
      throw new PriceError("BELOW_MINIMUM", `The minimum order is ${minimum} ${wanted} for ${variant.sku} on '${list.name}'.`, minimum);
    }
    throw new PriceError("NO_PRICE", `${variant.sku} has no price in ${wanted} on '${list.name}'.`);
  }

  return {
    priceListId: list.id,
    ruleId: chosen.id,
    currencyCode: list.currencyCode,
    unit: wanted,
    quantity: input.quantity,
    baseQuantity,
    unitPriceMinor: unitPrice,
    lineTotalMinor: unitPrice * BigInt(input.quantity),
    derivedFromBase: derived,
    breakMinQuantity: chosen.minQuantity,
  };
}

export interface CreatePriceListInput {
  businessId: string;
  name: string;
  kind: "RETAIL" | "WHOLESALE" | "CUSTOMER";
  currencyCode: string;
  customerId?: string;
  validFrom?: Date;
  validTo?: Date;
}

export async function createPriceList(scoped: TenantScopedClient, input: CreatePriceListInput) {
  if (!input.name.trim()) throw new PriceError("NOT_FOUND", "A price list needs a name.");
  if (input.kind === "CUSTOMER" && !input.customerId) throw new PriceError("NOT_FOUND", "A customer price list needs a customer.");
  if (input.kind !== "CUSTOMER" && input.customerId) throw new PriceError("NOT_FOUND", "Only a customer price list names a customer.");
  if (input.validFrom && input.validTo && input.validTo <= input.validFrom) throw new PriceError("INVALID_QUANTITY", "validTo must be after validFrom.");
  return scoped.priceList.create({
    data: {
      businessId: input.businessId,
      name: input.name.trim(),
      kind: input.kind,
      currencyCode: input.currencyCode,
      customerId: input.customerId ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
    },
  });
}

export interface AddPriceRuleInput {
  businessId: string;
  priceListId: string;
  variantId: string;
  unitPriceMinor: bigint;
  minQuantity?: number;
  /** Pack name; omitted = base unit. Must be a declared pack of the variant. */
  unit?: string;
  validFrom?: Date;
  validTo?: Date;
}

export async function addPriceRule(scoped: TenantScopedClient, input: AddPriceRuleInput): Promise<PriceRule> {
  if (input.unitPriceMinor <= 0n) throw new PriceError("NO_PRICE", "A price must be greater than zero.");
  const minQuantity = input.minQuantity ?? 1;
  if (!Number.isInteger(minQuantity) || minQuantity < 1) throw new PriceError("INVALID_QUANTITY", "The minimum quantity must be a whole number of at least 1.");
  if (input.validFrom && input.validTo && input.validTo <= input.validFrom) throw new PriceError("INVALID_QUANTITY", "validTo must be after validFrom.");
  const variant = await scoped.productVariant.findUnique({ where: { id: input.variantId } });
  const list = await scoped.priceList.findUnique({ where: { id: input.priceListId } });
  if (!variant || !list) throw new PriceError("NOT_FOUND", "Price list or variant not found.");
  let packConversionId: string | null = null;
  if (input.unit && normalizeKey(input.unit) !== variant.baseUnit) {
    const pack = await scoped.packConversion.findFirst({ where: { variantId: variant.id, normalizedName: normalizeKey(input.unit) } });
    if (!pack) throw new PriceError("UNIT_NOT_DECLARED", `'${input.unit}' is not a declared pack of ${variant.sku}.`);
    packConversionId = pack.id;
  }
  return scoped.priceRule.create({
    data: {
      businessId: input.businessId,
      priceListId: list.id,
      variantId: variant.id,
      packConversionId,
      minQuantity,
      unitPriceMinor: input.unitPriceMinor,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
    },
  });
}

export async function retirePriceRule(scoped: TenantScopedClient, ruleId: string): Promise<PriceRule> {
  return scoped.priceRule.update({ where: { id: ruleId }, data: { status: "RETIRED" } });
}
