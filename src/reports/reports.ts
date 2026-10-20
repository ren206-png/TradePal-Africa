import { SYSTEM_ACCOUNTS, trialBalance } from "../domain/accounting.js";
import { findLegacyStockDrift, reconcileStock } from "../domain/stock.js";
import { ensureDefaultShopFor } from "../domain/shops.js";
import { checkRange, journalsOn, localDay, meta, str, sumBig, ReportError, type RangeInput, type Report, type ReportContext, type Warning } from "./common.js";

const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
type Bucket = (typeof AGING_BUCKETS)[number];
const DAY = 86_400_000;

function bucketOf(dueOrStart: Date, asOf: Date, hasDueDate: boolean): Bucket {
  const days = Math.floor((asOf.getTime() - dueOrStart.getTime()) / DAY);
  if (hasDueDate) return days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
  // no due date: age counts from when the debt was created
  return days <= 30 ? "current" : days <= 60 ? "1-30" : days <= 90 ? "31-60" : days <= 120 ? "61-90" : "90+";
}

async function legacyNotJournaled(ctx: ReportContext, range: RangeInput): Promise<number> {
  const txns = await ctx.scoped.transaction.findMany({ where: { createdAt: { gte: range.from, lt: range.to }, reversalOfTransactionId: null, currencyCode: ctx.currencyCode }, select: { id: true } });
  if (txns.length === 0) return 0;
  const done = await ctx.scoped.journalEntry.count({ where: { sourceType: "TRANSACTION", sourceId: { in: txns.map((t) => t.id) } } });
  return Math.max(0, txns.length - done);
}

/** Entries in a currency other than the business's own are not in any total below (TradePal never converts between currencies); say so. */
async function otherCurrencyWarning(ctx: ReportContext, range: RangeInput): Promise<Warning | null> {
  const n = await ctx.scoped.journalEntry.count({ where: { currencyCode: { not: ctx.currencyCode }, occurredAt: { gte: range.from, lt: range.to } } });
  const t = await ctx.scoped.transaction.count({ where: { currencyCode: { not: ctx.currencyCode }, createdAt: { gte: range.from, lt: range.to } } });
  const count = Math.max(n, t);
  return count > 0 ? { code: "OTHER_CURRENCY", message: `${count} entr${count === 1 ? "y" : "ies"} in another currency ${count === 1 ? "is" : "are"} NOT included. TradePal does not convert between currencies; these totals are in ${ctx.currencyCode} only.` } : null;
}

// -------------------------------------------------------------------------------------------------- sales

export interface SalesDay { day: string; saleCount: number; grossSalesMinor: string; returnsMinor: string; netSalesMinor: string }
export interface SalesData { days: SalesDay[]; totals: { saleCount: number; grossSalesMinor: string; returnsMinor: string; netSalesMinor: string }; byProvenance: { provenance: string; netSalesMinor: string }[] }

