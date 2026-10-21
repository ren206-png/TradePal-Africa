import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { isBusinessSuspended } from "./businessModeration.js";

/**
 * Product photos. The bytes live in our own database and are served from our own address: a seller-supplied link would tell a third party
 * who is shopping, and the page security headers refuse it anyway. We never decode an image on the server (no image library, so no decoder
 * bugs to exploit): we only check what the first bytes say it is, read its size from the header, and bound everything.
 *
 * Limits: 6 live photos per product, 400 KB each, 2000 px on the longest side. The phone page shrinks a photo to about 1000 px before
 * sending, so a normal upload is 60-200 KB and a shop page of 30 items stays light on a slow link.
 */
export const MAX_IMAGES_PER_PRODUCT = 6;
export const MAX_IMAGE_BYTES = 400 * 1024;
export const MAX_IMAGE_SIDE = 2000;
export const MIN_IMAGE_SIDE = 50;

export class ImageError extends Error {
  readonly code: "NOT_AN_IMAGE" | "TOO_BIG" | "TOO_LARGE_DIMENSIONS" | "TOO_SMALL" | "TOO_MANY" | "NOT_FOUND" | "ANIMATED";
  constructor(code: ImageError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type ImageType = "image/jpeg" | "image/png" | "image/webp";
export interface ImageInfo { contentType: ImageType; width: number; height: number }

/** What a file really is, from its first bytes and its header. Anything else (SVG, GIF, HTML pretending to be a picture) is refused. */
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length < 24) return null;
  // PNG: signature + IHDR
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.subarray(12, 16).toString("latin1") === "IHDR") {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (buf.includes(Buffer.from("acTL"))) return null; // animated PNG
    return { contentType: "image/png", width, height };
  }
  // JPEG: FFD8FF, then walk the segments to the first start-of-frame
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { contentType: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    const kind = buf.subarray(12, 16).toString("latin1");
    if (kind === "VP8 " && buf.length >= 30) return { contentType: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { contentType: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X" && buf.length >= 30) {
      if ((buf[20]! & 0x02) !== 0) return null; // animation flag
      return { contentType: "image/webp", width: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)), height: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) };
    }
  }
  return null;
}

export interface ImageSummary { id: string; position: number; contentType: string; bytes: number; width: number; height: number; url: string }
export const imageUrlOf = (id: string): string => `/shop-image/${id}`;

export async function listProductImages(scoped: TenantScopedClient, productId: string): Promise<ImageSummary[]> {
  const rows = await scoped.productImage.findMany({
    where: { productId, removedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, position: true, contentType: true, bytes: true, width: true, height: true },
  });
  return rows.map((r) => ({ ...r, url: imageUrlOf(r.id) }));
}

export async function addProductImage(scoped: TenantScopedClient, input: { businessId: string; productId: string; data: Buffer; createdBy?: string }): Promise<ImageSummary & { duplicate: boolean }> {
  if (input.data.length > MAX_IMAGE_BYTES) throw new ImageError("TOO_BIG", `That photo is ${Math.ceil(input.data.length / 1024)} KB. The limit is ${MAX_IMAGE_BYTES / 1024} KB; the phone page shrinks photos for you.`);
  const info = sniffImage(input.data);
  if (!info) throw new ImageError("NOT_AN_IMAGE", "Send a JPEG, PNG or WebP photo (not animated).");
  if (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE) throw new ImageError("TOO_LARGE_DIMENSIONS", `Photos can be at most ${MAX_IMAGE_SIDE} pixels on the longest side.`);
  if (info.width < MIN_IMAGE_SIDE || info.height < MIN_IMAGE_SIDE || info.width < 1 || info.height < 1) throw new ImageError("TOO_SMALL", `Photos must be at least ${MIN_IMAGE_SIDE} pixels on each side.`);
  const product = await scoped.product.findUnique({ where: { id: input.productId } });
  if (!product) throw new ImageError("NOT_FOUND", "Product not found.");
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const existing = await scoped.productImage.findFirst({ where: { productId: input.productId, sha256, removedAt: null } });
  if (existing) return { id: existing.id, position: existing.position, contentType: existing.contentType, bytes: existing.bytes, width: existing.width, height: existing.height, url: imageUrlOf(existing.id), duplicate: true };
  const live = await scoped.productImage.count({ where: { productId: input.productId, removedAt: null } });
  if (live >= MAX_IMAGES_PER_PRODUCT) throw new ImageError("TOO_MANY", `A product can have ${MAX_IMAGES_PER_PRODUCT} photos. Remove one first.`);
  const created = await scoped.productImage.create({
    data: { businessId: input.businessId, productId: input.productId, position: live, contentType: info.contentType, bytes: input.data.length, width: info.width, height: info.height, sha256, data: new Uint8Array(input.data), createdBy: input.createdBy ?? null },
  });
  return { id: created.id, position: created.position, contentType: created.contentType, bytes: created.bytes, width: created.width, height: created.height, url: imageUrlOf(created.id), duplicate: false };
}

