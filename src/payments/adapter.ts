import type { TradePaymentEvidence } from "@prisma/client";

/**
 * The merchant-payment ADAPTER CONTRACT (expansion section 12). A provider is plugged in by implementing this interface; the
 * payment domain (intent, attempt, allocation, refund, settlement) never talks to a provider any other way. An operation the
 * provider does not support returns an explicit CapabilityError, never a silent no-op, so a missing capability can never look
 * like success.
 *
 * What an adapter must guarantee:
 *  - `createPayment` returning means the provider ACCEPTED the request: that is PENDING, never paid.
 *  - `getStatus` is an AUTHENTICATED lookup at the provider; it is the source of truth when a callback is weak or missing.
 *  - `ProviderUnavailableError` means "could not reach / could not tell": the payment may or may not exist. `ProviderRejectedError`
 *    means the provider definitely did not create it.
 *  - `receiveCallback` authenticates per the provider's actual scheme and normalises the body; it never trusts a claim in the body.
 */
export type Capability = "createPayment" | "getStatus" | "refund" | "getRefundStatus" | "settlementReport";

export class CapabilityError extends Error {
  readonly code = "CAPABILITY_UNSUPPORTED";
  constructor(readonly provider: string, readonly capability: Capability) {
    super(`Provider '${provider}' does not support '${capability}'.`);
    this.name = "CapabilityError";
  }
}

export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";
  constructor(readonly provider: string, message = "The payment provider could not be reached.") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderRejectedError extends Error {
  readonly code = "PROVIDER_REJECTED";
  constructor(readonly provider: string, message: string) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

export interface CreatePaymentRequest {
  /** Our reference (the attempt id). The provider must echo it back; it is how a payment is tied to its owner. */
  merchantReference: string;
  amountMinor: bigint;
  currencyCode: string;
  /** The allow-listed account the money must be collected for (from the merchant's own connection). */
  destinationKey: string;
  description: string;
  expiresAt: Date;
  idempotencyKey: string;
}
export interface CreatePaymentResult {
  externalRef: string;
  /** Accepted is pending. There is no "paid" here by design. */
  status: "PENDING";
  checkoutUrl: string | null;
}

export interface StatusQuery {
  externalRef: string | null;
  merchantReference: string;
  destinationKey: string;
}
export interface ProviderPaymentSnapshot {
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "NOT_FOUND";
  externalRef: string | null;
  merchantReference: string | null;
  amountMinor: bigint | null;
  currencyCode: string | null;
  destinationKey: string | null;
  feeMinor: bigint | null;
}

export interface RefundRequest {
  externalRef: string;
  merchantReference: string;
  amountMinor: bigint;
  currencyCode: string;
  idempotencyKey: string;
  reason: string;
}
export interface RefundResult {
  externalRef: string | null;
  status: "SUCCEEDED" | "PENDING" | "FAILED";
  failureReason?: string;
}

export interface SettlementReport {
  reference: string;
  destinationKey: string;
  currencyCode: string;
  settledAt: Date;
  grossMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  lines: { externalRef: string; grossMinor: bigint; feeMinor: bigint }[];
}

export type NormalizedEvent =
  | { kind: "payment"; eventId: string; purpose: string; sellerBusinessId?: string; snapshot: ProviderPaymentSnapshot }
  | { kind: "refund"; eventId: string; purpose: string; paymentExternalRef: string; refundExternalRef: string; status: "SUCCEEDED" | "FAILED"; amountMinor: bigint; failureReason?: string }
  | { kind: "settlement"; eventId: string; purpose: string; report: SettlementReport };

export type CallbackVerdict = { ok: true; event: NormalizedEvent } | { ok: false; reason: "BAD_SIGNATURE" | "BAD_BODY" | "PURPOSE_FORBIDDEN"; eventId?: string; detail?: string };

export interface ProviderAdapter {
  readonly id: string;
  /** The evidence label money confirmed through this adapter carries. A simulator never claims PROVIDER_CONFIRMED. */
  readonly evidence: Extract<TradePaymentEvidence, "SIMULATOR_CONFIRMED" | "PROVIDER_CONFIRMED">;
  readonly capabilities: ReadonlySet<Capability>;
  /** STRONG: the callback is cryptographically authenticated. WEAK: a callback is only a hint; the status endpoint decides. */
  readonly callbackAuth: "STRONG" | "WEAK";
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  getStatus(query: StatusQuery): Promise<ProviderPaymentSnapshot>;
  refund(req: RefundRequest): Promise<RefundResult>;
  getRefundStatus(query: { externalRef: string; paymentExternalRef: string }): Promise<RefundResult>;
  fetchSettlements(query: { destinationKey: string; since: Date }): Promise<SettlementReport[]>;
  receiveCallback(rawBody: string, headers: Record<string, string | undefined>): CallbackVerdict;
}

export function requireCapability(adapter: Pick<ProviderAdapter, "id" | "capabilities">, capability: Capability): void {
  if (!adapter.capabilities.has(capability)) throw new CapabilityError(adapter.id, capability);
}

/** Providers the server knows how to talk to. Only adapters registered here can ever be called (no URL comes from a merchant). */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }
  get(provider: string): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }
  has(provider: string): boolean {
    return this.adapters.has(provider);
  }
  ids(): string[] {
    return [...this.adapters.keys()];
  }
}