export async function salesReport(ctx: ReportContext, range: RangeInput): Promise<Report<SalesData>> {
  checkRange(range);
  const warnings: Warning[] = [];
  const byDay = new Map<string, { n: number; gross: bigint; returns: bigint }>();
  const day = (d: Date) => {
    const k = localDay(d, ctx.timezone);
    if (!byDay.has(k)) byDay.set(k, { n: 0, gross: 0n, returns: 0n });
    return byDay.get(k)!;
  };
  const prov = new Map<string, bigint>();
  let rows = 0;
  let basis: string;
  let sourceName: string;

  if (await journalsOn(ctx)) {
    sourceName = "journal entries (Sales and Sales returns accounts)";
    basis = "Sales are the credits to the Sales account; returns and refunds are debits to Sales returns. Corrections are reversals, so a voided sale nets to zero.";
    const lines = await ctx.scoped.journalLine.findMany({
      where: { account: { systemKey: { in: ["SALES_REVENUE", "SALES_RETURNS"] } }, entry: { currencyCode: ctx.currencyCode, occurredAt: { gte: range.from, lt: range.to } } },
      select: { debitMinor: true, creditMinor: true, account: { select: { systemKey: true } }, entry: { select: { id: true, occurredAt: true, kind: true, provenance: true, reversalOfEntryId: true } } },
    });
    rows = lines.length;
    // a sale that was later reversed (even outside the range) is not counted as a sale, though its money is netted either way
    const reversedIds = new Set((await ctx.scoped.journalEntry.findMany({ where: { reversalOfEntryId: { in: [...new Set(lines.map((l) => l.entry.id))] } }, select: { reversalOfEntryId: true } })).map((e) => e.reversalOfEntryId));
    for (const l of lines) {
      const d = day(l.entry.occurredAt);
      const net = l.creditMinor - l.debitMinor;
      if (l.account.systemKey === "SALES_REVENUE") {
        d.gross += net;
        if (l.entry.kind === "SALE" && l.entry.reversalOfEntryId === null && !reversedIds.has(l.entry.id)) d.n += 1;
      } else {
        d.returns += -net; // a debit to returns is a positive return amount
      }
      prov.set(l.entry.provenance, (prov.get(l.entry.provenance) ?? 0n) + net);
    }
    const missing = await legacyNotJournaled(ctx, range);
    if (missing > 0) warnings.push({ code: "UNJOURNALED_ENTRIES", message: `${missing} chat entr${missing === 1 ? "y" : "ies"} in this period have no journal entry yet, so they are not in these totals. Ask support to run the journal backfill.` });
  } else {
    sourceName = "chat ledger (sales entries)";
    basis = "Sales are SALE entries you recorded in chat, less any you undid. Online shop orders, wholesale sales and refunds are NOT included because the accounting journals are off for this business.";
    warnings.push({ code: "JOURNALS_OFF", message: "The accounting journals are off, so shop orders, wholesale sales, refunds and returns are not included." });
    const txns = await ctx.scoped.transaction.findMany({ where: { type: "SALE", reversalOfTransactionId: null, reversedBy: null, currencyCode: ctx.currencyCode, createdAt: { gte: range.from, lt: range.to } }, select: { amountMinor: true, createdAt: true } });
    rows = txns.length;
    for (const t of txns) {
      const d = day(t.createdAt);
      d.gross += t.amountMinor;
      d.n += 1;
    }
    prov.set("MERCHANT_ENTERED", sumBig(txns.map((t) => t.amountMinor)));
  }

  const oc = await otherCurrencyWarning(ctx, range);
  if (oc) warnings.push(oc);
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]): SalesDay => ({ day: k, saleCount: v.n, grossSalesMinor: str(v.gross), returnsMinor: str(v.returns), netSalesMinor: str(v.gross - v.returns) }));
  const gross = sumBig([...byDay.values()].map((v) => v.gross));
  const returns = sumBig([...byDay.values()].map((v) => v.returns));
  return {
    meta: meta(ctx, "sales", "Sales", basis, range, [{ name: sourceName, rows }], warnings),
    data: { days, totals: { saleCount: [...byDay.values()].reduce((n, v) => n + v.n, 0), grossSalesMinor: str(gross), returnsMinor: str(returns), netSalesMinor: str(gross - returns) }, byProvenance: [...prov.entries()].map(([provenance, v]) => ({ provenance, netSalesMinor: str(v) })) },
  };
}

// ------------------------------------------------------------------------------------------------ cash flow

export interface CashFlowRow { method: string; account: string; openingMinor: string; inMinor: string; outMinor: string; closingMinor: string }
export interface CashFlowData { rows: CashFlowRow[]; totals: { openingMinor: string; inMinor: string; outMinor: string; closingMinor: string }; unclassifiedMinor: string }

