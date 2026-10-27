import type { AdminRole, MembershipRole } from "@prisma/client";

/**
 * The permission matrix (expansion §6). Authorization is decided by asking `can(role, permission)`, never by
 * comparing role names at call sites, so adding a role or a permission is one reviewed change here.
 *
 * Two separate families that never overlap:
 *  - merchant roles (MembershipRole): what a person may do inside ONE business;
 *  - platform roles (AdminRole): what TradePal staff may do on the platform. A platform admin is not a
 *    super-merchant and has no merchant permission by default; viewing a merchant's books is a separate,
 *    audited "support access" action (admin:view_merchant_financials).
 */

// ---------------------------------------------------------------- merchant permissions
export const MERCHANT_PERMISSIONS = [
  "sales:create",
  "sales:void", //          reverse a posted sale
  "expenses:create",
  "customers:manage",
  "debts:record",
  "debts:view",
  "inventory:view",
  "inventory:receive", //   goods receipts, stock-ins
  "inventory:adjust", //    counts and controlled adjustments
  "prices:manage",
  "reports:view",
  "finance:close_day",
  "finance:export",
  "finance:reconcile",
  "payments:view",
  "payments:connect_provider", // sensitive: step-up verification required
  "staff:manage",
  "settings:manage",
  "business:manage", //     org settings, shops, deletion
  "trade:buy", //           purchase orders, goods receipts, reorder suggestions
  "trade:sell", //          accept, quote and ship sales orders
  "trade:payments", //      record and confirm payments on trade invoices
  "trade:partners", //      trade partners, links, shared price lists, credit terms
  "trade:credit_override", // go ahead despite a credit block (with a reason)
  "store:manage", //        the shop's web page, delivery areas, which products are listed
  "store:fulfil", //        confirm, prepare, dispatch and hand over consumer orders; record payments taken at hand-over
  "store:refund", //        decide cancellations and refunds, take returns back, pay refunds out
  "billing:view", //        see the business's own subscription, invoices and the plans on offer
  "billing:manage", //      pay or renew the subscription, schedule a plan change, cancel (owner only: it spends the business's money)
] as const;
export type MerchantPermission = (typeof MERCHANT_PERMISSIONS)[number];

const ALL_MERCHANT = new Set<MerchantPermission>(MERCHANT_PERMISSIONS);

const MERCHANT_MATRIX: Readonly<Record<MembershipRole, ReadonlySet<MerchantPermission>>> = {
  OWNER: ALL_MERCHANT,
  MANAGER: new Set<MerchantPermission>([
    "sales:create", "sales:void", "expenses:create", "customers:manage", "debts:record", "debts:view",
    "inventory:view", "inventory:receive", "inventory:adjust", "prices:manage", "reports:view",
    "finance:close_day", "finance:export", "finance:reconcile", "payments:view", "staff:manage",
    "trade:buy", "trade:sell", "trade:payments", "trade:partners", "store:manage", "store:fulfil", "store:refund", "billing:view",
  ]),
  SALES_CLERK: new Set<MerchantPermission>([
    "sales:create", "expenses:create", "customers:manage", "debts:record", "debts:view", "inventory:view", "reports:view", "store:fulfil",
  ]),
  INVENTORY_OPERATOR: new Set<MerchantPermission>(["inventory:view", "inventory:receive", "inventory:adjust", "prices:manage", "trade:buy"]),
  FINANCE_OPERATOR: new Set<MerchantPermission>([
    "expenses:create", "debts:view", "reports:view", "finance:close_day", "finance:export", "finance:reconcile", "payments:view", "trade:payments",
  ]),
  // Read-only: for a helper or an auditor who must see but never change anything.
  RESTRICTED_SUPPORT: new Set<MerchantPermission>(["debts:view", "inventory:view", "reports:view", "payments:view"]),
};

export function canMerchant(role: MembershipRole, permission: MerchantPermission): boolean {
  return MERCHANT_MATRIX[role]?.has(permission) ?? false; // an unknown role (e.g. a platform role name) has no merchant permission
}

