import type { AccountType, ActorType, JournalEntry, Provenance, Transaction } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { isFeatureEnabled } from "./featureFlags.js";

/**
 * Merchant accounting (expansion Phase 2): balanced journal entries underneath simple merchant language.
 * Worked examples for every posting rule are in docs/expansion/accounting-postings.md.
 *
 * Invariants (the database enforces the first three; see migration 20261021000000):
 *  - an entry has at least two lines and debits = credits, in one currency;
 *  - entries and lines are append-only: a correction is a REVERSAL entry (debits/credits swapped), never an edit;
 *  - every line and its account belong to the entry's business;
 *  - posting is idempotent per (business, idempotencyKey), so a replayed message cannot post twice.
 * Revenue is recognised when the sale is recorded, not when cash arrives. Buying stock is an asset (Inventory), not
 * an expense. Provider settlement moves money between accounts; it is never revenue. Fees are their own account.
 */
export class JournalError extends Error {
  readonly code: "IMBALANCE" | "INVALID" | "NOT_FOUND" | "ALREADY_REVERSED" | "REVERSAL_OF_REVERSAL";
  constructor(code: JournalError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type PaymentMethod = "CASH" | "MOBILE_MONEY" | "BANK" | "UNSPECIFIED";

export const SYSTEM_ACCOUNTS = [
  { key: "CASH", code: "1000", name: "Cash on hand", type: "ASSET" },
  { key: "MOBILE_MONEY", code: "1010", name: "Mobile money wallet", type: "ASSET" },
  { key: "BANK", code: "1020", name: "Bank account", type: "ASSET" },
  { key: "UNCLASSIFIED_FUNDS", code: "1090", name: "Money in/out (payment method not recorded)", type: "ASSET" },
  { key: "AR", code: "1100", name: "Accounts receivable (customers owe you)", type: "ASSET" },
  { key: "INVENTORY", code: "1200", name: "Inventory (stock on hand)", type: "ASSET" },
  { key: "PROVIDER_CLEARING", code: "1300", name: "Payment provider clearing", type: "ASSET" },
  { key: "UNRESOLVED_LEGACY", code: "1900", name: "Unresolved earlier entries (split not recorded)", type: "ASSET" },
  { key: "AP", code: "2000", name: "Accounts payable (you owe suppliers)", type: "LIABILITY" },
  { key: "CUSTOMER_ADVANCES", code: "2100", name: "Customer advances / deposits", type: "LIABILITY" },
  { key: "DEBT_NOTE_SUSPENSE", code: "2900", name: "Debt notes (original sale not recorded)", type: "LIABILITY" },
  { key: "OWNER_CAPITAL", code: "3000", name: "Owner's capital", type: "EQUITY" },
  { key: "OWNER_WITHDRAWALS", code: "3100", name: "Owner withdrawals", type: "EQUITY" },
  { key: "OPENING_BALANCE_EQUITY", code: "3900", name: "Opening balance equity", type: "EQUITY" },
  { key: "SALES_REVENUE", code: "4000", name: "Sales", type: "REVENUE" },
  { key: "DELIVERY_FEES", code: "4100", name: "Delivery fees charged", type: "REVENUE" },
  { key: "SALES_RETURNS", code: "4900", name: "Sales returns and refunds", type: "REVENUE" },
  { key: "COGS", code: "5000", name: "Cost of goods sold", type: "EXPENSE" },
  { key: "INVENTORY_SHRINKAGE", code: "5100", name: "Stock losses and adjustments", type: "EXPENSE" },
  { key: "CASH_OVER_SHORT", code: "5200", name: "Cash over / short", type: "EXPENSE" },
  { key: "OPERATING_EXPENSES", code: "6000", name: "Operating expenses", type: "EXPENSE" },
  { key: "PAYMENT_FEES", code: "6100", name: "Payment and mobile-money fees", type: "EXPENSE" },
] as const satisfies readonly { key: string; code: string; name: string; type: AccountType }[];

export type SystemAccountKey = (typeof SYSTEM_ACCOUNTS)[number]["key"];

const METHOD_ACCOUNT: Record<PaymentMethod, SystemAccountKey> = {
  CASH: "CASH",
  MOBILE_MONEY: "MOBILE_MONEY",
  BANK: "BANK",
  UNSPECIFIED: "UNCLASSIFIED_FUNDS",
};

/** The ledger account a payment method maps to (shared by every module that books money in or out). */
export const accountForMethod = (m: PaymentMethod): SystemAccountKey => METHOD_ACCOUNT[m];

export async function ensureChartOfAccounts(scoped: TenantScopedClient, businessId: string): Promise<Map<SystemAccountKey, string>> {
  const existing = await scoped.account.findMany({ where: {} });
  const have = new Set(existing.map((a) => a.systemKey));
  const missing = SYSTEM_ACCOUNTS.filter((a) => !have.has(a.key));
  if (missing.length > 0) {
    await scoped.account.createMany({
      data: missing.map((a) => ({ businessId, code: a.code, name: a.name, type: a.type, systemKey: a.key })),
      skipDuplicates: true,
    });
  }
  const all = await scoped.account.findMany({ where: {} });
  const map = new Map<SystemAccountKey, string>();
  for (const a of all) if (a.systemKey) map.set(a.systemKey as SystemAccountKey, a.id);
  return map;
}

export interface JournalLineInput {
  account: SystemAccountKey;
  debitMinor?: bigint;
  creditMinor?: bigint;
  memo?: string;
}

export interface PostJournalInput {
  businessId: string;
  currencyCode: string;
  kind: string;
  lines: JournalLineInput[];
  idempotencyKey: string;
  occurredAt?: Date;
  memo?: string;
  provenance?: Provenance;
  evidenceRef?: string;
  source?: { type: string; id: string };
  actor?: { type: ActorType; id?: string };
}

export interface PostedJournal {
  entry: JournalEntry;
  created: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

async function insertEntry(
  scoped: TenantScopedClient,
  header: Omit<PostJournalInput, "lines">,
  lines: { accountId: string; debitMinor: bigint; creditMinor: bigint; memo?: string }[],
  reversalOfEntryId?: string,
): Promise<PostedJournal> {
  const nonZero = lines.filter((l) => l.debitMinor > 0n || l.creditMinor > 0n);
  const debit = nonZero.reduce((s, l) => s + l.debitMinor, 0n);
  const credit = nonZero.reduce((s, l) => s + l.creditMinor, 0n);
  if (nonZero.some((l) => l.debitMinor < 0n || l.creditMinor < 0n || (l.debitMinor > 0n && l.creditMinor > 0n))) {
    throw new JournalError("INVALID", "Each journal line must be a single positive debit or credit.");
  }
  if (nonZero.length < 2) throw new JournalError("INVALID", "A journal entry needs at least two non-zero lines.");
  if (debit !== credit) throw new JournalError("IMBALANCE", `Journal entry does not balance (debits ${debit}, credits ${credit}).`);

  const existing = await scoped.journalEntry.findFirst({ where: { idempotencyKey: header.idempotencyKey } });
  if (existing) return { entry: existing, created: false };

  try {
    const entry = await scoped.journalEntry.create({
      data: {
        businessId: header.businessId,
        currencyCode: header.currencyCode,
        occurredAt: header.occurredAt ?? new Date(),
        kind: header.kind,
        memo: header.memo ?? null,
        sourceType: header.source?.type ?? null,
        sourceId: header.source?.id ?? null,
        provenance: header.provenance ?? "MERCHANT_ENTERED",
        evidenceRef: header.evidenceRef ?? null,
        actorType: header.actor?.type ?? "SYSTEM",
        actorId: header.actor?.id ?? null,
        idempotencyKey: header.idempotencyKey,
        reversalOfEntryId: reversalOfEntryId ?? null,
        lines: {
          create: nonZero.map((l) => ({
            businessId: header.businessId,
            accountId: l.accountId,
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
            memo: l.memo ?? null,
          })),
        },
      },
    });
    return { entry, created: true };
  } catch (error) {
    // A concurrent identical post won the unique index: that entry is the answer.
    if (isUniqueViolation(error)) {
      const raced = await scoped.journalEntry.findFirst({ where: { idempotencyKey: header.idempotencyKey } });
      if (raced) return { entry: raced, created: false };
    }
    throw error;
  }
}

export async function postJournal(scoped: TenantScopedClient, input: PostJournalInput): Promise<PostedJournal> {
  const accounts = await ensureChartOfAccounts(scoped, input.businessId);
  const lines = input.lines.map((l) => {
    const accountId = accounts.get(l.account);
    if (!accountId) throw new JournalError("INVALID", `Unknown account ${l.account}.`);
    return { accountId, debitMinor: l.debitMinor ?? 0n, creditMinor: l.creditMinor ?? 0n, ...(l.memo ? { memo: l.memo } : {}) };
  });
  const { lines: _ignored, ...header } = input;
  void _ignored;
  return insertEntry(scoped, header, lines);
}

/** A correction: a new entry with every debit and credit swapped, linked to the original. Idempotent. */
export async function reverseJournalEntry(
  scoped: TenantScopedClient,
  entryId: string,
  options: { reason?: string; actor?: { type: ActorType; id?: string }; occurredAt?: Date } = {},
): Promise<PostedJournal> {
  const original = await scoped.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
  if (!original) throw new JournalError("NOT_FOUND", "Journal entry not found.");
  if (original.reversalOfEntryId) throw new JournalError("REVERSAL_OF_REVERSAL", "A reversal cannot itself be reversed.");
  return insertEntry(
    scoped,
    {
      businessId: original.businessId,
      currencyCode: original.currencyCode,
      kind: "REVERSAL",
      idempotencyKey: `reverse:${original.id}`,
      occurredAt: options.occurredAt ?? new Date(),
      memo: options.reason ?? `Reversal of ${original.kind}`,
      provenance: "SYSTEM_DERIVED",
      source: { type: "JOURNAL_ENTRY", id: original.id },
      ...(options.actor ? { actor: options.actor } : {}),
    },
    original.lines.map((l) => ({ accountId: l.accountId, debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
    original.id,
  );
}

// ------------------------------------------------------------------------------------ posting rules

interface Common {
  businessId: string;
  currencyCode: string;
  idempotencyKey: string;
  occurredAt?: Date;
  memo?: string;
  provenance?: Provenance;
  evidenceRef?: string;
  source?: { type: string; id: string };
  actor?: { type: ActorType; id?: string };
}

function positive(amount: bigint, what: string): void {
  if (amount <= 0n) throw new JournalError("INVALID", `${what} must be greater than zero.`);
}

/**
 * Sale: Dr each payment method received, Dr Receivable for the unpaid part; Cr Sales for the total.
 * With a known cost: Dr Cost of goods sold, Cr Inventory (no cost known = no COGS line, never a guess).
 */
export async function postSale(
  scoped: TenantScopedClient,
  input: Common & { totalMinor: bigint; receipts: { method: PaymentMethod; amountMinor: bigint }[]; costMinor?: bigint },
): Promise<PostedJournal> {
  positive(input.totalMinor, "A sale total");
  const received = input.receipts.reduce((s, r) => s + r.amountMinor, 0n);
  if (input.receipts.some((r) => r.amountMinor <= 0n)) throw new JournalError("INVALID", "Each receipt must be greater than zero.");
  if (received > input.totalMinor) throw new JournalError("INVALID", "Receipts exceed the sale total; record the excess as a customer advance.");
  const onCredit = input.totalMinor - received;
  const lines: JournalLineInput[] = input.receipts.map((r) => ({ account: METHOD_ACCOUNT[r.method], debitMinor: r.amountMinor }));
  if (onCredit > 0n) lines.push({ account: "AR", debitMinor: onCredit });
  lines.push({ account: "SALES_REVENUE", creditMinor: input.totalMinor });
  if (input.costMinor && input.costMinor > 0n) {
    lines.push({ account: "COGS", debitMinor: input.costMinor }, { account: "INVENTORY", creditMinor: input.costMinor });
  }
  return postJournal(scoped, { ...input, kind: "SALE", lines });
}

/** Customer pays down what they owe: Dr method, Cr Receivable. Not revenue (the sale already was). */
export async function postDebtCollection(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; method: PaymentMethod }) {
  positive(input.amountMinor, "A collection");
  return postJournal(scoped, {
    ...input,
    kind: "DEBT_PAYMENT",
    lines: [{ account: METHOD_ACCOUNT[input.method], debitMinor: input.amountMinor }, { account: "AR", creditMinor: input.amountMinor }],
  });
}

/** Operating expense: Dr Expenses; Cr the method it was paid with, or Payables when on credit. */
export async function postExpense(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; paidWith: PaymentMethod | "CREDIT" }) {
  positive(input.amountMinor, "An expense");
  const credit: SystemAccountKey = input.paidWith === "CREDIT" ? "AP" : METHOD_ACCOUNT[input.paidWith];
  return postJournal(scoped, {
    ...input,
    kind: "EXPENSE",
    lines: [{ account: "OPERATING_EXPENSES", debitMinor: input.amountMinor }, { account: credit, creditMinor: input.amountMinor }],
  });
}

/** Buying stock: Dr Inventory (an asset, not an expense); Cr method or Payables. */
export async function postStockPurchase(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; paidWith: PaymentMethod | "CREDIT" }) {
  positive(input.amountMinor, "A purchase");
  const credit: SystemAccountKey = input.paidWith === "CREDIT" ? "AP" : METHOD_ACCOUNT[input.paidWith];
  return postJournal(scoped, {
    ...input,
    kind: "STOCK_PURCHASE",
    lines: [{ account: "INVENTORY", debitMinor: input.amountMinor }, { account: credit, creditMinor: input.amountMinor }],
  });
}

/** A fee charged by a provider or operator, separately identifiable: Dr Fees; Cr the account it was taken from. */
export async function postFee(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; from: PaymentMethod }) {
  positive(input.amountMinor, "A fee");
  return postJournal(scoped, {
    ...input,
    kind: "FEE",
    lines: [{ account: "PAYMENT_FEES", debitMinor: input.amountMinor }, { account: METHOD_ACCOUNT[input.from], creditMinor: input.amountMinor }],
  });
}

/**
 * Refund to a customer: Dr Sales returns; Cr the method paid out. If the goods came back sellable, also
 * Dr Inventory, Cr Cost of goods sold at the cost they left at.
 */
export async function postRefund(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; paidWith: PaymentMethod; restockCostMinor?: bigint }) {
  positive(input.amountMinor, "A refund");
  const lines: JournalLineInput[] = [
    { account: "SALES_RETURNS", debitMinor: input.amountMinor },
    { account: METHOD_ACCOUNT[input.paidWith], creditMinor: input.amountMinor },
  ];
  if (input.restockCostMinor && input.restockCostMinor > 0n) {
    lines.push({ account: "INVENTORY", debitMinor: input.restockCostMinor }, { account: "COGS", creditMinor: input.restockCostMinor });
  }
  return postJournal(scoped, { ...input, kind: "REFUND", lines });
}

/** The owner takes money out for personal use: equity, not an expense. */
export async function postOwnerWithdrawal(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; from: PaymentMethod }) {
  positive(input.amountMinor, "A withdrawal");
  return postJournal(scoped, {
    ...input,
    kind: "OWNER_WITHDRAWAL",
    lines: [{ account: "OWNER_WITHDRAWALS", debitMinor: input.amountMinor }, { account: METHOD_ACCOUNT[input.from], creditMinor: input.amountMinor }],
  });
}

