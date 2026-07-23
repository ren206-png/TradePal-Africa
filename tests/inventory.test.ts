import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import {
  backfillInventoryLinksForBusiness,
  findOrCreateInventoryItem,
  getInventoryStatus,
  InvalidStockThresholdError,
  recordStockAdjustment,
  setLowStockThreshold,
} from "../src/domain/inventory.js";
import { recordTransaction } from "../src/domain/ledger.js";

let testDb: TestDb;
let prisma: PrismaClient;
let businessId: string;
let scoped: TenantScopedClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  const business = await prisma.business.create({
    data: { name: "Inventory Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessId = business.id;
  scoped = getTenantScopedClient(prisma, businessId);
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("recordStockAdjustment", () => {
  it("creates a new InventoryItem on first use and records a positive InventoryMovement", async () => {
    const result = await recordStockAdjustment(scoped, businessId, "Rice", 10);

    expect(result.item.name).toBe("Rice");
    expect(result.item.estimatedStockQty).toBe(10);
    expect(result.quantityDelta).toBe(10);

    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: result.item.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.quantityDelta).toBe(10);
    expect(movements[0]?.source).toBe("ADJUSTMENT");
  });

  it("matches an existing item case-insensitively rather than creating a duplicate", async () => {
    const result = await recordStockAdjustment(scoped, businessId, "rice", -3);

    expect(result.item.name).toBe("Rice"); // the originally-created casing is preserved
    expect(result.item.estimatedStockQty).toBe(7);

    const items = await prisma.inventoryItem.findMany({ where: { businessId, name: { equals: "Rice", mode: "insensitive" } } });
    expect(items).toHaveLength(1);
  });

  it("decrements estimatedStockQty below zero without clamping (estimate, not a hard inventory ledger)", async () => {
    const result = await recordStockAdjustment(scoped, businessId, "Sugar", -5);
    expect(result.item.estimatedStockQty).toBe(-5);
  });

  it("records the given source and optional transactionId on the InventoryMovement row", async () => {
    const transaction = await prisma.transaction.create({
      data: {
        businessId,
        type: "SALE",
        amountMinor: 100n,
        currencyCode: "NGN",
        paymentStatus: "PAID",
      },
    });

    const result = await recordStockAdjustment(scoped, businessId, "Beans", -1, "SALE", transaction.id);

    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: result.item.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.source).toBe("SALE");
    expect(movements[0]?.transactionId).toBe(transaction.id);
  });
});

describe("findOrCreateInventoryItem (Phase 17: same-name collision race)", () => {
  it("concurrent first-time calls for the same new item name resolve to exactly one InventoryItem row", async () => {
    const raceBusiness = await prisma.business.create({
      data: { name: "Race Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const raceScoped = getTenantScopedClient(prisma, raceBusiness.id);

    // Two "concurrent" callers both naming a brand-new item for the first time —
    // before the normalizedName unique constraint + catch-and-refetch, both could
    // pass the findFirst check (neither row exists yet) and both create a row.
    const [first, second] = await Promise.all([
      findOrCreateInventoryItem(raceScoped, raceBusiness.id, "Bread"),
      findOrCreateInventoryItem(raceScoped, raceBusiness.id, "bread"),
    ]);

    expect(first.id).toBe(second.id);

    const rows = await prisma.inventoryItem.findMany({
      where: { businessId: raceBusiness.id, normalizedName: "bread" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("getInventoryStatus", () => {
  it("lists items alphabetically by name with isLowStock computed against the threshold", async () => {
    const statusBusiness = await prisma.business.create({
      data: { name: "Status Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const statusScoped = getTenantScopedClient(prisma, statusBusiness.id);

    await recordStockAdjustment(statusScoped, statusBusiness.id, "Zebra Snacks", 20);
    await recordStockAdjustment(statusScoped, statusBusiness.id, "Apple Juice", 3);
    await setLowStockThreshold(statusScoped, statusBusiness.id, "Apple Juice", 5);

    const status = await getInventoryStatus(statusScoped, statusBusiness.id);

    expect(status.map((s) => s.name)).toEqual(["Apple Juice", "Zebra Snacks"]);

    const apple = status.find((s) => s.name === "Apple Juice");
    expect(apple?.estimatedStockQty).toBe(3);
    expect(apple?.lowStockThreshold).toBe(5);
    expect(apple?.isLowStock).toBe(true); // 3 <= 5

    const zebra = status.find((s) => s.name === "Zebra Snacks");
    expect(zebra?.lowStockThreshold).toBeNull();
    expect(zebra?.isLowStock).toBe(false); // no threshold set => never flagged
  });

  it("returns an empty array for a business with no InventoryItem rows", async () => {
    const emptyBusiness = await prisma.business.create({
      data: { name: "Empty Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const emptyScoped = getTenantScopedClient(prisma, emptyBusiness.id);

    const status = await getInventoryStatus(emptyScoped, emptyBusiness.id);
    expect(status).toEqual([]);
  });
});

describe("setLowStockThreshold", () => {
  it("creates the item if it doesn't exist yet and sets its threshold", async () => {
    const item = await setLowStockThreshold(scoped, businessId, "Cooking Oil", 2);
    expect(item.name).toBe("Cooking Oil");
    expect(item.lowStockThreshold).toBe(2);
    expect(item.estimatedStockQty).toBe(0); // never adjusted, just thresholded
  });

  it("clears an existing threshold when given null", async () => {
    await setLowStockThreshold(scoped, businessId, "Cooking Oil", 2);
    const cleared = await setLowStockThreshold(scoped, businessId, "Cooking Oil", null);
    expect(cleared.lowStockThreshold).toBeNull();
  });

  it("rejects a negative threshold with InvalidStockThresholdError", async () => {
    await expect(setLowStockThreshold(scoped, businessId, "Cooking Oil", -1)).rejects.toThrow(InvalidStockThresholdError);
  });

  it("accepts a zero threshold (alert once fully out of stock)", async () => {
    const item = await setLowStockThreshold(scoped, businessId, "Salt", 0);
    expect(item.lowStockThreshold).toBe(0);
  });
});

describe("backfillInventoryLinksForBusiness (Phase 17)", () => {
  it("links pre-existing SALE/PURCHASE TransactionItem rows to InventoryItem and applies matching InventoryMovements", async () => {
    const backfillBusiness = await prisma.business.create({
      data: { name: "Backfill Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const backfillScoped = getTenantScopedClient(prisma, backfillBusiness.id);

    // Logged before stockTracking was ever enabled: items with no inventoryItemId.
    const sale = await recordTransaction(backfillScoped, {
      businessId: backfillBusiness.id,
      type: "SALE",
      amountMinor: 500n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
      items: [{ itemName: "Bread", quantity: 3, unitPriceMinor: 100n }],
    });
    const purchase = await recordTransaction(backfillScoped, {
      businessId: backfillBusiness.id,
      type: "PURCHASE",
      amountMinor: 200n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
      items: [{ itemName: "Bread", quantity: 5, unitPriceMinor: 40n }],
    });
    // Not a candidate: EXPENSE never carries items in the first place, but confirm the
    // backfill doesn't choke on a business that also has non-itemized transaction types.
    await recordTransaction(backfillScoped, {
      businessId: backfillBusiness.id,
      type: "EXPENSE",
      amountMinor: 50n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });

    const result = await backfillInventoryLinksForBusiness(backfillScoped, backfillBusiness.id);
    expect(result.transactionItemsLinked).toBe(2);

    const item = await prisma.inventoryItem.findFirst({ where: { businessId: backfillBusiness.id, normalizedName: "bread" } });
    expect(item).not.toBeNull();
    // -3 (sale) + 5 (purchase) = net +2
    expect(item?.estimatedStockQty).toBe(2);

    const saleItems = await prisma.transactionItem.findMany({ where: { transactionId: sale.id } });
    expect(saleItems[0]?.inventoryItemId).toBe(item?.id);
    const purchaseItems = await prisma.transactionItem.findMany({ where: { transactionId: purchase.id } });
    expect(purchaseItems[0]?.inventoryItemId).toBe(item?.id);

    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item!.id }, orderBy: { quantityDelta: "asc" } });
    expect(movements).toHaveLength(2);
    expect(movements[0]?.quantityDelta).toBe(-3);
    expect(movements[0]?.source).toBe("SALE");
    expect(movements[0]?.transactionId).toBe(sale.id);
    expect(movements[1]?.quantityDelta).toBe(5);
    expect(movements[1]?.source).toBe("PURCHASE");
    expect(movements[1]?.transactionId).toBe(purchase.id);
  });

  it("is idempotent: running it again after a prior run is a no-op", async () => {
    const idemBusiness = await prisma.business.create({
      data: { name: "Idempotent Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const idemScoped = getTenantScopedClient(prisma, idemBusiness.id);

    await recordTransaction(idemScoped, {
      businessId: idemBusiness.id,
      type: "SALE",
      amountMinor: 300n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
      items: [{ itemName: "Milk", quantity: 2, unitPriceMinor: 150n }],
    });

    const first = await backfillInventoryLinksForBusiness(idemScoped, idemBusiness.id);
    expect(first.transactionItemsLinked).toBe(1);

    const second = await backfillInventoryLinksForBusiness(idemScoped, idemBusiness.id);
    expect(second.transactionItemsLinked).toBe(0);

    const item = await prisma.inventoryItem.findFirst({ where: { businessId: idemBusiness.id, normalizedName: "milk" } });
    expect(item?.estimatedStockQty).toBe(-2); // not double-applied

    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item!.id } });
    expect(movements).toHaveLength(1);
  });

  it("returns zero for a business with no un-linked SALE/PURCHASE line items", async () => {
    const emptyBusiness = await prisma.business.create({
      data: { name: "Nothing To Backfill Shop", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const emptyScoped = getTenantScopedClient(prisma, emptyBusiness.id);

    const result = await backfillInventoryLinksForBusiness(emptyScoped, emptyBusiness.id);
    expect(result.transactionItemsLinked).toBe(0);
  });
});
