import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import {
  JournalError, SYSTEM_ACCOUNTS, accountNet, backfillJournals, ensureChartOfAccounts, findUnjournaledTransactions, postCashAdjustment, postCustomerAdvance,
  postDebtCollection, postExpense, postFee, postJournal, postOpeningBalance, postOwnerContribution, postOwnerWithdrawal, postProviderSettlement,
  postRefund, postSale, postStockPurchase, reverseJournalEntry, trialBalance,
} from "../src/domain/accounting.js";
import { recordTransaction, reverseTransaction } from "../src/domain/ledger.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { fulfilSale, receiveStock, recordOwnerWithdrawal, recordSpoilage, recordOpeningBalance, restockReturn } from "../src/domain/stock.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

let k = 0;
const key = () => `k-${++k}`;
const base = (b: { businessId: string }) => ({ businessId: b.businessId, currencyCode: "NGN" });

async function net(env: Awaited<ReturnType<typeof makeBusiness>>, systemKey: (typeof SYSTEM_ACCOUNTS)[number]["key"]) {
  return accountNet(env.scoped, systemKey, { currencyCode: "NGN" });
}

async function expectBalancedBooks(env: Awaited<ReturnType<typeof makeBusiness>>) {
  const tb = await trialBalance(env.scoped, { currencyCode: "NGN" });
  expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
  return tb;
}

describe("chart of accounts", () => {
  it("is created once per business and is idempotent", async () => {
    const env = await makeBusiness(prisma);
    const a = await ensureChartOfAccounts(env.scoped, env.businessId);
    const b = await ensureChartOfAccounts(env.scoped, env.businessId);
    expect(a.size).toBe(SYSTEM_ACCOUNTS.length);
    expect([...b.entries()]).toEqual([...a.entries()]);
    expect(await env.scoped.account.count({ where: {} })).toBe(SYSTEM_ACCOUNTS.length);
  });
});