export async function postOwnerContribution(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; into: PaymentMethod }) {
  positive(input.amountMinor, "A contribution");
  return postJournal(scoped, {
    ...input,
    kind: "OWNER_CONTRIBUTION",
    lines: [{ account: METHOD_ACCOUNT[input.into], debitMinor: input.amountMinor }, { account: "OWNER_CAPITAL", creditMinor: input.amountMinor }],
  });
}

/** Money a customer paid before the sale (deposit): a liability until the goods are delivered. */
export async function postCustomerAdvance(scoped: TenantScopedClient, input: Common & { amountMinor: bigint; method: PaymentMethod }) {
  positive(input.amountMinor, "An advance");
  return postJournal(scoped, {
    ...input,
    kind: "CUSTOMER_ADVANCE",
    lines: [{ account: METHOD_ACCOUNT[input.method], debitMinor: input.amountMinor }, { account: "CUSTOMER_ADVANCES", creditMinor: input.amountMinor }],
  });
}

/**
 * The provider pays out what it collected: Dr destination (net) and Dr Fees; Cr Provider clearing (gross).
 * A settlement moves money between accounts. It is never revenue.
 */
export async function postProviderSettlement(
  scoped: TenantScopedClient,
  input: Common & { grossMinor: bigint; feeMinor: bigint; destination: "BANK" | "MOBILE_MONEY" },
) {
  positive(input.grossMinor, "A settlement");
  if (input.feeMinor < 0n || input.feeMinor >= input.grossMinor) throw new JournalError("INVALID", "The fee must be zero or more and less than the settlement.");
  const lines: JournalLineInput[] = [
    { account: input.destination, debitMinor: input.grossMinor - input.feeMinor },
    { account: "PROVIDER_CLEARING", creditMinor: input.grossMinor },
  ];
  if (input.feeMinor > 0n) lines.push({ account: "PAYMENT_FEES", debitMinor: input.feeMinor });
  return postJournal(scoped, { ...input, kind: "SETTLEMENT", lines });
}