export async function cashFlowReport(ctx: ReportContext, range: RangeInput): Promise<Report<CashFlowData>> {
  checkRange(range);
  if (!(await journalsOn(ctx))) throw new ReportError("UNSUPPORTED", "Cash flow needs the accounting journals, which are off for this business. Without them TradePal does not know which payment method each entry used, so it will not guess.");
  const accounts = SYSTEM_ACCOUNTS.filter((a) => ["CASH", "MOBILE_MONEY", "BANK", "UNCLASSIFIED_FUNDS"].includes(a.key));
  const before = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode, to: range.from });
  const during = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode, from: range.from, to: range.to });
  const rows: CashFlowRow[] = accounts.map((a) => {
    const open = before.rows.find((r) => r.systemKey === a.key)?.netMinor ?? 0n;
    const d = during.rows.find((r) => r.systemKey === a.key);
    const inn = d?.debitMinor ?? 0n;
    const out = d?.creditMinor ?? 0n;
    return { method: a.key.toLowerCase().replace(/_/g, " "), account: a.name, openingMinor: str(open), inMinor: str(inn), outMinor: str(out), closingMinor: str(open + inn - out) };
  });
  const sum = (k: keyof CashFlowRow) => str(sumBig(rows.map((r) => BigInt(r[k]))));
  const unclassified = rows.find((r) => r.method === "unclassified funds");
  const warnings: Warning[] = [];
  if (unclassified && (BigInt(unclassified.inMinor) !== 0n || BigInt(unclassified.outMinor) !== 0n || BigInt(unclassified.openingMinor) !== 0n)) {
    warnings.push({ code: "PAYMENT_METHOD_NOT_RECORDED", message: "Some money in or out has no payment method recorded (shown as 'unclassified funds'), so the cash, mobile money and bank rows are incomplete." });
  }
  const missing = await legacyNotJournaled(ctx, range);
  if (missing > 0) warnings.push({ code: "UNJOURNALED_ENTRIES", message: `${missing} chat entries in this period have no journal entry yet and are not included.` });
  const oc = await otherCurrencyWarning(ctx, range);
  if (oc) warnings.push(oc);
  warnings.push({ code: "NOT_A_BANK_STATEMENT", message: "These are balances in TradePal's books, not counts of cash or statements from your bank or mobile-money provider. Compare them with the real balances." });
  return {
    meta: meta(ctx, "cash-flow", "Cash flow", "Money in is the debits to the cash, mobile money, bank and unclassified accounts; money out is the credits. Opening is everything before the start date.", range, [{ name: "journal entries", rows: during.rows.length }], warnings),
    data: { rows, totals: { openingMinor: sum("openingMinor"), inMinor: sum("inMinor"), outMinor: sum("outMinor"), closingMinor: sum("closingMinor") }, unclassifiedMinor: unclassified?.closingMinor ?? "0" },
  };
}

// ----------------------------------------------------------------------------------------- inventory valuation

export interface ValuationRow { sku: string; name: string; unit: string; onHand: number; avgCostMinor: string | null; valueMinor: string | null; uncostedQty: number; flag: string | null }
export interface ValuationData { rows: ValuationRow[]; totals: { valuedMinor: string; unitsValued: number; unitsWithoutCost: number; unitsNegative: number }; legacyItemsWithoutCost: { name: string; estimatedQty: number }[]; journalInventoryMinor: string | null }

