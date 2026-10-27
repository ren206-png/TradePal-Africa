import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ADMIN_MODULES, type AdminModule } from "./adminConfig.js";

/**
 * Per-module switches for the admin API (admin-console Phase 3). A route belongs to exactly one module, decided from its path. When a
 * module is off, its routes answer like routes that do not exist: the request leaves the admin router and falls through to the
 * application's ordinary 404 (not a 403 that would confirm the module is there). Sign-in, session, second-factor, sign-out and the
 * caller's own permissions belong to no module and are always reachable by a signed-in person.
 */
export type ModuleSwitch = (module: AdminModule) => boolean;

/** Ordered: the first matching rule wins, so the specific sub-paths come before their parent segment. */
const RULES: ReadonlyArray<readonly [RegExp, AdminModule]> = [
  [/^\/businesses\/[^/]+\/transactions(\/|$)/, "ORDERS"],
  [/^\/businesses\/[^/]+\/payment-connections(\/|$)/, "PAYMENTS"],
  [/^\/businesses\/[^/]+\/feature-flags(\/|$)/, "CONFIG"],
  [/^\/businesses\/[^/]+\/(invoices|payment-requests|subscription|subscriptions)(\/|$)/, "SUBSCRIPTIONS"],
  [/^\/businesses(\/|$)/, "MERCHANTS"],
  [/^\/(merchants|deletion-requests|mobile-money-alerts)(\/|$)/, "MERCHANTS"],
  [/^\/(staff|security-events|admins|invitations)(\/|$)/, "STAFF"],
  [/^\/audit-logs(\/|$)/, "AUDIT"],
  [/^\/(overview|system|system-health)(\/|$)/, "HEALTH"],
  [/^\/(subscriptions|plan-versions|plans|invoices|billing-switches)(\/|$)/, "SUBSCRIPTIONS"],
  [/^\/moderation(\/|$)/, "MODERATION"],
  [/^\/(reorder|forecast-gate-config|support-cases)(\/|$)/, "ORDERS"],
  [/^\/messaging(\/|$)/, "WHATSAPP"],
  [/^\/(payments|payment-exceptions|payment-connections)(\/|$)/, "PAYMENTS"],
  [/^\/refund-requests(\/|$)/, "REFUNDS"],
  [/^\/(feature-flags|maintenance)(\/|$)/, "CONFIG"],
  [/^\/reports(\/|$)/, "REPORTS"],
];

/** The module a path belongs to, or null for the always-available self-service routes. */
export function moduleOf(path: string): AdminModule | null {
  for (const [re, module] of RULES) if (re.test(path)) return module;
  return null;
}

/**
 * Placed after sign-in and the second-factor gate. A path of a module that is off, AND a path no rule knows about, both leave the router:
 * a route added later without a rule is closed by default, never silently open.
 */
export function moduleGate(isOn: ModuleSwitch | undefined): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isOn) return next();
    const path = req.path;
    if (ALWAYS_AVAILABLE.test(path)) return next();
    const module = moduleOf(path);
    if (module === null || !isOn(module)) return next("router");
    next();
  };
}

const ALWAYS_AVAILABLE = /^\/(login|logout|session|mfa|me|step-up|modules)(\/|$)/;

/**
 * What is actually built behind each module switch: a module that is switched on can still be only partly built, and the console says so
 * instead of showing something that looks finished.
 */
export type ModuleBuild = "available" | "partial" | "not_built";
export const MODULE_BUILD: Readonly<Record<AdminModule, { build: ModuleBuild; note: string }>> = {
  MERCHANTS: { build: "partial", note: "Search, inspect, suspend and reinstate exist. Approve or reject with recorded verification evidence is not built." },
  STAFF: { build: "available", note: "Invitations, roles, account status, session revocation, ownership transfer and security events." },
  AUDIT: { build: "available", note: "Search by actor, action, target, business, outcome, request id and date." },
  HEALTH: { build: "available", note: "Jobs, webhooks, queues, heartbeats, AI provider refusals and configuration presence. Whether an external heartbeat monitor polls /heartbeat is not visible from here." },
  SUBSCRIPTIONS: { build: "partial", note: "Plans, versions, invoices, adjustments and billing switches exist. Complimentary access grants (the EntitlementGrant table exists) have no workflow yet and are not consulted by entitlement checks." },
  MODERATION: { build: "available", note: "Queue, listing and seller actions, reports and appeals." },
  ORDERS: { build: "available", note: "Transactions, orders, reorder, forecasts and support cases, through the existing validated services." },
  WHATSAPP: { build: "available", note: "Templates, consent, blocks, stuck-message replay and alert-channel check. Conversation bodies are not shown." },
  PAYMENTS: { build: "partial", note: "Monitoring and reconciliation work against the simulator only: no real merchant sales-payment provider is connected, so there is nothing real to monitor yet." },
  REFUNDS: { build: "available", note: "Two-person approval of subscription refunds. Execution stays off until ADMIN_REFUND_EXECUTION_ENABLED=true." },
  CONFIG: { build: "partial", note: "Feature flags and billing switches exist. Validated country, currency and timezone settings are not built." },
  REPORTS: { build: "not_built", note: "Exports with expiring download links are not built. Existing CSV exports stay inside their own modules." },
};

export function moduleReport(isOn: ModuleSwitch | undefined) {
  return ADMIN_MODULES.map((module) => ({ module, enabled: isOn ? isOn(module) : true, ...MODULE_BUILD[module] }));
}
