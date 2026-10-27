// Mirrors the JSON shapes returned by src/admin/adminRoutes.ts on the backend.
// Kept as a hand-written mirror (not generated) since the admin API has no
// OpenAPI/schema export yet — if the backend shape changes, these need a
// matching manual update.

export type AdminRole = "SUPER_ADMIN" | "OPERATOR" | "SUPPORT" | "ANALYST" | "FINANCE_ADMIN" | "MODERATOR";

/** Where a sign-in stands with the second factor (admin-console Phase 2). */
export type MfaState = "NOT_REQUIRED" | "ENROLMENT_REQUIRED" | "CHALLENGE_REQUIRED" | "VERIFIED";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

export interface PaginationMeta {
  take: number;
  skip: number;
  hasMore: boolean;
}

export interface Paginated<T> {
  items: T[];
  pagination: PaginationMeta;
}

export type BusinessStatus = "ACTIVE" | "SUSPENDED";

export interface Business {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  languageCode: string;
  timezone: string;
  /** Phase 29: platform-moderation suspension — see src/domain/businessModeration.ts on the backend. */
  status: BusinessStatus;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
  _count?: { merchants: number };
}

export interface Merchant {
  id: string;
  businessId: string;
  phoneNumber: string;
  displayName: string | null;
  createdAt: string;
}

export interface Plan {
  code: string;
  name: string;
  priceMinor: string; // serialized bigint (minor units)
  currencyCode: string;
  entryCapPerMonth: number | null; // null = uncapped
  voiceEnabled: boolean;
  /** Phase 14: caps how many active STAFF Merchant rows /addstaff can create for a business on this plan. null = uncapped. */
  staffCapCount: number | null;
}

export type SubscriptionStatus = "ACTIVE" | "CANCELED";

export interface Subscription {
  id: string;
  businessId: string;
  planCode: string;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  createdAt: string;
  plan: Plan;
}

/** Mirrors billing.ts's EffectivePlan — "what plan is actually in force right now", per getEffectivePlan. */
export interface EffectivePlan {
  code: string;
  entryCapPerMonth: number | null;
  voiceEnabled: boolean;
}

export interface BusinessDetail extends Business {
  merchants: Merchant[];
  subscriptions: Subscription[];
}

export type InvoiceStatus = "PENDING" | "PAID" | "FAILED";

/** Mirrors GET /admin/businesses/:id/invoices (Phase 23) — see adminRoutes.ts. */
export interface Invoice {
  id: string;
  subscriptionId: string;
  amountMinor: string; // serialized bigint (minor units)
  currencyCode: string;
  status: InvoiceStatus;
  dueDate: string;
  paidAt: string | null;
  createdAt: string;
  providerCode: string | null;
  providerReference: string | null;
  subscription: { planCode: string };
}

export type DeletionRequestStatus = "PENDING" | "COMPLETED" | "REJECTED";
export type DeletionRequestorType = "CUSTOMER_DIRECT" | "CUSTOMER_VIA_MERCHANT" | "MERCHANT";

export interface DeletionRequest {
  id: string;
  businessId: string;
  customerId: string | null;
  requestorType: DeletionRequestorType;
  description: string;
  status: DeletionRequestStatus;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  [key: string]: unknown;
}

export interface AuditLog {
  id: string;
  businessId: string | null;
  action: string;
  createdAt: string;
  [key: string]: unknown;
}

export type MobileMoneyAlertStatus = "UNMATCHED" | "SUGGESTED" | "CONFIRMED";

export interface MobileMoneyAlert {
  id: string;
  businessId: string;
  provider: string;
  amountMinor: string; // serialized bigint
  matchStatus: MobileMoneyAlertStatus;
  senderMasked: string | null;
  providerTransactionId: string | null;
  createdAt: string;
  [key: string]: unknown;
}

export interface FeatureFlag {
  key: string;
  description: string;
  enabledByDefault: boolean;
  createdAt: string;
  [key: string]: unknown;
}

export type PaymentRequestStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED";

/** Mirrors GET /admin/businesses/:id/payment-requests (Phase 24) — see adminRoutes.ts. */
export interface PaymentRequest {
  id: string;
  businessId: string;
  customerId: string | null;
  description: string;
  amountMinor: string; // serialized bigint (minor units)
  currencyCode: string;
  status: PaymentRequestStatus;
  providerCode: string | null;
  providerReference: string | null;
  checkoutUrl: string | null;
  transactionId: string | null;
  createdAt: string;
  paidAt: string | null;
  customer: { name: string } | null;
}

/** Merged per-business view returned by GET /admin/businesses/:id/feature-flags. */
export interface FeatureFlagState {
  key: string;
  description: string;
  enabledByDefault: boolean;
  /** `null` means this business has never overridden the flag — it simply follows `enabledByDefault`. */
  override: boolean | null;
  /** What's actually in effect for this business right now. */
  effective: boolean;
}

