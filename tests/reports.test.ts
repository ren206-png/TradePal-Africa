import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MerchantRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { confirmStoreOrder, completeStoreOrder } from "../src/domain/store/orders.js";
import { recordTransaction, reverseTransaction } from "../src/domain/ledger.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import {
  REPORT_NAMES, ReportError, apAgingReport, arAgingReport, cashFlowReport, grossMarginReport, inventoryValuationReport, localDay, parseRange, paymentReconciliationReport,
  reportToCsv, reportText, salesReport, stockDiscrepancyReport, type ReportContext,
} from "../src/reports/index.js";
import { csvText } from "../src/admin/csv.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

const seller = (flags: string[] = ["reportsV2"]) => makeSeller(prisma, `Report Shop ${++k}`, { slug: `report-shop-${k}`, flags });
const ctxOf = (s: { businessId: string; scoped: ReportContext["scoped"] }, extra: Partial<ReportContext> = {}): ReportContext => ({ scoped: s.scoped, businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", ...extra });
const wide = () => ({ from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() + 86_400_000) });
const cmdCtx = (s: Seller, role: MerchantRole = "OWNER"): CommandContext => ({ prisma, scopedPrisma: s.scoped, businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m-1", merchantRole: role });

/** Sells 3 cans at 100.00 (cost 40.00 each) through the shop and collects the cash: net sales 300.00, cost 120.00. */
async function soldThroughShop(s: Seller, qty = 3) {
  const { order } = await placeStoreOrder(prisma, s, { qty });
  await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
  await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code: order.pickupCode, collect: { method: "CASH" } });
  return order;
}

describe("sales report", () => {
  it("counts a shop sale from the journals, nets a voided chat sale to zero, and says what it covers", async () => {
    const s = await seller();
    await soldThroughShop(s);
    const chat = await recordTransaction(s.scoped, { businessId: s.businessId, type: "SALE", amountMinor: 500_000n, currencyCode: "NGN", paymentStatus: "PAID" });
    await reverseTransaction(s.scoped, chat.id, "entered by mistake");
    const r = await salesReport(ctxOf(s), wide());
    expect(r.data.totals).toMatchObject({ grossSalesMinor: "30000", returnsMinor: "0", netSalesMinor: "30000", saleCount: 1 });
    expect(r.meta).toMatchObject({ currencyCode: "NGN", timezone: "Africa/Lagos", report: "sales" });
    expect(r.meta.sources[0]!.name).toContain("journal");
    expect(r.meta.warnings.find((w) => w.code === "JOURNALS_OFF")).toBeUndefined();
    expect(r.meta.notice).toContain("not a tax filing");
    expect(r.meta.title + r.meta.basis).not.toMatch(/profit/i);
  });

  it("buckets by the BUSINESS's local day, not UTC, and excludes entries outside the range", async () => {
    const s = await seller();
    const base = new Date("2026-03-10T23:30:00Z"); // 00:30 on the 11th in Lagos (UTC+1)
    expect(localDay(base, "Africa/Lagos")).toBe("2026-03-11");
    const { postSale } = await import("../src/domain/accounting.js");
    await postSale(s.scoped, { businessId: s.businessId, currencyCode: "NGN", totalMinor: 1000n, receipts: [{ method: "CASH", amountMinor: 1000n }], occurredAt: base, idempotencyKey: `t-${++k}` });
    await postSale(s.scoped, { businessId: s.businessId, currencyCode: "NGN", totalMinor: 2000n, receipts: [{ method: "CASH", amountMinor: 2000n }], occurredAt: new Date("2026-03-20T10:00:00Z"), idempotencyKey: `t-${++k}` });
    const r = await salesReport(ctxOf(s), { from: new Date("2026-03-10T23:00:00Z"), to: new Date("2026-03-12T00:00:00Z") });
    expect(r.data.days).toEqual([{ day: "2026-03-11", saleCount: 1, grossSalesMinor: "1000", returnsMinor: "0", netSalesMinor: "1000" }]);
  });

  it("with the journals off it reads the chat ledger and warns what is missing", async () => {
    const s = await seller(["reportsV2"]);
    await enableFlag(prisma, s.businessId, "accountingJournals", false);
    await recordTransaction(s.scoped, { businessId: s.businessId, type: "SALE", amountMinor: 70_000n, currencyCode: "NGN", paymentStatus: "PAID" });
    const r = await salesReport(ctxOf(s), wide());
    expect(r.data.totals.netSalesMinor).toBe("70000");
    expect(r.meta.warnings.map((w) => w.code)).toContain("JOURNALS_OFF");
    await expect(cashFlowReport(ctxOf(s), wide())).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(grossMarginReport(ctxOf(s), wide())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("refuses an empty, reversed or over-long range", async () => {
    const s = await seller();
    const now = new Date();
    await expect(salesReport(ctxOf(s), { from: now, to: now })).rejects.toBeInstanceOf(ReportError);
    await expect(salesReport(ctxOf(s), { from: new Date(now.getTime() + 1000), to: now })).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(salesReport(ctxOf(s), { from: new Date(now.getTime() - 400 * 86_400_000), to: now })).rejects.toMatchObject({ code: "INVALID_RANGE" });
  });
});

describe("cash flow", () => {
  it("opening + in - out = closing per method, and warns when a method was not recorded", async () => {
    const s = await seller();
    await soldThroughShop(s);
    const r = await cashFlowReport(ctxOf(s), wide());
    const cash = r.data.rows.find((x) => x.method === "cash")!;
    expect(BigInt(cash.openingMinor) + BigInt(cash.inMinor) - BigInt(cash.outMinor)).toBe(BigInt(cash.closingMinor));
    expect(cash.closingMinor).toBe("30000");
    expect(r.meta.warnings.map((w) => w.code)).toContain("NOT_A_BANK_STATEMENT");
    // money with no payment method recorded is shown, not hidden
    await recordTransaction(s.scoped, { businessId: s.businessId, type: "SALE", amountMinor: 9_000n, currencyCode: "NGN", paymentStatus: "PAID" });
    const r2 = await cashFlowReport(ctxOf(s), wide());
    expect(r2.data.unclassifiedMinor).not.toBe("0");
    expect(r2.meta.warnings.map((w) => w.code)).toContain("PAYMENT_METHOD_NOT_RECORDED");
  });

  it("opening balance is everything before the start", async () => {
    const s = await seller();
    await soldThroughShop(s);
    const future = { from: new Date(Date.now() + 86_400_000), to: new Date(Date.now() + 2 * 86_400_000) };
    const r = await cashFlowReport(ctxOf(s), future);
    const cash = r.data.rows.find((x) => x.method === "cash")!;
    expect(cash).toMatchObject({ openingMinor: "30000", inMinor: "0", outMinor: "0", closingMinor: "30000" });
  });
});

describe("inventory valuation", () => {
  it("values costed units at the average cost, flags uncosted and negative stock, lists chat-only items without a value, refuses a past date", async () => {
    const s = await seller();
    await soldThroughShop(s); // 47 cans left at 40.00
    await prisma.inventoryItem.create({ data: { businessId: s.businessId, name: "Loose onions", normalizedName: "loose onions", estimatedStockQty: 12 } });
    const r = await inventoryValuationReport(ctxOf(s));
    expect(r.data.totals).toMatchObject({ valuedMinor: String(47 * 4000), unitsValued: 47, unitsWithoutCost: 0 });
    expect(r.data.legacyItemsWithoutCost).toEqual([{ name: "Loose onions", estimatedQty: 12 }]);
    expect(r.meta.warnings.map((w) => w.code)).toContain("LEGACY_ITEMS_NO_VALUE");
    await expect(inventoryValuationReport(ctxOf(s), new Date("2026-01-01T00:00:00Z"))).rejects.toMatchObject({ code: "UNSUPPORTED" });

    // oversell: negative stock is flagged and not valued
    const { fulfilSale } = await import("../src/domain/stock.js");
    await fulfilSale(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: s.variant.id, quantity: 60, approvedBy: "owner" });
    const r2 = await inventoryValuationReport(ctxOf(s));
    expect(r2.data.rows[0]).toMatchObject({ onHand: -13, flag: "NEGATIVE_STOCK", valueMinor: null });
    expect(r2.data.totals.unitsNegative).toBe(13);
    expect(r2.meta.warnings.map((w) => w.code)).toContain("NEGATIVE_STOCK");
  });
});

describe("aging", () => {
  it("buckets customer debts by due date (or by age when there is none), excludes paid ones, and never contacts anyone", async () => {
    const b = await makeBusiness(prisma, `Aging ${++k}`);
    await enableFlag(prisma, b.businessId, "reportsV2");
    const cust = (name: string) => prisma.customer.create({ data: { businessId: b.businessId, name } });
    const day = 86_400_000;
    const debt = async (name: string, amount: bigint, due: Date | null, createdDaysAgo: number, status: "OPEN" | "PAID" = "OPEN") => {
      const c = await cust(name);
      await prisma.debt.create({ data: { businessId: b.businessId, customerId: c.id, originalAmountMinor: amount, outstandingAmountMinor: status === "PAID" ? 0n : amount, currencyCode: "NGN", dueDate: due, status, createdAt: new Date(Date.now() - createdDaysAgo * day) } });
    };
    await debt("Not due yet", 1000n, new Date(Date.now() + 5 * day), 10);
    await debt("Ten days late", 2000n, new Date(Date.now() - 10 * day), 40);
    await debt("Forty days late", 4000n, new Date(Date.now() - 40 * day), 80);
    await debt("Hundred late", 8000n, new Date(Date.now() - 100 * day), 120);
    await debt("No due date, old", 16000n, null, 70);
    await debt("Settled", 32000n, new Date(Date.now() - 10 * day), 40, "PAID");
    const r = await arAgingReport(ctxOf(b as never));
    const by = Object.fromEntries(r.data.buckets.map((x) => [x.bucket, x.totalMinor]));
    expect(by).toEqual({ current: "1000", "1-30": "2000", "31-60": "20000", "61-90": "0", "90+": "8000" });
    expect(r.data.totalMinor).toBe(String(1000 + 2000 + 4000 + 16000 + 8000));
    expect(r.meta.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["NO_DUE_DATES", "NO_COLLECTION_ACTION"]));
  });

  it("the payable report says plainly that chat purchases are not tracked", async () => {
    const s = await seller();
    const r = await apAgingReport(ctxOf(s));
    expect(r.data.totalMinor).toBe("0");
    expect(r.meta.warnings.map((w) => w.code)).toContain("CHAT_PURCHASES_NOT_TRACKED");
  });
});

describe("gross margin", () => {
  it("is sales minus recorded cost of goods, is never called profit, and shows expenses without deducting them", async () => {
    const s = await seller();
    await soldThroughShop(s);
    const { postExpense } = await import("../src/domain/accounting.js");
    await postExpense(s.scoped, { businessId: s.businessId, currencyCode: "NGN", amountMinor: 5_000n, paidWith: "CASH", idempotencyKey: `e-${++k}` });
    const r = await grossMarginReport(ctxOf(s), wide());
    expect(r.data).toMatchObject({ netSalesMinor: "30000", costOfGoodsSoldMinor: "12000", grossMarginMinor: "18000", grossMarginPercent: "60.0", operatingExpensesMinor: "5000" });
    expect(r.data.completeness).toMatchObject({ fulfilments: 1, withIncompleteCost: 0, percentComplete: "100.0" });
    expect(r.meta.warnings.map((w) => w.code)).toContain("NOT_PROFIT");
    expect(r.meta.title).not.toMatch(/profit/i);
    expect(reportText(r)).toContain("Gross margin");
  });

  it("warns that the margin is OVERSTATED when a sale has no recorded cost, and reports nothing when there are no sales", async () => {
    const s = await seller();
    await soldThroughShop(s);
    await recordTransaction(s.scoped, { businessId: s.businessId, type: "SALE", amountMinor: 100_000n, currencyCode: "NGN", paymentStatus: "PAID" });
    const r = await grossMarginReport(ctxOf(s), wide());
    expect(r.meta.warnings.find((w) => w.code === "SALES_WITHOUT_COST")?.message).toContain("OVERSTATED");
    const empty = await seller();
    const none = await grossMarginReport(ctxOf(empty), wide());
    expect(none.data.grossMarginMinor).toBeNull();
    expect(none.data.grossMarginPercent).toBeNull();
    expect(none.meta.warnings.map((w) => w.code)).toContain("NO_SALES");
  });

  it("flags stock movements whose cost was incomplete", async () => {
    const s = await seller();
    const { receiveStock, fulfilSale } = await import("../src/domain/stock.js");
    const { createProduct, createVariant } = await import("../src/domain/catalog.js");
    const p = await createProduct(s.scoped, { businessId: s.businessId, name: "Mystery" });
    const v = await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku: `MYS${k}`, name: "box", baseUnit: "box" });
    await receiveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: v.id, quantity: 10 }); // no cost known
    await fulfilSale(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: v.id, quantity: 2 });
    const r = await grossMarginReport(ctxOf(s), wide());
    expect(r.data.completeness.withIncompleteCost).toBe(1);
    expect(r.meta.warnings.map((w) => w.code)).toContain("COST_INCOMPLETE");
  });
});