/** Stock value removed without a sale (loss, spoilage, withdrawal at cost): Dr the loss account; Cr Inventory. */
export async function postStockWriteDown(
  scoped: TenantScopedClient,
  input: Common & { costMinor: bigint; into: "INVENTORY_SHRINKAGE" | "OWNER_WITHDRAWALS" },
) {
  positive(input.costMinor, "A write-down");
  return postJournal(scoped, {
    ...input,
    kind: input.into === "OWNER_WITHDRAWALS" ? "OWNER_STOCK_WITHDRAWAL" : "STOCK_WRITE_DOWN",
    lines: [{ account: input.into, debitMinor: input.costMinor }, { account: "INVENTORY", creditMinor: input.costMinor }],
  });
}

/** Stock value added without a purchase (a count found extra): Dr Inventory; Cr the same loss account. */
export async function postStockWriteUp(scoped: TenantScopedClient, input: Common & { costMinor: bigint }) {
  positive(input.costMinor, "A write-up");
  return postJournal(scoped, {
    ...input,
    kind: "STOCK_WRITE_UP",
    lines: [{ account: "INVENTORY", debitMinor: input.costMinor }, { account: "INVENTORY_SHRINKAGE", creditMinor: input.costMinor }],
  });
}

/** Declared starting balances, labelled MIGRATED_OPENING. Each is a positive amount in its natural account. */
export async function postOpeningBalance(
  scoped: TenantScopedClient,
  input: Common & { assets: { account: SystemAccountKey; amountMinor: bigint }[]; liabilities?: { account: SystemAccountKey; amountMinor: bigint }[] },
) {
  const liabilities = input.liabilities ?? [];
  const lines: JournalLineInput[] = [
    ...input.assets.map((a) => ({ account: a.account, debitMinor: a.amountMinor })),
    ...liabilities.map((l) => ({ account: l.account, creditMinor: l.amountMinor })),
  ];
  const assets = input.assets.reduce((s, a) => s + a.amountMinor, 0n);
  const owed = liabilities.reduce((s, l) => s + l.amountMinor, 0n);
  if (assets > owed) lines.push({ account: "OPENING_BALANCE_EQUITY", creditMinor: assets - owed });
  else if (owed > assets) lines.push({ account: "OPENING_BALANCE_EQUITY", debitMinor: owed - assets });
  return postJournal(scoped, { ...input, kind: "OPENING_BALANCE", provenance: "MIGRATED_OPENING", lines });
}

