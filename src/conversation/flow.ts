import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Merchant, PendingAction, Prisma, PrismaClient } from "@prisma/client";
import { applyLoggableIntent, type LoggableParsedIntent } from "../ai/applyParsedIntent.js";
import { recordAiParseLog } from "../ai/logParse.js";
import type { AiParseResult } from "../ai/parse.js";
import { ParsedIntentSchema } from "../ai/schema.js";
import { asTenantScoped, withScopedTransaction, type TenantScopedClient } from "../db/tenantScope.js";
import { QuotaExceededError, assertWithinQuotaIfEnabled } from "../domain/billing.js";
import { isBusinessSuspended } from "../domain/businessModeration.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { t } from "../i18n/index.js";
import { amountMinorOf, assessRisk, findAmbiguousItem, itemNamesOf, summarise, type RiskReason } from "./guards.js";

export const FLAG_CONVERSATIONAL = "conversationalConfirmations";
export const PENDING_MINUTES = 10;
const MAX_CODE_TRIES = 3;
const STOCK_TRACKING_FLAG = "stockTracking";

export type InputSource = "TEXT" | "VOICE";

export interface ConversationCtx {
  prisma: PrismaClient;
  scoped: TenantScopedClient;
  merchant: Pick<Merchant, "id" | "businessId" | "removedAt" | "phoneNumber">;
  business: { id: string; name: string; currencyCode: string; timezone: string; currency: { minorUnitExp: number } };
  now?: Date;
}

interface StoredPayload {
  parsed?: LoggableParsedIntent;
  parse?: AiParseResult;
  rawText: string;
  heard?: string;
  source: InputSource;
  reasons: RiskReason[];
  attempts: number;
  options?: { n: number; value: string }[];
  /** For a clarification: where the chosen value goes (index into the item names) and the proposal it belongs to. */
  clarifyItem?: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const codeHash = (id: string, code: string): string => sha256(`${id}:${code}`);

/** Binds a proposal to exactly this action for exactly this person. Recomputed at execution; a changed payload no longer matches. */
export function digestOf(args: { businessId: string; merchantId: string; parsed: LoggableParsedIntent; currencyCode: string }): string {
  return sha256(JSON.stringify([args.businessId, args.merchantId, args.currencyCode, canonical(args.parsed)]));
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

const YES = new Set(["yes", "y", "yeah", "yep", "ok", "okay", "confirm", "confirmed", "correct", "save", "save it"]);
const NO = new Set(["no", "n", "nope", "cancel", "discard", "wrong", "stop", "dont", "don't"]);
const norm = (s: string): string => s.trim().toLowerCase().replace(/[.!?\s]+$/g, "");

export async function conversationEnabled(scoped: TenantScopedClient, businessId: string): Promise<boolean> {
  return isFeatureEnabled(scoped, businessId, FLAG_CONVERSATIONAL);
}

async function logResolved(ctx: ConversationCtx, row: PendingAction, finalAction: "CONFIRMED_THEN_LOGGED" | "REJECTED", transactionId?: string | null): Promise<void> {
  const p = row.payload as unknown as StoredPayload;
  if (!p.parse) return;
  try {
    await recordAiParseLog(ctx.prisma, { businessId: row.businessId, whatsappMessageId: row.sourceMessageId.split(":")[0]!, rawInput: p.rawText, result: p.parse, finalAction, ...(transactionId ? { resultingTransactionId: transactionId } : {}) });
  } catch (error) {
    console.error("[conversation] could not write the parse log:", (error as Error).message);
  }
}

/** Guarded status change. Returns whether THIS call made the change. */
async function close(ctx: ConversationCtx, row: PendingAction, to: "CANCELLED" | "EXPIRED" | "SUPERSEDED", now: Date): Promise<boolean> {
  const r = await ctx.scoped.pendingAction.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: to, resolvedAt: now } });
  if (r.count === 1) await logResolved(ctx, row, "REJECTED");
  return r.count === 1;
}

