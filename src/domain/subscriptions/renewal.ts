import { randomUUID } from "node:crypto";
import type { Invoice, PlanPrice, PlanVersion, PrismaClient, Subscription } from "@prisma/client";
import { getTenantScopedClient } from "../../db/tenantScope.js";
import { getPawaPayCountryForCurrency } from "../../pawapay/countries.js";
import {
  PawaPayApiError, getActiveConfiguration, getAvailability, initiateDeposit, predictProvider, type ActiveConfigurationResult, type PawaPayDeps,
} from "../../pawapay/client.js";
import { assertProviderAllowedForPurpose } from "../paymentPurpose.js";
import { recordAuditLog } from "../auditLog.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { formatMoney } from "../money.js";
import {
  ACTIVE_BILLING_ATTEMPT_STATUSES, BillingError, DAY_MS, EARLY_RENEWAL_WINDOW_DAYS, FLAG_PAWAPAY_BILLING, INVOICE_DUE_DAYS, INVOICE_OPEN, PROVIDER, SWITCH_PROVIDER,
  getBillingConfig, newInvoiceReference, pollDelayMs, raiseBillingException, type BillingConfig,
} from "./common.js";
import { currentVersionFor } from "./plans.js";

/**
 * Customer-authorised subscription renewal through pawaPay (expansion section 13). There is NO recurring mandate and nothing is ever
 * charged unattended: each renewal is one deposit whose PIN prompt goes to the payer's phone, so the payer authorises every charge.
 * Money here is TradePal's own subscription revenue: it never touches a merchant's ledger, stock or payment records (tested).
 */

// ------------------------------------------------------------------------------------ gates

export interface BillingGate {
  config: BillingConfig;
  countryAlpha2: string;
}

/**
 * Whether a NEW charge may be started for this business. Every condition fails closed, in this order: the business flag, a valid
 * and consistent pawaPay configuration, production activation (in production), and the per-country/provider/purpose switch.
 * Reconciling and servicing EXISTING attempts never calls this: they must keep working when new charges are switched off.
 */
export async function assertNewChargeAllowed(prisma: PrismaClient, businessId: string): Promise<BillingGate> {
  assertProviderAllowedForPurpose(SWITCH_PROVIDER, "PLATFORM_SUBSCRIPTION");
  const scoped = getTenantScopedClient(prisma, businessId);
  if (!(await isFeatureEnabled(scoped, businessId, FLAG_PAWAPAY_BILLING))) throw new BillingError("NOT_AVAILABLE", "Subscription payments are not available for your account yet.");
  const cfg = getBillingConfig();
  if (!cfg.ok) throw new BillingError("NOT_CONFIGURED", "Subscription payments are not available right now.", { reason: cfg.reason });
  if (cfg.config.nodeEnv === "production" && !cfg.config.productionActivated) throw new BillingError("NOT_ACTIVATED", "Subscription payments are not available right now.", { reason: "production not activated" });
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { countryCode: true, status: true } });
  const sw = await prisma.billingSwitch.findUnique({ where: { provider_countryCode_purpose: { provider: SWITCH_PROVIDER, countryCode: business.countryCode, purpose: "PLATFORM_SUBSCRIPTION" } } });
  if (!sw || !sw.newAttemptsEnabled) throw new BillingError("SWITCHED_OFF", "Subscription payments are not available in your country right now.");
  return { config: cfg.config, countryAlpha2: business.countryCode };
}

const CONFIG_TTL_MS = 10 * 60_000;
const confCache = new Map<string, { value: ActiveConfigurationResult; expires: number }>();
export function resetBillingConfCacheForTests(): void {
  confCache.clear();
}
export async function activeConf(deps: PawaPayDeps, country: string): Promise<ActiveConfigurationResult> {
  const key = `${deps.apiBaseUrl ?? "sandbox"}|${country}`;
  const hit = confCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await getActiveConfiguration(deps, country, "DEPOSIT");
  confCache.set(key, { value, expires: Date.now() + CONFIG_TTL_MS });
  return value;
}

