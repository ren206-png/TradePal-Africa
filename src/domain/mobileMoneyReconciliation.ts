import type { ActorType, MobileMoneyAlert } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { recordAuditLog } from "./auditLog.js";
import { parseAmountToMinorUnits } from "./money.js";

export class MobileMoneyAlertNotFoundError extends Error {}
export class MobileMoneyAlertNotSuggestedError extends Error {}

/**
 * Provider SMS alerts vary a lot by market (M-Pesa in Kenya; MTN, Airtel,
 * Orange, and Africell Money across Ghana/Sierra Leone/elsewhere; ...).
 * Rather than one "smart" pattern that tries to cover every provider and
 * silently mis-extracts on anything novel, this is a set of narrow, explicit
 * patterns — one per SMS *shape*, not one per brand (several brands share a
 * shape). Anything that doesn't match any of them falls through to `null` —
 * per Phase 0 KQ4's "never guess" posture, an unrecognized format must be
 * logged manually by the merchant (`/paid`), not best-effort parsed.
 *
 * Amounts are intentionally optional-decimal (`(?:\.\d{2})?`): several
 * providers (MTN MoMo in particular) render whole-number amounts without
 * cents, and accepting "5,000" alongside "5,000.00" is exact parsing, not
 * guessing — parseAmountToMinorUnits pads the missing fraction with zeros.
 */