describe("posting rules produce balanced entries (scenario 5)", () => {
  it("cash sale, mobile-money sale, fee, refund, owner withdrawal and stock purchase all balance", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await postStockPurchase(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 50_000n, paidWith: "CASH" });
    await postSale(env.scoped, { ...c, idempotencyKey: key(), totalMinor: 20_000n, receipts: [{ method: "CASH", amountMinor: 20_000n }], costMinor: 12_000n });
    await postSale(env.scoped, { ...c, idempotencyKey: key(), totalMinor: 30_000n, receipts: [{ method: "MOBILE_MONEY", amountMinor: 30_000n }], costMinor: 18_000n });
    await postFee(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 450n, from: "MOBILE_MONEY" });
    await postRefund(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 5_000n, paidWith: "CASH", restockCostMinor: 3_000n });
    await postOwnerWithdrawal(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 4_000n, from: "CASH" });

    const tb = await expectBalancedBooks(env);
    expect(tb.totalDebitMinor).toBeGreaterThan(0n);
    // cash: -50,000 purchase +20,000 sale -5,000 refund -4,000 withdrawal
    expect(await net(env, "CASH")).toBe(-39_000n);
    // wallet: +30,000 sale -450 fee
    expect(await net(env, "MOBILE_MONEY")).toBe(29_550n);
    // revenue 50,000 (credit), returns 5,000 (debit): net sales 45,000
    expect(await net(env, "SALES_REVENUE")).toBe(-50_000n);
    expect(await net(env, "SALES_RETURNS")).toBe(5_000n);
    // stock: +50,000 bought -12,000 -18,000 sold cost +3,000 restocked
    expect(await net(env, "INVENTORY")).toBe(23_000n);
    expect(await net(env, "COGS")).toBe(27_000n);
    expect(await net(env, "PAYMENT_FEES")).toBe(450n);
    expect(await net(env, "OWNER_WITHDRAWALS")).toBe(4_000n);
  });

  it("buying stock is not an expense; an operating expense is; a fee is its own account", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await postStockPurchase(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 10_000n, paidWith: "BANK" });
    await postExpense(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 2_000n, paidWith: "CASH" });
    expect(await net(env, "OPERATING_EXPENSES")).toBe(2_000n);
    expect(await net(env, "INVENTORY")).toBe(10_000n);
    expect(await net(env, "COGS")).toBe(0n);
  });

  it("expenses and purchases on credit create a payable", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await postStockPurchase(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 8_000n, paidWith: "CREDIT" });
    await postExpense(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 1_000n, paidWith: "CREDIT" });
    expect(await net(env, "AP")).toBe(-9_000n);
    await expectBalancedBooks(env);
  });

  it("provider settlement is a movement between accounts, never revenue; the fee is separate", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await postProviderSettlement(env.scoped, { ...c, idempotencyKey: key(), grossMinor: 100_000n, feeMinor: 1_500n, destination: "BANK" });
    expect(await net(env, "BANK")).toBe(98_500n);
    expect(await net(env, "PROVIDER_CLEARING")).toBe(-100_000n);
    expect(await net(env, "PAYMENT_FEES")).toBe(1_500n);
    expect(await net(env, "SALES_REVENUE")).toBe(0n);
    await expect(postProviderSettlement(env.scoped, { ...c, idempotencyKey: key(), grossMinor: 100n, feeMinor: 100n, destination: "BANK" })).rejects.toBeInstanceOf(JournalError);
    await expectBalancedBooks(env);
  });

  it("customer advances are a liability, owner contributions are equity, opening balances are labelled and plugged to equity", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await postCustomerAdvance(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 3_000n, method: "MOBILE_MONEY" });
    await postOwnerContribution(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 7_000n, into: "CASH" });
    const open = await postOpeningBalance(env.scoped, {
      ...c, idempotencyKey: key(),
      assets: [{ account: "CASH", amountMinor: 5_000n }, { account: "INVENTORY", amountMinor: 20_000n }],
      liabilities: [{ account: "AP", amountMinor: 4_000n }],
    });
    expect(open.entry.provenance).toBe("MIGRATED_OPENING");
    expect(await net(env, "CUSTOMER_ADVANCES")).toBe(-3_000n);
    expect(await net(env, "OWNER_CAPITAL")).toBe(-7_000n);
    expect(await net(env, "OPENING_BALANCE_EQUITY")).toBe(-21_000n);
    await expectBalancedBooks(env);
  });

  it("a cash adjustment aligns the books to the count in either direction", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await postCashAdjustment(env.scoped, { ...c, idempotencyKey: key(), differenceMinor: -700n });
    await postCashAdjustment(env.scoped, { ...c, idempotencyKey: key(), differenceMinor: 200n });
    expect(await net(env, "CASH")).toBe(-500n);
    expect(await net(env, "CASH_OVER_SHORT")).toBe(500n);
    await expect(postCashAdjustment(env.scoped, { ...c, idempotencyKey: key(), differenceMinor: 0n })).rejects.toBeInstanceOf(JournalError);
  });
});

