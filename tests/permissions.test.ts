import { describe, expect, it } from "vitest";
import {
  MERCHANT_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PLATFORM_STEP_UP_PERMISSIONS,
  canMerchant,
  canPlatform,
  membershipRoleForLegacyMerchantRole,
  merchantPermissionsFor,
  platformPermissionsFor,
} from "../src/auth/permissions.js";

const MERCHANT_ROLES = ["OWNER", "MANAGER", "SALES_CLERK", "INVENTORY_OPERATOR", "FINANCE_OPERATOR", "RESTRICTED_SUPPORT"] as const;
const PLATFORM_ROLES = ["SUPER_ADMIN", "OPERATOR", "SUPPORT", "ANALYST", "FINANCE_ADMIN", "MODERATOR"] as const;

describe("merchant permission matrix", () => {
  it("gives the owner everything and keeps owner-only powers owner-only", () => {
    expect(merchantPermissionsFor("OWNER")).toEqual(MERCHANT_PERMISSIONS);
    for (const owned of ["payments:connect_provider", "settings:manage", "business:manage", "trade:credit_override"] as const) {
      const holders = MERCHANT_ROLES.filter((r) => canMerchant(r, owned));
      expect(holders, owned).toEqual(["OWNER"]);
    }
  });

  it("separates the duties: finance cannot adjust stock, inventory cannot touch finance, clerks cannot void", () => {
    expect(canMerchant("FINANCE_OPERATOR", "inventory:adjust")).toBe(false);
    expect(canMerchant("FINANCE_OPERATOR", "finance:close_day")).toBe(true);
    expect(canMerchant("INVENTORY_OPERATOR", "finance:close_day")).toBe(false);
    expect(canMerchant("INVENTORY_OPERATOR", "inventory:adjust")).toBe(true);
    expect(canMerchant("SALES_CLERK", "sales:void")).toBe(false);
    expect(canMerchant("MANAGER", "sales:void")).toBe(true);
    expect(canMerchant("MANAGER", "staff:manage")).toBe(true);
    expect(canMerchant("MANAGER", "payments:connect_provider")).toBe(false);
  });

  it("makes RESTRICTED_SUPPORT strictly read-only", () => {
    const perms = merchantPermissionsFor("RESTRICTED_SUPPORT");
    expect(perms.length).toBeGreaterThan(0);
    expect(perms.every((p) => p.endsWith(":view"))).toBe(true);
  });

  it("maps the legacy two-value merchant role onto membership roles", () => {
    expect(membershipRoleForLegacyMerchantRole("OWNER")).toBe("OWNER");
    expect(membershipRoleForLegacyMerchantRole("STAFF")).toBe("SALES_CLERK");
  });
});