async function openPending(ctx: ConversationCtx, now: Date): Promise<{ row: PendingAction | null; expired: boolean }> {
  const row = await ctx.scoped.pendingAction.findFirst({ where: { merchantId: ctx.merchant.id, status: "PENDING" } });
  if (!row) return { row: null, expired: false };
  if (row.expiresAt.getTime() <= now.getTime()) {
    await close(ctx, row, "EXPIRED", now);
    return { row: null, expired: true };
  }
  return { row, expired: false };
}

/**
 * A person's reply to an open question. Returns the text to send back when the message was an answer (YES, NO, a code, a choice),
 * or null when it is something else and should go through the normal path. Only a message from the same person who got the
 * preview counts; the pending row is looked up by that person.
 */
export async function tryHandleReply(ctx: ConversationCtx, text: string, source: InputSource): Promise<string | null> {
  const now = ctx.now ?? new Date();
  const word = norm(text);
  const isYes = YES.has(word);
  const isNo = NO.has(word);
  const { row, expired } = await openPending(ctx, now);

  if (!row) {
    // A stale "yes" must never become a new entry, and it must not disappear into the AI parser either.
    if (expired && (isYes || isNo || /^\d{1,4}$/.test(word))) return t("confirm.expired").text;
    if (isYes || isNo) return t("confirm.nothingPending").text;
    return null;
  }
  const p = row.payload as unknown as StoredPayload;

  if (isNo) {
    await close(ctx, row, "CANCELLED", now);
    return t("confirm.cancelled").text;
  }

  if (row.kind === "CLARIFICATION") {
    if (!/^\d{1,2}$/.test(word)) return isYes ? t("clarify.invalidChoice").text : null;
    const choice = p.options?.find((o) => o.n === Number(word));
    if (!choice) return t("clarify.invalidChoice").text;
    return resolveClarification(ctx, row, p, choice.value, now);
  }

  // a PROPOSAL
  if (isYes) {
    if (source === "VOICE") return t("confirm.typeIt").text;
    if (row.requiresCode) return t("confirm.needsCode").text;
    return execute(ctx, row, now);
  }
  if (row.requiresCode && /^\d{4}$/.test(word)) {
    if (source === "VOICE") return t("confirm.typeIt").text;
    if (row.codeHash && same(codeHash(row.id, word), row.codeHash)) return execute(ctx, row, now);
    const attempts = (p.attempts ?? 0) + 1;
    if (attempts >= MAX_CODE_TRIES) {
      await close(ctx, row, "CANCELLED", now);
      return t("confirm.cancelled").text;
    }
    await ctx.scoped.pendingAction.update({ where: { id: row.id }, data: { payload: { ...p, attempts } as unknown as Prisma.InputJsonValue } });
    return t("confirm.wrongCode").text;
  }
  return null;
}

class Changed extends Error {}