export function merchantPermissionsFor(role: MembershipRole): readonly MerchantPermission[] {
  return MERCHANT_PERMISSIONS.filter((p) => MERCHANT_MATRIX[role].has(p));
}

// ---------------------------------------------------------------- platform-admin permissions
export const PLATFORM_PERMISSIONS = [
  "admin:view_overview",
  "admin:view_system_health",
  "admin:view_orgs", //                  organizations, users, roles, flags (metadata, no financial data)
  "admin:view_audit_log",
  "admin:view_merchant_financials", //   opening a merchant's books: needs a recorded reason (support access)
  "admin:manage_flags", //               per-organization flag overrides
  "admin:manage_global_flags", //        bulk rollout of a flag default
  "admin:suspend_org",
  "admin:revoke_staff",
  "admin:reverse_transaction", //        creates a reversal, never edits history
  "admin:resolve_exception", //          payment/reconciliation exception queue
  "admin:replay_dead_letter",
  "admin:pause_job_class",
  "admin:manage_subscriptions",
  "admin:moderate_listings",
  "admin:resolve_support_case",
  "admin:delete_synthetic_org", //       hard delete, synthetic/test organizations only (typed confirmation)
  "admin:flip_forecast_gate", //         promote forecasting to live for one merchant (owner only)
  "admin:set_forecast_thresholds", //    the platform-wide promotion thresholds (owner only)
  "admin:view_reorder", //               reorder suggestions, forecasts and their scores
  "admin:view_support_cases", //         consumer support cases, payment exceptions and refund-request counts (no merchant books)
  "admin:view_payments", //              merchant payment intents, attempts, refunds, settlements and the exception queue
  "admin:view_moderation", //            marketplace reports, listings, suspensions and appeals
  "admin:view_subscriptions", //         plans, plan versions, subscriptions, invoices, entitlements and billing exceptions
  "admin:view_messaging", //             message template register, consent and opt-out records (numbers masked), block list, volumes, alert channel
  "admin:manage_messaging", //           disable a template, block / unblock a number, replay a stuck inbound message, run an alert channel check
  "admin:approve_templates", //          record that a provider template is APPROVED (owner only: it is what allows a class of message to go out)
  "admin:manage_payment_connections", // connect a merchant to a payment provider (owner only; never a secret)
  "admin:manage_admins", //              create/disable platform admins
  // Admin-console foundation. Same `admin:` vocabulary; docs/admin/permission-matrix.md maps each to the brief's dotted name.
  "admin:view_staff", //                 staff list, roles, sessions (read-only)
  "admin:view_security_events", //       sign-in, second-factor and denied-access events (read-only)
  "admin:view_reports", //               report views (never merchant books)
  "admin:create_export", //              create an expiring, redacted export
  "admin:read_whatsapp_conversation", // open one conversation's messages (audited, needs a reason)
  "admin:unmask_pii", //                 reveal one masked phone number or name (audited, needs a reason)
  "admin:request_refund", //             open a refund request (two-person workflow: step 1)
  "admin:approve_refund", //             approve exactly the frozen request (step 2; never your own)
  "admin:execute_refund", //             run an approved refund (step 3; also needs ADMIN_REFUND_EXECUTION_ENABLED)
  "admin:grant_entitlement", //          complimentary access with a reason and an end date
  "admin:manage_config", //              validated country, currency and timezone settings (owner only)
  "admin:transfer_ownership", //         hand the platform-owner role to someone else (owner only)
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const PLATFORM_MATRIX: Readonly<Record<AdminRole, ReadonlySet<PlatformPermission>>> = {
  SUPER_ADMIN: new Set<PlatformPermission>(PLATFORM_PERMISSIONS), // the platform owner
  OPERATOR: new Set<PlatformPermission>([
    "admin:view_overview", "admin:view_system_health", "admin:view_orgs", "admin:view_audit_log",
    "admin:view_merchant_financials", "admin:manage_flags", "admin:resolve_exception", "admin:replay_dead_letter",
    "admin:pause_job_class", "admin:reverse_transaction", "admin:resolve_support_case", "admin:view_reorder", "admin:view_support_cases",
    "admin:view_payments", "admin:view_moderation", "admin:moderate_listings", "admin:view_subscriptions",
    "admin:view_messaging", "admin:manage_messaging",
    "admin:view_reports", "admin:create_export", "admin:request_refund",
  ]),
  SUPPORT: new Set<PlatformPermission>([
    "admin:view_overview", "admin:view_orgs", "admin:view_audit_log", "admin:view_merchant_financials",
    "admin:revoke_staff", "admin:resolve_support_case", "admin:view_support_cases", "admin:view_moderation", "admin:view_subscriptions", "admin:view_messaging",
    "admin:read_whatsapp_conversation", "admin:unmask_pii",
  ]),
  // Read-only analyst (legacy role; the "auditor"): metadata, audit, staff and security views only, never merchant financials.
  ANALYST: new Set<PlatformPermission>([
    "admin:view_overview", "admin:view_system_health", "admin:view_orgs", "admin:view_audit_log",
    "admin:view_staff", "admin:view_security_events", "admin:view_reports",
  ]),
  // Subscription billing, reconciliation, refunds under the two-person rule. No staff privilege grants, no flags, no moderation.
  FINANCE_ADMIN: new Set<PlatformPermission>([
    "admin:view_overview", "admin:view_orgs", "admin:view_merchant_financials", "admin:view_payments", "admin:resolve_exception",
    "admin:view_subscriptions", "admin:manage_subscriptions", "admin:view_reports", "admin:create_export",
    "admin:request_refund", "admin:approve_refund", "admin:execute_refund", "admin:grant_entitlement",
  ]),
  // Listings, reports, moderation decisions and appeals. No private financial access and no support or messaging data.
  MODERATOR: new Set<PlatformPermission>(["admin:view_overview", "admin:view_orgs", "admin:view_moderation", "admin:moderate_listings"]),
};

export function canPlatform(role: AdminRole, permission: PlatformPermission): boolean {
  return PLATFORM_MATRIX[role]?.has(permission) ?? false;
}

export function platformPermissionsFor(role: AdminRole): readonly PlatformPermission[] {
  return PLATFORM_PERMISSIONS.filter((p) => PLATFORM_MATRIX[role].has(p));
}

/** Permissions that must be re-confirmed with the admin's password (step-up) even inside a valid session. */
export const PLATFORM_STEP_UP_PERMISSIONS: ReadonlySet<PlatformPermission> = new Set<PlatformPermission>([
  "admin:view_merchant_financials",
  "admin:manage_flags",
  "admin:manage_global_flags",
  "admin:suspend_org",
  "admin:revoke_staff",
  "admin:reverse_transaction",
  "admin:resolve_exception",
  "admin:replay_dead_letter",
  "admin:pause_job_class",
  "admin:manage_subscriptions",
  "admin:manage_messaging",
  "admin:approve_templates",
  "admin:moderate_listings",
  "admin:resolve_support_case",
  "admin:delete_synthetic_org",
  "admin:flip_forecast_gate",
  "admin:set_forecast_thresholds",
  "admin:manage_payment_connections",
  "admin:manage_admins",
  "admin:create_export",
  "admin:read_whatsapp_conversation",
  "admin:unmask_pii",
  "admin:request_refund",
  "admin:approve_refund",
  "admin:execute_refund",
  "admin:grant_entitlement",
  "admin:manage_config",
  "admin:transfer_ownership",
]);

/** Legacy bridge: the two-value MerchantRole used by the WhatsApp flows maps onto membership roles. */
export function membershipRoleForLegacyMerchantRole(role: "OWNER" | "STAFF"): MembershipRole {
  return role === "OWNER" ? "OWNER" : "SALES_CLERK";
}