export async function inventoryValuationReport(ctx: ReportContext, asOf?: Date): Promise<Report<ValuationData>> {
  const now = ctx.now ?? new Date();
  if (asOf && Math.abs(asOf.getTime() - now.getTime()) > 60_000) throw new ReportError("UNSUPPORTED", "Inventory is valued as of now only. TradePal keeps running balances, not a dated history of costs, and will not reconstruct an old value by guessing.");
  const shop = await ensureDefaultShopFor(ctx.scoped, ctx.businessId);
  const balances = await ctx.scoped.stockBalance.findMany({ where: { shopId: shop.id }, include: { variant: { include: { product: true } } } });
  const warnings: Warning[] = [];
  let valued = 0n;
  let unitsValued = 0;
  let unitsNoCost = 0;
  let unitsNegative = 0;
  const rows: ValuationRow[] = balances
    .filter((b) => b.onHand !== 0 || b.uncostedQty !== 0)
    .map((b): ValuationRow => {
      let flag: string | null = null;
      let value: bigint | null = null;
      if (b.onHand < 0) { flag = "NEGATIVE_STOCK"; unitsNegative += -b.onHand; }
      else if (b.avgCostMinor === null) { flag = "NO_COST"; unitsNoCost += b.onHand; }
      else {
        const costed = Math.max(0, b.onHand - b.uncostedQty);
        value = BigInt(costed) * b.avgCostMinor;
        valued += value;
        unitsValued += costed;
        if (b.uncostedQty > 0) { flag = "PART_UNCOSTED"; unitsNoCost += Math.min(b.uncostedQty, b.onHand); }
      }
      return { sku: b.variant.sku, name: `${b.variant.product.name}${b.variant.name && b.variant.name !== b.variant.product.name ? ` ${b.variant.name}` : ""}`, unit: b.variant.baseUnit, onHand: b.onHand, avgCostMinor: b.avgCostMinor === null ? null : str(b.avgCostMinor), valueMinor: value === null ? null : str(value), uncostedQty: b.uncostedQty, flag };
    })
    .sort((a, b) => a.sku.localeCompare(b.sku));
  if (unitsNoCost > 0) warnings.push({ code: "UNITS_WITHOUT_COST", message: `${unitsNoCost} unit(s) have no recorded cost and are valued at nothing. The total is therefore LOWER than the true value of your stock.` });
  if (unitsNegative > 0) warnings.push({ code: "NEGATIVE_STOCK", message: `${unitsNegative} unit(s) are recorded as sold beyond what was in stock. Those lines are not valued; count the stock and correct it.` });
  const legacy = await ctx.scoped.inventoryItem.findMany({ where: { variant: null }, select: { name: true, estimatedStockQty: true } });
  const legacyRows = legacy.filter((i) => i.estimatedStockQty > 0).map((i) => ({ name: i.name, estimatedQty: i.estimatedStockQty }));
  if (legacyRows.length > 0) warnings.push({ code: "LEGACY_ITEMS_NO_VALUE", message: `${legacyRows.length} chat-tracked item(s) have only an estimated quantity and no cost, so they are listed but not valued.` });
  let journalInv: string | null = null;
  if (await journalsOn(ctx)) {
    const tb = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode });
    const net = tb.rows.find((r) => r.systemKey === "INVENTORY")?.netMinor ?? 0n;
    journalInv = str(net);
    if (net !== valued) warnings.push({ code: "DIFFERS_FROM_BOOKS", message: `The stock valuation (${valued}) differs from the Inventory account in the books (${net}). Stock bought before the journals were switched on, uncosted units or write-downs can cause this; it is shown, not hidden.` });
  }
  return {
    meta: meta(ctx, "inventory-valuation", "Inventory valuation", "On-hand units times the moving weighted-average cost of the COSTED units. Units that arrived without a cost are not valued.", null, [{ name: "stock balances", rows: balances.length }], warnings, now),
    data: { rows, totals: { valuedMinor: str(valued), unitsValued, unitsWithoutCost: unitsNoCost, unitsNegative }, legacyItemsWithoutCost: legacyRows, journalInventoryMinor: journalInv },
  };
}

// ---------------------------------------------------------------------------------------------------- aging

export interface AgingRow { party: string; kind: string; reference: string | null; dueDate: string | null; ageBasis: string; bucket: Bucket; outstandingMinor: string }
export interface AgingData { buckets: { bucket: Bucket; totalMinor: string; count: number }[]; totalMinor: string; rows: AgingRow[] }

function agingResult(rows: AgingRow[]): AgingData {
  const buckets = AGING_BUCKETS.map((b) => ({ bucket: b, totalMinor: str(sumBig(rows.filter((r) => r.bucket === b).map((r) => BigInt(r.outstandingMinor)))), count: rows.filter((r) => r.bucket === b).length }));
  return { buckets, totalMinor: str(sumBig(rows.map((r) => BigInt(r.outstandingMinor)))), rows: rows.sort((a, b) => Number(BigInt(b.outstandingMinor) - BigInt(a.outstandingMinor))) };
}