describe("payment reconciliation and stock discrepancies", () => {
  it("compares captured, applied and settled money and warns it is not a provider statement", async () => {
    const s = await seller();
    const r = await paymentReconciliationReport(ctxOf(s), wide());
    expect(r.data.captured).toEqual({ totalMinor: "0", allocatedMinor: "0", unallocatedMinor: "0" });
    expect(r.meta.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["NO_PROVIDER_PAYMENTS", "PROVIDER_STATEMENT_NEEDED"]));
  });

  it("finds a running balance that disagrees with its movements and an approved count variance", async () => {
    const s = await seller();
    const clean = await stockDiscrepancyReport(ctxOf(s), wide());
    expect(clean.data.balanceMismatches).toEqual([]);
    expect(clean.meta.warnings.map((w) => w.code)).toContain("NOTHING_FOUND");
    await testDb.db.query(`UPDATE "StockBalance" SET "onHand" = "onHand" + 5 WHERE "variantId" = $1`, [s.variant.id]);
    const r = await stockDiscrepancyReport(ctxOf(s), wide());
    expect(r.data.balanceMismatches).toEqual([{ sku: "COLA", field: "onHand", balance: 55, expected: 50 }]);
    expect(r.meta.warnings.map((w) => w.code)).toContain("BALANCE_NOT_EQUAL_TO_MOVEMENTS");
  });
});

