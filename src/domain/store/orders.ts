import { timingSafeEqual } from "node:crypto";
import type { Basket, BasketLine, Prisma, PrismaClient, StoreFulfilment, StoreOrder, StoreOrderLine, StorePaymentMethod, TradePaymentMethod } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../../db/tenantScope.js";
import { recordAuditLog } from "../auditLog.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { PriceError, resolvePrice } from "../pricing.js";
import { ensureDefaultShopFor } from "../shops.js";
import { StockError, fulfilReservation, releaseReservation, reserveStock, reverseStockMovement } from "../stock.js";
import { loadBasket } from "./basket.js";
import {
  FLAG_ONLINE_PAYMENT, StoreError, isUniqueViolation, loadPublicStorefrontById, newPickupCode, newToken, nextStoreReference, sha256, simulatedPaymentsAllowed, toE164,
} from "./common.js";
import { journalStoreHandover, journalStorePaymentIn } from "./journal.js";
import { retailListOf } from "./storefront.js";

/**
 * Store orders (expansion Phase 4). One order per seller; stock is HELD (reserved) when the order is placed and leaves when the
 * goods leave (collection for pickup, dispatch for delivery); revenue is recognised at hand-over. The status machine:
 *
 *   PLACED -> CONFIRMED -> READY (pickup) -> COMPLETED
 *                      \-> OUT_FOR_DELIVERY (delivery) -> COMPLETED
 *   PLACED/CONFIRMED/READY -> CANCELLED (buyer or seller) | EXPIRED (hold lapsed)    OUT_FOR_DELIVERY -> CANCELLED (delivery failed)
 *   EXPIRED -> CONFIRMED only through a resolved late-payment exception (see exceptions.ts)
 *
 * Payment is a separate state (paidMinor, refundedMinor). Cancellation and refund rules live in ONE place below (the
 * `*Policy` functions) and are used by the web pages, the commands and the backend alike, so they cannot disagree.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ACCESS_DAYS = 90;
const AFTER_COMPLETION_ACCESS_DAYS = 30;

export type StoreOrderFull = StoreOrder & { lines: StoreOrderLine[] };

export async function loadStoreOrder(scoped: TenantScopedClient, orderId: string): Promise<StoreOrderFull> {
  const order = await scoped.storeOrder.findUnique({ where: { id: orderId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!order) throw new StoreError("NOT_FOUND", "Order not found.");
  return order;
}

// ----------------------------------------------------------------------------------- policies

export type CancellationMode = "IMMEDIATE" | "REQUEST" | "NONE";

/** What a BUYER may do about cancelling, by status. */
export function cancellationPolicy(order: Pick<StoreOrder, "status" | "fulfilment">): { mode: CancellationMode; message: string } {
  switch (order.status) {
    case "PLACED": return { mode: "IMMEDIATE", message: "You can cancel now: nothing has been prepared yet." };
    case "CONFIRMED": return { mode: "REQUEST", message: "The seller has confirmed this order. You can ask to cancel; the seller decides." };
    case "READY": return { mode: "NONE", message: "This order is ready. Contact the seller if you cannot collect it." };
    case "OUT_FOR_DELIVERY": return { mode: "NONE", message: "This order is on its way. Contact the seller if there is a problem." };
    default: return { mode: "NONE", message: "This order can no longer be cancelled." };
  }
}

/**
 * Refunds and returns: only after hand-over, and only within the seller's own return window. A seller with no window accepts
 * no returns by default (shoppers can still report a problem). A refund REQUEST is not a refund.
 */
export function refundPolicy(order: Pick<StoreOrder, "status" | "completedAt">, returnWindowDays: number | null, now: Date): { allowed: boolean; message: string; closesAt: Date | null } {
  if (order.status !== "COMPLETED" || !order.completedAt) return { allowed: false, message: "A return or refund can be requested after you have received the order.", closesAt: null };
  if (returnWindowDays === null) return { allowed: false, message: "This seller does not accept returns by default. You can report a problem instead.", closesAt: null };
  const closesAt = new Date(order.completedAt.getTime() + returnWindowDays * DAY);
  return now <= closesAt ? { allowed: true, message: `You can ask for a return or refund until ${closesAt.toISOString().slice(0, 10)}.`, closesAt } : { allowed: false, message: "The return window for this order has closed. You can report a problem instead.", closesAt };
}

// ------------------------------------------------------------------------------------ checkout