/** Removes a photo: the row stays, the bytes go. The remaining photos close up so the first one is always the main picture. */
export async function removeProductImage(scoped: TenantScopedClient, imageId: string): Promise<void> {
  const img = await scoped.productImage.findFirst({ where: { id: imageId, removedAt: null } });
  if (!img) throw new ImageError("NOT_FOUND", "Photo not found.");
  const r = await scoped.productImage.updateMany({ where: { id: imageId, removedAt: null }, data: { removedAt: new Date(), data: new Uint8Array(0) } });
  if (r.count !== 1) throw new ImageError("NOT_FOUND", "Photo not found.");
  const rest = await listProductImages(scoped, img.productId);
  for (let i = 0; i < rest.length; i++) if (rest[i]!.position !== i) await scoped.productImage.update({ where: { id: rest[i]!.id }, data: { position: i } });
}

/** Makes one photo the main picture (position 0), keeping the others in their order. */
export async function makeMainImage(scoped: TenantScopedClient, imageId: string): Promise<void> {
  const img = await scoped.productImage.findFirst({ where: { id: imageId, removedAt: null } });
  if (!img) throw new ImageError("NOT_FOUND", "Photo not found.");
  const order = (await listProductImages(scoped, img.productId)).map((x) => x.id).filter((x) => x !== imageId);
  order.unshift(imageId);
  for (let i = 0; i < order.length; i++) await scoped.productImage.update({ where: { id: order[i]! }, data: { position: i } });
}

/** The main photo of each product, as the shop page needs it (one query for many products). */
export async function mainImageIds(scoped: TenantScopedClient, productIds: string[]): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await scoped.productImage.findMany({ where: { productId: { in: productIds }, removedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, productId: true } });
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.productId)) out.set(r.productId, r.id);
  return out;
}

/**
 * A photo as the PUBLIC may see it: only while the product is on sale on an open storefront (an ACTIVE, not-hidden listing of a
 * non-archived variant) and the business is not suspended. Anything else is the same "not found", so a photo of an unlisted or hidden
 * product cannot be probed by id.
 */
export async function loadPublicImage(prisma: PrismaClient, imageId: string): Promise<{ contentType: string; data: Buffer; sha256: string } | null> {
  if (!/^[0-9a-f-]{36}$/.test(imageId)) return null;
  const img = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!img || img.removedAt) return null;
  const listed = await prisma.listing.findFirst({ where: { businessId: img.businessId, channel: "STOREFRONT", status: "ACTIVE", moderation: "VISIBLE", variant: { productId: img.productId, status: { not: "ARCHIVED" } } }, select: { id: true } });
  if (!listed) return null;
  const sf = await prisma.storefront.findFirst({ where: { businessId: img.businessId, enabled: true }, select: { id: true } });
  if (!sf) return null;
  if (await isBusinessSuspended(prisma, img.businessId)) return null;
  return { contentType: img.contentType, data: Buffer.from(img.data), sha256: img.sha256 };
}
