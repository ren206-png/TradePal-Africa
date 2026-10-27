import { createHmac } from "node:crypto";

/**
 * Admin-console switches and session rules (admin-console Phase 2). Everything here is read from the environment so a deployment can
 * change it without a code change; every value has a safe default and an out-of-range value falls back to the default instead of
 * silently weakening a rule.
 */

/** The master switch. Anything but the exact string "true" means off: every /admin route then answers like a route that does not exist. */
export function adminConsoleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ADMIN_CONSOLE_ENABLED"] === "true";
}

/**
 * Per-module switches (`ADMIN_MODULE_MERCHANTS`, `ADMIN_MODULE_STAFF`, ...). A module is on only when the master switch is on AND
 * its own switch is exactly "true". Default off.
 */
export const ADMIN_MODULES = [
  "MERCHANTS", "STAFF", "AUDIT", "HEALTH", "SUBSCRIPTIONS", "MODERATION", "ORDERS", "WHATSAPP", "PAYMENTS", "REFUNDS", "CONFIG", "REPORTS",
] as const;
export type AdminModule = (typeof ADMIN_MODULES)[number];

export function adminModuleEnabled(module: AdminModule, env: NodeJS.ProcessEnv = process.env): boolean {
  return adminConsoleEnabled(env) && env[`ADMIN_MODULE_${module}`] === "true";
}

/** Refund execution has its own switch, default off even when the Refunds module is on. */
export function refundExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return adminModuleEnabled("REFUNDS", env) && env["ADMIN_REFUND_EXECUTION_ENABLED"] === "true";
}

/** Second-factor enforcement for everyone. On unless explicitly set to "false" (a staff member invited after Phase 2 is always held to it). */
export function adminMfaEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ADMIN_MFA_ENFORCE"] !== "false";
}

/** The first-owner command and the second-factor reset command run only while this is "true": set it for one command, never on the server. */
export function adminBootstrapAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ADMIN_BOOTSTRAP_ALLOWED"] === "true";
}

/**
 * WhatsApp sign-in codes (the alternative to an authenticator app). Available only when the switch is exactly "true" AND the Meta
 * AUTHENTICATION template name is set; the template language defaults to "en". The WhatsApp send credentials are the platform's
 * existing ones (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID); without them nothing can be sent either.
 */
export interface AdminWhatsappCodeConfig { templateName: string; languageCode: string }
export function adminWhatsappCodesConfig(env: NodeJS.ProcessEnv = process.env): AdminWhatsappCodeConfig | undefined {
  if (env["ADMIN_WHATSAPP_CODES_ENABLED"] !== "true") return undefined;
  const templateName = (env["WHATSAPP_ADMIN_CODE_TEMPLATE_NAME"] ?? "").trim();
  if (!templateName) return undefined;
  return { templateName, languageCode: (env["WHATSAPP_ADMIN_CODE_TEMPLATE_LANGUAGE"] ?? "").trim() || "en" };
}

export interface AdminSessionPolicy {
  /** Longest a session can live, whatever the activity. */
  absoluteMs: number;
  /** A session with no request for this long is over. */
  idleMs: number;
  /** A sensitive action needs a password + second-factor confirmation no older than this. */
  reauthMs: number;
  /** After sign-in with the password, the second factor must be completed within this time. */
  preMfaMs: number;
}

export const DEFAULT_SESSION_POLICY: AdminSessionPolicy = {
  absoluteMs: 12 * 60 * 60_000,
  idleMs: 30 * 60_000,
  reauthMs: 10 * 60_000,
  preMfaMs: 15 * 60_000,
};

function minutes(raw: string | undefined, fallbackMs: number, maxMinutes: number): number {
  if (raw === undefined || raw === "") return fallbackMs;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= maxMinutes ? n * 60_000 : fallbackMs;
}

export function sessionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AdminSessionPolicy {
  return {
    absoluteMs: minutes(env["ADMIN_SESSION_ABSOLUTE_MINUTES"], DEFAULT_SESSION_POLICY.absoluteMs, 24 * 60),
    idleMs: minutes(env["ADMIN_SESSION_IDLE_MINUTES"], DEFAULT_SESSION_POLICY.idleMs, 8 * 60),
    reauthMs: minutes(env["ADMIN_REAUTH_MINUTES"], DEFAULT_SESSION_POLICY.reauthMs, 60),
    preMfaMs: minutes(env["ADMIN_PRE_MFA_MINUTES"], DEFAULT_SESSION_POLICY.preMfaMs, 60),
  };
}

export const INVITATION_TTL_MS = 72 * 60 * 60_000;
export const OWNERSHIP_TRANSFER_TTL_MS = 24 * 60 * 60_000;

/** The 32-byte key that encrypts second-factor secrets at rest: `ADMIN_MFA_ENCRYPTION_KEY`, 64 hex characters. Unset means enrolment is refused. */
export function mfaEncryptionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const hex = env["ADMIN_MFA_ENCRYPTION_KEY"] ?? "";
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : undefined;
}

/**
 * A keyed hash for things that must be countable but never stored raw: a caller's address, a user agent, a tried email. The key is
 * derived from the admin JWT secret and a purpose label, so the same input hashes differently for each purpose.
 */
export function keyedHash(jwtSecret: string, purpose: string, value: string): string {
  return createHmac("sha256", `${jwtSecret}::admin-hash::${purpose}`).update(value.toLowerCase()).digest("hex").slice(0, 32);
}