/** Revalidates everything that may have changed since the preview, then claims the row and applies the entry in ONE transaction. */
async function execute(ctx: ConversationCtx, row: PendingAction, now: Date): Promise<string> {
  const p = row.payload as unknown as StoredPayload;
  const fail = async (reason: string): Promise<string> => {
    await close(ctx, row, "CANCELLED", now);
    return t("confirm.changed", { reason }).text;
  };

  const merchant = await ctx.prisma.merchant.findUnique({ where: { id: row.merchantId } });
  if (!merchant || merchant.removedAt || merchant.businessId !== row.businessId) return fail("your access to this business changed.");
  if (await isBusinessSuspended(ctx.prisma, row.businessId)) return fail("this business is suspended.");
  const parsedCheck = ParsedIntentSchema.safeParse(p.parsed);
  if (!parsedCheck.success || !p.parsed) return fail("the entry could not be read back.");
  const parsed = p.parsed;
  if (digestOf({ businessId: row.businessId, merchantId: row.merchantId, parsed, currencyCode: ctx.business.currencyCode }) !== row.actionDigest) return fail("the entry no longer matches what you were shown.");
  if (row.currencyCode && row.currencyCode !== ctx.business.currencyCode) return fail("the business currency changed.");
  const stockTrackingEnabled = parsed.intent === "STOCK_ADJUSTMENT" || ((parsed.intent === "SALE" || parsed.intent === "PURCHASE") && (parsed.items?.length ?? 0) > 0)
    ? await isFeatureEnabled(ctx.scoped, row.businessId, STOCK_TRACKING_FLAG) : false;
  if (parsed.intent === "STOCK_ADJUSTMENT" && !stockTrackingEnabled) return fail("stock tracking is off.");
  try {
    await assertWithinQuotaIfEnabled(ctx.scoped, row.businessId, ctx.business.timezone);
  } catch (error) {
    if (error instanceof QuotaExceededError) return fail(error.message);
    throw error;
  }

  const sourceId = row.sourceMessageId.split(":")[0]!;
  try {
    const reply = await withScopedTransaction(ctx.scoped, async (tx) => {
      const claim = await tx.pendingAction.updateMany({ where: { id: row.id, status: "PENDING", expiresAt: { gt: now } }, data: { status: "EXECUTED", resolvedAt: now } });
      if (claim.count !== 1) throw new Changed("claimed");
      return applyLoggableIntent(
        { scopedPrisma: asTenantScoped(tx), businessId: row.businessId, currencyCode: ctx.business.currencyCode, minorUnitExp: ctx.business.currency.minorUnitExp, whatsappMessageId: sourceId, stockTrackingEnabled, businessName: ctx.business.name },
        parsed,
      );
    });
    const txn = await ctx.scoped.transaction.findFirst({ where: { whatsappMessageId: sourceId }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (txn) await ctx.scoped.pendingAction.updateMany({ where: { id: row.id }, data: { executedRef: txn.id } });
    await logResolved(ctx, row, "CONFIRMED_THEN_LOGGED", txn?.id ?? null);
    return reply;
  } catch (error) {
    // Someone else (a second YES, a sweep) already settled it: nothing more to do, and nothing was applied twice.
    if (error instanceof Changed) return t("confirm.nothingPending").text;
    // Anything the domain refuses (e.g. a debt payment above the balance) rolled the whole thing back, claim included.
    const known = (error as Error).name === "DebtOverpaymentError" || error instanceof QuotaExceededError;
    if (known) return fail((error as Error).message);
    throw error;
  }
}

/** The person chose one of the numbered options: build the proposal with that value and ask for the real confirmation. */
async function resolveClarification(ctx: ConversationCtx, row: PendingAction, p: StoredPayload, value: string, now: Date): Promise<string> {
  if (!p.parsed || !p.clarifyItem) return t("confirm.changed", { reason: "the question could not be read back." }).text;
  const typed = p.clarifyItem.trim().toLowerCase();
  const swap = (name: string): string => (name.trim().toLowerCase() === typed ? value : name);
  let parsed: LoggableParsedIntent = p.parsed;
  if (parsed.intent === "STOCK_ADJUSTMENT") parsed = { ...parsed, itemName: swap(parsed.itemName) };
  else if (parsed.intent === "SALE" || parsed.intent === "PURCHASE") parsed = { ...parsed, ...(parsed.items ? { items: parsed.items.map((i) => ({ ...i, itemName: swap(i.itemName) })) } : {}) } as LoggableParsedIntent;
  const claim = await ctx.scoped.pendingAction.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "EXECUTED", resolvedAt: now, executedRef: `answered:${value}`.slice(0, 120) } });
  if (claim.count !== 1) return t("confirm.nothingPending").text;
  return createProposal(ctx, { parsed, parse: p.parse, rawText: p.rawText, source: p.source, ...(p.heard ? { heard: p.heard } : {}), sourceMessageId: `${row.sourceMessageId.split(":")[0]}:clarified`, now, reasons: p.reasons });
}