/** Aligns the books to a counted amount of cash. Positive difference = cash over; negative = short. */
export async function postCashAdjustment(scoped: TenantScopedClient, input: Common & { differenceMinor: bigint }) {
  if (input.differenceMinor === 0n) throw new JournalError("INVALID", "There is no difference to adjust.");
  const over = input.differenceMinor > 0n;
  const amount = over ? input.differenceMinor : -input.differenceMinor;
  return postJournal(scoped, {
    ...input,
    kind: "CASH_ADJUSTMENT",
    lines: over
      ? [{ account: "CASH", debitMinor: amount }, { account: "CASH_OVER_SHORT", creditMinor: amount }]
      : [{ account: "CASH_OVER_SHORT", debitMinor: amount }, { account: "CASH", creditMinor: amount }],
  });
}

// ------------------------------------------------------------------------------------------ reading

export interface AccountBalanceRow {
  systemKey: string | null;
  code: string;
  name: string;
  type: AccountType;
  debitMinor: bigint;
  creditMinor: bigint;
  /** debit - credit (positive = debit balance). */
  netMinor: bigint;
}

export async function trialBalance(
  scoped: TenantScopedClient,
  options: { currencyCode: string; from?: Date; to?: Date },
): Promise<{ rows: AccountBalanceRow[]; totalDebitMinor: bigint; totalCreditMinor: bigint }> {
  const grouped = await scoped.journalLine.groupBy({
    by: ["accountId"],
    where: {
      entry: {
        currencyCode: options.currencyCode,
        ...(options.from || options.to ? { occurredAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lt: options.to } : {}) } } : {}),
      },
    },
    _sum: { debitMinor: true, creditMinor: true },
  });
  const accounts = await scoped.account.findMany({ where: {}, orderBy: { code: "asc" } });
  const rows: AccountBalanceRow[] = [];
  for (const a of accounts) {
    const g = grouped.find((x) => x.accountId === a.id);
    const debit = g?._sum.debitMinor ?? 0n;
    const credit = g?._sum.creditMinor ?? 0n;
    if (debit === 0n && credit === 0n) continue;
    rows.push({ systemKey: a.systemKey, code: a.code, name: a.name, type: a.type, debitMinor: debit, creditMinor: credit, netMinor: debit - credit });
  }
  return {
    rows,
    totalDebitMinor: rows.reduce((s, r) => s + r.debitMinor, 0n),
    totalCreditMinor: rows.reduce((s, r) => s + r.creditMinor, 0n),
  };
}