export async function arAgingReport(ctx: ReportContext): Promise<Report<AgingData>> {
  const asOf = ctx.now ?? new Date();
  const warnings: Warning[] = [];
  const debts = await ctx.scoped.debt.findMany({ where: { status: { in: ["OPEN", "PARTIALLY_PAID"] }, currencyCode: ctx.currencyCode }, include: { customer: true } });
  const rows: AgingRow[] = debts.map((d) => ({
    party: d.customer.isAnonymized ? "(removed customer)" : d.customer.name, kind: "customer debt", reference: null,
    dueDate: d.dueDate ? d.dueDate.toISOString() : null, ageBasis: d.dueDate ? "due date" : "date recorded", bucket: bucketOf(d.dueDate ?? d.createdAt, asOf, !!d.dueDate), outstandingMinor: str(d.outstandingAmountMinor),
  }));
  const noDue = debts.filter((d) => !d.dueDate).length;
  if (noDue > 0) warnings.push({ code: "NO_DUE_DATES", message: `${noDue} debt(s) have no due date, so they age from the day they were recorded, with a 30-day allowance. Treat their buckets as approximate.` });
  const invoices = await ctx.scoped.tradeInvoice.findMany({ where: { side: "SELL", status: "ISSUED", currencyCode: ctx.currencyCode }, include: { order: { select: { id: true } } } });
  const partners = await ctx.scoped.tradePartner.findMany({ where: {}, select: { id: true, name: true } });
  for (const i of invoices) {
    const out = i.totalMinor - i.creditedMinor - i.paidMinor;
    if (out <= 0n) continue;
    rows.push({ party: partners.find((p) => p.id === i.partnerId)?.name ?? "trade partner", kind: "wholesale invoice", reference: i.number, dueDate: i.dueDate ? i.dueDate.toISOString() : null, ageBasis: i.dueDate ? "due date" : "date issued", bucket: bucketOf(i.dueDate ?? i.issuedAt, asOf, !!i.dueDate), outstandingMinor: str(out) });
  }
  warnings.push({ code: "NO_COLLECTION_ACTION", message: "This report lists what is owed to you. TradePal does not contact anyone about it." });
  const data = agingResult(rows);
  if (await journalsOn(ctx)) {
    const tb = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode });
    const ar = tb.rows.find((r) => r.systemKey === "AR")?.netMinor ?? 0n;
    if (str(ar) !== data.totalMinor) warnings.push({ code: "DIFFERS_FROM_BOOKS", message: `The receivable in the books (${ar}) differs from the open items listed here (${data.totalMinor}). Online shop orders paid on collection and opening balances are not itemised here.` });
  }
  return { meta: meta(ctx, "ar-aging", "Money owed to you (aging)", "Open customer debts and issued wholesale invoices, by how long past due (or, with no due date, how long since recorded).", null, [{ name: "debt book", rows: debts.length }, { name: "wholesale invoices (seller side)", rows: invoices.length }], warnings, asOf), data };
}

export async function apAgingReport(ctx: ReportContext): Promise<Report<AgingData>> {
  const asOf = ctx.now ?? new Date();
  const warnings: Warning[] = [];
  const invoices = await ctx.scoped.tradeInvoice.findMany({ where: { side: "BUY", status: "ISSUED", currencyCode: ctx.currencyCode } });
  const partners = await ctx.scoped.tradePartner.findMany({ where: {}, select: { id: true, name: true } });
  const rows: AgingRow[] = [];
  for (const i of invoices) {
    const out = i.totalMinor - i.creditedMinor - i.paidMinor;
    if (out <= 0n) continue;
    rows.push({ party: partners.find((p) => p.id === i.partnerId)?.name ?? "supplier", kind: "supplier invoice", reference: i.externalNumber ?? i.number, dueDate: i.dueDate ? i.dueDate.toISOString() : null, ageBasis: i.dueDate ? "due date" : "date issued", bucket: bucketOf(i.dueDate ?? i.issuedAt, asOf, !!i.dueDate), outstandingMinor: str(out) });
  }
  warnings.push({ code: "CHAT_PURCHASES_NOT_TRACKED", message: "Purchases and expenses you typed in chat are recorded as paid. Money you owe a supplier for those is not tracked, so it does not appear here." });
  const data = agingResult(rows);
  if (await journalsOn(ctx)) {
    const tb = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode });
    const ap = -(tb.rows.find((r) => r.systemKey === "AP")?.netMinor ?? 0n);
    if (str(ap) !== data.totalMinor) warnings.push({ code: "DIFFERS_FROM_BOOKS", message: `The payable in the books (${ap}) differs from the supplier invoices listed here (${data.totalMinor}).` });
  }
  return { meta: meta(ctx, "ap-aging", "Money you owe (aging)", "Issued supplier invoices (the buyer's copy of a wholesale invoice) with an outstanding balance, by how long past due.", null, [{ name: "wholesale invoices (buyer side)", rows: invoices.length }], warnings, asOf), data };
}