export interface BuyerInput {
  name: string;
  phone: string;
  note?: string;
  contactConsent: boolean;
}

export interface SellerCheckoutInput {
  businessId: string;
  fulfilment: StoreFulfilment;
  zoneId?: string;
  address?: { line?: string; landmark?: string; area?: string; latitude?: number; longitude?: number };
  paymentMethod: StorePaymentMethod;
}

export type CheckoutOutcome =
  | { businessId: string; ok: true; order: StoreOrderFull; accessToken: string }
  | { businessId: string; ok: false; error: string; code: string };

export interface CheckoutResult {
  outcomes: CheckoutOutcome[];
  /** A fresh basket token when lines were left over (a seller not submitted, or one that failed); the shopper's cookie must follow it. */
  nextBasketToken: string | null;
  alreadyPlaced: boolean;
}

async function placeForSeller(
  prisma: PrismaClient,
  args: { basket: Basket; businessId: string; lines: BasketLine[]; buyer: BuyerInput; input: SellerCheckoutInput; allowOnline: boolean; now: Date },
): Promise<{ order: StoreOrderFull; accessToken: string }> {
  const { basket, businessId, lines, buyer, input, now } = args;
  const sf = await loadPublicStorefrontById(prisma, businessId);
  if (!sf) throw new StoreError("UNAVAILABLE", "This shop is not open right now.");
  if (input.fulfilment === "PICKUP" && !sf.pickupEnabled) throw new StoreError("INVALID", "This seller does not offer pickup.");
  if (input.fulfilment === "DELIVERY" && !sf.deliveryEnabled) throw new StoreError("INVALID", "This seller does not offer delivery.");
  const scoped = getTenantScopedClient(prisma, businessId);

  if (input.paymentMethod === "ONLINE_SIMULATED") {
    if (!args.allowOnline || !simulatedPaymentsAllowed() || !(await isFeatureEnabled(scoped, businessId, FLAG_ONLINE_PAYMENT))) {
      throw new StoreError("SIMULATOR_FORBIDDEN", "Online payment is not available. Choose to pay when you collect or receive your order.");
    }
  }
  const phone = toE164(buyer.phone, sf.business.country.callingCode);
  if (!phone) throw new StoreError("INVALID", "Enter a phone number the seller can reach you on.");
  const name = buyer.name.trim();
  if (name.length < 2 || name.length > 80) throw new StoreError("INVALID", "Enter your name.");

  let zone = null as Awaited<ReturnType<typeof scoped.deliveryZone.findFirst>>;
  if (input.fulfilment === "DELIVERY") {
    zone = input.zoneId ? await scoped.deliveryZone.findFirst({ where: { id: input.zoneId, active: true } }) : null;
    if (!zone) throw new StoreError("INVALID", "Choose one of the delivery areas.");
    if (!input.address?.landmark?.trim() && !input.address?.line?.trim()) throw new StoreError("INVALID", "Tell the seller where to deliver: a landmark or address.");
  }

  const list = await retailListOf(scoped);
  if (!list) throw new StoreError("UNAVAILABLE", "This seller has no prices set.");
  const built: { variantId: string; sku: string; description: string; unit: string; packBase: number; quantity: number; baseQuantity: number; unitPrice: bigint; total: bigint; track: boolean }[] = [];
  for (const l of lines) {
    const variant = await scoped.productVariant.findUnique({ where: { id: l.variantId }, include: { product: true } });
    const listing = await scoped.listing.findFirst({ where: { variantId: l.variantId, channel: "STOREFRONT", status: "ACTIVE" } });
    if (!variant || !listing || variant.status === "ARCHIVED") throw new StoreError("UNAVAILABLE", "An item in your basket is no longer available.");
    try {
      const r = await resolvePrice(scoped, { priceListId: list.id, variantId: l.variantId, quantity: l.quantity, unit: l.unit, at: now });
      built.push({
        variantId: variant.id, sku: variant.sku, description: `${variant.product.name}${variant.name && variant.name !== variant.product.name ? ` ${variant.name}` : ""}`, unit: r.unit,
        packBase: r.baseQuantity / r.quantity, quantity: r.quantity, baseQuantity: r.baseQuantity, unitPrice: r.unitPriceMinor, total: r.lineTotalMinor, track: variant.trackStock,
      });
    } catch (error) {
      if (error instanceof PriceError) throw new StoreError("INVALID", `${variant.product.name}: ${error.message}`);
      throw error;
    }
  }
  const subtotal = built.reduce((n, b) => n + b.total, 0n);
  if (zone?.minOrderMinor && subtotal < zone.minOrderMinor) throw new StoreError("INVALID", `The minimum order for ${zone.name} is ${zone.minOrderMinor} (minor units).`);
  const fee = zone?.feeMinor ?? 0n;
  const holdMs = input.paymentMethod === "ONLINE_SIMULATED" ? sf.reservationMinutes * 60_000 : sf.pickupHoldHours * HOUR;
  const reservedUntil = new Date(now.getTime() + holdMs);
  const accessToken = newToken();
  const terms: Prisma.InputJsonValue = {
    seller: { name: sf.title, supportPhone: sf.supportPhone, slug: sf.slug }, fulfilment: input.fulfilment, paymentMethod: input.paymentMethod, currencyCode: sf.business.currencyCode,
    ...(input.fulfilment === "PICKUP" ? { pickup: { location: sf.pickupLocation, instructions: sf.pickupInstructions, holdHours: sf.pickupHoldHours } } : { delivery: { zone: zone!.name, feeMinor: fee.toString() } }),
    returnWindowDays: sf.returnWindowDays, termsText: sf.termsText, placedAt: now.toISOString(),
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await withScopedTransaction(scoped, async (tx) => {
        const reference = await nextStoreReference(tx);
        const order = await tx.storeOrder.create({
          data: {
            businessId, reference, basketId: basket.id, fulfilment: input.fulfilment, paymentMethod: input.paymentMethod, buyerName: name, buyerPhone: phone, contactConsent: buyer.contactConsent,
            buyerNote: buyer.note?.trim().slice(0, 500) || null, addressLine: input.address?.line?.trim().slice(0, 200) || null, landmark: input.address?.landmark?.trim().slice(0, 200) || null,
            area: input.address?.area?.trim().slice(0, 100) || null, latitude: input.address?.latitude ?? null, longitude: input.address?.longitude ?? null,
            deliveryZoneId: zone?.id ?? null, deliveryZoneName: zone?.name ?? null, deliveryFeeMinor: fee, subtotalMinor: subtotal, totalMinor: subtotal + fee, currencyCode: sf.business.currencyCode,
            accessTokenHash: sha256(accessToken), accessExpiresAt: new Date(now.getTime() + ACCESS_DAYS * DAY), pickupCode: newPickupCode(), reservedUntil, terms, placedAt: now,
            lines: { create: built.map((b, i) => ({ businessId, lineNo: i + 1, variantId: b.variantId, sku: b.sku, description: b.description, unit: b.unit, packBaseQuantity: b.packBase, quantity: b.quantity, baseQuantity: b.baseQuantity, unitPriceMinor: b.unitPrice, lineTotalMinor: b.total })) },
          },
          include: { lines: { orderBy: { lineNo: "asc" } } },
        });
        const shop = await ensureDefaultShopFor(tx, businessId);
        for (let i = 0; i < built.length; i++) {
          if (!built[i]!.track) continue;
          try {
            const r = await reserveStock(tx, { businessId, shopId: shop.id, variantId: built[i]!.variantId, quantity: built[i]!.baseQuantity, reference: `store:${order.id}`, idempotencyKey: `store:${order.id}:${i + 1}`, expiresAt: reservedUntil, now });
            await tx.storeOrderLine.update({ where: { id: order.lines[i]!.id }, data: { reservationId: r.reservation.id } });
          } catch (error) {
            if (error instanceof StockError && error.code === "INSUFFICIENT_STOCK") throw new StoreError("UNAVAILABLE", `${built[i]!.description}: not enough in stock (${error.available ?? 0} left).`);
            throw error;
          }
        }
        return { order: await loadStoreOrder(tx, order.id), accessToken };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new StoreError("DUPLICATE", "Could not place the order; try again.");
}

/**
 * Turns the basket into independent per-seller orders. Each seller's order succeeds or fails on its own (stock, minimums,
 * closed shop); nothing is pooled. The basket is claimed first (so a double submit cannot place twice); anything not placed
 * moves to a fresh basket so nothing the shopper chose is lost.
 */
export async function checkoutBasket(
  prisma: PrismaClient,
  input: { basketToken: string; buyer: BuyerInput; sellers: SellerCheckoutInput[]; allowOnline?: boolean; now?: Date },
): Promise<CheckoutResult> {
  const now = input.now ?? new Date();
  const basket = await loadBasket(prisma, input.basketToken, now);
  if (!basket) {
    const already = await prisma.basket.findUnique({ where: { tokenHash: sha256(input.basketToken) } });
    if (already?.status === "CHECKED_OUT") return { outcomes: [], nextBasketToken: null, alreadyPlaced: true };
    throw new StoreError("NOT_FOUND", "Your basket has expired. Please add your items again.");
  }
  const lines = await prisma.basketLine.findMany({ where: { basketId: basket.id }, orderBy: { addedAt: "asc" } });
  if (lines.length === 0) throw new StoreError("INVALID", "Your basket is empty.");
  const claimed = await prisma.basket.updateMany({ where: { id: basket.id, status: "OPEN" }, data: { status: "CHECKED_OUT" } });
  if (claimed.count !== 1) return { outcomes: [], nextBasketToken: null, alreadyPlaced: true };

  const outcomes: CheckoutOutcome[] = [];
  const leftover: BasketLine[] = [];
  const bySeller = new Map<string, BasketLine[]>();
  for (const l of lines) bySeller.set(l.sellerBusinessId, [...(bySeller.get(l.sellerBusinessId) ?? []), l]);
  for (const [businessId, ls] of bySeller) {
    const sellerInput = input.sellers.find((s) => s.businessId === businessId);
    if (!sellerInput) {
      leftover.push(...ls);
      continue;
    }
    try {
      const placed = await placeForSeller(prisma, { basket, businessId, lines: ls, buyer: input.buyer, input: sellerInput, allowOnline: input.allowOnline ?? false, now });
      outcomes.push({ businessId, ok: true, order: placed.order, accessToken: placed.accessToken });
    } catch (error) {
      if (!(error instanceof StoreError)) {
        await restoreBasket(prisma, basket.id);
        throw error;
      }
      outcomes.push({ businessId, ok: false, error: error.message, code: error.code });
      leftover.push(...ls);
    }
  }
  let nextBasketToken: string | null = null;
  if (leftover.length > 0) {
    const token = newToken();
    const fresh = await prisma.basket.create({ data: { tokenHash: sha256(token), expiresAt: new Date(now.getTime() + 7 * DAY) } });
    await prisma.basketLine.createMany({ data: leftover.map((l) => ({ basketId: fresh.id, sellerBusinessId: l.sellerBusinessId, variantId: l.variantId, unit: l.unit, quantity: l.quantity })) });
    nextBasketToken = token;
  }
  return { outcomes, nextBasketToken, alreadyPlaced: false };
}

async function restoreBasket(prisma: PrismaClient, basketId: string): Promise<void> {
  const placed = await prisma.storeOrder.count({ where: { basketId } });
  if (placed === 0) await prisma.basket.update({ where: { id: basketId }, data: { status: "OPEN" } }).catch(() => undefined);
}

// -------------------------------------------------------------------------------- token access

/** The order a secret link points at, if the link is genuine and has not expired. */
export async function resolveOrderByToken(prisma: PrismaClient, token: string, now: Date = new Date()): Promise<{ businessId: string; orderId: string } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const order = await prisma.storeOrder.findUnique({ where: { accessTokenHash: sha256(token) }, select: { id: true, businessId: true, accessExpiresAt: true } });
  if (!order || order.accessExpiresAt <= now) return null;
  return { businessId: order.businessId, orderId: order.id };
}

/** Orders that came from the shopper's own basket (the cookie is the credential). */
export async function ordersForBasket(prisma: PrismaClient, basketToken: string): Promise<{ businessId: string; orderId: string; reference: string }[]> {
  if (!basketToken || basketToken.length < 20) return [];
  const basket = await prisma.basket.findUnique({ where: { tokenHash: sha256(basketToken) } });
  if (!basket) return [];
  const orders = await prisma.storeOrder.findMany({ where: { basketId: basket.id }, select: { id: true, businessId: true, reference: true }, orderBy: { createdAt: "asc" } });
  return orders.map((o) => ({ businessId: o.businessId, orderId: o.id, reference: o.reference }));
}

// ------------------------------------------------------------------------------ stock helpers

async function releaseOrderStock(tx: TenantScopedClient, order: StoreOrderFull, now: Date): Promise<void> {
  for (const l of order.lines) if (l.reservationId) await releaseReservation(tx, l.reservationId, now);
}

/** The goods leave: each tracked line's held stock is fulfilled. If a hold lapsed meanwhile, it is re-taken (or the hand-over is refused). */
async function fulfilOrderStock(tx: TenantScopedClient, order: StoreOrderFull, now: Date, actor?: string): Promise<void> {
  const shop = await ensureDefaultShopFor(tx, order.businessId);
  for (const l of order.lines) {
    if (!l.reservationId) continue;
    const common = { currencyCode: order.currencyCode, sourceType: "STORE_ORDER", sourceId: order.id, now, ...(actor ? { actor: { type: "MERCHANT" as const, id: actor } } : {}) };
    let movementId: string;
    try {
      movementId = (await fulfilReservation(tx, l.reservationId, common)).movement.id;
    } catch (error) {
      if (!(error instanceof StockError) || error.code !== "RESERVATION_CLOSED") throw error;
      try {
        const r = await reserveStock(tx, { businessId: order.businessId, shopId: shop.id, variantId: l.variantId, quantity: l.baseQuantity, reference: `store:${order.id}`, idempotencyKey: `store:${order.id}:${l.lineNo}:retake:${now.getTime()}`, expiresAt: new Date(now.getTime() + HOUR), now });
        movementId = (await fulfilReservation(tx, r.reservation.id, common)).movement.id;
      } catch (inner) {
        if (inner instanceof StockError && inner.code === "INSUFFICIENT_STOCK") throw new StoreError("UNAVAILABLE", `${l.description}: the stock held for this order has been released and there is not enough left.`);
        throw inner;
      }
    }
    await tx.storeOrderLine.update({ where: { id: l.id }, data: { fulfilMovementId: movementId } });
  }
}

const extendAccess = (now: Date, extraDays: number) => new Date(now.getTime() + extraDays * DAY);

// --------------------------------------------------------------------------- seller lifecycle

type Actor = { actor?: string; now?: Date };

async function transition(
  prisma: PrismaClient,
  businessId: string,
  orderId: string,
  from: StoreOrder["status"][],
  work: (tx: TenantScopedClient, order: StoreOrderFull) => Promise<Prisma.StoreOrderUpdateInput>,
): Promise<StoreOrderFull> {
  const scoped = getTenantScopedClient(prisma, businessId);
  return withScopedTransaction(scoped, async (tx) => {
    const order = await loadStoreOrder(tx, orderId);
    if (!from.includes(order.status)) throw new StoreError("WRONG_STATE", `This order is ${order.status.toLowerCase().replace(/_/g, " ")}; that action is not available.`);
    const data = await work(tx, order);
    const claimed = await tx.storeOrder.updateMany({ where: { id: order.id, status: order.status }, data: data as Prisma.StoreOrderUncheckedUpdateManyInput });
    if (claimed.count !== 1) throw new StoreError("WRONG_STATE", "The order was just changed by someone else.");
    return loadStoreOrder(tx, order.id);
  });
}

/** The seller accepts the order. Extends the stock hold; an online order must already be paid in full. */
export async function confirmStoreOrder(prisma: PrismaClient, input: { businessId: string; orderId: string } & Actor): Promise<StoreOrderFull> {
  const now = input.now ?? new Date();
  const sf = await prisma.storefront.findFirstOrThrow({ where: { businessId: input.businessId } });
  return transition(prisma, input.businessId, input.orderId, ["PLACED"], async (tx, order) => {
    if (order.paymentMethod === "ONLINE_SIMULATED" && order.paidMinor < order.totalMinor) throw new StoreError("PAYMENT_REQUIRED", "This order is waiting for the online payment.");
    const until = new Date(now.getTime() + sf.pickupHoldHours * HOUR);
    const { extendReservation } = await import("../stock.js");
    for (const l of order.lines) if (l.reservationId) await extendReservation(tx, l.reservationId, until);
    return { status: "CONFIRMED", confirmedAt: now, reservedUntil: until };
  });
}

export async function markStoreOrderReady(prisma: PrismaClient, input: { businessId: string; orderId: string } & Actor): Promise<StoreOrderFull> {
  const now = input.now ?? new Date();
  return transition(prisma, input.businessId, input.orderId, ["CONFIRMED"], async (_tx, order) => {
    if (order.fulfilment !== "PICKUP") throw new StoreError("WRONG_STATE", "Only a pickup order can be marked ready; dispatch a delivery order instead.");
    return { status: "READY", readyAt: now };
  });
}

/** A delivery order leaves: stock leaves with it. There is no courier integration, so the reference is whatever the seller records. */
export async function dispatchStoreOrder(prisma: PrismaClient, input: { businessId: string; orderId: string; deliveryRef?: string; carrier?: string } & Actor): Promise<StoreOrderFull> {
  const now = input.now ?? new Date();
  return transition(prisma, input.businessId, input.orderId, ["CONFIRMED"], async (tx, order) => {
    if (order.fulfilment !== "DELIVERY") throw new StoreError("WRONG_STATE", "Only a delivery order can be dispatched.");
    await fulfilOrderStock(tx, order, now, input.actor);
    return { status: "OUT_FOR_DELIVERY", dispatchedAt: now, deliveryRef: input.deliveryRef?.trim().slice(0, 100) ?? null, carrier: input.carrier?.trim().slice(0, 100) ?? null };
  });
}

function codeMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Hand-over. Pickup: stock leaves now, and the buyer's pickup code is required. Delivery: the goods already left at dispatch;
 * the code proves delivery unless the seller states a reason for completing without it (audited). A pay-on-collection order
 * must be paid in full here (the money is booked as an advance, then revenue is recognised). Nothing is recognised as revenue
 * before this point.
 */
export async function completeStoreOrder(
  prisma: PrismaClient,
  input: { businessId: string; orderId: string; code?: string; withoutCodeReason?: string; collect?: { method: TradePaymentMethod; amountMinor?: bigint } } & Actor,
): Promise<StoreOrderFull> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  return transition(prisma, input.businessId, input.orderId, ["READY", "CONFIRMED", "OUT_FOR_DELIVERY"], async (tx, order) => {
    if (order.fulfilment === "PICKUP" && order.status === "OUT_FOR_DELIVERY") throw new StoreError("WRONG_STATE", "Invalid state.");
    if (order.fulfilment === "DELIVERY" && order.status !== "OUT_FOR_DELIVERY") throw new StoreError("WRONG_STATE", "Dispatch a delivery order before completing it.");
    if (!(input.code && codeMatches(order.pickupCode, input.code))) {
      if (!input.withoutCodeReason?.trim() || order.fulfilment === "PICKUP") throw new StoreError("BAD_CODE", "The code does not match. Ask the buyer for the 6-digit code on their order page.");
      await recordAuditLog(tx, { businessId: input.businessId, actorType: "MERCHANT", ...(input.actor ? { actorId: input.actor } : {}), action: "store.order.completed_without_code", entityType: "StoreOrder", entityId: order.id, metadata: { reason: input.withoutCodeReason.trim() } });
    }
    let paid = order.paidMinor;
    const remaining = order.totalMinor - paid;
    if (remaining > 0n) {
      const amount = input.collect?.amountMinor ?? remaining;
      if (order.paymentMethod !== "PAY_ON_COLLECTION" || !input.collect) throw new StoreError("PAYMENT_REQUIRED", "This order is not fully paid.");
      if (amount !== remaining) throw new StoreError("PAYMENT_REQUIRED", "Collect the full amount outstanding before handing the order over.");
      const { insertCollectedPayment } = await import("./payments.js");
      await insertCollectedPayment(tx, { order, amountMinor: amount, method: input.collect.method, now, ...(input.actor ? { actor: input.actor } : {}) });
      paid += amount;
    }
    if (order.fulfilment === "PICKUP") await fulfilOrderStock(tx, order, now, input.actor);
    await journalStoreHandover(tx, { ...order, paidMinor: paid }, now);
    return { status: "COMPLETED", completedAt: now, paidMinor: paid, accessExpiresAt: extendAccess(now, AFTER_COMPLETION_ACCESS_DAYS + Math.max(0, (await returnWindow(scoped)) ?? 0)) };
  });
}

async function returnWindow(scoped: TenantScopedClient): Promise<number | null> {
  return (await scoped.storefront.findFirst({ where: {} }))?.returnWindowDays ?? null;
}

type Canceller = "BUYER" | "SELLER" | "SYSTEM";

async function cancelInternal(prisma: PrismaClient, input: { businessId: string; orderId: string; by: Canceller; reason?: string; from: StoreOrder["status"][]; restock?: boolean } & Actor): Promise<StoreOrderFull> {
  const now = input.now ?? new Date();
  return transition(prisma, input.businessId, input.orderId, input.from, async (tx, order) => {
    if (input.restock) {
      for (const l of order.lines) if (l.fulfilMovementId) await reverseStockMovement(tx, l.fulfilMovementId, input.actor ? { type: "MERCHANT", id: input.actor } : undefined, "Delivery failed: goods returned to stock");
    } else {
      await releaseOrderStock(tx, order, now);
    }
    return { status: "CANCELLED", cancelledAt: now, cancelledBy: input.by, cancelReason: input.reason?.trim().slice(0, 300) ?? null };
  });
}

/** The seller cancels or declines. Held stock is released; money already paid is now owed back (see refunds.ts). */
export async function cancelStoreOrderBySeller(prisma: PrismaClient, input: { businessId: string; orderId: string; reason: string } & Actor): Promise<StoreOrderFull> {
  if (!input.reason.trim()) throw new StoreError("INVALID", "Give the buyer a reason.");
  return cancelInternal(prisma, { ...input, by: "SELLER", from: ["PLACED", "CONFIRMED", "READY"] });
}

export async function markDeliveryFailed(prisma: PrismaClient, input: { businessId: string; orderId: string; reason: string } & Actor): Promise<StoreOrderFull> {
  if (!input.reason.trim()) throw new StoreError("INVALID", "Say what happened.");
  return cancelInternal(prisma, { ...input, by: "SELLER", from: ["OUT_FOR_DELIVERY"], restock: true });
}

/**
 * The buyer cancels. Before the seller confirms it is immediate; after confirmation it becomes a REQUEST the seller decides;
 * from ready onward it is not available. Same rule everywhere (see cancellationPolicy).
 */
export async function cancelStoreOrderByBuyer(prisma: PrismaClient, input: { businessId: string; orderId: string; reason?: string; now?: Date }): Promise<{ outcome: "CANCELLED" | "REQUESTED"; order: StoreOrderFull }> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const order = await loadStoreOrder(scoped, input.orderId);
  const policy = cancellationPolicy(order);
  if (policy.mode === "NONE") throw new StoreError("NOT_ALLOWED", policy.message);
  if (policy.mode === "IMMEDIATE") {
    const cancelled = await cancelInternal(prisma, { businessId: input.businessId, orderId: input.orderId, by: "BUYER", ...(input.reason ? { reason: input.reason } : {}), from: ["PLACED"], ...(input.now ? { now: input.now } : {}) });
    return { outcome: "CANCELLED", order: cancelled };
  }
  const reason = input.reason?.trim();
  if (!reason) throw new StoreError("INVALID", "Tell the seller why you want to cancel.");
  if (await scoped.storeCancellationRequest.findFirst({ where: { orderId: order.id, status: "REQUESTED" } })) throw new StoreError("DUPLICATE", "You have already asked to cancel; the seller will answer.");
  await scoped.storeCancellationRequest.create({ data: { businessId: input.businessId, orderId: order.id, reason: reason.slice(0, 300) } });
  return { outcome: "REQUESTED", order };
}