/** Binds an environment to the account it first authenticated as; a different company later means the wrong credentials are in use. */
async function checkAccountBinding(prisma: PrismaClient, cfg: BillingConfig, companyName: string): Promise<void> {
  await prisma.billingAccountBinding.createMany({ data: [{ provider: SWITCH_PROVIDER, environment: cfg.environment, companyName }], skipDuplicates: true });
  const bound = await prisma.billingAccountBinding.findUniqueOrThrow({ where: { provider_environment: { provider: SWITCH_PROVIDER, environment: cfg.environment } } });
  if (bound.companyName !== companyName) {
    await raiseBillingException(prisma, { type: "ENVIRONMENT_MISMATCH", fingerprint: `account:${cfg.environment}:${companyName}`, details: { expected: bound.companyName, got: companyName, environment: cfg.environment } });
    throw new BillingError("ACCOUNT_MISMATCH", "Subscription payments are not available right now.", { reason: "provider account mismatch" });
  }
}

// ------------------------------------------------------------------------------------ plan resolution

async function versionAndPrice(prisma: PrismaClient, versionId: string, countryCode: string): Promise<(PlanVersion & { price: PlanPrice }) | null> {
  const v = await prisma.planVersion.findUnique({ where: { id: versionId }, include: { prices: { where: { countryCode } } } });
  return v && v.prices[0] ? { ...v, price: v.prices[0] } : null;
}

export interface RenewalPlan {
  version: PlanVersion & { price: PlanPrice };
  kind: "NEW" | "RENEWAL" | "PLAN_CHANGE";
}

/** Which version a renewal buys, by the documented rules: a scheduled change wins; a retired version moves to the plan's current one; a live plan cannot be switched mid-period. */
export async function resolveRenewalPlan(prisma: PrismaClient, sub: Subscription | null, countryCode: string, requestedPlanCode: string | undefined, now: Date): Promise<RenewalPlan> {
  const live = !!sub && (sub.status === "ACTIVE" || sub.status === "PAST_DUE") && now < sub.currentPeriodEnd;
  let version: (PlanVersion & { price: PlanPrice }) | null = null;
  if (requestedPlanCode) {
    const currentCode = sub ? (sub.pendingPlanVersionId ? (await prisma.planVersion.findUnique({ where: { id: sub.pendingPlanVersionId } }))?.planCode : sub.planCode) : undefined;
    if (live && requestedPlanCode !== currentCode) throw new BillingError("PLAN_CHANGE_AT_RENEWAL", "You are paid up on your current plan, so a change takes effect when it renews. Schedule it with /changeplan and nothing is charged or prorated now.");
    version = await currentVersionFor(prisma, requestedPlanCode, countryCode);
  } else if (sub?.pendingPlanVersionId) {
    version = await versionAndPrice(prisma, sub.pendingPlanVersionId, countryCode);
  } else if (sub?.planVersionId) {
    const cur = await prisma.planVersion.findUnique({ where: { id: sub.planVersionId } });
    version = cur?.status === "PUBLISHED" ? await versionAndPrice(prisma, cur.id, countryCode) : cur ? await currentVersionFor(prisma, cur.planCode, countryCode) : null;
  } else if (sub && sub.planCode !== "FREE") {
    version = await currentVersionFor(prisma, sub.planCode, countryCode);
  }
  if (!version) throw new BillingError("NO_PLAN", "There is no plan with a published price for your country to renew onto. See /plans.");
  const kind: RenewalPlan["kind"] = !sub || sub.status === "PENDING" ? "NEW" : version.id !== sub.planVersionId && version.planCode !== sub.planCode ? "PLAN_CHANGE" : "RENEWAL";
  return { version, kind };
}

// ------------------------------------------------------------------------------------ start

export interface StartRenewalInput {
  businessId: string;
  merchantId: string;
  payerPhone: string;
  planCode?: string;
  now?: Date;
}
export interface StartedRenewal {
  invoiceReference: string;
  depositId: string;
  providerName: string;
  payerLast4: string;
  amountText: string;
  currencyCode: string;
  planCode: string;
}

const REJECTION_TEXT: Record<string, string> = {
  PAYER_NOT_FOUND: "That number is not registered for mobile money.", PAYER_LIMIT_REACHED: "That wallet has reached its limit.",
  AMOUNT_OUT_OF_BOUNDS: "That amount is outside what the provider allows.", PROVIDER_TEMPORARILY_UNAVAILABLE: "The mobile-money provider is temporarily unavailable. Try again shortly.",
  DEPOSITS_NOT_ALLOWED: "That number cannot make this payment.",
};