// ------------------------------------------------------------------------------------------- gross margin

export interface MarginData {
  netSalesMinor: string;
  costOfGoodsSoldMinor: string;
  grossMarginMinor: string | null;
  grossMarginPercent: string | null;
  completeness: { fulfilments: number; withFullCost: number; withIncompleteCost: number; percentComplete: string | null };
  operatingExpensesMinor: string;
  expensesNote: string;
}

export async function grossMarginReport(ctx: ReportContext, range: RangeInput): Promise<Report<MarginData>> {
  checkRange(range);
  if (!(await journalsOn(ctx))) throw new ReportError("UNSUPPORTED", "Gross margin needs the accounting journals and stock costs, which are off for this business. TradePal will not subtract your chat expenses from your sales and call the result a margin.");
  const warnings: Warning[] = [];
  const tb = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode, from: range.from, to: range.to });
  const net = (k: string) => tb.rows.find((r) => r.systemKey === k)?.netMinor ?? 0n;
  const sales = -net("SALES_REVENUE") - net("SALES_RETURNS"); // revenue is a credit balance; returns a debit
  const cogs = net("COGS");
  const opex = net("OPERATING_EXPENSES");
  const moves = await ctx.scoped.stockMovement.findMany({ where: { kind: "SALE_FULFILLMENT", occurredAt: { gte: range.from, lt: range.to } }, select: { costIncomplete: true, costMinor: true } });
  const incomplete = moves.filter((m) => m.costIncomplete || m.costMinor === null).length;
  const fulfilments = moves.length;
  const pct = fulfilments > 0 ? (((fulfilments - incomplete) / fulfilments) * 100).toFixed(1) : null;
  const salesRows = await ctx.scoped.journalEntry.count({ where: { kind: "SALE", currencyCode: ctx.currencyCode, occurredAt: { gte: range.from, lt: range.to }, reversalOfEntryId: null } });
  const costedSales = await ctx.scoped.journalLine.count({ where: { account: { systemKey: "COGS" }, entry: { kind: "SALE", currencyCode: ctx.currencyCode, occurredAt: { gte: range.from, lt: range.to }, reversalOfEntryId: null } } });
  const salesWithoutCost = Math.max(0, salesRows - costedSales);
  let margin: bigint | null = sales - cogs;
  if (sales <= 0n && cogs === 0n) margin = null;
  if (salesRows === 0) margin = null;
  if (incomplete > 0) warnings.push({ code: "COST_INCOMPLETE", message: `${incomplete} of ${fulfilments} stock movements for sales had no complete cost. Cost of goods sold is understated, so the margin is OVERSTATED.` });
  if (salesWithoutCost > 0) warnings.push({ code: "SALES_WITHOUT_COST", message: `${salesWithoutCost} of ${salesRows} sales have no cost of goods recorded (items not linked to stock, or no cost known). The margin is OVERSTATED by their cost.` });
  if (salesRows === 0) warnings.push({ code: "NO_SALES", message: "There are no sales in this period." });
  const oc = await otherCurrencyWarning(ctx, range);
  if (oc) warnings.push(oc);
  warnings.push({ code: "NOT_PROFIT", message: "Gross margin is sales less the recorded cost of the goods sold. It is NOT profit: operating expenses, fees, tax, owner withdrawals and unrecorded costs are not deducted." });
  const marginValue = margin;
  const ok = marginValue !== null && sales > 0n;
  return {
    meta: meta(ctx, "gross-margin", "Gross margin (before operating expenses)", "Net sales (Sales less Sales returns) minus Cost of goods sold, both from the journals, for sales whose cost was recorded.", range, [{ name: "journal entries", rows: tb.rows.length }, { name: "stock movements (sale fulfilment)", rows: moves.length }], warnings),
    data: {
      netSalesMinor: str(sales), costOfGoodsSoldMinor: str(cogs), grossMarginMinor: margin === null ? null : str(margin), grossMarginPercent: ok ? (Number((marginValue! * 10000n) / sales) / 100).toFixed(1) : null,
      completeness: { fulfilments, withFullCost: fulfilments - incomplete, withIncompleteCost: incomplete, percentComplete: pct },
      operatingExpensesMinor: str(opex), expensesNote: "Shown for reference only; not deducted from the gross margin above.",
    },
  };
}