export async function decideCancellationRequest(prisma: PrismaClient, input: { businessId: string; requestId: string; approve: boolean } & Actor): Promise<void> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const req = await scoped.storeCancellationRequest.findUnique({ where: { id: input.requestId } });
  if (!req) throw new StoreError("NOT_FOUND", "Request not found.");
  if (req.status !== "REQUESTED") throw new StoreError("WRONG_STATE", `That request is already ${req.status.toLowerCase()}.`);
  const now = input.now ?? new Date();
  if (input.approve) {
    await cancelInternal(prisma, { businessId: input.businessId, orderId: req.orderId, by: "BUYER", reason: `Cancellation approved: ${req.reason}`, from: ["CONFIRMED", "PLACED", "READY"], now, ...(input.actor ? { actor: input.actor } : {}) });
  }
  await scoped.storeCancellationRequest.update({ where: { id: req.id }, data: { status: input.approve ? "APPROVED" : "DENIED", decidedBy: input.actor ?? null, decidedAt: now } });
}

/** Releases the hold on orders nobody paid for, confirmed or collected in time. Each business's own rows; idempotent. */
export async function expireStoreOrders(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const due = await prisma.storeOrder.findMany({ where: { status: { in: ["PLACED", "CONFIRMED", "READY"] }, reservedUntil: { lte: now } }, select: { id: true, businessId: true } });
  let expired = 0;
  for (const d of due) {
    try {
      await transition(prisma, d.businessId, d.id, ["PLACED", "CONFIRMED", "READY"], async (tx, order) => {
        await releaseOrderStock(tx, order, now);
        return { status: "EXPIRED", cancelledAt: now, cancelledBy: "SYSTEM", cancelReason: "The stock hold ran out before the order was paid, confirmed or collected." };
      });
      expired++;
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
    }
  }
  return expired;
}