export async function startRenewal(prisma: PrismaClient, input: StartRenewalInput): Promise<StartedRenewal> {
  const now = input.now ?? new Date();
  const gate = await assertNewChargeAllowed(prisma, input.businessId);
  const cfg = gate.config;
  const business = await prisma.business.findUniqueOrThrow({ where: { id: input.businessId }, include: { currency: true } });
  const country = getPawaPayCountryForCurrency(business.currencyCode);
  if (!country) throw new BillingError("NOT_AVAILABLE", "Subscription payments by mobile money are not available in your country yet.");
  const scoped = getTenantScopedClient(prisma, input.businessId);
  if (!(await scoped.merchant.findUnique({ where: { id: input.merchantId } }))) throw new BillingError("NOT_FOUND", "Merchant not found.");

  const sub = (await scoped.subscription.findFirst({ where: { businessId: input.businessId }, orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }] })) as Subscription | null;
  const plan = await resolveRenewalPlan(prisma, sub, business.countryCode, input.planCode, now);
  const price = plan.version.price;
  if (price.currencyCode !== business.currencyCode) throw new BillingError("NO_PLAN", "The published price for your country is not in your business currency. Please contact TradePal support.");
  if (sub && sub.status === "ACTIVE" && !sub.cancelAtPeriodEnd && now < new Date(sub.currentPeriodEnd.getTime() - EARLY_RENEWAL_WINDOW_DAYS * DAY_MS)) {
    const from = new Date(sub.currentPeriodEnd.getTime() - EARLY_RENEWAL_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    throw new BillingError("TOO_EARLY", `You are paid up until ${sub.currentPeriodEnd.toISOString().slice(0, 10)}. You can renew from ${from}.`);
  }

  // payer, provider, limits: BEFORE anything is created
  const prediction = await predictProvider(cfg.deps, input.payerPhone.trim());
  if (!prediction) throw new BillingError("INVALID_PHONE", "That does not look like a valid mobile-money number. Include the country code, e.g. 23276123456.");
  if (prediction.country !== country.country) throw new BillingError("INVALID_PHONE", `That is not a ${country.name} mobile-money number.`);
  const conf = await activeConf(cfg.deps, country.country);
  await checkAccountBinding(prisma, cfg, conf.companyName);
  const providerEntry = conf.countries.find((c) => c.country === country.country)?.providers.find((p) => p.provider === prediction.provider);
  const deposit = providerEntry?.currencies.find((c) => c.currency === business.currencyCode)?.operationTypes.DEPOSIT;
  if (!providerEntry || !deposit || deposit.status !== "OPERATIONAL") throw new BillingError("PROVIDER_UNAVAILABLE", `${providerEntry?.displayName ?? "That mobile-money provider"} is not accepting payments right now. Please try again later.`);
  const availability = await getAvailability(cfg.deps, country.country, "DEPOSIT");
  const live = availability.find((a) => a.provider === prediction.provider);
  if (live && live.status !== "OPERATIONAL") throw new BillingError("PROVIDER_UNAVAILABLE", `${providerEntry.displayName} is not accepting payments right now (${live.status.toLowerCase()}). Please try again later.`);
  const unit = 10n ** BigInt(business.currency.minorUnitExp);
  let amountText = formatMoney(price.priceMinor, business.currency.minorUnitExp);
  if (deposit.decimalsInAmount === "NONE") {
    if (price.priceMinor % unit !== 0n) throw new BillingError("AMOUNT_UNSUPPORTED", `${providerEntry.displayName} only accepts whole amounts and this plan's price has cents. Please contact TradePal support.`);
    amountText = (price.priceMinor / unit).toString();
  }
  const min = Number(deposit.minAmount ?? deposit.minTransactionLimit ?? "0");
  const max = Number(deposit.maxAmount ?? deposit.maxTransactionLimit ?? "Infinity");
  if (Number(amountText) < min || Number(amountText) > max) throw new BillingError("AMOUNT_UNSUPPORTED", `${providerEntry.displayName} accepts payments between ${min} and ${max} ${business.currencyCode}.`);

  // subscription row and invoice (reused when an unpaid one for the same version and price exists)
  let subscription = sub;
  if (!subscription || subscription.status === "CANCELED") {
    subscription = await scoped.subscription.create({ data: { businessId: input.businessId, planCode: plan.version.planCode, planVersionId: plan.version.id, status: "PENDING", currentPeriodStart: now, currentPeriodEnd: now } });
  }
  let invoice: Invoice | null = await prisma.invoice.findFirst({
    where: { subscriptionId: subscription.id, status: { in: [...INVOICE_OPEN] }, providerCode: PROVIDER, purpose: "PLATFORM_SUBSCRIPTION" }, orderBy: { createdAt: "desc" },
  });
  if (invoice) {
    const active = await scoped.billingAttempt.findFirst({ where: { invoiceId: invoice.id, status: { in: [...ACTIVE_BILLING_ATTEMPT_STATUSES] } } });
    if (active) throw new BillingError("ATTEMPT_ACTIVE", `A payment for ${invoice.reference} is already waiting. Approve it on your phone, or wait a few minutes before trying again.`);
    if (invoice.planVersionId !== plan.version.id || invoice.amountMinor !== price.priceMinor) {
      await prisma.invoice.updateMany({ where: { id: invoice.id, status: { in: [...INVOICE_OPEN] } }, data: { status: "CANCELLED", cancelledAt: now } });
      invoice = null;
    }
  }
  if (!invoice) {
    invoice = await prisma.invoice.create({
      data: {
        subscriptionId: subscription.id, amountMinor: price.priceMinor, currencyCode: price.currencyCode, status: "PENDING", purpose: "PLATFORM_SUBSCRIPTION", dueDate: new Date(now.getTime() + INVOICE_DUE_DAYS * DAY_MS),
        providerCode: PROVIDER, planVersionId: plan.version.id, kind: plan.kind, reference: newInvoiceReference(),
      },
    });
  }

  // persist BEFORE calling pawaPay: the depositId is the only handle for reconciling a dropped call
  const depositId = randomUUID();
  const last4 = prediction.phoneNumber.replace(/\D/g, "").slice(-4);
  const created = await scoped.billingAttempt.createMany({
    data: [{ id: depositId, businessId: input.businessId, invoiceId: invoice.id, environment: cfg.environment, providerCode: prediction.provider, amountMinor: price.priceMinor, currencyCode: price.currencyCode, payerPhoneLast4: last4, initiatedBy: input.merchantId }],
    skipDuplicates: true,
  });
  if (created.count !== 1) throw new BillingError("ATTEMPT_ACTIVE", `A payment for ${invoice.reference} is already waiting. Approve it on your phone, or wait a few minutes before trying again.`);

  try {
    const result = await initiateDeposit(cfg.deps, { depositId, amount: amountText, currency: business.currencyCode, phoneNumber: prediction.phoneNumber, provider: prediction.provider });
    if (result.status === "REJECTED") {
      await scoped.billingAttempt.updateMany({ where: { id: depositId, status: "INITIATED" }, data: { status: "REJECTED", failureCode: result.failureReason?.failureCode ?? "REJECTED" } });
      throw new BillingError("REJECTED", REJECTION_TEXT[result.failureReason?.failureCode ?? ""] ?? "The payment request was rejected. Please check the number and try again.");
    }
    const next = result.status === "ACCEPTED" ? "ACCEPTED" : result.status === "PROCESSING" ? "PROCESSING" : "UNKNOWN";
    await scoped.billingAttempt.updateMany({ where: { id: depositId, status: "INITIATED" }, data: { status: next, nextPollAt: new Date(now.getTime() + pollDelayMs(0)) } });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    if (error instanceof PawaPayApiError || error instanceof Error) {
      // We cannot tell whether pawaPay created it: it MAY still prompt the payer, so it stays active (UNKNOWN) until a status lookup says otherwise.
      await scoped.billingAttempt.updateMany({ where: { id: depositId, status: "INITIATED" }, data: { status: "UNKNOWN", nextPollAt: new Date(now.getTime() + pollDelayMs(0)) } });
      throw new BillingError("UNCONFIRMED", "We could not confirm that the payment request reached your phone. Please wait a few minutes before trying again; if you receive a prompt, approve it and the subscription will update by itself.");
    }
    throw error;
  }

  await recordAuditLog(scoped, {
    businessId: input.businessId, actorType: "MERCHANT", actorId: input.merchantId, action: "SUBSCRIPTION_CHARGE_INITIATED", entityType: "Invoice", entityId: invoice.id,
    metadata: { reference: invoice.reference, planCode: plan.version.planCode, planVersion: plan.version.version, amountMinor: price.priceMinor.toString(), currencyCode: price.currencyCode, depositId, provider: prediction.provider, environment: cfg.environment },
  });
  return { invoiceReference: invoice.reference!, depositId, providerName: providerEntry.displayName, payerLast4: last4, amountText, currencyCode: business.currencyCode, planCode: plan.version.planCode };
}