// ------------------------------------------------------------------------------------ payment reconciliation

export interface PaymentRecData {
  attempts: { status: string; count: number; capturedMinor: string }[];
  captured: { totalMinor: string; allocatedMinor: string; unallocatedMinor: string };
  refundedMinor: string;
  settlement: { settledGrossMinor: string; settledFeeMinor: string; capturedNotYetSettledMinor: string; providerClearingBalanceMinor: string | null };
  openExceptions: number;
  staleAttempts: number;
  unmatchedMobileMoneyAlerts: number;
}

export async function paymentReconciliationReport(ctx: ReportContext, range: RangeInput): Promise<Report<PaymentRecData>> {
  checkRange(range);
  const warnings: Warning[] = [];
  const attempts = await ctx.scoped.paymentAttempt.findMany({ where: { currencyCode: ctx.currencyCode, createdAt: { gte: range.from, lt: range.to } }, include: { allocation: true, settlementLine: true } });
  const byStatus = new Map<string, { n: number; cap: bigint }>();
  for (const a of attempts) {
    const e = byStatus.get(a.status) ?? { n: 0, cap: 0n };
    e.n += 1;
    e.cap += a.capturedMinor;
    byStatus.set(a.status, e);
  }
  const captured = attempts.filter((a) => a.status === "SUCCEEDED");
  const capTotal = sumBig(captured.map((a) => a.capturedMinor));
  const allocated = sumBig(captured.filter((a) => a.allocation).map((a) => a.allocation!.amountMinor));
  const settled = captured.filter((a) => a.settlementLine);
  const grossSettled = sumBig(settled.map((a) => a.settlementLine!.grossMinor));
  const feeSettled = sumBig(settled.map((a) => a.settlementLine!.feeMinor));
  const notSettled = sumBig(captured.filter((a) => !a.settlementLine).map((a) => a.capturedMinor));
  const refunded = sumBig(attempts.map((a) => a.refundedMinor));
  const stale = attempts.filter((a) => ["CREATED", "PENDING", "UNKNOWN"].includes(a.status) && a.expiresAt.getTime() < (ctx.now ?? new Date()).getTime() - 3_600_000).length;
  const exceptions = await ctx.scoped.paymentException.count({ where: { status: "OPEN" } }).catch(() => 0);
  const unmatched = await ctx.scoped.mobileMoneyAlert.count({ where: { matchStatus: "UNMATCHED", createdAt: { gte: range.from, lt: range.to } } });
  let clearing: string | null = null;
  if (await journalsOn(ctx)) {
    const tb = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode });
    clearing = str(tb.rows.find((r) => r.systemKey === "PROVIDER_CLEARING")?.netMinor ?? 0n);
  }
  if (capTotal !== allocated) warnings.push({ code: "UNALLOCATED_PAYMENTS", message: `${capTotal - allocated} (minor units) was captured but is not applied to an order or invoice. See the exception queue.` });
  if (stale > 0) warnings.push({ code: "STALE_ATTEMPTS", message: `${stale} payment attempt(s) are still unresolved more than an hour after they expired.` });
  if (unmatched > 0) warnings.push({ code: "UNMATCHED_ALERTS", message: `${unmatched} mobile-money alert(s) have not been matched to a sale.` });
  if (attempts.length === 0) warnings.push({ code: "NO_PROVIDER_PAYMENTS", message: "No online payments through a provider in this period." });
  warnings.push({ code: "PROVIDER_STATEMENT_NEEDED", message: "This compares TradePal's own records. It is not a reconciliation against the provider's statement; settlement lines exist only when a provider settlement report was recorded." });
  return {
    meta: meta(ctx, "payment-reconciliation", "Payment reconciliation", "Provider payment attempts in the period: captured, applied to an order or invoice, settled, and refunded.", range, [{ name: "payment attempts", rows: attempts.length }, { name: "mobile-money alerts", rows: unmatched }], warnings),
    data: {
      attempts: [...byStatus.entries()].map(([status, v]) => ({ status, count: v.n, capturedMinor: str(v.cap) })),
      captured: { totalMinor: str(capTotal), allocatedMinor: str(allocated), unallocatedMinor: str(capTotal - allocated) },
      refundedMinor: str(refunded),
      settlement: { settledGrossMinor: str(grossSettled), settledFeeMinor: str(feeSettled), capturedNotYetSettledMinor: str(notSettled), providerClearingBalanceMinor: clearing },
      openExceptions: exceptions, staleAttempts: stale, unmatchedMobileMoneyAlerts: unmatched,
    },
  };
}