// ---------------------------------------------------------------------------------- public view

export interface PublicOrderView {
  reference: string;
  status: StoreOrder["status"];
  fulfilment: StoreFulfilment;
  paymentMethod: StorePaymentMethod;
  currencyCode: string;
  minorUnitExp: number;
  items: { description: string; unit: string; quantity: number; unitPriceMinor: bigint; lineTotalMinor: bigint }[];
  subtotalMinor: bigint;
  deliveryFeeMinor: bigint;
  totalMinor: bigint;
  paidMinor: bigint;
  refundedMinor: bigint;
  seller: { name: string; supportPhone: string | null };
  collection: { location: string | null; instructions: string | null } | null;
  delivery: { zone: string | null; landmark: string | null; address: string | null; reference: string | null; carrier: string | null } | null;
  pickupCode: string;
  timeline: { label: string; at: Date }[];
  actions: { cancel: CancellationMode; cancelMessage: string; refund: { allowed: boolean; message: string }; pay: boolean; reportProblem: boolean };
  requests: { cancellations: { status: string; reason: string }[]; refunds: { id: string; kind: string; status: string; approvedAmountMinor: bigint | null }[] };
  paymentUnderReview: boolean;
  terms: string | null;
  expiresAtLabel: Date | null;
}

/** Everything a shopper may see about one order, and only that. No cost, no other customer, no internal notes. */
export async function publicOrderView(prisma: PrismaClient, businessId: string, orderId: string, now: Date = new Date()): Promise<PublicOrderView> {
  const scoped = getTenantScopedClient(prisma, businessId);
  const order = await loadStoreOrder(scoped, orderId);
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { currency: true } });
  const terms = order.terms as { seller: { name: string; supportPhone: string | null }; pickup?: { location: string | null; instructions: string | null }; returnWindowDays: number | null; termsText: string | null };
  const cancels = await scoped.storeCancellationRequest.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const refunds = await scoped.storeRefundRequest.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const held = await scoped.paymentException.count({ where: { orderId, status: "OPEN" } });
  const cp = cancellationPolicy(order);
  const rp = refundPolicy(order, terms.returnWindowDays, now);
  const timeline = (
    [["Order placed", order.placedAt], ["Confirmed by the seller", order.confirmedAt], ["Ready for collection", order.readyAt], ["On its way", order.dispatchedAt], ["Completed", order.completedAt], [order.status === "EXPIRED" ? "Expired" : "Cancelled", order.cancelledAt]] as [string, Date | null][]
  ).filter((t): t is [string, Date] => t[1] !== null).map(([label, at]) => ({ label, at }));
  return {
    reference: order.reference, status: order.status, fulfilment: order.fulfilment, paymentMethod: order.paymentMethod, currencyCode: order.currencyCode, minorUnitExp: business.currency.minorUnitExp,
    items: order.lines.map((l) => ({ description: l.description, unit: l.unit, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })),
    subtotalMinor: order.subtotalMinor, deliveryFeeMinor: order.deliveryFeeMinor, totalMinor: order.totalMinor, paidMinor: order.paidMinor, refundedMinor: order.refundedMinor,
    seller: { name: terms.seller.name, supportPhone: terms.seller.supportPhone },
    collection: order.fulfilment === "PICKUP" ? { location: terms.pickup?.location ?? null, instructions: terms.pickup?.instructions ?? null } : null,
    delivery: order.fulfilment === "DELIVERY" ? { zone: order.deliveryZoneName, landmark: order.landmark, address: order.addressLine, reference: order.deliveryRef, carrier: order.carrier } : null,
    pickupCode: order.pickupCode, timeline,
    actions: {
      cancel: cp.mode, cancelMessage: cp.message, refund: { allowed: rp.allowed, message: rp.message },
      pay: order.paymentMethod === "ONLINE_SIMULATED" && order.paidMinor < order.totalMinor && order.status === "PLACED" && (order.reservedUntil ? order.reservedUntil > now : false), reportProblem: true,
    },
    requests: { cancellations: cancels.map((c) => ({ status: c.status, reason: c.reason })), refunds: refunds.map((r) => ({ id: r.id, kind: r.kind, status: r.status, approvedAmountMinor: r.approvedAmountMinor })) },
    paymentUnderReview: held > 0, terms: terms.termsText, expiresAtLabel: order.reservedUntil,
  };
}
