import { createHash, createHmac } from "node:crypto";
import type { ContactConsentBasis, ContactPurpose, PrismaClient } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction } from "../db/tenantScope.js";

/**
 * The consent register (expansion Phase 7). Transaction updates and marketing are SEPARATE purposes: ticking the order-update
 * box at checkout can never grant marketing (a CHECK constraint refuses it). Nothing here messages anyone; it only records
 * what a person agreed to and what they withdrew. A number that sent STOP is blocked platform-wide until the person themselves
 * sends START (or an operator lifts an operator block).
 */
export const ORDER_UPDATES_TEXT_VERSION = "order-updates-v2";
export const ORDER_UPDATES_NOTICE =
  "I want WhatsApp updates about this order from TradePal Africa, on behalf of the seller. Updates only, no marketing. To start them I will tap a link on my order page and send one WhatsApp message from this number. I can reply STOP at any time.";

/**
 * Ticking the box is a CLAIM, and the number typed at checkout may belong to somebody else. Updates are sent only after the person has sent
 * TradePal a WhatsApp message from that very number carrying a code derived from their private order link ("double opt-in" with no extra
 * template: the person's own message opens the conversation and proves they control the number).
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const UPDATES_CODE_DAYS = 30;
export function deriveUpdatesCode(accessToken: string): string {
  const h = createHmac("sha256", process.env["MESSAGING_LOG_PEPPER"] ?? "tradepal-unset-pepper").update(`updates:${accessToken}`).digest();
  return Array.from(h.subarray(0, 8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
const codeHash = (code: string): string => createHash("sha256").update(`updates-code:${code.toUpperCase()}`).digest("hex");
/** "UPDATES AB12CD34" (whole message). */
export function parseUpdatesMessage(text: string): string | null {
  const m = /^updates\s+([A-Za-z0-9]{8})$/i.exec(text.trim());
  return m ? m[1]!.toUpperCase() : null;
}
/** The wa.me link the shopper taps, or null when the public number is not configured (then no consent can ever be verified: fail closed). */
export function updatesLink(code: string): string | null {
  const number = process.env["WHATSAPP_PUBLIC_NUMBER"]?.replace(/\D/g, "");
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(`UPDATES ${code}`)}` : null;
}

export const digitsOnly = (phone: string): string => phone.replace(/\D/g, "");

/** A keyed hash so a stored log row cannot be turned back into a number by guessing; it only lets us match repeat sends. */
export function phoneHash(phone: string): string {
  return createHmac("sha256", process.env["MESSAGING_LOG_PEPPER"] ?? "tradepal-unset-pepper").update(digitsOnly(phone)).digest("hex");
}
export const phoneLast4 = (phone: string): string => digitsOnly(phone).slice(-4).padStart(4, "0");
export const maskPhone = (phone: string): string => `••••${phoneLast4(phone)}`;

const STOP_WORDS = new Set(["stop", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "subscribe"]);
export type ConsentKeyword = "STOP" | "START" | null;
/** Whole-message match only: "please stop the delivery" is not an opt-out. */
export function consentKeyword(text: string): ConsentKeyword {
  const w = text.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  if (STOP_WORDS.has(w)) return "STOP";
  if (START_WORDS.has(w)) return "START";
  return null;
}

export async function recordOrderUpdatesConsent(
  prisma: PrismaClient,
  input: { businessId: string; phone: string; sourceRef?: string; textVersion?: string; basis?: ContactConsentBasis; verifyCode?: string },
): Promise<void> {
  const phone = digitsOnly(input.phone);
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const textVersion = input.textVersion ?? ORDER_UPDATES_TEXT_VERSION;
  await withScopedTransaction(scoped, async (tx) => {
    const consent = await tx.contactConsent.upsert({
      where: { businessId_phone_purpose: { businessId: input.businessId, phone, purpose: "ORDER_UPDATES" } },
      create: { businessId: input.businessId, phone, purpose: "ORDER_UPDATES", status: "OPTED_IN", basis: input.basis ?? "ORDER_CHECKOUT", textVersion, sourceRef: input.sourceRef ?? null, ...(input.verifyCode ? { verifyCodeHash: codeHash(input.verifyCode) } : {}) },
      // an already-verified number stays verified; a withdrawn one must verify again
      update: { status: "OPTED_IN", basis: input.basis ?? "ORDER_CHECKOUT", textVersion, sourceRef: input.sourceRef ?? null, ...(input.verifyCode ? { verifyCodeHash: codeHash(input.verifyCode) } : {}) },
    });
    await tx.contactConsentEvent.create({ data: { businessId: input.businessId, consentId: consent.id, event: "OPT_IN", source: input.basis ?? "ORDER_CHECKOUT", textVersion } });
  });
}

/** One seller's consent only (the shopper withdraws from one seller). Does not block the number. */
export async function withdrawConsent(prisma: PrismaClient, input: { businessId: string; phone: string; purpose: ContactPurpose; source: string }): Promise<boolean> {
  const phone = digitsOnly(input.phone);
  const scoped = getTenantScopedClient(prisma, input.businessId);
  return withScopedTransaction(scoped, async (tx) => {
    const consent = await tx.contactConsent.findFirst({ where: { phone, purpose: input.purpose } });
    if (!consent || consent.status === "OPTED_OUT") return false;
    await tx.contactConsent.update({ where: { id: consent.id }, data: { status: "OPTED_OUT" } });
    await tx.contactConsentEvent.create({ data: { businessId: input.businessId, consentId: consent.id, event: "OPT_OUT", source: input.source } });
    return true;
  });
}

export async function isBlocked(prisma: PrismaClient, phone: string): Promise<boolean> {
  const row = await prisma.blockedNumber.findUnique({ where: { phone: digitsOnly(phone) } });
  return !!row && row.liftedAt === null;
}

/** True when this number has any consent or block record, i.e. TradePal has a reason to treat STOP / START from it as an opt-out request. */
export async function hasConsentHistory(prisma: PrismaClient, phone: string): Promise<boolean> {
  const p = digitsOnly(phone);
  if (await prisma.contactConsent.findFirst({ where: { phone: p }, select: { id: true } })) return true;
  return !!(await prisma.blockedNumber.findUnique({ where: { phone: p }, select: { id: true } }));
}

/**
 * STOP: the person withdraws from everything, with every seller, and the number is blocked. Platform operation: it reads and
 * updates consent rows across businesses, so it uses the unscoped client by design (see db-protection.md about the future role).
 */
export async function applyStop(prisma: PrismaClient, phoneInput: string, source = "STOP_KEYWORD"): Promise<{ withdrawn: number }> {
  const phone = digitsOnly(phoneInput);
  const open = await prisma.contactConsent.findMany({ where: { phone, status: "OPTED_IN" } });
  for (const c of open) {
    await prisma.contactConsent.update({ where: { id: c.id }, data: { status: "OPTED_OUT" } });
    await prisma.contactConsentEvent.create({ data: { businessId: c.businessId, consentId: c.id, event: "GLOBAL_STOP", source } });
  }
  const existing = await prisma.blockedNumber.findUnique({ where: { phone } });
  if (!existing) await prisma.blockedNumber.create({ data: { phone, source } });
  else if (existing.liftedAt !== null) await prisma.blockedNumber.update({ where: { phone }, data: { liftedAt: null, liftedBy: null, liftReason: null, source } });
  return { withdrawn: open.length };
}

/**
 * START: only lifts a block the PERSON created with STOP, and only restores the consents that STOP itself withdrew (their last
 * event is GLOBAL_STOP). A consent the person withdrew another way, and any operator block, stay as they are.
 */
export async function applyStart(prisma: PrismaClient, phoneInput: string): Promise<{ restored: number; lifted: boolean }> {
  const phone = digitsOnly(phoneInput);
  const block = await prisma.blockedNumber.findUnique({ where: { phone } });
  if (!block || block.liftedAt !== null || block.source !== "STOP_KEYWORD") return { restored: 0, lifted: false };
  await prisma.blockedNumber.update({ where: { phone }, data: { liftedAt: new Date(), liftedBy: "self", liftReason: "START keyword" } });
  const withdrawn = await prisma.contactConsent.findMany({ where: { phone, status: "OPTED_OUT" } });
  let restored = 0;
  for (const c of withdrawn) {
    const last = await prisma.contactConsentEvent.findFirst({ where: { consentId: c.id }, orderBy: { createdAt: "desc" } });
    if (last?.event !== "GLOBAL_STOP") continue;
    await prisma.contactConsent.update({ where: { id: c.id }, data: { status: "OPTED_IN" } });
    await prisma.contactConsentEvent.create({ data: { businessId: c.businessId, consentId: c.id, event: "GLOBAL_START", source: "START_KEYWORD" } });
    restored++;
  }
  return { restored, lifted: true };
}

/** Operator block / unblock (admin panel). A block overrides every consent; an operator block cannot be lifted by START. */
export async function adminBlock(prisma: PrismaClient, input: { phone: string; reason: string; adminUserId: string }): Promise<void> {
  const phone = digitsOnly(input.phone);
  const existing = await prisma.blockedNumber.findUnique({ where: { phone } });
  if (!existing) await prisma.blockedNumber.create({ data: { phone, source: "ADMIN", reason: input.reason, blockedBy: input.adminUserId } });
  else await prisma.blockedNumber.update({ where: { phone }, data: { source: "ADMIN", reason: input.reason, blockedBy: input.adminUserId, liftedAt: null, liftedBy: null, liftReason: null } });
}

export async function adminUnblock(prisma: PrismaClient, input: { phone: string; reason: string; adminUserId: string }): Promise<boolean> {
  const phone = digitsOnly(input.phone);
  const existing = await prisma.blockedNumber.findUnique({ where: { phone } });
  if (!existing || existing.liftedAt !== null) return false;
  // Lifting a block never re-opts anyone in: consents stay withdrawn until the person opts in again.
  await prisma.blockedNumber.update({ where: { phone }, data: { liftedAt: new Date(), liftedBy: input.adminUserId, liftReason: input.reason } });
  return true;
}

export type VerifyResult = { result: "VERIFIED"; sellerName: string; reference: string } | { result: "NOT_FOUND" } | { result: "BLOCKED" };

/**
 * The shopper's own message "UPDATES <code>": marks the consent verified only when the SENDER is the number the consent was recorded for
 * and the code matches (so a code leaked to someone else is useless from another phone). Platform operation (unscoped client, by design).
 */
export async function verifyUpdatesByCode(prisma: PrismaClient, input: { phone: string; code: string; now?: Date }): Promise<VerifyResult> {
  const now = input.now ?? new Date();
  const phone = digitsOnly(input.phone);
  const since = new Date(now.getTime() - UPDATES_CODE_DAYS * 86_400_000);
  const consent = await prisma.contactConsent.findFirst({ where: { phone, purpose: "ORDER_UPDATES", status: "OPTED_IN", verifyCodeHash: codeHash(input.code), updatedAt: { gte: since } } });
  if (!consent) return { result: "NOT_FOUND" };
  if (await isBlocked(prisma, phone)) return { result: "BLOCKED" };
  await prisma.contactConsent.update({ where: { id: consent.id }, data: { verifiedAt: now, verifyCodeHash: null } });
  await prisma.contactConsentEvent.create({ data: { businessId: consent.businessId, consentId: consent.id, event: "VERIFIED", source: "INBOUND_MESSAGE", textVersion: consent.textVersion } });
  const order = consent.sourceRef ? await prisma.storeOrder.findUnique({ where: { id: consent.sourceRef }, select: { reference: true } }) : null;
  const shop = await prisma.storefront.findFirst({ where: { businessId: consent.businessId }, select: { title: true } });
  return { result: "VERIFIED", sellerName: shop?.title ?? "the seller", reference: order?.reference ?? "your order" };
}