describe("exports are formula-safe and keep their caveats", () => {
  it("neutralises a hostile name and carries range, currency, timezone, sources and every warning in the file", async () => {
    const b = await makeBusiness(prisma, `Hostile ${++k}`);
    await enableFlag(prisma, b.businessId, "reportsV2");
    const c = await prisma.customer.create({ data: { businessId: b.businessId, name: '=HYPERLINK("http://evil.example","pay")' } });
    await prisma.debt.create({ data: { businessId: b.businessId, customerId: c.id, originalAmountMinor: 500n, outstandingAmountMinor: 500n, currencyCode: "NGN" } });
    const r = await arAgingReport(ctxOf(b as never));
    const csv = reportToCsv(r);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""pay"")"`);
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(csv).toContain('"currency","NGN"');
    expect(csv).toContain('"timezone","Africa/Lagos"');
    for (const w of r.meta.warnings) expect(csv).toContain(csvText(w.message));
    expect(csv).toContain("not a tax filing");
    expect(csv).toContain("outstanding_minor");
  });

  it("every report renders as text and CSV without throwing", async () => {
    const s = await seller();
    await soldThroughShop(s);
    for (const name of REPORT_NAMES) {
      const { runReport } = await import("../src/reports/index.js");
      const rep = await runReport(ctxOf(s), name, wide());
      expect(reportText(rep).length).toBeGreaterThan(20);
      expect(reportToCsv(rep)).toContain("notice");
      expect(rep.meta.warnings.every((w) => w.message.length > 5)).toBe(true);
    }
  });
});