describe("platform-admin permission matrix", () => {
  it("is a separate family: no overlap with merchant permissions, every platform permission is admin:-prefixed", () => {
    expect(PLATFORM_PERMISSIONS.every((p) => p.startsWith("admin:"))).toBe(true);
    expect(MERCHANT_PERMISSIONS.some((p) => p.startsWith("admin:"))).toBe(false);
    const merchantNames = new Set<string>(MERCHANT_PERMISSIONS);
    expect(PLATFORM_PERMISSIONS.some((p) => merchantNames.has(p))).toBe(false);
  });

  it("reserves the sharpest tools for the platform owner", () => {
    for (const sharp of ["admin:flip_forecast_gate", "admin:set_forecast_thresholds", "admin:manage_admins", "admin:delete_synthetic_org", "admin:manage_global_flags"] as const) {
      expect(PLATFORM_ROLES.filter((r) => canPlatform(r, sharp)), sharp).toEqual(["SUPER_ADMIN"]);
    }
  });

  it("keeps the analyst read-only and away from merchant money, and support away from flags", () => {
    const analyst = platformPermissionsFor("ANALYST");
    expect(analyst.every((p) => p.startsWith("admin:view_"))).toBe(true);
    expect(canPlatform("ANALYST", "admin:view_merchant_financials")).toBe(false);
    expect(canPlatform("SUPPORT", "admin:manage_flags")).toBe(false);
    expect(canPlatform("SUPPORT", "admin:view_merchant_financials")).toBe(true);
    expect(canPlatform("OPERATOR", "admin:reverse_transaction")).toBe(true);
    expect(canPlatform("OPERATOR", "admin:manage_admins")).toBe(false);
  });

  it("requires step-up confirmation for every permission that changes anything or opens merchant money", () => {
    const readOnly = PLATFORM_PERMISSIONS.filter((p) => p.startsWith("admin:view_") && p !== "admin:view_merchant_financials");
    for (const permission of PLATFORM_PERMISSIONS) {
      if (readOnly.includes(permission)) expect(PLATFORM_STEP_UP_PERMISSIONS.has(permission), permission).toBe(false);
      else expect(PLATFORM_STEP_UP_PERMISSIONS.has(permission), permission).toBe(true);
    }
  });

  it("admin-console foundation: owner-only powers, the two-person refund split, and the least-privilege new roles", () => {
    for (const ownerOnly of ["admin:manage_config", "admin:transfer_ownership"] as const) {
      expect(PLATFORM_ROLES.filter((r) => canPlatform(r, ownerOnly)), ownerOnly).toEqual(["SUPER_ADMIN"]);
    }
    // refunds: requesting is wider than approving, approving and executing sit with finance and the owner, support never refunds
    expect(PLATFORM_ROLES.filter((r) => canPlatform(r, "admin:request_refund"))).toEqual(["SUPER_ADMIN", "OPERATOR", "FINANCE_ADMIN"]);
    expect(PLATFORM_ROLES.filter((r) => canPlatform(r, "admin:approve_refund"))).toEqual(["SUPER_ADMIN", "FINANCE_ADMIN"]);
    expect(PLATFORM_ROLES.filter((r) => canPlatform(r, "admin:execute_refund"))).toEqual(["SUPER_ADMIN", "FINANCE_ADMIN"]);
    expect(canPlatform("SUPPORT", "admin:request_refund")).toBe(false);
    // finance: no staff powers, no flags, no moderation, no messaging
    for (const p of ["admin:manage_admins", "admin:manage_flags", "admin:moderate_listings", "admin:manage_messaging", "admin:view_staff"] as const) expect(canPlatform("FINANCE_ADMIN", p), p).toBe(false);
    // moderator: no financial, support, messaging, staff or export access at all
    expect([...platformPermissionsFor("MODERATOR")].sort()).toEqual(["admin:moderate_listings", "admin:view_moderation", "admin:view_orgs", "admin:view_overview"]);
    // the auditor (ANALYST) sees staff and security events but cannot change or export anything
    expect(canPlatform("ANALYST", "admin:view_security_events")).toBe(true);
    expect(canPlatform("ANALYST", "admin:create_export")).toBe(false);
    // support can read a conversation or unmask a number (audited, step-up), nobody else except the owner
    expect(PLATFORM_ROLES.filter((r) => canPlatform(r, "admin:read_whatsapp_conversation"))).toEqual(["SUPER_ADMIN", "SUPPORT"]);
    expect(PLATFORM_ROLES.filter((r) => canPlatform(r, "admin:unmask_pii"))).toEqual(["SUPER_ADMIN", "SUPPORT"]);
  });

  it("never gives a platform role a merchant permission (an admin is not a super-merchant)", () => {
    // Platform roles have no entry in the merchant matrix at all, and every platform permission is admin:-prefixed,
    // so opening a merchant's books is only ever the separate, audited admin:view_merchant_financials.
    for (const role of PLATFORM_ROLES) expect(platformPermissionsFor(role).every((p) => p.startsWith("admin:")), role).toBe(true);
  });
});
