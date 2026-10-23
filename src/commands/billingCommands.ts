import type { CommandContext } from "./commandRouter.js";
import { canMerchant, membershipRoleForLegacyMerchantRole, type MerchantPermission } from "../auth/permissions.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { formatMoney } from "../domain/money.js";
import { BillingError, FLAG_PAWAPAY_BILLING } from "../domain/subscriptions/common.js";
import { getEntitlement } from "../domain/subscriptions/entitlements.js";
import { offeredPlans } from "../domain/subscriptions/plans.js";
import { requestCancellation, schedulePlanChange, startRenewal } from "../domain/subscriptions/renewal.js";

/**
 * The owner's WhatsApp commands for TradePal's OWN subscription billing (expansion Phase 6), behind the `pawapayBilling` flag (default
 * OFF; while off they answer exactly as any unknown command). The renewal is customer-authorised: the payer gets a PIN prompt on their
 * phone, nothing is ever charged unattended, and the number is used once and not kept (only its last four digits).
 *   /plans              the plans on offer in your country (only what has a published price)
 *   /billing            your plan, when it ends, grace, and recent invoices
 *   /renew <number> [plan]   start a renewal payment (the number is the mobile-money wallet that will pay)
 *   /changeplan <plan>  switch plan from the next renewal (nothing is charged or prorated now)
 *   /cancelplan         stop renewing; access continues to the end of the paid period
 */
export const BILLING_COMMANDS = new Set(["/plans", "/billing", "/renew", "/changeplan", "/cancelplan"]);

const can = (ctx: CommandContext, p: MerchantPermission) => canMerchant(membershipRoleForLegacyMerchantRole(ctx.merchantRole), p);
const NOT_ALLOWED = "Only the owner can manage the subscription.";
const day = (d: Date) => d.toISOString().slice(0, 10);

export async function handleBillingCommand(ctx: CommandContext, command: string, args: string): Promise<string | null> {
  if (!BILLING_COMMANDS.has(command)) return null;
  if (!(await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, FLAG_PAWAPAY_BILLING))) return null;
  try {
    switch (command) {
      case "/plans": return can(ctx, "billing:view") ? await plans(ctx) : NOT_ALLOWED;
      case "/billing": return can(ctx, "billing:view") ? await status(ctx) : NOT_ALLOWED;
      case "/renew": return can(ctx, "billing:manage") ? await renew(ctx, args) : NOT_ALLOWED;
      case "/changeplan": return can(ctx, "billing:manage") ? await changePlan(ctx, args) : NOT_ALLOWED;
      case "/cancelplan": return can(ctx, "billing:manage") ? await cancel(ctx) : NOT_ALLOWED;
      default: return null;
    }
  } catch (error) {
    if (error instanceof BillingError) return error.message;
    throw error;
  }
}

async function plans(ctx: CommandContext): Promise<string> {
  const business = await ctx.prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId } });
  const offered = await offeredPlans(ctx.prisma, business.countryCode);
  if (offered.length === 0) return "No plans are on offer in your country yet.";
  return [
    "Plans you can choose:",
    ...offered.map((p) => `${p.planCode} (${p.name}): ${formatMoney(p.priceMinor, ctx.minorUnitExp)} ${p.currencyCode} per ${p.billingPeriodDays} days. Includes: ${p.features.length ? p.features.join(", ") : "the basics"}. ${p.graceDays} day(s) of grace after it ends.`),
    "To pay: /renew <your mobile-money number> <plan code>",
  ].join("\n");
}

async function status(ctx: CommandContext): Promise<string> {
  const ent = await getEntitlement(ctx.scopedPrisma, ctx.businessId);
  const sub = await ctx.scopedPrisma.subscription.findFirst({ where: { businessId: ctx.businessId, status: { in: ["ACTIVE", "PAST_DUE", "PENDING"] } }, orderBy: { currentPeriodEnd: "desc" } });
  const invoices = sub ? await ctx.prisma.invoice.findMany({ where: { subscriptionId: sub.id, providerCode: "PAWAPAY" }, orderBy: { createdAt: "desc" }, take: 3 }) : [];
  const lines: string[] = [];
  switch (ent.state) {
    case "FREE": lines.push("You are on the FREE plan."); break;
    case "ACTIVE": lines.push(`Your ${ent.planCode} plan is active until ${day(ent.periodEnd!)}.${sub?.cancelAtPeriodEnd ? " It will not renew." : ""}`); break;
    case "GRACE": lines.push(`Your ${ent.planCode} plan ended on ${day(ent.periodEnd!)}. You are in a grace period until ${day(ent.graceEndsAt!)}: everything still works. Renew with /renew.`); break;
    case "EXPIRED": lines.push(`Your ${ent.planCode} plan ended on ${day(ent.periodEnd!)}. New orders, publishing and rules are paused; everything already in progress and all your records are untouched. Renew with /renew.`); break;
    case "SECURITY_SUSPENDED": lines.push("Your account is suspended by TradePal. Please contact TradePal support."); break;
  }
  for (const i of invoices) lines.push(`${i.reference}: ${formatMoney(i.amountMinor, ctx.minorUnitExp)} ${i.currencyCode}, ${i.status.toLowerCase().replace(/_/g, " ")}${i.refundedMinor > 0n ? `, refunded ${formatMoney(i.refundedMinor, ctx.minorUnitExp)}` : ""}`);
  return lines.join("\n");
}

async function renew(ctx: CommandContext, args: string): Promise<string> {
  const [phone, planCode] = args.trim().split(/\s+/);
  if (!phone) return "Give the mobile-money number that will pay: /renew <number> [plan code]. See /plans.";
  const r = await startRenewal(ctx.prisma, { businessId: ctx.businessId, merchantId: ctx.merchantId, payerPhone: phone, ...(planCode ? { planCode: planCode.toUpperCase() } : {}) });
  return [
    `Payment request ${r.invoiceReference} sent to ${r.providerName} number ending ${r.payerLast4}: ${r.amountText} ${r.currencyCode} for ${r.planCode}.`,
    "Approve it with your PIN on that phone. Your subscription updates by itself once the payment is confirmed. Nothing is charged until you approve, and nothing is ever charged automatically.",
  ].join("\n");
}

async function changePlan(ctx: CommandContext, args: string): Promise<string> {
  const planCode = args.trim().toUpperCase();
  if (!planCode) return "Say which plan: /changeplan <plan code>. See /plans.";
  const r = await schedulePlanChange(ctx.prisma, { businessId: ctx.businessId, planCode, actorId: ctx.merchantId });
  return `Done: from ${day(r.effectiveAt)} you will be on ${r.planCode}. Nothing is charged or reduced now; you keep your current plan until then. Renew with /renew when the time comes.`;
}

async function cancel(ctx: CommandContext): Promise<string> {
  const r = await requestCancellation(ctx.prisma, { businessId: ctx.businessId, actorId: ctx.merchantId });
  return `Your subscription will not renew. You keep everything until ${day(r.endsAt)}. Your records stay and can be exported. Renew any time with /renew.`;
}