// ------------------------------------------------------------------------------------ plan change and cancellation

async function writeEvent(prisma: PrismaClient, e: { businessId: string; subscriptionId: string; kind: "PLAN_CHANGE_SCHEDULED" | "CANCEL_REQUESTED" | "CANCELLED"; fromPlanCode?: string; toPlanCode?: string; source: string; adminUserId?: string; reason?: string }): Promise<void> {
  await getTenantScopedClient(prisma, e.businessId).entitlementEvent.create({
    data: { businessId: e.businessId, subscriptionId: e.subscriptionId, kind: e.kind, fromPlanCode: e.fromPlanCode ?? null, toPlanCode: e.toPlanCode ?? null, source: e.source, adminUserId: e.adminUserId ?? null, reason: e.reason ?? null },
  });
}

/** Schedules a change of plan for the next renewal. Nothing is charged or prorated now; the current period runs out on the plan already paid for. */
export async function schedulePlanChange(prisma: PrismaClient, input: { businessId: string; planCode: string; actorId?: string }): Promise<{ effectiveAt: Date; planCode: string }> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const business = await prisma.business.findUniqueOrThrow({ where: { id: input.businessId } });
  const sub = await scoped.subscription.findFirst({ where: { businessId: input.businessId, status: { in: ["ACTIVE", "PAST_DUE"] } }, orderBy: { currentPeriodEnd: "desc" } });
  if (!sub) throw new BillingError("NO_SUBSCRIPTION", "You have no paid subscription to change. Start one with /renew.");
  const version = await currentVersionFor(prisma, input.planCode, business.countryCode);
  if (!version) throw new BillingError("NO_PLAN", "That plan has no published price for your country. See /plans.");
  await scoped.subscription.update({ where: { id: sub.id }, data: { pendingPlanVersionId: version.id } });
  await writeEvent(prisma, { businessId: input.businessId, subscriptionId: sub.id, kind: "PLAN_CHANGE_SCHEDULED", fromPlanCode: sub.planCode, toPlanCode: version.planCode, source: "MERCHANT", ...(input.actorId ? { reason: `by ${input.actorId}` } : {}) });
  return { effectiveAt: sub.currentPeriodEnd, planCode: version.planCode };
}

