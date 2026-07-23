// Mirrors the JSON shapes returned by src/admin/adminRoutes.ts on the backend.
// Kept as a hand-written mirror (not generated) since the admin API has no
// OpenAPI/schema export yet — if the backend shape changes, these need a
// matching manual update.

export type AdminRole = "SUPER_ADMIN" | "SUPPORT" | "ANALYST";

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

export interface Business {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  languageCode: string;
  timezone: string;
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
