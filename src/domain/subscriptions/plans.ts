import type { PlanPrice, PlanVersion, PrismaClient } from "@prisma/client";
import { BillingError } from "./common.js";

/**
 * Versioned plans with country prices (expansion section 13). A plan VERSION is a snapshot of what the plan includes (period length, grace
 * days, premium features, caps); it is editable only while DRAFT, and once published it and its prices are frozen by the database. A new
 * version is the only way to change what a plan includes or costs, and an existing subscriber stays on the version they bought until they
 * renew onto a newer one. There are NO default prices: nothing can be sold until a person enters a price for a country and publishes.
 */
export interface PlanVersionInput {
  planCode: string;
  features?: string[];
  billingPeriodDays?: number;
  graceDays?: number;
  entryCapPerMonth?: number | null;
  voiceEnabled?: boolean;
  staffCapCount?: number | null;
  aiDeepseekMonthlyBudgetMicroUsd?: bigint | null;
  note?: string;
  createdBy?: string;
}

export const KNOWN_FEATURES = ["trade", "marketplace", "reorder", "storefront", "voice"] as const;

export async function createPlanVersion(prisma: PrismaClient, input: PlanVersionInput): Promise<PlanVersion> {
  if (!(await prisma.plan.findUnique({ where: { code: input.planCode } }))) throw new BillingError("NOT_FOUND", `Plan '${input.planCode}' does not exist.`);
  const features = [...new Set(input.features ?? [])];
  const unknown = features.filter((f) => !(KNOWN_FEATURES as readonly string[]).includes(f));
  if (unknown.length) throw new BillingError("INVALID", `Unknown feature(s): ${unknown.join(", ")}. Known: ${KNOWN_FEATURES.join(", ")}.`);
  const period = input.billingPeriodDays ?? 30;
  const grace = input.graceDays ?? 3;
  if (!Number.isInteger(period) || period < 1 || period > 366) throw new BillingError("INVALID", "The billing period must be 1 to 366 days.");
  if (!Number.isInteger(grace) || grace < 0 || grace > 30) throw new BillingError("INVALID", "The grace period must be 0 to 30 days.");
  const last = await prisma.planVersion.findFirst({ where: { planCode: input.planCode }, orderBy: { version: "desc" }, select: { version: true } });
  return prisma.planVersion.create({
    data: {
      planCode: input.planCode, version: (last?.version ?? 0) + 1, features, billingPeriodDays: period, graceDays: grace,
      entryCapPerMonth: input.entryCapPerMonth ?? null, voiceEnabled: input.voiceEnabled ?? false, staffCapCount: input.staffCapCount ?? null,
      aiDeepseekMonthlyBudgetMicroUsd: input.aiDeepseekMonthlyBudgetMicroUsd ?? null, note: input.note ?? null, createdBy: input.createdBy ?? null,
    },
  });
}

/** Sets a country price on a DRAFT version. The currency must be that country's own currency; the database refuses prices on a published version. */
export async function setPlanPrice(prisma: PrismaClient, input: { planVersionId: string; countryCode: string; priceMinor: bigint }): Promise<PlanPrice> {
  const v = await prisma.planVersion.findUnique({ where: { id: input.planVersionId } });
  if (!v) throw new BillingError("NOT_FOUND", "No such plan version.");
  if (v.status !== "DRAFT") throw new BillingError("FROZEN", "A published plan version cannot be changed. Create a new version.");
  const country = await prisma.country.findUnique({ where: { code: input.countryCode } });
  if (!country) throw new BillingError("NOT_FOUND", `Unknown country '${input.countryCode}'.`);
  if (input.priceMinor <= 0n) throw new BillingError("INVALID", "A price must be more than zero.");
  const existing = await prisma.planPrice.findUnique({ where: { planVersionId_countryCode: { planVersionId: v.id, countryCode: country.code } } });
  if (existing) return prisma.planPrice.update({ where: { id: existing.id }, data: { priceMinor: input.priceMinor, currencyCode: country.defaultCurrency } });
  return prisma.planPrice.create({ data: { planVersionId: v.id, countryCode: country.code, currencyCode: country.defaultCurrency, priceMinor: input.priceMinor } });
}

export async function publishPlanVersion(prisma: PrismaClient, planVersionId: string): Promise<PlanVersion> {
  const v = await prisma.planVersion.findUnique({ where: { id: planVersionId }, include: { prices: true } });
  if (!v) throw new BillingError("NOT_FOUND", "No such plan version.");
  if (v.prices.length === 0) throw new BillingError("INVALID", "Set at least one country price before publishing.");
  const done = await prisma.planVersion.updateMany({ where: { id: planVersionId, status: "DRAFT" }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  if (done.count !== 1) throw new BillingError("WRONG_STATE", "Only a draft version can be published.");
  return prisma.planVersion.findUniqueOrThrow({ where: { id: planVersionId } });
}

export async function retirePlanVersion(prisma: PrismaClient, planVersionId: string): Promise<void> {
  const done = await prisma.planVersion.updateMany({ where: { id: planVersionId, status: "PUBLISHED" }, data: { status: "RETIRED", retiredAt: new Date() } });
  if (done.count !== 1) throw new BillingError("WRONG_STATE", "Only a published version can be retired.");
}

/** The newest PUBLISHED version of a plan that has a price in this country. */
export async function currentVersionFor(prisma: PrismaClient, planCode: string, countryCode: string): Promise<(PlanVersion & { price: PlanPrice }) | null> {
  const versions = await prisma.planVersion.findMany({ where: { planCode, status: "PUBLISHED", prices: { some: { countryCode } } }, orderBy: { version: "desc" }, take: 1, include: { prices: { where: { countryCode } } } });
  const v = versions[0];
  return v ? { ...v, price: v.prices[0]! } : null;
}

/** What a merchant in a country can buy right now: every plan's newest published version with its price there. */
export async function offeredPlans(prisma: PrismaClient, countryCode: string) {
  const plans = await prisma.plan.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true } });
  const out: { planCode: string; name: string; versionId: string; version: number; priceMinor: bigint; currencyCode: string; features: string[]; billingPeriodDays: number; graceDays: number }[] = [];
  for (const p of plans) {
    const v = await currentVersionFor(prisma, p.code, countryCode);
    if (v) out.push({ planCode: p.code, name: p.name, versionId: v.id, version: v.version, priceMinor: v.price.priceMinor, currencyCode: v.price.currencyCode, features: v.features, billingPeriodDays: v.billingPeriodDays, graceDays: v.graceDays });
  }
  return out;
}