// Expansion Phase 2: transactions and orders panel (src/admin/adminTransactions.ts).
export type TransactionStatus = "POSTED" | "REVERSED" | "REVERSAL";

export interface AdminTransaction {
  id: string;
  type: string;
  amountMinor: string;
  currencyCode: string;
  paymentStatus: string;
  description: string | null;
  counterparty: string | null;
  createdAt: string;
  itemCount: number;
  status: TransactionStatus;
  reversalOfTransactionId: string | null;
  reversedByTransactionId: string | null;
  provenance: { label: string; channel: string; reference: string | null };
  journalEntryId: string | null;
}

export interface AdminStockMovement {
  id: string;
  kind?: string;
  sku?: string;
  product?: string;
  item?: string;
  shop?: string;
  onHandDelta?: number;
  damagedDelta?: number;
  inTransitDelta?: number;
  quantityDelta?: number;
  costMinor?: string | null;
  costIncomplete?: boolean;
  provenance?: string;
  source: string | null;
  createdAt: string;
}

export interface AdminJournalLine {
  account: string;
  debitMinor: string;
  creditMinor: string;
}

export interface AdminJournal {
  id: string;
  kind: string;
  currencyCode: string;
  memo: string | null;
  provenance: string;
  source: string | null;
  occurredAt: string;
  status: "POSTED" | "REVERSED" | "REVERSAL";
  lines: AdminJournalLine[];
}

// Expansion Phase 3: reorder and forecasting panel (src/admin/adminReorder.ts).
export interface ForecastSummary {
  scoredPredictions: number;
  countedPredictions: number;
  excludedStockouts: number;
  scoredWeeks: number;
  modelMapeBps: number | null;
  baselineMapeBps: number | null;
  modelWapeBps: number | null;
  baselineWapeBps: number | null;
  improvementBps: number | null;
}

export interface ReorderMerchantRow {
  businessId: string;
  name: string;
  country: string;
  rules: number;
  suggestions: { issued: number; proposed: number; accepted: number; dismissed: number; superseded: number; tier2Issued: number };
  flags: { tier1: boolean; shadow: boolean; live: boolean };
  forecast: ForecastSummary;
  eligible: boolean;
}

export interface ReorderOverview {
  thresholds: { minScoredWeeks: number | null; minImprovementBps: number | null; updatedAt: string };
  method: string;
  merchants: ReorderMerchantRow[];
}

export interface ForecastPredictionRow {
  id: string;
  sku: string;
  unit: string;
  method: string;
  periodStart: string;
  periodEnd: string;
  predictedUnits: number;
  tier1Units: number;
  suggestedReorderQty: number;
  score: { actualUnits: number; modelApeBps: number | null; tier1ApeBps: number | null; stockout: boolean } | null;
}

export interface AdminTradeOrder {
  id: string;
  reference: string;
  side: "BUY" | "SELL";
  partner: string | null;
  linked: boolean;
  acceptance: string;
  movement: string;
  totalMinor: string;
  currencyCode: string;
  createdAt: string;
}

export interface AdminTradeInvoice {
  id: string;
  number: string;
  externalNumber: string | null;
  side: "BUY" | "SELL";
  order: string;
  totalMinor: string;
  paidMinor: string;
  outstandingMinor: string;
  paymentStatus: string;
  overdue: boolean;
  payments: { id: string; direction: string; amountMinor: string; method: string; evidence: string; state: string; reason: string | null }[];
}

export type SupportParty = "SELLER" | "PLATFORM" | "PROVIDER";
export type SupportCaseStatus = "OPEN" | "ASSIGNED" | "CLOSED";

export interface SupportCaseRow {
  id: string;
  business: string;
  orderReference: string | null;
  type: string;
  handledBy: SupportParty;
  status: SupportCaseStatus;
  openedBy: string;
  summary: string;
  contactPhone: string | null;
  createdAt: string;
}

export interface SupportCaseList {
  cases: SupportCaseRow[];
  counts: { byStatus: Record<string, number>; openByParty: Record<string, number> };
  pagination: PaginationMeta;
}

export interface SupportCaseDetail extends Omit<SupportCaseRow, "summary"> {
  summary: string;
  contactName: string | null;
  resolution: string | null;
  order: { reference: string; status: string; fulfilment: string; paymentMethod: string; totalMinor: string; paidMinor: string; refundedMinor: string; currencyCode: string } | null;
  notes: { id: string; authorType: string; body: string; createdAt: string }[];
}