describe("credit sale, partial payment, remaining balance - no duplicated revenue (scenario 4)", () => {
  it("revenue is recognised once; collections reduce what is owed and are never revenue", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await postSale(env.scoped, { ...c, idempotencyKey: "sale-1", totalMinor: 10_000n, receipts: [{ method: "CASH", amountMinor: 4_000n }] });
    expect(await net(env, "AR")).toBe(6_000n);
    expect(await net(env, "CASH")).toBe(4_000n);
    await postDebtCollection(env.scoped, { ...c, idempotencyKey: "pay-1", amountMinor: 2_500n, method: "CASH" });
    await postDebtCollection(env.scoped, { ...c, idempotencyKey: "pay-2", amountMinor: 1_000n, method: "MOBILE_MONEY" });
    expect(await net(env, "AR")).toBe(2_500n);
    expect(await net(env, "SALES_REVENUE")).toBe(-10_000n); // still exactly one sale's worth
    expect(await net(env, "CASH")).toBe(6_500n);
    expect(await net(env, "MOBILE_MONEY")).toBe(1_000n);
    // replaying the same sale/collection (duplicate delivery) changes nothing
    const replay = await postSale(env.scoped, { ...c, idempotencyKey: "sale-1", totalMinor: 10_000n, receipts: [{ method: "CASH", amountMinor: 4_000n }] });
    expect(replay.created).toBe(false);
    await postDebtCollection(env.scoped, { ...c, idempotencyKey: "pay-1", amountMinor: 2_500n, method: "CASH" });
    expect(await net(env, "AR")).toBe(2_500n);
    expect(await net(env, "SALES_REVENUE")).toBe(-10_000n);
    await postDebtCollection(env.scoped, { ...c, idempotencyKey: "pay-3", amountMinor: 2_500n, method: "CASH" });
    expect(await net(env, "AR")).toBe(0n);
    await expectBalancedBooks(env);
  });

  it("rejects receipts above the sale total and zero amounts", async () => {
    const env = await makeBusiness(prisma);
    const c = base(env);
    await expect(postSale(env.scoped, { ...c, idempotencyKey: key(), totalMinor: 100n, receipts: [{ method: "CASH", amountMinor: 200n }] })).rejects.toBeInstanceOf(JournalError);
    await expect(postSale(env.scoped, { ...c, idempotencyKey: key(), totalMinor: 0n, receipts: [] })).rejects.toBeInstanceOf(JournalError);
    await expect(postDebtCollection(env.scoped, { ...c, idempotencyKey: key(), amountMinor: 0n, method: "CASH" })).rejects.toBeInstanceOf(JournalError);
  });
});

