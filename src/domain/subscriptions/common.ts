import type { PrismaClient, BillingExceptionType } from "@prisma/client";
import { buildPawaPayDepsFromEnv } from "../../config/paymentsEnv.js";
import { pawaPayEnvironmentOf, type PawaPayDeps } from "../../pawapay/client.js";

export class BillingError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "BillingError";
  }
}

export const DAY_MS = 86_400_000;
export const PROVIDER = "PAWAPAY" as const;
/** The switch/policy provider id (lower case, as in the purpose policy table). */
export const SWITCH_PROVIDER = "pawapay" as const;
export const FLAG_PAWAPAY_BILLING = "pawapayBilling";
export const FLAG_ENTITLEMENTS = "subscriptionEntitlements";

/** Conservative defaults, each a documented decision (docs/expansion/decisions.md C7), not a silent behaviour. */
export const EARLY_RENEWAL_WINDOW_DAYS = 14; // a renewal may be started this long before the period ends; earlier is refused
export const INVOICE_DUE_DAYS = 3;
export const LEGACY_PERIOD_DAYS = 30; // subscriptions created before plan versions existed

export const ACTIVE_BILLING_ATTEMPT_STATUSES = ["INITIATED", "ACCEPTED", "PROCESSING", "UNKNOWN"] as const;
export const MAX_POLLS = 8;
export const pollDelayMs = (n: number): number => Math.min(30_000 * 2 ** Math.max(0, n), 30 * 60_000);

/**
 * Everything the billing code needs to talk to pawaPay SAFELY. Built from the environment; any inconsistency makes it `invalid`, and an
 * invalid config refuses every NEW charge (servicing of existing attempts also needs a usable config, so it is refused too and the
 * problem is loud). The two environments differ only by base URL and token (per pawaPay's go-live page), so we cross-check three things:
 * the URL's own environment, the declared PAWAPAY_ENVIRONMENT, and NODE_ENV (sandbox never runs in production, production credentials
 * never run outside production: "never test against production credentials").
 */
export interface BillingConfig {
  deps: PawaPayDeps;
  environment: "SANDBOX" | "PRODUCTION";
  /** Our public host (and port) for the callback URL, exactly as configured in the pawaPay dashboard: used in signature verification. */
  callbackAuthority: string;
  callbackPath: string;
  /** In production, new charges also need the owner's explicit activation. Absent means NOT activated. */
  productionActivated: boolean;
  requireSignedCallbacks: boolean;
  nodeEnv: string;
}

export type BillingConfigResult = { ok: true; config: BillingConfig } | { ok: false; reason: string };

export const BILLING_CALLBACK_PATH = "/webhooks/pawapay/billing";

export function buildBillingConfigFromEnv(env: NodeJS.ProcessEnv = process.env, deps: PawaPayDeps | undefined = buildPawaPayDepsFromEnv()): BillingConfigResult {
  if (!deps) return { ok: false, reason: "pawaPay is not configured (no API token)." };
  const fromUrl = pawaPayEnvironmentOf(deps);
  if (!fromUrl) return { ok: false, reason: "PAWAPAY_API_BASE_URL is not a known pawaPay host." };
  const declared = env["PAWAPAY_ENVIRONMENT"]?.toUpperCase();
  if (declared !== "SANDBOX" && declared !== "PRODUCTION") return { ok: false, reason: "PAWAPAY_ENVIRONMENT must be SANDBOX or PRODUCTION." };
  if (declared !== fromUrl) return { ok: false, reason: `PAWAPAY_ENVIRONMENT (${declared}) does not match the base URL (${fromUrl}).` };
  const nodeEnv = env["NODE_ENV"] ?? "development";
  if (nodeEnv === "production" && fromUrl !== "PRODUCTION") return { ok: false, reason: "The sandbox is never used from a production deployment." };
  if (nodeEnv !== "production" && fromUrl === "PRODUCTION") return { ok: false, reason: "Production pawaPay credentials are never used outside a production deployment." };
  const authority = env["PAWAPAY_BILLING_CALLBACK_AUTHORITY"]?.trim().toLowerCase();
  if (!authority || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(authority)) return { ok: false, reason: "PAWAPAY_BILLING_CALLBACK_AUTHORITY (the public host of the callback URL) is not set." };
  return {
    ok: true,
    config: {
      deps, environment: fromUrl, callbackAuthority: authority, callbackPath: BILLING_CALLBACK_PATH,
      productionActivated: env["PAWAPAY_BILLING_PRODUCTION_ACTIVATED"] === "true", requireSignedCallbacks: env["PAWAPAY_REQUIRE_SIGNED_CALLBACKS"] !== "false", nodeEnv,
    },
  };
}

let current: BillingConfigResult | null = null;
export function getBillingConfig(): BillingConfigResult {
  if (!current) current = buildBillingConfigFromEnv();
  return current;
}
export function setBillingConfig(c: BillingConfigResult | null): void {
  current = c;
}

export interface RaiseBilling {
  type: BillingExceptionType;
  fingerprint: string;
  businessId?: string | null;
  attemptId?: string | null;
  invoiceId?: string | null;
  amountMinor?: bigint | null;
  details?: Record<string, unknown>;
}

/** One exception per fingerprint (a replayed callback cannot flood the queue). ON CONFLICT DO NOTHING: no error to poison a connection. */
export async function raiseBillingException(prisma: PrismaClient, i: RaiseBilling): Promise<void> {
  await prisma.billingException.createMany({
    data: [{ type: i.type, fingerprint: i.fingerprint, businessId: i.businessId ?? null, attemptId: i.attemptId ?? null, invoiceId: i.invoiceId ?? null, amountMinor: i.amountMinor ?? null, details: (i.details ?? {}) as never }],
    skipDuplicates: true,
  });
}

export const INVOICE_OPEN = ["PENDING", "OVERDUE"] as const;

export function newInvoiceReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `INV-${s}`;
}