export interface PaymentsOverview {
  intents: Record<string, number>;
  attempts: Record<string, number>;
  openProviderExceptions: Record<string, number>;
  openStorePaymentExceptions: Record<string, number>;
  refunds: Record<string, number>;
  collectedNotSettled: { currencyCode: string; amountMinor: string | null }[];
  callbacks: { received: number; processing: number; processed: number; dead: number };
  providers: string[];
  connections: { id: string; business: string; provider: string; status: string; consecutiveFailures: number; circuitOpen: boolean }[];
}
export interface PaymentAttemptRow {
  id: string;
  business: string;
  provider: string;
  reference: string;
  status: string;
  amountMinor: string | null;
  capturedMinor: string | null;
  currencyCode: string;
  pollCount: number;
  createdAt: string;
}
export interface PaymentExceptionRow {
  id: string;
  source: "PROVIDER" | "STORE_ORDER";
  type: string;
  status: string;
  business: string | null;
  reference: string | null;
  amountMinor: string | null;
  currencyCode: string | null;
  createdAt: string;
}
export interface RefundRow {
  id: string;
  business: string;
  reference: string;
  amountMinor: string | null;
  status: string;
  failureReason: string | null;
}
export interface SettlementRow {
  id: string;
  business: string;
  reference: string;
  grossMinor: string | null;
  feeMinor: string | null;
  netMinor: string | null;
  currencyCode: string;
  payments: number;
}

export interface ReportRow {
  id: string;
  reason: string;
  details: string;
  status: string;
  createdAt: string;
  openReportsAboutSeller: number;
  seller: { id: string; name: string; country: string; marketplaceStatus: string } | null;
  listing: { id: string; item: string; sku: string; moderation: string } | null;
}
export interface AppealRow {
  id: string;
  seller: string;
  text: string;
  status: string;
  action: { type: string; reason: string };
}
export interface SellerModerationRow {
  businessId: string;
  name: string;
  marketplaceStatus: string;
  note: string | null;
}

export interface SubscriptionsOverview {
  states: Record<string, number>;
  invoices: Record<string, number>;
  attempts: Record<string, number>;
  openExceptions: Record<string, number>;
  refunds: Record<string, number>;
  callbackAuthFailuresLast24h: number;
  switches: { id: string; provider: string; countryCode: string; purpose: string; newAttemptsEnabled: boolean; reason: string | null }[];
  configuration: { configured: true; environment: string; requireSignedCallbacks: boolean; productionActivated: boolean } | { configured: false; reason: string };
}
export interface SubscriptionRow {
  id: string;
  business: string;
  country: string;
  securitySuspended: boolean;
  planCode: string;
  planVersion: number | null;
  status: string;
  state: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}
export interface SubscriptionDetail extends SubscriptionRow {
  invoices: { id: string; reference: string | null; status: string; amountMinor: string | null; paidMinor: string | null; refundedMinor: string | null; currencyCode: string }[];
  history: { id: string; kind: string; from: string | null; to: string | null; source: string; reason: string | null; at: string }[];
}
export interface BillingExceptionRow {
  id: string;
  attemptId?: string | null;
  type: string;
  business: string | null;
  amountMinor: string | null;
  createdAt: string;
}
export interface PlanVersionRow {
  id: string;
  planCode: string;
  version: number;
  status: string;
  graceDays: number;
  billingPeriodDays: number;
  features: string[];
  subscribers: number;
  prices: { countryCode: string; currencyCode: string; priceMinor: string | null }[];
}

// ---- Expansion Phase 7: messaging and consent
export interface AlertChannelStatus {
  lastDeliveredAt: string | null;
  lastFailedAt: string | null;
  lastChannelCheckAt: string | null;
  lastChannelCheckStatus: string | null;
  failedLast7Days: number;
  recentFailures: { at: string; title: string; error: string | null; httpStatus: number | null }[];
  needsAttention: boolean;
}
export interface MessagingOverview {
  consumerMessaging: { platformSwitchOn: boolean; globalDefault: boolean };
  templatesByStatus: Record<string, number>;
  consents: { purpose: string; status: string; count: number }[];
  blockedNumbers: number;
  outbound30d: Record<string, number>;
  suppressionReasons30d: { reason: string; count: number }[];
  volumes: { inbound24h: number; inbound7d: number; outbound24h: number; outbound7d: number };
  aiParse7d: { total: number; validationPassed: number; validationFailed: number; successRate: number | null };
  stuckInbound: number;
  alertChannel: AlertChannelStatus;
  localization: { code: string; name: string; status: string; keysServed: number; keysTotal: number; caveat: string }[];
}
export interface TemplateRow {
  messageClass: string;
  audience: string;
  category: string;
  pipeline: string;
  trigger: string;
  consentBasis: string;
  windowRule: string;
  body: string | null;
  needsTemplate: boolean;
  status: string;
  providerTemplateName: string | null;
  approvalReference: string | null;
  disabledReason: string | null;
}
export interface ConsentRow { id: string; phone: string; business: string; purpose: string; status: string; basis: string; textVersion: string; updatedAt: string }
export interface BlockRow { id: string; phone: string; source: string; reason: string | null; active: boolean; createdAt: string; liftedAt: string | null; liftReason: string | null }
export interface StuckInboundRow { id: string; waMessageId: string; receivedAt: string; from: string | null; messageType: string | null; replayable: boolean; tooOld: boolean }
