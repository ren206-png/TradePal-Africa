import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { applyLoggableIntent, type ApplyIntentContext } from "../src/ai/applyParsedIntent.js";
import { listOpenDebtsForCustomer } from "../src/domain/debtBook.js";

let testDb: TestDb;
let prisma: PrismaClient;
let scoped: TenantScopedClient;
let businessId: string;
let ctx: ApplyIntentContext;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  const business = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessId = business.id;
  scoped = getTenantScopedClient(prisma, businessId);
  ctx = { scopedPrisma: scoped, businessId, currencyCode: "NGN", minorUnitExp: 2 };
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("applyLoggableIntent", () => {
  it("logs a SALE with line items and an optional customer", async () => {
    const reply = await applyLoggableIntent(ctx, {
      intent: "SALE",
      confidence: 0.95,
      amountMinor: 2000,
      paymentStatus: "PAID",
      customerName: "Grace",
      items: [{ itemName: "bread", quantity: 2, unitPriceMinor: 1000 }],
    });

    expect(reply).toContain("20.00");
    const transactions = await scoped.transaction.findMany({ where: { type: "SALE" } });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.amountMinor).toBe(2000n);
  });

  it("logs a PURCHASE and creates the supplier once", async () => {
    await applyLoggableIntent(ctx, {
      intent: "PURCHASE",
      confidence: 0.9,
      amountMinor: 5000,
      supplierName: "Coca-Cola Depot",
    });
    await applyLoggableIntent(ctx, {
      intent: "PURCHASE",
      confidence: 0.9,
      amountMinor: 1500,
      supplierName: "coca-cola depot",
    });

    const suppliers = await scoped.supplier.findMany({ where: { name: { equals: "Coca-Cola Depot", mode: "insensitive" } } });
    expect(suppliers).toHaveLength(1);
  });

  it("logs an EXPENSE with a description", async () => {
    const reply = await applyLoggableIntent(ctx, {
      intent: "EXPENSE",
      confidence: 0.99,
      amountMinor: 300,
      description: "transport",
    });
    expect(reply).toContain("3.00");
  });

  it("records a DEBT_NOTE that shows up as an open debt for the customer", async () => {
    await applyLoggableIntent(ctx, {
      intent: "DEBT_NOTE",
      confidence: 0.9,
      amountMinor: 4000,
      customerName: "Tunde",
    });

    const customer = await scoped.customer.findFirstOrThrow({ where: { name: "Tunde" } });
    const openDebts = await listOpenDebtsForCustomer(scoped, customer.id);
    expect(openDebts).toHaveLength(1);
    expect(openDebts[0]?.outstandingAmountMinor).toBe(4000n);
  });

  it("applies a PAYMENT_RECEIVED against that customer's open debt", async () => {
    const customer = await scoped.customer.findFirstOrThrow({ where: { name: "Tunde" } });

    const reply = await applyLoggableIntent(ctx, {
      intent: "PAYMENT_RECEIVED",
      confidence: 0.9,
      amountMinor: 1500,
      customerName: "Tunde",
    });

    expect(reply).toContain("15.00");
    const openDebts = await listOpenDebtsForCustomer(scoped, customer.id);
    expect(openDebts[0]?.outstandingAmountMinor).toBe(2500n);
  });

  it("surfaces an overpayment refusal for PAYMENT_RECEIVED instead of throwing", async () => {
    const reply = await applyLoggableIntent(ctx, {
      intent: "PAYMENT_RECEIVED",
      confidence: 0.9,
      amountMinor: 999999,
      customerName: "Tunde",
    });

    expect(reply).toMatch(/exceeds/i);
  });

  it("Phase 15: does NOT touch InventoryItem for a SALE with items when stockTrackingEnabled is unset (default false)", async () => {
    await applyLoggableIntent(ctx, {
      intent: "SALE",
      confidence: 0.9,
      amountMinor: 500,
      paymentStatus: "PAID",
      items: [{ itemName: "Untracked Item", quantity: 1, unitPriceMinor: 500 }],
    });

    const item = await scoped.inventoryItem.findFirst({ where: { name: "Untracked Item" } });
    expect(item).toBeNull();
  });

  it("Phase 15: a SALE with items decrements InventoryItem stock and links TransactionItem.inventoryItemId when stockTrackingEnabled is true", async () => {
    const trackedCtx: ApplyIntentContext = { ...ctx, stockTrackingEnabled: true };
    await scoped.inventoryItem.create({
      data: { businessId, name: "Rice", normalizedName: "rice", estimatedStockQty: 20 },
    });

    await applyLoggableIntent(trackedCtx, {
      intent: "SALE",
      confidence: 0.9,
      amountMinor: 4000,
      paymentStatus: "PAID",
      items: [{ itemName: "rice", quantity: 4, unitPriceMinor: 1000 }], // case-insensitive match against "Rice"
    });

    const item = await scoped.inventoryItem.findFirstOrThrow({ where: { name: "Rice" } });
    expect(item.estimatedStockQty).toBe(16);

    const transactionItem = await scoped.transactionItem.findFirstOrThrow({ where: { itemName: "rice" } });
    expect(transactionItem.inventoryItemId).toBe(item.id);

    const movements = await scoped.inventoryMovement.findMany({ where: { inventoryItemId: item.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.source).toBe("SALE");
    expect(movements[0]?.quantityDelta).toBe(-4);
  });

  it("Phase 15: a PURCHASE with items increments InventoryItem stock, creating the item if it doesn't exist yet", async () => {
    const trackedCtx: ApplyIntentContext = { ...ctx, stockTrackingEnabled: true };

    await applyLoggableIntent(trackedCtx, {
      intent: "PURCHASE",
      confidence: 0.9,
      amountMinor: 10000,
      items: [{ itemName: "Cooking Gas", quantity: 5, unitPriceMinor: 2000 }],
    });

    const item = await scoped.inventoryItem.findFirstOrThrow({ where: { name: "Cooking Gas" } });
    expect(item.estimatedStockQty).toBe(5);

    const movements = await scoped.inventoryMovement.findMany({ where: { inventoryItemId: item.id } });
    expect(movements[0]?.source).toBe("PURCHASE");
    expect(movements[0]?.quantityDelta).toBe(5);
  });

  it("Phase 15: two line items naming the same new item in one SALE resolve to a single InventoryItem row, not two", async () => {
    const trackedCtx: ApplyIntentContext = { ...ctx, stockTrackingEnabled: true };

    await applyLoggableIntent(trackedCtx, {
      intent: "SALE",
      confidence: 0.9,
      amountMinor: 6000,
      paymentStatus: "PAID",
      items: [
        { itemName: "Egg Crate", quantity: 2, unitPriceMinor: 2000 },
        { itemName: "Egg Crate", quantity: 1, unitPriceMinor: 2000 },
      ],
    });

    const items = await scoped.inventoryItem.findMany({ where: { name: { equals: "Egg Crate", mode: "insensitive" } } });
    expect(items).toHaveLength(1);
    expect(items[0]?.estimatedStockQty).toBe(-3); // both lines decrement the same row
  });

  it("Phase 19: a bare SALE with no items and no customer stays a plain one-line confirmation", async () => {
    const reply = await applyLoggableIntent(ctx, {
      intent: "SALE",
      confidence: 0.95,
      amountMinor: 5000,
      paymentStatus: "PAID",
    });

    expect(reply).toBe("Logged sale of 50.00 NGN.");
  });

  it("Phase 19: a SALE with line items produces an itemized, forwardable receipt", async () => {
    const receiptCtx: ApplyIntentContext = { ...ctx, businessName: "Shop A" };
    const reply = await applyLoggableIntent(receiptCtx, {
      intent: "SALE",
      confidence: 0.95,
      amountMinor: 3500,
      paymentStatus: "PAID",
      customerName: "Ada",
      items: [
        { itemName: "bread", quantity: 2, unitPriceMinor: 1000 },
        { itemName: "eggs", quantity: 1, unitPriceMinor: 1500 },
      ],
    });

    expect(reply).toContain("Logged sale of 35.00 NGN.");
    expect(reply).toContain("Receipt — Shop A");
    expect(reply).toContain("Customer: Ada");
    expect(reply).toContain("2 x bread @ 10.00 = 20.00");
    expect(reply).toContain("1 x eggs @ 15.00 = 15.00");
    expect(reply).toContain("Total: 35.00 NGN");
    expect(reply).toContain("Forward this receipt to your customer yourself — TradePal cannot message customers directly.");
  });

  it("Phase 19: a SALE with a customer name but no items still produces a forwardable (non-itemized) receipt", async () => {
    const reply = await applyLoggableIntent(ctx, {
      intent: "SALE",
      confidence: 0.9,
      amountMinor: 1200,
      paymentStatus: "PAID",
      customerName: "Femi",
    });

    expect(reply).toContain("Receipt — Your business");
    expect(reply).toContain("Customer: Femi");
    expect(reply).toContain("Total: 12.00 NGN");
    expect(reply).toContain("Forward this receipt to your customer yourself");
    expect(reply).not.toMatch(/\dx? .* @ .* = /); // no itemized lines when there are no items
  });
});