describe("the /report command", () => {
  it("answers like any unknown command with the flag off, and reads reports with it on; periods parse in the business timezone", async () => {
    const off = await seller([]);
    expect(await handleCommand(cmdCtx(off), "/report sales")).toContain('Unrecognized command "/report"');
    expect(await handleCommand(cmdCtx(off), "/help")).not.toContain("/report");
    const on = await seller();
    expect(await handleCommand(cmdCtx(on), "/help")).toContain("/report");
    await soldThroughShop(on);
    const text = await handleCommand(cmdCtx(on), "/report sales");
    expect(text).toContain("Net sales: 300.00 NGN");
    expect(text).toContain("Africa/Lagos");
    expect(await handleCommand(cmdCtx(on), "/report margin")).toMatch(/NOT profit/);
    expect(await handleCommand(cmdCtx(on), "/report nonsense")).toContain("do not have a report called");
    expect(await handleCommand(cmdCtx(on), "/report sales 2026-13-45 2026-14-01")).toContain("not real dates");
    expect(await handleCommand(cmdCtx(on), "/report sales 2026-02-31 2026-03-01")).toContain("not real dates");
    const r = parseRange(["2026-03-11", "2026-03-11"], "Africa/Lagos");
    expect(r.from.toISOString()).toBe("2026-03-10T23:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-03-11T23:00:00.000Z");
  });

  it("/today stops calling sales minus expenses 'Net' when reports are on; unchanged when off", async () => {
    const off = await seller([]);
    const on = await seller();
    expect(await handleCommand(cmdCtx(off), "/today")).toContain("Net:");
    const t = await handleCommand(cmdCtx(on), "/today");
    expect(t).toContain("Sales minus expenses (not profit):");
    expect(t).not.toContain("Net:");
  });

  it("a staff member (sales clerk) can read reports but not request a download link", async () => {
    const on = await seller();
    expect(await handleCommand(cmdCtx(on, "STAFF"), "/report sales")).toContain("Net sales");
    expect(await handleCommand(cmdCtx(on, "STAFF"), "/report link")).toContain("Only the owner or a manager");
  });
});
