import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeBusiness, seedReference } from "./helpers/phase2.js";
import {
  CatalogError, addAlias, addPackConversion, adoptLegacyInventory, createProduct, createVariant, findVariantByText, listCatalog, toBaseQuantity,
} from "../src/domain/catalog.js";
import { PriceError, addPriceRule, createPriceList, resolvePrice, retirePriceRule } from "../src/domain/pricing.js";
import { allocateProportionally, divRoundHalfUp, percentOfBps } from "../src/domain/rounding.js";
import { postAdoptionOpening, getStockLevel } from "../src/domain/stock.js";

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

async function variantWithCarton(env: Awaited<ReturnType<typeof makeBusiness>>, sku = "COLA-330") {
  const product = await createProduct(env.scoped, { businessId: env.businessId, name: "Cola" });
  const variant = await createVariant(env.scoped, { businessId: env.businessId, productId: product.id, sku, name: "330 ml can", baseUnit: "Piece" });
  const carton = await addPackConversion(env.scoped, env.businessId, variant.id, "Carton", 24);
  return { product, variant, carton };
}

describe("rounding and allocation (invariant 4)", () => {
  it("rounds half away from zero, symmetrically", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(7n, 3n)).toBe(2n);
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
  });

  it("computes basis-point percentages exactly", () => {
    expect(percentOfBps(10_000n, 250)).toBe(250n); // 2.5%
    expect(percentOfBps(999n, 1000)).toBe(100n); // 99.9 -> 100
    expect(percentOfBps(5n, 5000)).toBe(3n); // 2.5 -> 3
    expect(() => percentOfBps(100n, 1.5)).toThrow(RangeError);
  });

  it("allocates a total across lines so the parts always add back exactly (largest remainder, ties to the earlier line)", () => {
    const parts = allocateProportionally(100n, [1n, 1n, 1n]);
    expect(parts).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
    for (const [total, weights] of [[1n, [3n, 3n, 3n]], [999n, [1n, 2n, 3n, 4n]], [7n, [0n, 5n, 0n]], [0n, [4n, 4n]]] as const) {
      const out = allocateProportionally(total, weights);
      expect(out.reduce((a, b) => a + b, 0n)).toBe(total);
      out.forEach((v, i) => { if (weights[i] === 0n) expect(v).toBe(0n); });
    }
    expect(() => allocateProportionally(10n, [0n, 0n])).toThrow(RangeError);
  });
});

