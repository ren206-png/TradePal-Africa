/**
 * PawaPay Merchant API client — C2B mobile money collection for West Africa.
 *
 * Sandbox base URL:    https://api.sandbox.pawapay.io/v2
 * Production base URL: https://api.pawapay.io/v2  (swap via apiBaseUrl)
 *
 * Key Sierra Leone provider codes:
 *   AFRIMONEY_SLE  — Africell / Afrimoney (currency: SLE)
 *   ORANGE_SLE     — Orange Money SL      (currency: SLE)
 *
 * Docs: https://docs.pawapay.io/v2/docs/deposits
 */

export interface PawaPayDeps {
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** Defaults to the PawaPay *sandbox* endpoint; set PAWAPAY_API_BASE_URL (config/paymentsEnv.ts) for production. */
  apiBaseUrl?: string;
  /** Per-request timeout; defaults to 20s. */
  timeoutMs?: number;
}

export class PawaPayApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "PawaPayApiError";
  }
}

// ── Deposit status vocabulary ─────────────────────────────────────────────────

export type DepositStatus =
  | "ACCEPTED" // initiation accepted, awaiting customer PIN
  | "COMPLETED" // funds collected — terminal, successful
  | "FAILED" // terminal, unsuccessful — see failureReason
  | "PROCESSING" // in-flight (redirection-auth flows only)
  | "DUPLICATE_IGNORED" // depositId already used
  | "REJECTED"; // rejected at initiation — see failureReason

// ── Initiate deposit ──────────────────────────────────────────────────────────

export interface InitiateDepositParams {
  /**
   * Caller-generated UUIDv4. Store this in your DB *before* calling — it is
   * your idempotency key and your only handle if the network drops mid-call.
   * PawaPay rejects a second initiation with the same ID as DUPLICATE_IGNORED.
   */
  depositId: string;
  /**
   * Major-unit decimal string (e.g. "100" for 100 SLE). Check
   * decimalsInAmount from getActiveConfiguration — many West African providers
   * do not support decimal places and will REJECT "100.50".
   */
  amount: string;
  /** ISO 4217 currency code, e.g. "SLE" for Sierra Leonean Leone. */
  currency: string;
  /**
   * MSISDN-format phone number, e.g. "23276123456". Always run the raw input
   * through predictProvider first to sanitize and validate format.
   */
  phoneNumber: string;
  /** PawaPay provider code, e.g. "AFRIMONEY_SLE" or "ORANGE_SLE". */
  provider: string;
}

export interface InitiateDepositResult {
  depositId: string;
  status: DepositStatus;
  /** ISO 8601 timestamp. */
  created: string;
  /** Present only when status is REJECTED. */
  failureReason?: { failureCode: string; failureMessage: string };
}

// ── Check deposit status ──────────────────────────────────────────────────────

export interface CheckDepositStatusResult {
  /** false when PawaPay returns 404 — deposit never reached PawaPay, safe to mark FAILED. */
  found: boolean;
  data?: {
    depositId: string;
    status: DepositStatus;
    amount?: string;
    currency?: string;
    providerTransactionId?: string;
    failureReason?: { failureCode: string; failureMessage: string };
  };
}

// ── Active configuration ──────────────────────────────────────────────────────

export interface ProviderOperationConfig {
  status: "OPERATIONAL" | "CLOSED";
  decimalsInAmount: "NONE" | "TWO_PLACES";
  minAmount: string;
  maxAmount: string;
  authType: "PROVIDER_AUTH" | "PRE_AUTH" | "REDIRECT_AUTH";
  pinPrompt?: "AUTOMATIC" | "MANUAL";
  pinPromptRevivable?: boolean;
  pinPromptInstructions?: unknown; // USSD dial instructions for MANUAL pinPrompt
}

export interface ActiveProvider {
  provider: string;
  displayName: string;
  nameDisplayedToCustomer: string;
  logo: string;
  currencies: Array<{
    currency: string;
    displayName: string;
    operationTypes: {
      DEPOSIT?: ProviderOperationConfig;
      PAYOUT?: ProviderOperationConfig;
    };
  }>;
}

export interface ActiveConfigurationResult {
  companyName: string;
  countries: Array<{
    country: string;
    prefix: string;
    displayName: { en: string; fr?: string };
    providers: ActiveProvider[];
  }>;
}

// ── Provider prediction ───────────────────────────────────────────────────────

export interface PredictProviderResult {
  country: string;
  provider: string;
  /** Sanitized MSISDN — use this (not the raw input) for initiateDeposit. */
  phoneNumber: string;
}

// ── Deposit callback payload (inbound webhook) ────────────────────────────────

