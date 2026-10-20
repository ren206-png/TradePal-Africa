import { createHmac } from "node:crypto";
import type { ContactConsentBasis, ContactPurpose, PrismaClient } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction } from "../db/tenantScope.js";

/**
 * The consent register (expansion Phase 7). Transaction updates and marketing are SEPARATE purposes: ticking the order-update
 * box at checkout can never grant marketing (a CHECK constraint refuses it). Nothing here messages anyone; it only records
 * what a person agreed to and what they withdrew. A number that sent STOP is blocked platform-wide until the person themselves
 * sends START (or an operator lifts an operator block).
 */
export const ORDER_UPDATES_TEXT_VERSION = "order-updates-v1";
export const ORDER_UPDATES_NOTICE =
  "Send me WhatsApp updates about this order from TradePal Africa, on behalf of the seller. Updates only, no marketing. I can reply STOP at any time.";

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
  input: { businessId: string; phone: string; sourceRef?: string; textVersion?: string; basis?: ContactConsentBasis },
): Promise<void> {
  const phone = digitsOnly(input.phone);
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const textVersion = input.textVersion ?? ORDER_UPDATES_TEXT_VERSION;
  await withScopedTransaction(scoped, async (tx) => {
    const consent = await tx.contactConsent.upsert({
      where: { businessId_phone_purpose: { businessId: input.businessId, phone, purpose: "ORDER_UPDATES" } },
      create: { businessId: input.businessId, phone, purpose: "ORDER_UPDATES", status: "OPTED_IN", basis: input.basis ?? "ORDER_CHECKOUT", textVersion, sourceRef: input.sourceRef ?? null },
      update: { status: "OPTED_IN", basis: input.basis ?? "ORDER_CHECKOUT", textVersion, sourceRef: input.sourceRef ?? null },
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