describe("balance and integrity are enforced by the database (invariants 5, 6, 9)", () => {
  it("the application refuses an unbalanced entry", async () => {
    const env = await makeBusiness(prisma);
    await expect(
      postJournal(env.scoped, { ...base(env), kind: "X", idempotencyKey: key(), lines: [{ account: "CASH", debitMinor: 100n }, { account: "SALES_REVENUE", creditMinor: 90n }] }),
    ).rejects.toMatchObject({ code: "IMBALANCE" });
    await expect(postJournal(env.scoped, { ...base(env), kind: "X", idempotencyKey: key(), lines: [{ account: "CASH", debitMinor: 100n }] })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("the database refuses an unbalanced entry even if the application is bypassed", async () => {
    const env = await makeBusiness(prisma);
    const accounts = await ensureChartOfAccounts(env.scoped, env.businessId);
    const cash = accounts.get("CASH")!;
    const sales = accounts.get("SALES_REVENUE")!;
    const db = testDb.db;
    await db.exec("BEGIN");
    await db.query(`INSERT INTO "JournalEntry" (id,"businessId","currencyCode","occurredAt",kind,"idempotencyKey") VALUES ('je-bad','${env.businessId}','NGN',now(),'X','bad-1')`);
    await db.query(`INSERT INTO "JournalLine" (id,"businessId","entryId","accountId","debitMinor","creditMinor") VALUES ('jl-1','${env.businessId}','je-bad','${cash}',100,0)`);
    await db.query(`INSERT INTO "JournalLine" (id,"businessId","entryId","accountId","debitMinor","creditMinor") VALUES ('jl-2','${env.businessId}','je-bad','${sales}',0,60)`);
    await expect(db.exec("COMMIT")).rejects.toThrow(/unbalanced/);
    await db.exec("ROLLBACK").catch(() => undefined);
    expect(await env.scoped.journalEntry.count({ where: {} })).toBe(0);
  });

  it("the database refuses an entry with a single line, and a line that is both debit and credit", async () => {
    const env = await makeBusiness(prisma);
    const accounts = await ensureChartOfAccounts(env.scoped, env.businessId);
    const cash = accounts.get("CASH")!;
    const db = testDb.db;
    await db.exec("BEGIN");
    await db.query(`INSERT INTO "JournalEntry" (id,"businessId","currencyCode","occurredAt",kind,"idempotencyKey") VALUES ('je-one','${env.businessId}','NGN',now(),'X','one-1')`);
    await db.query(`INSERT INTO "JournalLine" (id,"businessId","entryId","accountId","debitMinor","creditMinor") VALUES ('jl-3','${env.businessId}','je-one','${cash}',100,0)`);
    await expect(db.exec("COMMIT")).rejects.toThrow(/at least two lines|unbalanced/);
    await db.exec("ROLLBACK").catch(() => undefined);
    await expect(
      db.query(`INSERT INTO "JournalLine" (id,"businessId","entryId","accountId","debitMinor","creditMinor") VALUES ('jl-4','${env.businessId}','x','${cash}',5,5)`),
    ).rejects.toThrow(/check constraint|one_sided/);
  });

  it("the database refuses lines that point at another business's account", async () => {
    const a = await makeBusiness(prisma);
    const b = await makeBusiness(prisma);
    const aAcc = await ensureChartOfAccounts(a.scoped, a.businessId);
    const bAcc = await ensureChartOfAccounts(b.scoped, b.businessId);
    const db = testDb.db;
    await db.exec("BEGIN");
    await db.query(`INSERT INTO "JournalEntry" (id,"businessId","currencyCode","occurredAt",kind,"idempotencyKey") VALUES ('je-x','${a.businessId}','NGN',now(),'X','x-1')`);
    await db.query(`INSERT INTO "JournalLine" (id,"businessId","entryId","accountId","debitMinor","creditMinor") VALUES ('jl-5','${a.businessId}','je-x','${aAcc.get("CASH")}',100,0)`);
    await db.query(`INSERT INTO "JournalLine" (id,"businessId","entryId","accountId","debitMinor","creditMinor") VALUES ('jl-6','${a.businessId}','je-x','${bAcc.get("SALES_REVENUE")}',0,100)`);
    await expect(db.exec("COMMIT")).rejects.toThrow(/mixes businesses/);
    await db.exec("ROLLBACK").catch(() => undefined);
  });

  it("entries and lines are append-only and cannot be truncated", async () => {
    const env = await makeBusiness(prisma);
    const posted = await postSale(env.scoped, { ...base(env), idempotencyKey: key(), totalMinor: 100n, receipts: [{ method: "CASH", amountMinor: 100n }] });
    const line = await env.scoped.journalLine.findFirstOrThrow({ where: { entryId: posted.entry.id } });
    await expect(testDb.db.query(`UPDATE "JournalLine" SET "debitMinor" = 1 WHERE id = '${line.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "JournalLine" WHERE id = '${line.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`UPDATE "JournalEntry" SET memo = 'x' WHERE id = '${posted.entry.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "JournalEntry" WHERE id = '${posted.entry.id}'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`TRUNCATE "JournalLine"`)).rejects.toThrow(/TRUNCATE/);
  });

  it("idempotency: the same key posts once", async () => {
    const env = await makeBusiness(prisma);
    const c = { ...base(env), idempotencyKey: "same" };
    const first = await postExpense(env.scoped, { ...c, amountMinor: 500n, paidWith: "CASH" });
    const second = await postExpense(env.scoped, { ...c, amountMinor: 500n, paidWith: "CASH" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await env.scoped.journalEntry.count({ where: {} })).toBe(1);
  });

  it("a tenant cannot read another tenant's journals", async () => {
    const a = await makeBusiness(prisma);
    const b = await makeBusiness(prisma);
    await postExpense(a.scoped, { ...base(a), idempotencyKey: key(), amountMinor: 500n, paidWith: "CASH" });
    expect(await b.scoped.journalEntry.count({ where: {} })).toBe(0);
    expect((await trialBalance(b.scoped, { currencyCode: "NGN" })).rows).toEqual([]);
  });
});

describe("corrections are reversals (invariant 6)", () => {
  it("a reversal swaps every line, leaves the original intact and nets to zero; it is idempotent", async () => {
    const env = await makeBusiness(prisma);
    const sale = await postSale(env.scoped, { ...base(env), idempotencyKey: key(), totalMinor: 9_000n, receipts: [{ method: "CASH", amountMinor: 9_000n }], costMinor: 5_000n });
    const r1 = await reverseJournalEntry(env.scoped, sale.entry.id, { reason: "customer cancelled" });
    const r2 = await reverseJournalEntry(env.scoped, sale.entry.id);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r1.entry).toMatchObject({ kind: "REVERSAL", reversalOfEntryId: sale.entry.id });
    expect(await net(env, "CASH")).toBe(0n);
    expect(await net(env, "SALES_REVENUE")).toBe(0n);
    expect(await net(env, "COGS")).toBe(0n);
    expect(await net(env, "INVENTORY")).toBe(0n);
    expect(await env.scoped.journalEntry.findUniqueOrThrow({ where: { id: sale.entry.id } })).toMatchObject({ kind: "SALE" });
    await expect(reverseJournalEntry(env.scoped, r1.entry.id)).rejects.toMatchObject({ code: "REVERSAL_OF_REVERSAL" });
    await expect(reverseJournalEntry(env.scoped, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expectBalancedBooks(env);
  });
});

describe("legacy transactions journal behind the accountingJournals flag (scenario 25)", () => {
  it("flag OFF: recording and reversing transactions writes nothing new (existing behaviour unchanged)", async () => {
    const env = await makeBusiness(prisma);
    const t = await recordTransaction(env.scoped, { businessId: env.businessId, type: "SALE", amountMinor: 5_000n, currencyCode: "NGN", paymentStatus: "PAID" });
    await reverseTransaction(env.scoped, t.id, "undo");
    expect(await env.scoped.journalEntry.count({ where: {} })).toBe(0);
    expect(await env.scoped.account.count({ where: {} })).toBe(0);
  });

  it("flag ON: every legacy transaction type posts an honest, balanced entry", async () => {
    const env = await makeBusiness(prisma);
    await enableFlag(prisma, env.businessId, "accountingJournals");
    const mk = (type: Parameters<typeof recordTransaction>[1]["type"], amountMinor: bigint, paymentStatus: "PAID" | "CREDIT" | "PARTIAL") =>
      recordTransaction(env.scoped, { businessId: env.businessId, type, amountMinor, currencyCode: "NGN", paymentStatus, whatsappMessageId: `wamid.${++k}` });
    await mk("SALE", 10_000n, "PAID");
    await mk("SALE", 6_000n, "CREDIT");
    await mk("SALE", 3_000n, "PARTIAL");
    await mk("DEBT_NOTE", 2_000n, "CREDIT");
    await mk("PAYMENT_RECEIVED", 1_000n, "PAID");
    await mk("PURCHASE", 4_000n, "PAID");
    await mk("EXPENSE", 500n, "PAID");
    await mk("STOCK_ADJUSTMENT", 0n, "PAID"); // no monetary effect: not journaled

    expect(await env.scoped.journalEntry.count({ where: {} })).toBe(7);
    expect(await net(env, "SALES_REVENUE")).toBe(-19_000n); // three sales recognised; the debt note is not a sale
    expect(await net(env, "UNCLASSIFIED_FUNDS")).toBe(10_000n + 1_000n - 4_000n - 500n); // method not recorded: never guessed as cash
    expect(await net(env, "CASH")).toBe(0n);
    expect(await net(env, "AR")).toBe(6_000n + 2_000n - 1_000n);
    expect(await net(env, "UNRESOLVED_LEGACY")).toBe(3_000n);
    expect(await net(env, "DEBT_NOTE_SUSPENSE")).toBe(-2_000n);
    expect(await net(env, "INVENTORY")).toBe(4_000n);
    expect(await net(env, "OPERATING_EXPENSES")).toBe(500n);
    const entry = await env.scoped.journalEntry.findFirstOrThrow({ where: { kind: "SALE" } });
    expect(entry).toMatchObject({ provenance: "MERCHANT_ENTERED", sourceType: "TRANSACTION" });
    expect(entry.evidenceRef).toMatch(/^wamid\./);
    await expectBalancedBooks(env);
  });

  it("flag ON: /undo journals a reversal that zeroes the sale", async () => {
    const env = await makeBusiness(prisma);
    await enableFlag(prisma, env.businessId, "accountingJournals");
    const t = await recordTransaction(env.scoped, { businessId: env.businessId, type: "SALE", amountMinor: 7_000n, currencyCode: "NGN", paymentStatus: "CREDIT" });
    await reverseTransaction(env.scoped, t.id, "undone");
    expect(await net(env, "SALES_REVENUE")).toBe(0n);
    expect(await net(env, "AR")).toBe(0n);
    expect(await env.scoped.journalEntry.count({ where: {} })).toBe(2);
  });

  it("detects and backfills transactions recorded while the flag was off (oldest first, reversals after originals)", async () => {
    const env = await makeBusiness(prisma);
    const sale = await recordTransaction(env.scoped, { businessId: env.businessId, type: "SALE", amountMinor: 8_000n, currencyCode: "NGN", paymentStatus: "PAID" });
    await recordTransaction(env.scoped, { businessId: env.businessId, type: "EXPENSE", amountMinor: 1_000n, currencyCode: "NGN", paymentStatus: "PAID" });
    await reverseTransaction(env.scoped, sale.id, "undo");
    expect((await findUnjournaledTransactions(env.scoped)).length).toBe(3);
    const result = await backfillJournals(env.scoped);
    expect(result.posted).toBe(3);
    expect(await findUnjournaledTransactions(env.scoped)).toEqual([]);
    expect(await net(env, "SALES_REVENUE")).toBe(0n);
    expect(await net(env, "OPERATING_EXPENSES")).toBe(1_000n);
    expect((await backfillJournals(env.scoped)).posted).toBe(0); // repeatable
    await expectBalancedBooks(env);
  });
});

describe("stock movements journal their money effect (flag accountingJournals)", () => {
  it("cost of goods, losses, owner stock withdrawals, restocks and opening stock reach the books at cost", async () => {
    const env = await makeBusiness(prisma);
    await enableFlag(prisma, env.businessId, "accountingJournals");
    const product = await createProduct(env.scoped, { businessId: env.businessId, name: "Rice" });
    const v = await createVariant(env.scoped, { businessId: env.businessId, productId: product.id, sku: "RICE-1", name: "Rice", baseUnit: "kg" });
    const common = { businessId: env.businessId, shopId: env.shopId, variantId: v.id, currencyCode: "NGN" };

    await recordOpeningBalance(env.scoped, { ...common, quantity: 10, unitCostMinor: 100n });
    expect(await net(env, "INVENTORY")).toBe(1_000n);
    expect(await net(env, "OPENING_BALANCE_EQUITY")).toBe(-1_000n);

    const sale = await fulfilSale(env.scoped, { ...common, quantity: 4 });
    expect(await net(env, "COGS")).toBe(400n);
    await recordSpoilage(env.scoped, { ...common, quantity: 1 });
    expect(await net(env, "INVENTORY_SHRINKAGE")).toBe(100n);
    await recordOwnerWithdrawal(env.scoped, { ...common, quantity: 2 });
    expect(await net(env, "OWNER_WITHDRAWALS")).toBe(200n);
    await restockReturn(env.scoped, { ...common, quantity: 1, unitCostMinor: sale.movement.unitCostMinor! });
    expect(await net(env, "COGS")).toBe(300n);
    // inventory asset equals what is physically valued: 10 -4 -1 -2 +1 = 4 units @ 100
    expect(await net(env, "INVENTORY")).toBe(400n);
    await expectBalancedBooks(env);
  });

  it("with the flag off, stock movements post no journals", async () => {
    const env = await makeBusiness(prisma);
    const product = await createProduct(env.scoped, { businessId: env.businessId, name: "Beans" });
    const v = await createVariant(env.scoped, { businessId: env.businessId, productId: product.id, sku: "BEANS-1", name: "b", baseUnit: "kg" });
    await receiveStock(env.scoped, { businessId: env.businessId, shopId: env.shopId, variantId: v.id, quantity: 5, unitCostMinor: 10n, currencyCode: "NGN" });
    await fulfilSale(env.scoped, { businessId: env.businessId, shopId: env.shopId, variantId: v.id, quantity: 2, currencyCode: "NGN" });
    expect(await env.scoped.journalEntry.count({ where: {} })).toBe(0);
  });
});
