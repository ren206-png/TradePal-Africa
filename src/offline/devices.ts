import { createHash, randomBytes, randomInt } from "node:crypto";
import type { DeviceSession, Merchant, PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { isBusinessSuspended } from "../domain/businessModeration.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";

/**
 * Phone sessions for offline drafts (expansion Phase 7). A person asks for a one-time code on WhatsApp (`/connect`), types it on the
 * phone's page, and receives a device token. Both the code and the token are stored only as hashes; the code works once and expires in
 * ten minutes. A shared phone gets a much shorter session and the page clears its local drafts after each sync.
 */
export const FLAG_OFFLINE_DRAFTS = "offlineDrafts";
export const CODE_MINUTES = 10;
export const SESSION_DAYS = 14;
export const SHARED_SESSION_HOURS = 8;

export const offlineSwitchOn = (): boolean => process.env["OFFLINE_DRAFTS_ENABLED"] === "true";
/** Phase 8: the same phone session can also download bookkeeping reports, behind its own platform switch and the per-business `reportsV2` flag. */
export const FLAG_REPORTS_WEB = "reportsV2";
export const reportsWebSwitchOn = (): boolean => process.env["REPORTS_WEB_ENABLED"] === "true";
/** The same phone session can also edit the product catalog in bulk and manage product photos: its own platform switch and the per-business `catalogV2` flag. */
export const FLAG_CATALOG_WEB = "catalogV2";
export const catalogWebSwitchOn = (): boolean => process.env["CATALOG_WEB_ENABLED"] === "true";
export const webRouterEnabled = (): boolean => offlineSwitchOn() || reportsWebSwitchOn() || catalogWebSwitchOn();
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const codeKey = (code: string): string => sha(`connect-code:${code}`);
const tokenKey = (token: string): string => sha(`device-token:${token}`);

export async function issueConnectCode(
  prisma: PrismaClient,
  input: { businessId: string; merchantId: string; shared: boolean; now?: Date },
): Promise<{ code: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  // an earlier code that was never used stops working the moment a new one is asked for
  await prisma.deviceSession.updateMany({ where: { merchantId: input.merchantId, lastSeenAt: null, revokedAt: null }, data: { revokedAt: now } });
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60_000);
  await prisma.deviceSession.create({ data: { businessId: input.businessId, merchantId: input.merchantId, tokenHash: codeKey(code), label: input.shared ? "shared phone" : "phone", shared: input.shared, expiresAt } });
  return { code, expiresAt };
}

/** Trades a code for a token in ONE guarded update: a second try with the same code, or a late one, finds nothing to claim. */
export async function exchangeConnectCode(prisma: PrismaClient, code: string, now: Date = new Date()): Promise<{ token: string; session: DeviceSession } | null> {
  if (!/^\d{8}$/.test(code)) return null;
  const token = randomBytes(32).toString("hex");
  const pending = await prisma.deviceSession.findUnique({ where: { tokenHash: codeKey(code) } });
  if (!pending) return null;
  const ttlMs = pending.shared ? SHARED_SESSION_HOURS * 3_600_000 : SESSION_DAYS * 86_400_000;
  const claimed = await prisma.deviceSession.updateMany({
    where: { id: pending.id, tokenHash: codeKey(code), revokedAt: null, lastSeenAt: null, expiresAt: { gt: now } },
    data: { tokenHash: tokenKey(token), lastSeenAt: now, expiresAt: new Date(now.getTime() + ttlMs) },
  });
  if (claimed.count !== 1) return null;
  return { token, session: await prisma.deviceSession.findUniqueOrThrow({ where: { id: pending.id } }) };
}

export interface AuthedDevice {
  session: DeviceSession;
  merchant: Merchant;
  business: { id: string; name: string; currencyCode: string; timezone: string; currency: { minorUnitExp: number } };
}

/** Looks the token up AND re-checks that the person and the business are still allowed in, every time. */
export async function authenticateDevice(prisma: PrismaClient, token: string | undefined, now: Date = new Date(), requiredFlag: string = FLAG_OFFLINE_DRAFTS): Promise<AuthedDevice | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const session = await prisma.deviceSession.findUnique({ where: { tokenHash: tokenKey(token) } });
  if (!session || session.revokedAt || !session.lastSeenAt || session.expiresAt.getTime() <= now.getTime()) return null;
  const merchant = await prisma.merchant.findUnique({ where: { id: session.merchantId } });
  if (!merchant || merchant.removedAt || merchant.businessId !== session.businessId) return null;
  if (await isBusinessSuspended(prisma, session.businessId)) return null;
  const business = await prisma.business.findUnique({ where: { id: session.businessId }, include: { currency: true } });
  if (!business) return null;
  if (!(await isFeatureEnabled(getTenantScopedClient(prisma, business.id), business.id, requiredFlag))) return null;
  await prisma.deviceSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  return { session, merchant, business };
}

export async function revokeSession(prisma: PrismaClient, sessionId: string, now: Date = new Date()): Promise<void> {
  await prisma.deviceSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}

export async function revokeAllForMerchant(prisma: PrismaClient, merchantId: string, now: Date = new Date()): Promise<number> {
  return (await prisma.deviceSession.updateMany({ where: { merchantId, revokedAt: null }, data: { revokedAt: now } })).count;
}