/** Stops renewal at the end of the paid period (access continues until then). Open unpaid invoices with no payment in flight are cancelled. */
export async function requestCancellation(prisma: PrismaClient, input: { businessId: string; actorId?: string; now?: Date }): Promise<{ endsAt: Date }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const sub = await scoped.subscription.findFirst({ where: { businessId: input.businessId, status: { in: ["ACTIVE", "PAST_DUE"] } }, orderBy: { currentPeriodEnd: "desc" } });
  if (!sub) throw new BillingError("NO_SUBSCRIPTION", "You have no paid subscription to cancel.");
  await scoped.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, cancelledAt: now } });
  const open = await prisma.invoice.findMany({ where: { subscriptionId: sub.id, status: { in: [...INVOICE_OPEN] } }, select: { id: true } });
  for (const inv of open) {
    if (!(await scoped.billingAttempt.findFirst({ where: { invoiceId: inv.id, status: { in: [...ACTIVE_BILLING_ATTEMPT_STATUSES] } } }))) {
      await prisma.invoice.updateMany({ where: { id: inv.id, status: { in: [...INVOICE_OPEN] } }, data: { status: "CANCELLED", cancelledAt: now } });
    }
  }
  await writeEvent(prisma, { businessId: input.businessId, subscriptionId: sub.id, kind: "CANCEL_REQUESTED", fromPlanCode: sub.planCode, source: "MERCHANT", ...(input.actorId ? { reason: `by ${input.actorId}` } : {}) });
  return { endsAt: sub.currentPeriodEnd };
}