/** Net debit balance of one system account in a window (to is exclusive). */
export async function accountNet(
  scoped: TenantScopedClient,
  systemKey: SystemAccountKey,
  options: { currencyCode: string; from?: Date; to?: Date },
): Promise<bigint> {
  const account = await scoped.account.findFirst({ where: { systemKey } });
  if (!account) return 0n;
  const sum = await scoped.journalLine.aggregate({
    where: {
      accountId: account.id,
      entry: {
        currencyCode: options.currencyCode,
        ...(options.from || options.to ? { occurredAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lt: options.to } : {}) } } : {}),
      },
    },
    _sum: { debitMinor: true, creditMinor: true },
  });
  return (sum._sum.debitMinor ?? 0n) - (sum._sum.creditMinor ?? 0n);
}

// ------------------------------------------------------- legacy Transaction bridge (flag accountingJournals)

export const ACCOUNTING_FLAG = "accountingJournals";

/**
 * Journals one legacy `Transaction`. The legacy ledger recorded no payment method and no cost, so nothing is
 * invented: money in/out goes to "method not recorded", a credit sale to Receivables, a partial sale (split never
 * recorded) to "unresolved", a debt note to a suspense liability (no revenue is fabricated from it). Returns null
 * for transactions with no monetary effect.
 */