// ---------------------------------------------------------------------------------------- stock discrepancies

export interface DiscrepancyData {
  balanceMismatches: { sku: string; field: string; balance: number; expected: number }[];
  countVariances: { sku: string; countedAt: string; expectedQty: number; countedQty: number; discrepancy: number; reason: string | null }[];
  legacyDrift: { sku: string; legacyEstimate: number; v2OnHand: number }[];
  negativeStock: { sku: string; onHand: number }[];
  shrinkageMinor: string | null;
}

export async function stockDiscrepancyReport(ctx: ReportContext, range: RangeInput): Promise<Report<DiscrepancyData>> {
  checkRange(range);
  const warnings: Warning[] = [];
  const shop = await ensureDefaultShopFor(ctx.scoped, ctx.businessId);
  const variants = await ctx.scoped.productVariant.findMany({ select: { id: true, sku: true } });
  const sku = (id: string) => variants.find((v) => v.id === id)?.sku ?? id.slice(0, 8);
  const mism = await reconcileStock(ctx.scoped);
  const lines = await ctx.scoped.stockCountLine.findMany({ where: { discrepancy: { not: 0 }, count: { status: "APPROVED", approvedAt: { gte: range.from, lt: range.to } } }, include: { count: true }, orderBy: { createdAt: "asc" } });
  const drift = await findLegacyStockDrift(ctx.scoped, shop.id);
  const bal = await ctx.scoped.stockBalance.findMany({ where: { shopId: shop.id, onHand: { lt: 0 } } });
  let shrink: string | null = null;
  if (await journalsOn(ctx)) {
    const tb = await trialBalance(ctx.scoped, { currencyCode: ctx.currencyCode, from: range.from, to: range.to });
    shrink = str(tb.rows.find((r) => r.systemKey === "INVENTORY_SHRINKAGE")?.netMinor ?? 0n);
  }
  if (mism.length > 0) warnings.push({ code: "BALANCE_NOT_EQUAL_TO_MOVEMENTS", message: `${mism.length} running balance(s) do not equal the sum of their movements. This should never happen; report it.` });
  if (drift.length > 0) warnings.push({ code: "LEGACY_DRIFT", message: `${drift.length} item(s) show a different quantity in the old chat tracker and the catalog.` });
  if (bal.length > 0) warnings.push({ code: "NEGATIVE_STOCK", message: `${bal.length} item(s) are below zero.` });
  if (lines.length === 0 && mism.length === 0 && drift.length === 0 && bal.length === 0) warnings.push({ code: "NOTHING_FOUND", message: "No discrepancies were found in the records TradePal has. That does not prove your shelves match: only a physical count does." });
  return {
    meta: meta(ctx, "stock-discrepancies", "Stock discrepancies", "Differences found between recorded stock, its movement history, approved physical counts and the older chat tracker.", range, [{ name: "stock balances and movements", rows: mism.length }, { name: "approved stock counts", rows: lines.length }], warnings),
    data: {
      balanceMismatches: mism.map((m) => ({ sku: sku(m.variantId), field: m.field, balance: m.balance, expected: m.expected })),
      countVariances: lines.map((l) => ({ sku: sku(l.variantId), countedAt: (l.count.approvedAt ?? l.createdAt).toISOString(), expectedQty: l.expectedQty, countedQty: l.countedQty, discrepancy: l.discrepancy, reason: l.reason })),
      legacyDrift: drift.map((d) => ({ sku: d.sku, legacyEstimate: d.legacyEstimate, v2OnHand: d.v2OnHand })),
      negativeStock: bal.map((b) => ({ sku: sku(b.variantId), onHand: b.onHand })),
      shrinkageMinor: shrink,
    },
  };
}