export interface PawaPayDepositCallback {
  depositId: string;
  status: DepositStatus;
  amount?: string;
  currency?: string;
  country?: string;
  payer?: {
    type: string;
    accountDetails: { phoneNumber: string; provider: string };
  };
  customerMessage?: string;
  created?: string;
  providerTransactionId?: string;
  failureReason?: { failureCode: string; failureMessage: string };
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

const SANDBOX_BASE_URL = "https://api.sandbox.pawapay.io/v2";
const DEFAULT_TIMEOUT_MS = 20_000;

async function pawaPayFetch(
  deps: PawaPayDeps,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const baseUrl = deps.apiBaseUrl ?? SANDBOX_BASE_URL;
  return fetchFn(`${baseUrl}${path}`, {
    // A hung PawaPay connection must never hang a merchant's WhatsApp command or a webhook handler.
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...options,
    headers: {
      Authorization: `Bearer ${deps.apiToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

// ── Public API functions ──────────────────────────────────────────────────────

/**
 * Initiates a C2B mobile money deposit — requests payment from a customer's
 * mobile wallet to TradePal's PawaPay account.
 *
 * IMPORTANT: generate and store params.depositId in your database *before*
 * calling this. If the network drops, use checkDepositStatus(depositId) to
 * reconcile — only mark FAILED when checkDepositStatus returns found: false.
 */
export async function initiateDeposit(
  deps: PawaPayDeps,
  params: InitiateDepositParams,
): Promise<InitiateDepositResult> {
  const response = await pawaPayFetch(deps, "/deposits", {
    method: "POST",
    body: JSON.stringify({
      depositId: params.depositId,
      amount: params.amount,
      currency: params.currency,
      payer: {
        type: "MMO",
        accountDetails: {
          phoneNumber: params.phoneNumber,
          provider: params.provider,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PawaPayApiError(
      `PawaPay deposit initiation failed (${response.status}): ${body}`,
      response.status,
    );
  }

  return response.json() as Promise<InitiateDepositResult>;
}

/**
 * Fetches the current status of a deposit by its ID.
 *
 * Use this for:
 *   - Reconciliation when a callback was not received
 *   - Polling as an alternative to callbacks (not recommended for production)
 *   - Verifying a COMPLETED callback server-side before crediting funds
 *
 * Returns { found: false } when PawaPay has no record of the depositId —
 * this is the ONLY case where it is safe to mark a payment definitively FAILED.
 */
export async function checkDepositStatus(
  deps: PawaPayDeps,
  depositId: string,
): Promise<CheckDepositStatusResult> {
  const response = await pawaPayFetch(deps, `/deposits/${depositId}`, {
    method: "GET",
  });

  if (response.status === 404) return { found: false };

  if (!response.ok) {
    const body = await response.text();
    throw new PawaPayApiError(
      `PawaPay checkDepositStatus failed (${response.status}): ${body}`,
      response.status,
    );
  }

  const data = (await response.json()) as {
    depositId?: string;
    status?: DepositStatus;
    amount?: string;
    currency?: string;
    providerTransactionId?: string;
    failureReason?: { failureCode: string; failureMessage: string };
  };

  return {
    found: true,
    data: {
      depositId: data.depositId ?? depositId,
      status: data.status ?? "FAILED",
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.currency !== undefined ? { currency: data.currency } : {}),
      ...(data.providerTransactionId !== undefined ? { providerTransactionId: data.providerTransactionId } : {}),
      ...(data.failureReason !== undefined ? { failureReason: data.failureReason } : {}),
    },
  };
}

/**
 * Returns the active provider configuration for a country.
 *
 * Use this to:
 *   - List available providers and show their logos to the customer
 *   - Check operational status (OPERATIONAL vs CLOSED) before initiating
 *   - Read decimalsInAmount, minAmount, maxAmount to validate input
 *   - Read pinPrompt type (AUTOMATIC vs MANUAL) to show correct UX
 *
 * Pass country as an ISO 3166-1 alpha-3 code (PawaPay uses 3-letter codes):
 *   SLE — Sierra Leone
 *   LBR — Liberia
 *   GMB — Gambia
 *   GIN — Guinea (Conakry)
 */
export async function getActiveConfiguration(
  deps: PawaPayDeps,
  country: string,
  operationType: "DEPOSIT" | "PAYOUT" = "DEPOSIT",
): Promise<ActiveConfigurationResult> {
  const response = await pawaPayFetch(
    deps,
    `/active-conf?country=${country}&operationType=${operationType}`,
    { method: "GET" },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new PawaPayApiError(
      `PawaPay getActiveConfiguration failed (${response.status}): ${body}`,
      response.status,
    );
  }

  return response.json() as Promise<ActiveConfigurationResult>;
}

/**
 * Validates a phone number and predicts the mobile money provider.
 *
 * Always call this before initiateDeposit:
 *   - Sanitizes whitespace, dashes, and local formatting to MSISDN
 *   - Validates digit count for the country
 *   - Predicts provider so the customer skips a selection step
 *
 * Returns null when the number is invalid (show a validation error to the
 * customer). Allow the customer to override the prediction — accuracy is
 * high but not 100%.
 *
 * Use the returned phoneNumber (not the original input) in initiateDeposit.
 */
export async function predictProvider(
  deps: PawaPayDeps,
  phoneNumber: string,
): Promise<PredictProviderResult | null> {
  const response = await pawaPayFetch(deps, "/predict-provider", {
    method: "POST",
    body: JSON.stringify({ phoneNumber }),
  });

  // 400/422 = invalid number — expected, not an API error
  if (response.status === 400 || response.status === 422) return null;

  if (!response.ok) {
    const body = await response.text();
    throw new PawaPayApiError(
      `PawaPay predictProvider failed (${response.status}): ${body}`,
      response.status,
    );
  }

  return response.json() as Promise<PredictProviderResult>;
}
