import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MembershipRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller } from "./helpers/store.js";
import { BulkError, applyBulkChanges, catalogToCsv, exportCatalog, parseCsv, previewBulkChanges, rowsFromCsv, type BulkContext, type BulkRow } from "../src/domain/bulkCatalog.js";
import { publicCatalog } from "../src/domain/store/storefront.js";

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

async function world(role: MembershipRole = "OWNER") {
  const s = await makeSeller(prisma, `Bulk ${++k}`, { slug: `bulk-${k}` });
  const ctx: BulkContext = { businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, role, actorId: "m-1" };
  return { s, ctx, batch: () => `batch-${k}-${Math.random().toString(36).slice(2, 10)}` };
}

describe("export", () => {
  it("shows each product as the seller sees it, with a fingerprint, and never any cost", async () => {
    const { s, ctx } = await world();
    const { rows } = await exportCatalog(s.scoped, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "COLA", productName: "Cola", baseUnit: "can", retailPrice: "100.00", listed: true, status: "DRAFT", photos: 0 });
    expect(rows[0]!.rev).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(rows)).not.toMatch(/cost|avg|4000|40\.00/i);
  });
});

describe("preview and apply", () => {
  it("shows what will change without writing, then applies it, keeping the old price in history and writing one audit entry", async () => {
    const { s, ctx, batch } = await world();
    const rows: BulkRow[] = [{ sku: "COLA", retailPrice: "125.50", lowStockThreshold: 12, category: "Drinks" }];
    const plan = await previewBulkChanges(prisma, ctx, rows);
    expect(plan.canApply).toBe(true);
    expect(plan.rows[0]).toMatchObject({ action: "UPDATE" });
    expect(plan.rows[0]!.changes).toEqual(expect.arrayContaining(["price: 100.00 -> 125.50 NGN", "low-stock alert: 5 -> 12", "category: none -> Drinks"]));
    expect((await exportCatalog(s.scoped, ctx)).rows[0]!.retailPrice).toBe("100.00"); // nothing written by a preview

    const id = batch();
    const r = await applyBulkChanges(prisma, ctx, { batchId: id, rows });
    expect(r).toMatchObject({ replayed: false, updated: 1, created: 0 });
    const after = (await exportCatalog(s.scoped, ctx)).rows[0]!;
    expect(after).toMatchObject({ retailPrice: "125.50", lowStockThreshold: 12, category: "Drinks" });
    const rules = await s.scoped.priceRule.findMany({ where: { variantId: s.variant.id, packConversionId: null, minQuantity: 1 } });
    expect(rules.filter((x) => x.status === "ACTIVE")).toHaveLength(1);
    expect(rules.filter((x) => x.status === "RETIRED")).toHaveLength(1); // history kept
    expect(await s.scoped.auditLog.count({ where: { action: "catalog.bulk_edit" } })).toBe(1);
    const shop = await publicCatalog(prisma, s.businessId);
    expect(shop.items[0]!.options[0]!.unitPriceMinor).toBe(12_550n);

    // a retry of the same batch (a dropped connection) changes nothing and says so
    const again = await applyBulkChanges(prisma, ctx, { batchId: id, rows });
    expect(again.replayed).toBe(true);
    expect(await s.scoped.auditLog.count({ where: { action: "catalog.bulk_edit" } })).toBe(1);
    expect(await s.scoped.priceRule.count({ where: { variantId: s.variant.id, status: "ACTIVE", packConversionId: null, minQuantity: 1 } })).toBe(1);
  });

  it("creates a new product with a price and puts it on the shop, in one step", async () => {
    const { s, ctx, batch } = await world();
    const r = await applyBulkChanges(prisma, ctx, { batchId: batch(), rows: [{ sku: "FANTA", productName: "Fanta", variantName: "Fanta 330 ml", baseUnit: "Can", retailPrice: "90", listed: true, barcode: "6001234567" }] });
    expect(r.created).toBe(1);
    const shop = await publicCatalog(prisma, s.businessId);
    expect(shop.items.map((i) => i.name).sort()).toEqual(["Cola", "Fanta"]);
    const fanta = (await exportCatalog(s.scoped, ctx)).rows.find((x) => x.sku === "FANTA")!;
    expect(fanta).toMatchObject({ baseUnit: "can", retailPrice: "90.00", listed: true, barcode: "6001234567" });
  });

  it("takes a product off the shop and removes a price (null) only in a consistent way", async () => {
    const { s, ctx, batch } = await world();
    await expect(applyBulkChanges(prisma, ctx, { batchId: batch(), rows: [{ sku: "COLA", retailPrice: null }] })).rejects.toMatchObject({ code: "INVALID" }); // still listed
    const r = await applyBulkChanges(prisma, ctx, { batchId: batch(), rows: [{ sku: "COLA", listed: false, retailPrice: null }] });
    expect(r.updated).toBe(1);
    expect((await exportCatalog(s.scoped, ctx)).rows[0]).toMatchObject({ retailPrice: null, listed: false });
    expect((await publicCatalog(prisma, s.businessId)).items).toHaveLength(0);
  });

  it("is all-or-nothing: one bad row stops the whole batch and nothing is written", async () => {
    const { s, ctx, batch } = await world();
    const rows: BulkRow[] = [{ sku: "COLA", retailPrice: "200" }, { sku: "NEW1", productName: "New", baseUnit: "kg", retailPrice: "-4" }];
    const err = await applyBulkChanges(prisma, ctx, { batchId: batch(), rows }).catch((e) => e);
    expect(err).toBeInstanceOf(BulkError);
    expect((err as BulkError).plan!.rows[1]!.errors.join(" ")).toMatch(/more than zero/);
    expect((await exportCatalog(s.scoped, ctx)).rows[0]!.retailPrice).toBe("100.00");
    expect(await s.scoped.productVariant.count({ where: { sku: "NEW1" } })).toBe(0);
    expect(await s.scoped.auditLog.count({ where: { action: "catalog.bulk_edit" } })).toBe(0);
  });

  it("refuses stale edits (the row changed after it was opened), unit changes, repeated SKUs, bad prices and duplicate barcodes", async () => {
    const { s, ctx, batch } = await world();
    const opened = (await exportCatalog(s.scoped, ctx)).rows[0]!;
    await applyBulkChanges(prisma, ctx, { batchId: batch(), rows: [{ sku: "COLA", retailPrice: "110" }] }); // someone else edits first
    const plan = await previewBulkChanges(prisma, ctx, [
      { sku: "COLA", rev: opened.rev, retailPrice: "150" },
      { sku: "A1", productName: "A", baseUnit: "kg" }, { sku: "A1", productName: "A", baseUnit: "kg" },
      { sku: "A2", productName: "B", baseUnit: "kg", retailPrice: "1.234" },
      { sku: "A3", productName: "C", baseUnit: "kg", barcode: "1111" }, { sku: "A4", productName: "D", baseUnit: "kg", barcode: "1111" },
    ]);
    const msg = plan.rows.map((r) => r.errors.join(" "));
    expect(msg[0]).toMatch(/changed after you opened/);
    expect(msg[2]).toMatch(/twice/);
    expect(msg[3]).toMatch(/decimal places/);
    expect(msg[5]).toMatch(/also used by A3/);
    expect(plan.canApply).toBe(false);
    const unit = await previewBulkChanges(prisma, ctx, [{ sku: "COLA", baseUnit: "carton" }]);
    expect(unit.rows[0]!.errors.join(" ")).toMatch(/unit cannot be changed/);
    const bad = await previewBulkChanges(prisma, ctx, [{ sku: "bad sku!" }, { sku: "COLA", description: "x".repeat(1001) }, { sku: "N", productName: "N" }]);
    expect(bad.rows.every((r) => r.action === "ERROR")).toBe(true);
  });

  it("limits the size of a batch and the room for error", async () => {
    const { ctx } = await world();
    await expect(previewBulkChanges(prisma, ctx, [])).rejects.toMatchObject({ code: "INVALID" });
    await expect(previewBulkChanges(prisma, ctx, Array.from({ length: 201 }, (_, i) => ({ sku: `S${i}` })))).rejects.toMatchObject({ code: "TOO_MANY" });
    await expect(applyBulkChanges(prisma, ctx, { batchId: "x", rows: [{ sku: "COLA" }] })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("two rows editing the same product's shared fields differently are refused", async () => {
    const { s, ctx } = await world();
    const sib = await s.scoped.productVariant.create({ data: { businessId: s.businessId, productId: s.product.id, sku: "COLA-2L", name: "2 L bottle", baseUnit: "bottle" } });
    void sib;
    const plan = await previewBulkChanges(prisma, ctx, [{ sku: "COLA", productName: "Cola Classic" }, { sku: "COLA-2L", productName: "Cola Original" }]);
    expect(plan.rows[0]!.warnings.join(" ")).toMatch(/shared with 1 other/);
    expect(plan.rows[1]!.errors.join(" ")).toMatch(/same product/);
  });
});

describe("who may do what", () => {
  it("a sales clerk cannot change anything; an inventory operator can price but not list; a manager can do both", async () => {
    const { s, ctx, batch } = await world();
    const clerk = await previewBulkChanges(prisma, { ...ctx, role: "SALES_CLERK" }, [{ sku: "COLA", retailPrice: "5" }]);
    expect(clerk.rows[0]!.errors.join(" ")).toMatch(/not allowed/);
    const op = await previewBulkChanges(prisma, { ...ctx, role: "INVENTORY_OPERATOR" }, [{ sku: "COLA", retailPrice: "5" }, { sku: "COLA", listed: false }]);
    expect(op.rows[0]!.action).toBe("UPDATE");
    const op2 = await previewBulkChanges(prisma, { ...ctx, role: "INVENTORY_OPERATOR" }, [{ sku: "COLA", listed: false }]);
    expect(op2.rows[0]!.errors.join(" ")).toMatch(/list or unlist/);
    const mgr = await applyBulkChanges(prisma, { ...ctx, role: "MANAGER" }, { batchId: batch(), rows: [{ sku: "COLA", retailPrice: "95", listed: true }] });
    expect(mgr.updated).toBe(1);
    void s;
  });
});

describe("CSV", () => {
  it("reads quotes, commas and line breaks inside quoted cells", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi""\nthere"\r\n\r\nlast,')).toEqual([["a", "b"], ["x, y", 'he said "hi"\nthere'], ["last", ""]]);
  });

  it("an export, read back unchanged, plans no changes; an edited file plans exactly the edits, with CLEAR removing a value", async () => {
    const { s, ctx, batch } = await world();
    await applyBulkChanges(prisma, ctx, { batchId: batch(), rows: [{ sku: "COLA", category: "Drinks", description: "Cold, fizzy" }] });
    const csv = catalogToCsv((await exportCatalog(s.scoped, ctx)).rows);
    expect(csv.split("\r\n")[0]).toBe('"sku","product","variant","unit","category","description","barcode","low_stock_alert","status","price","listed","rev"');
    const same = rowsFromCsv(csv);
    expect(same.errors).toEqual([]);
    expect((await previewBulkChanges(prisma, ctx, same.rows)).counts).toMatchObject({ update: 0, error: 0, noop: 1 });

    const edited = csv.replace('"100.00"', '"120"').replace('"Drinks"', '"CLEAR"');
    const rows = rowsFromCsv(edited).rows;
    const plan = await previewBulkChanges(prisma, ctx, rows);
    expect(plan.rows[0]!.changes).toEqual(expect.arrayContaining(["price: 100.00 -> 120.00 NGN", "category: Drinks -> none"]));
  });

  it("neutralises spreadsheet formulas on the way out and restores them on the way in; reports bad cells by line", async () => {
    const { s, ctx, batch } = await world();
    await applyBulkChanges(prisma, ctx, { batchId: batch(), rows: [{ sku: "COLA", description: "=HYPERLINK(\"http://evil\")" }] });
    const csv = catalogToCsv((await exportCatalog(s.scoped, ctx)).rows);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    const back = rowsFromCsv(csv).rows[0]!;
    expect(back.description).toBe('=HYPERLINK("http://evil")');
    const bad = rowsFromCsv("sku,low_stock_alert,status,listed\nA,abc,SOMETHING,maybe\n,,,\n");
    expect(bad.errors.join(" | ")).toMatch(/Line 2 \(A\): low_stock_alert/);
    expect(bad.errors.join(" | ")).toMatch(/status must be/);
    expect(bad.errors.join(" | ")).toMatch(/listed must be yes or no/);
    expect(bad.errors.join(" | ")).toMatch(/Line 3: no sku/);
    expect(rowsFromCsv("name,price\nx,1").errors[0]).toMatch(/must name the columns/);
  });
});