const MPESA_ALERT_PATTERN =
  /^([A-Z0-9]{8,12})\s+Confirmed\.\s*You have received\s+(?:Ksh|KES)\s?([\d,]+(?:\.\d{2})?)\s+from\s+([A-Za-z .'-]+?)\s+(\d{6,15})\b/i;

/**
 * Till/Business ("Buy Goods" and Paybill) payment-confirmation shape —
 * Safaricom's confirmation text for a payment received into a business
 * account drops "You have" that the personal-account P2P shape
 * (`MPESA_ALERT_PATTERN`) always includes: "<ID> Confirmed. Ksh<amount>
 * received from <name> <phone> ...", vs. P2P's "<ID> Confirmed. You have
 * received Ksh<amount> from <name> <phone> ...". This is the shape TradePal's
 * actual users — retail merchants — receive far more often than P2P transfers,
 * since customers typically pay a Till/Paybill number rather than the
 * merchant's personal M-Pesa account. Documented as a distinct, well-known
 * Safaricom confirmation format (not an invented guess); still M-PESA, so it
 * shares the P2P shape's provider tag.
 */
const MPESA_TILL_ALERT_PATTERN =
  /^([A-Z0-9]{8,12})\s+Confirmed\.\s*(?:Ksh|KES)\s?([\d,]+(?:\.\d{2})?)\s+received\s+from\s+([A-Za-z .'-]+?)\s+(\d{6,15})\b/i;

const TRANSACTION_ID_KEYWORD =
  "(?:Financial\\s*Transaction\\s*Id|Trans(?:action)?\\s*ID|TxnId|Ref(?:erence)?\\s*(?:No\\.?|Number)?)";

/**
 * ID-after-body shape: "...from <name> (<phone>) ... Trans ID: X" (MTN MoMo,
 * generic MoMo). The name group is greedy (not lazy) — its character class
 * already excludes digits and "(", so greedy still stops exactly at the
 * phone number; a lazy quantifier here would let the *optional* phone group
 * match zero-width and leave the name truncated to a single character (the
 * regex engine is satisfied as soon as the trailing keyword is found within
 * the following .{0,60}? window, regardless of how little of the name and
 * phone it captured).
 */
const GENERIC_MOMO_ALERT_PATTERN = new RegExp(
  `You(?:'ve| have)? received\\s+[A-Z]{3}\\s?([\\d,]+(?:\\.\\d{2})?)\\s+from\\s+([A-Za-z .'-]+)(?:\\s*\\(?(\\d{6,15})\\)?)?\\.?.{0,60}?${TRANSACTION_ID_KEYWORD}[:\\s]+([A-Za-z0-9]+)`,
  "i",
);

/** ID-leads shape: "TxnId: X. You have received ... from <name> <phone>" (Airtel Money and others). */
const LEADING_ID_MOMO_ALERT_PATTERN = new RegExp(
  `^${TRANSACTION_ID_KEYWORD}[:\\s]+([A-Za-z0-9]+)\\.?\\s*You(?:'ve| have)? received\\s+[A-Z]{3}\\s?([\\d,]+(?:\\.\\d{2})?)\\s+from\\s+([A-Za-z .'-]+?)\\s*\\(?(\\d{6,15})\\)?`,
  "i",
);

/**
 * Tags a generic-shape match with the actual provider brand when the SMS
 * names one explicitly, rather than lumping every non-M-Pesa alert under a
 * single "MOBILE_MONEY" bucket — still exact text matching, never a guess.
 */
function detectProviderBrand(rawText: string): string {
  if (/\bmtn\b/i.test(rawText)) return "MTN_MOMO";
  if (/\bairtel\b/i.test(rawText)) return "AIRTEL_MONEY";
  if (/\borange\s*money\b/i.test(rawText)) return "ORANGE_MONEY";
  if (/\bafricell\b/i.test(rawText)) return "AFRICELL_MONEY";
  return "MOBILE_MONEY";
}

export interface ParsedMobileMoneyAlert {
  provider: string;
  amountMinor: bigint;
  senderMasked?: string;
  providerTransactionId?: string;
}

/** Keeps only the last 4 digits of a phone number — the merchant already knows who paid them; this
 * is just enough for them to recognize the sender without TradePal storing the full number (KQ5-style caution). */
function maskPhoneNumber(phone: string): string {
  if (phone.length <= 4) return "*".repeat(phone.length);
  return "*".repeat(phone.length - 4) + phone.slice(-4);
}

function toMinorUnitsOrNull(amountText: string, minorUnitExp: number): bigint | null {
  try {
    return parseAmountToMinorUnits(amountText.replace(/,/g, ""), minorUnitExp);
  } catch {
    return null;
  }
}

/**
 * Attempts to parse a forwarded mobile money SMS into structured fields.
 * Returns `null` (never a best-effort guess) if the text doesn't match a
 * recognized provider format, or if the amount can't be cleanly represented
 * in the business's currency (e.g. more decimal places than the currency
 * supports).
 */
export function parseMobileMoneyAlertText(rawText: string, minorUnitExp: number): ParsedMobileMoneyAlert | null {
  const trimmed = rawText.trim();

  const mpesaMatch = MPESA_ALERT_PATTERN.exec(trimmed);
  if (mpesaMatch) {
    const providerTransactionId = mpesaMatch[1] as string;
    const amountText = mpesaMatch[2] as string;
    const senderName = (mpesaMatch[3] as string).trim();
    const senderPhone = mpesaMatch[4] as string;

    const amountMinor = toMinorUnitsOrNull(amountText, minorUnitExp);
    if (amountMinor === null) return null;

    return {
      provider: "M-PESA",
      amountMinor,
      senderMasked: `${senderName} (${maskPhoneNumber(senderPhone)})`,
      providerTransactionId,
    };
  }

  const mpesaTillMatch = MPESA_TILL_ALERT_PATTERN.exec(trimmed);
  if (mpesaTillMatch) {
    const providerTransactionId = mpesaTillMatch[1] as string;
    const amountText = mpesaTillMatch[2] as string;
    const senderName = (mpesaTillMatch[3] as string).trim();
    const senderPhone = mpesaTillMatch[4] as string;

    const amountMinor = toMinorUnitsOrNull(amountText, minorUnitExp);
    if (amountMinor === null) return null;

    return {
      provider: "M-PESA",
      amountMinor,
      senderMasked: `${senderName} (${maskPhoneNumber(senderPhone)})`,
      providerTransactionId,
    };
  }

  const genericMatch = GENERIC_MOMO_ALERT_PATTERN.exec(trimmed);
  if (genericMatch) {
    const amountText = genericMatch[1] as string;
    const senderName = (genericMatch[2] as string).trim();
    const senderPhone = genericMatch[3];
    const providerTransactionId = genericMatch[4] as string;

    const amountMinor = toMinorUnitsOrNull(amountText, minorUnitExp);
    if (amountMinor === null) return null;

    return {
      provider: detectProviderBrand(trimmed),
      amountMinor,
      senderMasked: senderPhone ? `${senderName} (${maskPhoneNumber(senderPhone)})` : senderName,
      providerTransactionId,
    };
  }

  const leadingIdMatch = LEADING_ID_MOMO_ALERT_PATTERN.exec(trimmed);
  if (leadingIdMatch) {
    const providerTransactionId = leadingIdMatch[1] as string;
    const amountText = leadingIdMatch[2] as string;
    const senderName = (leadingIdMatch[3] as string).trim();
    const senderPhone = leadingIdMatch[4] as string;

    const amountMinor = toMinorUnitsOrNull(amountText, minorUnitExp);
    if (amountMinor === null) return null;

    return {
      provider: detectProviderBrand(trimmed),
      amountMinor,
      senderMasked: `${senderName} (${maskPhoneNumber(senderPhone)})`,
      providerTransactionId,
    };
  }

  return null;
}

export interface RecordMobileMoneyAlertInput {
  businessId: string;
  provider: string;
  amountMinor: bigint;
  currencyCode: string;
  senderMasked?: string;
  providerTransactionId?: string;
  rawText: string;
}

/**
 * Idempotent on `providerTransactionId` when the provider supplies one — a
 * merchant forwarding the same SMS twice (easy to do by accident) must not
 * create a duplicate alert.
 */
export async function recordMobileMoneyAlert(
  scopedPrisma: TenantScopedClient,
  input: RecordMobileMoneyAlertInput,
): Promise<MobileMoneyAlert> {
  if (input.providerTransactionId) {
    const existing = await scopedPrisma.mobileMoneyAlert.findFirst({
      where: { providerTransactionId: input.providerTransactionId },
    });
    if (existing) return existing;
  }

  return scopedPrisma.mobileMoneyAlert.create({
    data: {
      businessId: input.businessId,
      provider: input.provider,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      senderMasked: input.senderMasked ?? null,
      providerTransactionId: input.providerTransactionId ?? null,
      rawText: input.rawText,
    },
  });
}

const DEFAULT_MATCH_WINDOW_HOURS = 48;

/**
 * Looks for exactly one unambiguous `PAYMENT_RECEIVED` transaction (same
 * amount, same currency, within `windowHours` of the alert) that isn't
 * already linked to another alert. Only auto-suggests when there is exactly
 * one candidate — zero or multiple candidates leave the alert `UNMATCHED`
 * rather than guessing which transaction it corresponds to.
 */
export async function suggestMatchForAlert(
  scopedPrisma: TenantScopedClient,
  alertId: string,
  windowHours: number = DEFAULT_MATCH_WINDOW_HOURS,
): Promise<MobileMoneyAlert> {
  const alert = await scopedPrisma.mobileMoneyAlert.findUnique({ where: { id: alertId } });
  if (!alert) throw new MobileMoneyAlertNotFoundError(`No mobile money alert with id ${alertId}.`);
  if (alert.matchStatus !== "UNMATCHED") return alert;

  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = new Date(alert.createdAt.getTime() - windowMs);
  const windowEnd = new Date(alert.createdAt.getTime() + windowMs);

  const candidates = await scopedPrisma.transaction.findMany({
    where: {
      type: "PAYMENT_RECEIVED",
      amountMinor: alert.amountMinor,
      currencyCode: alert.currencyCode,
      createdAt: { gte: windowStart, lte: windowEnd },
      mobileMoneyMatch: { none: {} },
    },
  });

  const onlyCandidate = candidates.length === 1 ? candidates[0] : undefined;
  if (!onlyCandidate) return alert;

  return scopedPrisma.mobileMoneyAlert.update({
    where: { id: alertId },
    data: { matchStatus: "SUGGESTED", matchedTransactionId: onlyCandidate.id },
  });
}

export interface MobileMoneyMatchActionInput {
  alertId: string;
  businessId: string;
  actorType: ActorType;
  actorId?: string;
}

/** Shared guard for confirm/reject: both only make sense on a `SUGGESTED` alert. */
async function loadSuggestedAlertOrThrow(scopedPrisma: TenantScopedClient, alertId: string): Promise<MobileMoneyAlert> {
  const alert = await scopedPrisma.mobileMoneyAlert.findUnique({ where: { id: alertId } });
  if (!alert) throw new MobileMoneyAlertNotFoundError(`No mobile money alert with id ${alertId}.`);
  if (alert.matchStatus !== "SUGGESTED") {
    throw new MobileMoneyAlertNotSuggestedError(
      `Alert ${alertId} has no suggested match to act on (current status: ${alert.matchStatus}).`,
    );
  }
  return alert;
}

export async function confirmMobileMoneyMatch(
  scopedPrisma: TenantScopedClient,
  input: MobileMoneyMatchActionInput,
): Promise<MobileMoneyAlert> {
  const alert = await loadSuggestedAlertOrThrow(scopedPrisma, input.alertId);

  const updated = await scopedPrisma.mobileMoneyAlert.update({
    where: { id: input.alertId },
    data: { matchStatus: "CONFIRMED" },
  });

  await recordAuditLog(scopedPrisma, {
    businessId: input.businessId,
    actorType: input.actorType,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    action: "MOBILE_MONEY_ALERT_CONFIRMED",
    entityType: "MobileMoneyAlert",
    entityId: input.alertId,
    metadata: { matchedTransactionId: alert.matchedTransactionId },
  });

  return updated;
}

/**
 * Rejecting a suggested match doesn't delete the alert — it reverts to
 * `UNMATCHED` so a future `suggestMatchForAlert` pass (or a manual re-check)
 * can still consider it, and so the audit trail of "we suggested X, merchant
 * said no" is preserved rather than erased.
 */
export async function rejectMobileMoneyMatch(
  scopedPrisma: TenantScopedClient,
  input: MobileMoneyMatchActionInput,
): Promise<MobileMoneyAlert> {
  const alert = await loadSuggestedAlertOrThrow(scopedPrisma, input.alertId);

  const updated = await scopedPrisma.mobileMoneyAlert.update({
    where: { id: input.alertId },
    data: { matchStatus: "UNMATCHED", matchedTransactionId: null },
  });

  await recordAuditLog(scopedPrisma, {
    businessId: input.businessId,
    actorType: input.actorType,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    action: "MOBILE_MONEY_ALERT_REJECTED",
    entityType: "MobileMoneyAlert",
    entityId: input.alertId,
    metadata: { previouslyMatchedTransactionId: alert.matchedTransactionId },
  });

  return updated;
}

/** Alerts currently awaiting a merchant's confirm/reject via `/confirmmomo` or `/rejectmomo`. */
export async function listSuggestedMobileMoneyAlerts(scopedPrisma: TenantScopedClient): Promise<MobileMoneyAlert[]> {
  return scopedPrisma.mobileMoneyAlert.findMany({
    where: { matchStatus: "SUGGESTED" },
    orderBy: { createdAt: "desc" },
  });
}