export async function postLegacyTransactionJournal(scoped: TenantScopedClient, txn: Transaction): Promise<PostedJournal | null> {
  const base: Common = {
    businessId: txn.businessId,
    currencyCode: txn.currencyCode,
    idempotencyKey: `txn:${txn.id}`,
    occurredAt: txn.createdAt,
    provenance: "MERCHANT_ENTERED",
    source: { type: "TRANSACTION", id: txn.id },
    actor: { type: "MERCHANT" },
    ...(txn.whatsappMessageId ? { evidenceRef: txn.whatsappMessageId } : {}),
    ...(txn.description ? { memo: txn.description.slice(0, 200) } : {}),
  };

  if (txn.reversalOfTransactionId) {
    const original = await scoped.journalEntry.findFirst({ where: { idempotencyKey: `txn:${txn.reversalOfTransactionId}` } });
    if (!original) return null; // the original was never journaled; nothing to reverse
    return reverseJournalEntry(scoped, original.id, { reason: txn.description ?? "Reversal", actor: { type: "MERCHANT" }, occurredAt: txn.createdAt });
  }

  const amount = txn.amountMinor;
  if (amount <= 0n) return null;

  switch (txn.type) {
    case "SALE": {
      const debit: SystemAccountKey = txn.paymentStatus === "PAID" ? "UNCLASSIFIED_FUNDS" : txn.paymentStatus === "CREDIT" ? "AR" : "UNRESOLVED_LEGACY";
      return postJournal(scoped, { ...base, kind: "SALE", lines: [{ account: debit, debitMinor: amount }, { account: "SALES_REVENUE", creditMinor: amount }] });
    }
    case "PAYMENT_RECEIVED":
      return postJournal(scoped, { ...base, kind: "DEBT_PAYMENT", lines: [{ account: "UNCLASSIFIED_FUNDS", debitMinor: amount }, { account: "AR", creditMinor: amount }] });
    case "DEBT_NOTE":
      return postJournal(scoped, { ...base, kind: "DEBT_NOTE", lines: [{ account: "AR", debitMinor: amount }, { account: "DEBT_NOTE_SUSPENSE", creditMinor: amount }] });
    case "PURCHASE":
      return postJournal(scoped, { ...base, kind: "STOCK_PURCHASE", lines: [{ account: "INVENTORY", debitMinor: amount }, { account: "UNCLASSIFIED_FUNDS", creditMinor: amount }] });
    case "EXPENSE":
      return postJournal(scoped, { ...base, kind: "EXPENSE", lines: [{ account: "OPERATING_EXPENSES", debitMinor: amount }, { account: "UNCLASSIFIED_FUNDS", creditMinor: amount }] });
    default:
      return null;
  }
}