describe("catalog: units and declared pack sizes (scenario 3)", () => {
  it("creates products and variants and refuses duplicates and bad input", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    expect(variant.baseUnit).toBe("piece"); // normalized
    const p2 = await createProduct(env.scoped, { businessId: env.businessId, name: "Fanta" });
    await expect(createVariant(env.scoped, { businessId: env.businessId, productId: p2.id, sku: "COLA-330", name: "x", baseUnit: "piece" })).rejects.toMatchObject({ code: "DUPLICATE_SKU" });
    await createVariant(env.scoped, { businessId: env.businessId, productId: p2.id, sku: "FAN-1", name: "x", baseUnit: "piece", barcode: "123" });
    await expect(createVariant(env.scoped, { businessId: env.businessId, productId: p2.id, sku: "FAN-2", name: "x", baseUnit: "piece", barcode: "123" })).rejects.toMatchObject({ code: "DUPLICATE_BARCODE" });
    await expect(createVariant(env.scoped, { businessId: env.businessId, productId: p2.id, sku: " ", name: "x", baseUnit: "piece" })).rejects.toBeInstanceOf(CatalogError);
    await expect(createProduct(env.scoped, { businessId: env.businessId, name: "  " })).rejects.toBeInstanceOf(CatalogError);
  });

  it("converts only through DECLARED packs; an undeclared unit is an error, not a guess", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    expect((await toBaseQuantity(env.scoped, variant.id, "carton", 3)).baseQuantity).toBe(72);
    expect((await toBaseQuantity(env.scoped, variant.id, "CARTON ", 1)).baseQuantity).toBe(24);
    expect((await toBaseQuantity(env.scoped, variant.id, "piece", 5)).baseQuantity).toBe(5);
    expect((await toBaseQuantity(env.scoped, variant.id, undefined, 5)).baseQuantity).toBe(5);
    await expect(toBaseQuantity(env.scoped, variant.id, "bag", 1)).rejects.toMatchObject({ code: "UNIT_NOT_DECLARED" });
    await expect(toBaseQuantity(env.scoped, variant.id, "carton", 0)).rejects.toMatchObject({ code: "INVALID" });
    await expect(toBaseQuantity(env.scoped, variant.id, "carton", 1.5)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("validates pack declarations", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    await expect(addPackConversion(env.scoped, env.businessId, variant.id, "Carton", 12)).rejects.toMatchObject({ code: "DUPLICATE_PACK" });
    await expect(addPackConversion(env.scoped, env.businessId, variant.id, "Pair", 1)).rejects.toMatchObject({ code: "INVALID" });
    await expect(addPackConversion(env.scoped, env.businessId, variant.id, "Half", 2.5)).rejects.toMatchObject({ code: "INVALID" });
    await expect(addPackConversion(env.scoped, env.businessId, variant.id, "piece", 6)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("the database also refuses a pack of fewer than 2 base units", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    await expect(
      testDb.db.query(`INSERT INTO "PackConversion" (id,"businessId","variantId",name,"normalizedName","baseQuantity") VALUES ('pc-x','${env.businessId}','${variant.id}','Solo','solo',1)`),
    ).rejects.toThrow(/PackConversion_baseQuantity_check|check constraint/);
  });

  it("aliases are unique per business and idempotent per variant; lookup finds SKU, barcode or alias", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    const other = await createVariant(env.scoped, {
      businessId: env.businessId, productId: (await createProduct(env.scoped, { businessId: env.businessId, name: "Sprite" })).id,
      sku: "SPR-1", name: "x", baseUnit: "piece", barcode: "999",
    });
    await addAlias(env.scoped, env.businessId, variant.id, "Coca Cola  can");
    await addAlias(env.scoped, env.businessId, variant.id, "coca cola can"); // same alias again: no-op
    await expect(addAlias(env.scoped, env.businessId, other.id, "COCA COLA CAN")).rejects.toMatchObject({ code: "DUPLICATE_ALIAS" });
    expect((await findVariantByText(env.scoped, "coca   cola can"))?.id).toBe(variant.id);
    expect((await findVariantByText(env.scoped, "SPR-1"))?.id).toBe(other.id);
    expect((await findVariantByText(env.scoped, "999"))?.id).toBe(other.id);
    expect(await findVariantByText(env.scoped, "nothing like it")).toBeNull();
  });

  it("is tenant-isolated: another business neither sees nor resolves these variants", async () => {
    const a = await makeBusiness(prisma);
    const b = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(a, "ISO-1");
    expect(await findVariantByText(b.scoped, "ISO-1")).toBeNull();
    expect((await listCatalog(b.scoped)).length).toBe(0);
    await expect(toBaseQuantity(b.scoped, variant.id, "piece", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // the same SKU may exist independently in another business
    await variantWithCarton(b, "ISO-1");
  });

  it("the catalog view never exposes cost", async () => {
    const env = await makeBusiness(prisma);
    await variantWithCarton(env);
    const view = await listCatalog(env.scoped);
    expect(JSON.stringify(view)).not.toMatch(/cost/i);
    expect(view[0]?.packs).toEqual([{ name: "Carton", baseQuantity: 24 }]);
  });
});

describe("price lists: wholesale minimums, quantity breaks, expiry (scenario 3)", () => {
  async function setup() {
    const env = await makeBusiness(prisma);
    const { variant, carton } = await variantWithCarton(env);
    const retail = await createPriceList(env.scoped, { businessId: env.businessId, name: "Retail", kind: "RETAIL", currencyCode: "NGN" });
    const wholesale = await createPriceList(env.scoped, { businessId: env.businessId, name: "Wholesale", kind: "WHOLESALE", currencyCode: "NGN" });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: retail.id, variantId: variant.id, unitPriceMinor: 10_000n });
    // wholesale: pieces from 24 at 95.00; cartons priced explicitly with a break at 5 cartons
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: wholesale.id, variantId: variant.id, unitPriceMinor: 9_500n, minQuantity: 24 });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: wholesale.id, variantId: variant.id, unit: "carton", unitPriceMinor: 220_000n, minQuantity: 1 });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: wholesale.id, variantId: variant.id, unit: "carton", unitPriceMinor: 210_000n, minQuantity: 5 });
    return { env, variant, carton, retail, wholesale };
  }

  it("prices exact line totals and stock-quantity conversions agree", async () => {
    const { env, variant, wholesale, retail } = await setup();
    const r = await resolvePrice(env.scoped, { priceListId: retail.id, variantId: variant.id, quantity: 3 });
    expect(r).toMatchObject({ unitPriceMinor: 10_000n, lineTotalMinor: 30_000n, baseQuantity: 3, unit: "piece", derivedFromBase: false });
    const three = await resolvePrice(env.scoped, { priceListId: wholesale.id, variantId: variant.id, quantity: 3, unit: "carton" });
    expect(three).toMatchObject({ unitPriceMinor: 220_000n, lineTotalMinor: 660_000n, baseQuantity: 72, breakMinQuantity: 1 });
    const five = await resolvePrice(env.scoped, { priceListId: wholesale.id, variantId: variant.id, quantity: 5, unit: "Carton" });
    expect(five).toMatchObject({ unitPriceMinor: 210_000n, lineTotalMinor: 1_050_000n, baseQuantity: 120, breakMinQuantity: 5 });
    expect((await toBaseQuantity(env.scoped, variant.id, "carton", 5)).baseQuantity).toBe(five.baseQuantity);
  });

  it("enforces the wholesale minimum deterministically", async () => {
    const { env, variant, wholesale } = await setup();
    const err = await resolvePrice(env.scoped, { priceListId: wholesale.id, variantId: variant.id, quantity: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(PriceError);
    expect(err).toMatchObject({ code: "BELOW_MINIMUM", minimumQuantity: 24 });
    const ok = await resolvePrice(env.scoped, { priceListId: wholesale.id, variantId: variant.id, quantity: 24 });
    expect(ok).toMatchObject({ unitPriceMinor: 9_500n, lineTotalMinor: 228_000n });
  });

  it("prices a pack from the base rule when it has none of its own, and flags it", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    const list = await createPriceList(env.scoped, { businessId: env.businessId, name: "W", kind: "WHOLESALE", currencyCode: "NGN" });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: 9_500n, minQuantity: 24 });
    const r = await resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 2, unit: "carton" });
    expect(r).toMatchObject({ unitPriceMinor: 228_000n, lineTotalMinor: 456_000n, derivedFromBase: true, baseQuantity: 48 });
  });

  it("never derives a base price from a pack price, and refuses an undeclared unit", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    const list = await createPriceList(env.scoped, { businessId: env.businessId, name: "Packs only", kind: "WHOLESALE", currencyCode: "NGN" });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unit: "carton", unitPriceMinor: 220_000n });
    await expect(resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 1 })).rejects.toMatchObject({ code: "NO_PRICE" });
    await expect(resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 1, unit: "bag" })).rejects.toMatchObject({ code: "UNIT_NOT_DECLARED" });
    await expect(addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unit: "bag", unitPriceMinor: 5n })).rejects.toMatchObject({ code: "UNIT_NOT_DECLARED" });
  });

  it("rejects expired, retired and inactive prices instead of falling back", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    const list = await createPriceList(env.scoped, { businessId: env.businessId, name: "Promo", kind: "RETAIL", currencyCode: "NGN" });
    const past = new Date(Date.now() - 86_400_000);
    const rule = await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: 5_000n, validFrom: new Date(past.getTime() - 86_400_000), validTo: past });
    await expect(resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 1 })).rejects.toMatchObject({ code: "EXPIRED" });
    // but a historical "at" inside the window resolves (the price that applied then)
    expect((await resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 1, at: new Date(past.getTime() - 3_600_000) })).unitPriceMinor).toBe(5_000n);

    const fresh = await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: 6_000n });
    expect((await resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 1 })).ruleId).toBe(fresh.id);
    await retirePriceRule(env.scoped, fresh.id);
    await expect(resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 1 })).rejects.toMatchObject({ code: "EXPIRED" });
    void rule;

    const dead = await createPriceList(env.scoped, { businessId: env.businessId, name: "Old", kind: "RETAIL", currencyCode: "NGN", validTo: past, validFrom: new Date(past.getTime() - 86_400_000) });
    await expect(resolvePrice(env.scoped, { priceListId: dead.id, variantId: variant.id, quantity: 1 })).rejects.toMatchObject({ code: "LIST_INACTIVE" });
  });

  it("refuses currency mismatches, bad quantities, and invalid rules", async () => {
    const { env, variant, retail } = await setup();
    await expect(resolvePrice(env.scoped, { priceListId: retail.id, variantId: variant.id, quantity: 1, currencyCode: "SLE" })).rejects.toMatchObject({ code: "CURRENCY_MISMATCH" });
    await expect(resolvePrice(env.scoped, { priceListId: retail.id, variantId: variant.id, quantity: 0 })).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(resolvePrice(env.scoped, { priceListId: retail.id, variantId: variant.id, quantity: 2.5 })).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(addPriceRule(env.scoped, { businessId: env.businessId, priceListId: retail.id, variantId: variant.id, unitPriceMinor: 0n })).rejects.toBeInstanceOf(PriceError);
    await expect(addPriceRule(env.scoped, { businessId: env.businessId, priceListId: retail.id, variantId: variant.id, unitPriceMinor: 5n, minQuantity: 0 })).rejects.toBeInstanceOf(PriceError);
    await expect(createPriceList(env.scoped, { businessId: env.businessId, name: "C", kind: "CUSTOMER", currencyCode: "NGN" })).rejects.toBeInstanceOf(PriceError);
    await expect(resolvePrice(env.scoped, { priceListId: "nope", variantId: variant.id, quantity: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("customer-specific lists are bound to one customer and chosen explicitly (no silent fallback to retail)", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    const customer = await env.scoped.customer.create({ data: { businessId: env.businessId, name: "Mama Put" } });
    const list = await createPriceList(env.scoped, { businessId: env.businessId, name: "Mama Put approved", kind: "CUSTOMER", currencyCode: "NGN", customerId: customer.id });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: 8_800n });
    expect((await resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 4 })).lineTotalMinor).toBe(35_200n);
  });

  it("breaks tie deterministically (higher minimum, then lower price)", async () => {
    const env = await makeBusiness(prisma);
    const { variant } = await variantWithCarton(env);
    const list = await createPriceList(env.scoped, { businessId: env.businessId, name: "T", kind: "RETAIL", currencyCode: "NGN" });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: 9_000n, minQuantity: 2 });
    await addPriceRule(env.scoped, { businessId: env.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: 8_000n, minQuantity: 2 });
    const r = await resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 2 });
    expect(r.unitPriceMinor).toBe(8_000n);
  });

  it("the database refuses a zero price or a backwards validity window", async () => {
    const { env, variant, retail } = await setup();
    await expect(
      testDb.db.query(`INSERT INTO "PriceRule" (id,"businessId","priceListId","variantId","minQuantity","unitPriceMinor") VALUES ('pr-x','${env.businessId}','${retail.id}','${variant.id}',1,0)`),
    ).rejects.toThrow(/check constraint|PriceRule_values_check/);
    await expect(
      testDb.db.query(`INSERT INTO "PriceRule" (id,"businessId","priceListId","variantId","minQuantity","unitPriceMinor","validFrom","validTo") VALUES ('pr-y','${env.businessId}','${retail.id}','${variant.id}',1,5,'2026-02-01','2026-01-01')`),
    ).rejects.toThrow(/check constraint|PriceRule_values_check/);
  });
});