interface ProposalArgs {
  parsed: LoggableParsedIntent;
  parse: AiParseResult | undefined;
  rawText: string;
  source: InputSource;
  heard?: string;
  sourceMessageId: string;
  now: Date;
  reasons?: RiskReason[];
}

async function createProposal(ctx: ConversationCtx, a: ProposalArgs): Promise<string> {
  const exp = ctx.business.currency.minorUnitExp;
  const { parsed } = a;
  const history = await ctx.scoped.transaction.aggregate({ _max: { amountMinor: true }, _count: { _all: true } });
  const stockOn = await isFeatureEnabled(ctx.scoped, ctx.business.id, STOCK_TRACKING_FLAG);
  const known = stockOn ? (await ctx.scoped.inventoryItem.findMany({ select: { name: true } })).map((i) => i.name) : undefined;
  const risk = assessRisk({
    rawText: a.rawText, parsed, businessCurrency: ctx.business.currencyCode, minorUnitExp: exp,
    history: { largestMinor: history._max.amountMinor ?? null, count: history._count._all },
    ...(known ? { knownItems: new Set(known.map((k) => k.toLowerCase())) } : {}),
  });
  const reasons = [...new Set([...(a.reasons ?? []), ...risk.reasons])];
  const needsCode = risk.needsCode || reasons.includes("INJECTION") || reasons.includes("LARGE_AMOUNT") || reasons.includes("AMOUNT_NOT_IN_MESSAGE");

  // The very same message delivered again: say where that entry stands. Checked BEFORE anything is replaced.
  const sameMessage = await ctx.scoped.pendingAction.findFirst({ where: { merchantId: ctx.merchant.id, sourceMessageId: a.sourceMessageId } });
  if (sameMessage) {
    if (sameMessage.status === "PENDING") return t("confirm.reminder", { summary: sameMessage.summary }).text;
    return sameMessage.status === "EXECUTED" ? "That entry was already saved." : t("confirm.nothingPending").text;
  }

  // an earlier question is replaced by this newer one, so "yes" can only ever mean the latest
  const open = await ctx.scoped.pendingAction.findFirst({ where: { merchantId: ctx.merchant.id, status: "PENDING" } });
  let prefix = "";
  if (open) {
    await close(ctx, open, "SUPERSEDED", a.now);
    prefix = `${t("confirm.replaced").text}\n\n`;
  }

  const base = { businessId: ctx.business.id, merchantId: ctx.merchant.id, sourceMessageId: a.sourceMessageId, expiresAt: new Date(a.now.getTime() + PENDING_MINUTES * 60_000) };
  const payloadBase: StoredPayload = { parsed, ...(a.parse ? { parse: a.parse } : {}), rawText: a.rawText, source: a.source, ...(a.heard ? { heard: a.heard } : {}), reasons, attempts: 0 };

  // ambiguous product → ask which one (numbered options)
  if (known) {
    const amb = findAmbiguousItem(itemNamesOf(parsed), known);
    if (amb) {
      const options = amb.candidates.map((value, i) => ({ n: i + 1, value }));
      const question = `${t("clarify.product", { item: amb.typed }).text}`;
      const created = await ctx.scoped.pendingAction.createMany({
        skipDuplicates: true,
        data: [{ ...base, kind: "CLARIFICATION", actionDigest: digestOf({ businessId: ctx.business.id, merchantId: ctx.merchant.id, parsed, currencyCode: ctx.business.currencyCode }), summary: summarise(parsed, ctx.business.currencyCode, exp).slice(0, 300), payload: { ...payloadBase, options, clarifyItem: amb.typed } as unknown as Prisma.InputJsonValue, question: { text: question, options } as unknown as Prisma.InputJsonValue }],
      });
      if (created.count === 0) return t("confirm.nothingPending").text;
      return prefix + t("clarify.ask", { question, options: options.map((o) => `${o.n}) ${o.value}`).join("\n") }).text;
    }
  }

  const amount = amountMinorOf(parsed);
  const code = needsCode ? String(randomInt(1000, 10000)) : null;
  const id = crypto.randomUUID();
  const lines = [summarise(parsed, ctx.business.currencyCode, exp)];
  if (reasons.includes("PACK_UNIT")) lines.push("Check the unit and the price: a carton, bag or dozen price is not the same as a single item.");
  if (reasons.includes("NEW_ITEM")) lines.push("One or more items are not in your stock list yet and would be added.");
  if (reasons.includes("INJECTION")) lines.push(t("clarify.suspicious").text);
  if (reasons.includes("LARGE_AMOUNT")) lines.push(t("clarify.largeAmount", { amount: amount !== null ? `${(Number(amount) / 10 ** exp).toLocaleString("en")} ${ctx.business.currencyCode}` : "That quantity" }).text);
  if (reasons.includes("AMOUNT_NOT_IN_MESSAGE")) lines.push("The amount I read is not one of the numbers in your message.");
  const summary = lines.join("\n");
  const created = await ctx.scoped.pendingAction.createMany({
    skipDuplicates: true,
    data: [{
      id, ...base, kind: "PROPOSAL", actionDigest: digestOf({ businessId: ctx.business.id, merchantId: ctx.merchant.id, parsed, currencyCode: ctx.business.currencyCode }),
      summary: summary.slice(0, 600), payload: payloadBase as unknown as Prisma.InputJsonValue, amountMinor: amount, currencyCode: ctx.business.currencyCode,
      requiresCode: needsCode, codeHash: code ? codeHash(id, code) : null,
    }],
  });
  if (created.count === 0) {
    // The same message arrived twice: say where that entry stands instead of proposing it again.
    const prior = await ctx.scoped.pendingAction.findFirst({ where: { merchantId: ctx.merchant.id, sourceMessageId: a.sourceMessageId } });
    if (prior?.status === "PENDING") return t("confirm.reminder", { summary: prior.summary }).text;
    return prior?.status === "EXECUTED" ? "That entry was already saved." : t("confirm.nothingPending").text;
  }
  const body = code ? t("confirm.proposalCode", { summary, code, minutes: PENDING_MINUTES }).text : t("confirm.proposal", { summary, minutes: PENDING_MINUTES }).text;
  const spoken = a.source === "VOICE" && a.heard ? t("confirm.heard", { heard: a.heard, rest: body }).text : body;
  return prefix + spoken;
}