/** Called by the legacy ledger after each write. Never throws: a journal failure must not break a merchant's message. */
export async function journalLegacyTransactionIfEnabled(scoped: TenantScopedClient, txn: Transaction): Promise<void> {
  try {
    if (!(await isFeatureEnabled(scoped, txn.businessId, ACCOUNTING_FLAG))) return;
    await postLegacyTransactionJournal(scoped, txn);
  } catch (error) {
    console.error("journal posting failed (reconcile with findUnjournaledTransactions):", error instanceof Error ? error.message : error);
  }
}

/** Transactions that should have a journal entry and do not (flag was off, or a posting failed). */
export async function findUnjournaledTransactions(scoped: TenantScopedClient, limit = 500): Promise<Transaction[]> {
  const txns = await scoped.transaction.findMany({ orderBy: { createdAt: "asc" } });
  const entries = await scoped.journalEntry.findMany({ where: { sourceType: "TRANSACTION" }, select: { id: true, sourceId: true } });
  const entryOfTxn = new Map(entries.map((e) => [e.sourceId, e.id]));
  const reversedEntries = new Set(
    (await scoped.journalEntry.findMany({ where: { reversalOfEntryId: { not: null } }, select: { reversalOfEntryId: true } })).map((e) => e.reversalOfEntryId),
  );
  const missing: Transaction[] = [];
  const missingIds = new Set<string>();
  for (const t of txns) {
    if (t.reversalOfTransactionId) {
      const originalEntry = entryOfTxn.get(t.reversalOfTransactionId);
      if (originalEntry && reversedEntries.has(originalEntry)) continue; // already reversed in the books
      // A reversal of something neither journaled nor about to be has nothing to reverse: not a gap.
      if (!originalEntry && !missingIds.has(t.reversalOfTransactionId)) continue;
    } else {
      if (entryOfTxn.has(t.id)) continue;
      if (t.type === "STOCK_ADJUSTMENT" || t.amountMinor <= 0n) continue;
    }
    missing.push(t);
    missingIds.add(t.id);
    if (missing.length >= limit) break;
  }
  return missing;
}

/** Posts the missing entries, oldest first (a reversal needs its original journaled first, which ordering guarantees). */
export async function backfillJournals(scoped: TenantScopedClient, limit = 500): Promise<{ posted: number; skipped: number }> {
  const missing = await findUnjournaledTransactions(scoped, limit);
  let posted = 0;
  let skipped = 0;
  for (const t of missing) {
    const result = await postLegacyTransactionJournal(scoped, t);
    if (result?.created) posted++;
    else skipped++;
  }
  return { posted, skipped };
}
