import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller } from "./helpers/store.js";
import { fakeJpeg, fakePng, fakeWebp } from "./helpers/images.js";
import { ImageError, MAX_IMAGES_PER_PRODUCT, addProductImage, listProductImages, loadPublicImage, makeMainImage, removeProductImage, sniffImage } from "../src/domain/productImages.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { unlistVariant } from "../src/domain/store/storefront.js";

vi.setConfig({ testTimeout: 60_000 });
let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  app = express();
  app.use(createStorefrontRouter(prisma, {}));
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});
const seller = () => makeSeller(prisma, `Photo Shop ${++k}`, { slug: `photo-shop-${k}` });

describe("what counts as a photo", () => {
  it("reads the type and size from the header, and refuses everything else", () => {
    expect(sniffImage(fakePng(800, 600))).toEqual({ contentType: "image/png", width: 800, height: 600 });
    expect(sniffImage(fakeJpeg(1000, 750))).toEqual({ contentType: "image/jpeg", width: 1000, height: 750 });
    expect(sniffImage(fakeWebp(640, 480, "VP8X"))).toEqual({ contentType: "image/webp", width: 640, height: 480 });
    expect(sniffImage(fakeWebp(640, 480, "VP8 "))).toEqual({ contentType: "image/webp", width: 640, height: 480 });
    expect(sniffImage(fakeWebp(640, 480, "VP8L"))).toEqual({ contentType: "image/webp", width: 640, height: 480 });
    expect(sniffImage(fakePng(100, 100, { animated: true }))).toBeNull();
    expect(sniffImage(fakeWebp(100, 100, "VP8X", true))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a" + "x".repeat(60)))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from("<html><body>not a picture</body></html>" + " ".repeat(40)))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("storing photos", () => {
  it("stores a photo against the product, once per picture, up to the limit, with the first as the main picture", async () => {
    const s = await seller();
    const base = { businessId: s.businessId, productId: s.product.id };
    const a = await addProductImage(s.scoped, { ...base, data: fakeJpeg(900, 900, 1), createdBy: "m-1" });
    expect(a).toMatchObject({ position: 0, contentType: "image/jpeg", duplicate: false, url: `/shop-image/${a.id}` });
    const dup = await addProductImage(s.scoped, { ...base, data: fakeJpeg(900, 900, 1) });
    expect(dup).toMatchObject({ id: a.id, duplicate: true });
    for (let i = 2; i <= MAX_IMAGES_PER_PRODUCT; i++) await addProductImage(s.scoped, { ...base, data: fakeJpeg(900, 900, i) });
    await expect(addProductImage(s.scoped, { ...base, data: fakeJpeg(900, 900, 99) })).rejects.toMatchObject({ code: "TOO_MANY" });
    const all = await listProductImages(s.scoped, s.product.id);
    expect(all.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 5]);

    await makeMainImage(s.scoped, all[3]!.id);
    expect((await listProductImages(s.scoped, s.product.id))[0]!.id).toBe(all[3]!.id);

    await removeProductImage(s.scoped, all[3]!.id);
    const rest = await listProductImages(s.scoped, s.product.id);
    expect(rest).toHaveLength(5);
    expect(rest.map((x) => x.position)).toEqual([0, 1, 2, 3, 4]); // closed up
    const gone = await s.scoped.productImage.findUniqueOrThrow({ where: { id: all[3]!.id } });
    expect(gone.removedAt).not.toBeNull();
    expect(gone.data.length).toBe(0); // the bytes are gone, the row stays
    await expect(removeProductImage(s.scoped, all[3]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await addProductImage(s.scoped, { ...base, data: fakeJpeg(900, 900, 99) }); // room again
  });

  it("refuses what is not a photo, is too big, too large in pixels or too small, and another business's product", async () => {
    const s = await seller();
    const other = await seller();
    const base = { businessId: s.businessId, productId: s.product.id };
    await expect(addProductImage(s.scoped, { ...base, data: Buffer.from("hello".repeat(30)) })).rejects.toMatchObject({ code: "NOT_AN_IMAGE" });
    await expect(addProductImage(s.scoped, { ...base, data: Buffer.concat([fakeJpeg(900, 900), Buffer.alloc(400 * 1024)]) })).rejects.toMatchObject({ code: "TOO_BIG" });
    await expect(addProductImage(s.scoped, { ...base, data: fakePng(4000, 100) })).rejects.toMatchObject({ code: "TOO_LARGE_DIMENSIONS" });
    await expect(addProductImage(s.scoped, { ...base, data: fakePng(10, 10) })).rejects.toMatchObject({ code: "TOO_SMALL" });
    await expect(addProductImage(s.scoped, { businessId: s.businessId, productId: other.product.id, data: fakeJpeg(900, 900) })).rejects.toBeInstanceOf(ImageError);
    expect(await other.scoped.productImage.count({ where: {} })).toBe(0);
  });

  it("the database itself refuses to move, edit or delete a photo, or to keep a mislabelled one", async () => {
    const s = await seller();
    const img = await addProductImage(s.scoped, { businessId: s.businessId, productId: s.product.id, data: fakeJpeg(900, 900, 5) });
    await expect(testDb.db.query(`UPDATE "ProductImage" SET "sha256" = repeat('a', 64) WHERE id = '${img.id}'`)).rejects.toThrow(/cannot be moved or changed/);
    await expect(testDb.db.query(`UPDATE "ProductImage" SET "data" = '\\x00'::bytea WHERE id = '${img.id}'`)).rejects.toThrow();
    await expect(testDb.db.query(`DELETE FROM "ProductImage" WHERE id = '${img.id}'`)).rejects.toThrow();
    await expect(testDb.db.query(`UPDATE "ProductImage" SET "contentType" = 'image/svg+xml' WHERE id = '${img.id}'`)).rejects.toThrow();
  });
});

describe("what the public sees", () => {
  it("serves a photo only while its product is on sale in an open shop; the shop page shows it from our own address", async () => {
    const s = await seller();
    const img = await addProductImage(s.scoped, { businessId: s.businessId, productId: s.product.id, data: fakeJpeg(900, 900, 11) });
    const res = await request(app).get(img.url);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.body.length).toBeGreaterThan(50);
    const etag = res.headers["etag"]!;
    expect((await request(app).get(img.url).set("If-None-Match", etag)).status).toBe(304);

    const slug = (await prisma.storefront.findFirstOrThrow({ where: { businessId: s.businessId } })).slug;
    const page = await request(app).get(`/shop/${slug}`);
    expect(page.text).toContain(`<img src="${img.url}"`);
    expect(page.text).not.toMatch(/https?:\/\/[^"' ]*\.(jpg|png)/);

    await unlistVariant(prisma, s.businessId, s.variant.id);
    expect((await request(app).get(img.url)).status).toBe(404); // unlisted: gone at once
    expect(await loadPublicImage(prisma, img.id)).toBeNull();
  });

  it("answers 404 the same way for a made-up id, a removed photo, a hidden listing and a suspended business", async () => {
    const s = await seller();
    const img = await addProductImage(s.scoped, { businessId: s.businessId, productId: s.product.id, data: fakeJpeg(900, 900, 21) });
    expect((await request(app).get("/shop-image/not-an-id")).status).toBe(404);
    expect((await request(app).get("/shop-image/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await request(app).get(img.url)).status).toBe(200);
    await prisma.listing.updateMany({ where: { businessId: s.businessId }, data: { moderation: "UNPUBLISHED" } });
    expect((await request(app).get(img.url)).status).toBe(404);
    await prisma.listing.updateMany({ where: { businessId: s.businessId }, data: { moderation: "VISIBLE" } });
    await prisma.business.update({ where: { id: s.businessId }, data: { status: "SUSPENDED" } });
    expect((await request(app).get(img.url)).status).toBe(404);
    await prisma.business.update({ where: { id: s.businessId }, data: { status: "ACTIVE" } });
    await removeProductImage(s.scoped, img.id);
    expect((await request(app).get(img.url)).status).toBe(404);
  });

  it("never loads a link the seller typed in as a picture", async () => {
    const s = await seller();
    await s.scoped.product.update({ where: { id: s.product.id }, data: { imageUrls: ["https://tracker.example/pixel.png"] } });
    const slug = (await prisma.storefront.findFirstOrThrow({ where: { businessId: s.businessId } })).slug;
    expect((await request(app).get(`/shop/${slug}`)).text).not.toContain("tracker.example");
  });
});