export interface ProposeInput {
  parsed: LoggableParsedIntent;
  parse: AiParseResult;
  rawText: string;
  whatsappMessageId: string;
  source: InputSource;
}

/** Called instead of applying a parsed entry when the business has conversational confirmations on. Nothing is saved here. */
export async function proposeLoggable(ctx: ConversationCtx, input: ProposeInput): Promise<{ reply: string; finalAction: "REJECTED" | "PENDING" }> {
  const now = ctx.now ?? new Date();
  const exp = ctx.business.currency.minorUnitExp;
  const conflict = assessRisk({ rawText: input.rawText, parsed: input.parsed, businessCurrency: ctx.business.currencyCode, minorUnitExp: exp, history: { largestMinor: null, count: 0 } });
  if (conflict.currencyAmbiguous) {
    const amount = amountMinorOf(input.parsed);
    await recordAiParseLog(ctx.prisma, { businessId: ctx.business.id, whatsappMessageId: input.whatsappMessageId, rawInput: input.rawText, result: input.parse, finalAction: "REJECTED" });
    return { reply: t("clarify.currency", { amount: amount !== null ? `${(Number(amount) / 10 ** exp).toLocaleString("en")}` : "that amount", currency: ctx.business.currencyCode }).text, finalAction: "REJECTED" };
  }
  const reply = await createProposal(ctx, {
    parsed: input.parsed, parse: input.parse, rawText: input.rawText, source: input.source, sourceMessageId: input.whatsappMessageId, now,
    ...(input.source === "VOICE" ? { heard: input.rawText } : {}),
  });
  return { reply, finalAction: "PENDING" };
}