describe("adopting the legacy inventory (no data fabricated)", () => {
  it("creates variants, labelled opening stock and retail prices, once", async () => {
    const env = await makeBusiness(prisma);
    const rice = await env.scoped.inventoryItem.create({ data: { businessId: env.businessId, name: "Rice", normalizedName: "rice", unit: "Bag", estimatedStockQty: 12, priceMinor: 500_000n } });
    await env.scoped.inventoryItem.create({ data: { businessId: env.businessId, name: "Salt", normalizedName: "salt", estimatedStockQty: 0 } });
    const input = { businessId: env.businessId, shopId: env.shopId, currencyCode: "NGN" };
    const post = (variant: { id: string }, item: Parameters<typeof postAdoptionOpening>[1]["item"]) =>
      postAdoptionOpening(env.scoped, { businessId: env.businessId, shopId: env.shopId, variantId: variant.id, item });

    const first = await adoptLegacyInventory(env.scoped, input, post);
    expect(first).toMatchObject({ adopted: 2, alreadyAdopted: 0, openingMovements: 1, priceRules: 1 });
    const variant = await env.scoped.productVariant.findFirstOrThrow({ where: { inventoryItemId: rice.id } });
    expect(variant).toMatchObject({ baseUnit: "bag", status: "DRAFT" });
    const level = await getStockLevel(env.scoped, env.shopId, variant.id);
    expect(level.onHand).toBe(12);
    expect(level.avgCostMinor).toBeNull(); // no cost invented
    expect(level.uncostedQty).toBe(12);
    const movement = await env.scoped.stockMovement.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(movement).toMatchObject({ kind: "OPENING_BALANCE", provenance: "MIGRATED_OPENING" });
    const list = await env.scoped.priceList.findFirstOrThrow({ where: { kind: "RETAIL" } });
    expect((await resolvePrice(env.scoped, { priceListId: list.id, variantId: variant.id, quantity: 2 })).lineTotalMinor).toBe(1_000_000n);

    const second = await adoptLegacyInventory(env.scoped, input, post);
    expect(second).toMatchObject({ adopted: 0, alreadyAdopted: 2, openingMovements: 0, priceRules: 0 });
    expect(await env.scoped.stockMovement.count({ where: {} })).toBe(1);
  });
});
