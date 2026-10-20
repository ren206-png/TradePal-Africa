/**
 * The financial-purpose boundary (expansion decisions G5-G7).
 *
 * Two kinds of money must never mix: what a business pays TradePal (PLATFORM_SUBSCRIPTION) and what a
 * merchant's customer pays that merchant (MERCHANT_SALE). Each payment provider adapter is allowed for an
 * explicit list of purposes, decided HERE, in code, from the call path, never from a request field.
 *
 *  - pawaPay: subscriptions only (owner decision G5). It must be unable to touch merchant sales, supplier
 *    settlements, wallets, escrow, payouts or commissions, even if a flag is forced on.
 *  - Flutterwave: subscriptions only for now. Its one credential set would credit TradePal's own account, so
 *    merchant sales through it are quarantined until proceeds can settle to the merchant under an approved
 *    arrangement (decisions P2 / OPEN-2).
 *  - simulator: the deterministic, money-free adapter used to develop merchant checkout (Phase 5).
 *
 * To open a new combination, change this table in a reviewed change that also records the decision in
 * docs/expansion/decisions.md. Tests assert the table so an accidental edit fails CI.
 */
export const PAYMENT_PURPOSES = ["PLATFORM_SUBSCRIPTION", "MERCHANT_SALE"] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_PROVIDER_IDS = ["pawapay", "flutterwave", "simulator"] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDER_IDS)[number];

const PURPOSE_POLICY: Readonly<Record<PaymentProviderId, readonly PaymentPurpose[]>> = {
  pawapay: ["PLATFORM_SUBSCRIPTION"],
  flutterwave: ["PLATFORM_SUBSCRIPTION"],
  simulator: ["MERCHANT_SALE"],
};

export class PaymentPurposeForbiddenError extends Error {
  constructor(
    readonly provider: PaymentProviderId,
    readonly purpose: PaymentPurpose,
  ) {
    super(`Payment provider '${provider}' is not permitted for purpose '${purpose}'.`);
    this.name = "PaymentPurposeForbiddenError";
  }
}

export function isProviderAllowedForPurpose(provider: PaymentProviderId, purpose: PaymentPurpose): boolean {
  return PURPOSE_POLICY[provider].includes(purpose);
}

/** Throws PaymentPurposeForbiddenError unless the provider may serve this purpose. Call before any side effect. */
export function assertProviderAllowedForPurpose(provider: PaymentProviderId, purpose: PaymentPurpose): void {
  if (!isProviderAllowedForPurpose(provider, purpose)) throw new PaymentPurposeForbiddenError(provider, purpose);
}

/** The shown-to-merchant text for a quarantined online-payment command. */
export const ONLINE_CUSTOMER_PAYMENTS_UNAVAILABLE_REPLY =
  "Online customer payments aren't available yet. You can still record the sale and share your receipt.";
