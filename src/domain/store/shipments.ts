import type { CourierJobStatus, DeliveryShipment, DeliveryShipmentEvent, PrismaClient } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction, type TenantScopedClient } from "../../db/tenantScope.js";
import { JOB_STATUS_LABEL, MANUAL_COURIER_ID, MANUAL_COURIER_NAME, CourierError, type CourierBooking, type CourierEvent, type CourierRegistry } from "../../couriers/adapter.js";
import { couriersEnabled } from "../../couriers/registry.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { recordCallback, type CallbackHandler } from "../callbackInbox.js";
import { StoreError, isUniqueViolation, toE164 } from "./common.js";
import { dispatchStoreOrder } from "./orders.js";

/**
 * Couriers for delivery orders (expansion, after Phase 9). A delivery job tracks who is carrying one order and how it is going.
 *
 * What a courier can and cannot do:
 *  - it can take a job (the seller books it, or the seller records an outside courier or their own rider by hand);
 *  - it can report PICKED_UP, IN_TRANSIT, DELIVERED, FAILED, CANCELLED, RETURNED, by a verified callback or by the seller;
 *  - it can NEVER complete an order, release or move stock, or touch money. An order is completed only by the shopper's hand-over
 *    code (the courier saying "delivered" is shown to the shopper and the seller, and the seller completes the order with the code);
 *  - its fee is the seller's cost: it is stored on the job and is never added to the shopper's total.
 *
 * A job only moves forward. An event that arrives late or out of order is kept in the history but does not move the job back.
 */
export const FLAG_STORE_COURIER = "storeCourier";
const LIVE: CourierJobStatus[] = ["BOOKED", "PICKED_UP", "IN_TRANSIT"];
/** The states a job may be in just before it can take each new state. */
const FROM: Record<CourierJobStatus, CourierJobStatus[]> = {
  BOOKED: [],
  PICKED_UP: ["BOOKED"],
  IN_TRANSIT: ["BOOKED", "PICKED_UP"],
  DELIVERED: ["BOOKED", "PICKED_UP", "IN_TRANSIT"],
  FAILED: ["BOOKED", "PICKED_UP", "IN_TRANSIT"],
  CANCELLED: ["BOOKED"],
  RETURNED: ["PICKED_UP", "IN_TRANSIT", "FAILED"],
};

export async function courierEnabledFor(scoped: TenantScopedClient, businessId: string): Promise<boolean> {
  return couriersEnabled() && (await isFeatureEnabled(scoped, businessId, FLAG_STORE_COURIER));
}

const text = (v: string | undefined, max: number): string | null => {
  const t = v?.trim();
  return t ? t.slice(0, max) : null;
};

export interface CreateShipmentInput {
  businessId: string;
  orderId: string;
  /** "manual" or a registered courier id. */
  courier: string;
  /** For the manual courier: the name shown to the shopper (e.g. "Own rider", "Gokada"). */
  courierName?: string;
  trackingRef?: string;
  trackingUrl?: string;
  riderName?: string;
  riderPhone?: string;
  actor?: string;
  now?: Date;
}

export function validateTrackingUrl(url: string | undefined): string | null {
  const t = url?.trim();
  if (!t) return null;
  if (t.length > 300) throw new StoreError("INVALID", "That tracking link is too long.");
  let u: URL;
  try { u = new URL(t); } catch { throw new StoreError("INVALID", "The tracking link must be a web address starting with https://."); }
  if (u.protocol !== "https:" || u.username || u.password) throw new StoreError("INVALID", "The tracking link must be a web address starting with https:// (and carry no password).");
  return u.toString();
}

/** What the courier is told about the parcel: item names and quantities, never a price. */
function parcelDescription(lines: { quantity: number; unit: string; description: string }[]): string {
  return lines.map((l) => `${l.quantity} x ${l.unit} ${l.description}`).join(", ").slice(0, 300);
}

/**
 * Hands a confirmed delivery order to a courier and dispatches it, or attaches a courier to an order that was already dispatched. The seller
 * is told plainly when the courier refuses the job; nothing changes in that case.
 */
export async function createShipment(prisma: PrismaClient, registry: CourierRegistry, input: CreateShipmentInput): Promise<{ shipment: DeliveryShipment; dispatched: boolean }> {
  const now = input.now ?? new Date();
  const scoped = getTenantScopedClient(prisma, input.businessId);
  if (!(await courierEnabledFor(scoped, input.businessId))) throw new StoreError("INVALID", "Courier tracking is not switched on for your shop.");
  const order = await scoped.storeOrder.findUnique({ where: { id: input.orderId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!order) throw new StoreError("NOT_FOUND", "Order not found.");
  if (order.fulfilment !== "DELIVERY") throw new StoreError("WRONG_STATE", "Only a delivery order has a courier.");
  if (order.status !== "CONFIRMED" && order.status !== "OUT_FOR_DELIVERY") throw new StoreError("WRONG_STATE", `This order is ${order.status.toLowerCase().replace(/_/g, " ")}; confirm it first.`);
  if (await scoped.deliveryShipment.findFirst({ where: { orderId: order.id, status: { in: LIVE } } })) throw new StoreError("DUPLICATE", "This order already has a delivery job in progress.");

  const courierId = input.courier.trim().toLowerCase();
  const adapter = courierId === MANUAL_COURIER_ID ? null : registry.get(courierId);
  if (courierId !== MANUAL_COURIER_ID && !adapter) throw new StoreError("INVALID", `I don't know the courier "${input.courier}". Send /store couriers to see what you can use.`);
  const trackingUrl = validateTrackingUrl(input.trackingUrl);
  const riderPhone = input.riderPhone ? toE164(input.riderPhone, (await prisma.business.findUniqueOrThrow({ where: { id: input.businessId }, select: { country: { select: { callingCode: true } } } })).country.callingCode) : null;
  if (input.riderPhone && !riderPhone) throw new StoreError("INVALID", "That rider phone number does not look right.");
  const attemptNo = (await scoped.deliveryShipment.count({ where: { orderId: order.id } })) + 1;
  const idempotencyKey = `ship:${order.id}:${attemptNo}`;

  let booking: CourierBooking | null = null;
  if (adapter) {
    if (!adapter.capabilities.book || !adapter.book) throw new StoreError("INVALID", `${adapter.displayName} cannot be booked from here. Use "manual" and record its details.`);
    const sf = await scoped.storefront.findFirst({ where: {} });
    try {
      booking = await adapter.book({
        reference: order.reference, idempotencyKey,
        pickup: { name: sf?.title ?? "Seller", phone: sf?.supportPhone ?? null, address: sf?.pickupLocation ?? null },
        dropoff: { name: order.buyerName, phone: order.buyerPhone, landmark: order.landmark, address: order.addressLine, area: order.area, latitude: order.latitude, longitude: order.longitude },
        parcel: { description: parcelDescription(order.lines) },
      });
    } catch (error) {
      if (error instanceof CourierError) throw new StoreError("INVALID", `The courier could not take this job: ${error.message} Nothing was changed.`);
      throw error;
    }
  }

  const courierName = adapter ? adapter.displayName : (text(input.courierName, 60) ?? MANUAL_COURIER_NAME);
  let shipment: DeliveryShipment;
  try {
    shipment = await withScopedTransaction(scoped, async (tx) => {
      const created = await tx.deliveryShipment.create({
        data: {
          businessId: input.businessId, orderId: order.id, courier: courierId, courierName, idempotencyKey,
          externalId: booking?.externalId ?? null, trackingRef: text(input.trackingRef, 100) ?? booking?.trackingRef ?? null,
          trackingUrl: trackingUrl ?? booking?.trackingUrl ?? null, riderName: text(input.riderName, 80) ?? booking?.riderName ?? null, riderPhone: riderPhone ?? booking?.riderPhone ?? null,
          feeMinor: booking?.feeMinor ?? null, currencyCode: booking?.currencyCode ?? null, status: "BOOKED", lastEventAt: now, createdBy: input.actor ?? null,
        },
      });
      await tx.deliveryShipmentEvent.create({ data: { businessId: input.businessId, shipmentId: created.id, status: "BOOKED", source: adapter ? "SYSTEM" : "SELLER", detail: `Booked with ${courierName}`, occurredAt: now } });
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // the same booking arrived twice (a repeated message): the first one stands
      const again = await scoped.deliveryShipment.findFirst({ where: { orderId: order.id, idempotencyKey } });
      if (again) return { shipment: again, dispatched: false };
    }
    throw error;
  }

  let dispatched = false;
  if (order.status === "CONFIRMED") {
    try {
      const ref = shipment.trackingRef ?? shipment.externalId;
      await dispatchStoreOrder(prisma, { businessId: input.businessId, orderId: order.id, ...(ref ? { deliveryRef: ref } : {}), carrier: courierName, ...(input.actor ? { actor: input.actor } : {}), now });
      dispatched = true;
    } catch (error) {
      // the order could not leave (it changed under us): call the job off so nothing is left half-done
      await abandonShipment(prisma, registry, shipment, "The order could not be dispatched.");
      throw error;
    }
  }
  return { shipment, dispatched };
}

async function abandonShipment(prisma: PrismaClient, registry: CourierRegistry, shipment: DeliveryShipment, reason: string): Promise<void> {
  const adapter = registry.get(shipment.courier);
  if (adapter?.capabilities.cancel && adapter.cancel && shipment.externalId) await adapter.cancel(shipment.externalId).catch(() => undefined);
  await applyShipmentUpdate(prisma, { businessId: shipment.businessId, shipmentId: shipment.id, status: "CANCELLED", source: "SYSTEM", reason });
}

export interface ShipmentUpdateInput {
  businessId: string;
  shipmentId: string;
  status: CourierJobStatus;
  source: "SELLER" | "COURIER" | "SYSTEM";
  reason?: string;
  externalEventId?: string;
  occurredAt?: Date;
  riderName?: string;
  riderPhone?: string;
}

export interface ShipmentUpdateResult { applied: boolean; duplicate: boolean; shipment: DeliveryShipment }

/** Records one status report. The job moves only forward; a repeated or out-of-order report is kept in the history and changes nothing. */
export async function applyShipmentUpdate(prisma: PrismaClient, input: ShipmentUpdateInput): Promise<ShipmentUpdateResult> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const reason = text(input.reason, 300);
  if ((input.status === "FAILED") && (!reason || reason.length < 3)) throw new StoreError("INVALID", "Say why it could not be delivered.");
  const occurredAt = input.occurredAt ?? new Date();
  try {
    return await withScopedTransaction(scoped, async (tx) => {
      const current = await tx.deliveryShipment.findUnique({ where: { id: input.shipmentId } });
      if (!current) throw new StoreError("NOT_FOUND", "Delivery job not found.");
      if (input.externalEventId && (await tx.deliveryShipmentEvent.findFirst({ where: { shipmentId: current.id, externalEventId: input.externalEventId } }))) return { applied: false, duplicate: true, shipment: current };
      const allowed = FROM[input.status].includes(current.status);
      const sameState = current.status === input.status;
      await tx.deliveryShipmentEvent.create({
        data: { businessId: input.businessId, shipmentId: current.id, status: input.status, source: input.source, externalEventId: input.externalEventId ?? null, occurredAt, detail: allowed || sameState ? reason : `(not applied: the job is already ${current.status}) ${reason ?? ""}`.trim().slice(0, 300) },
      });
      if (!allowed) return { applied: false, duplicate: false, shipment: current };
      const claimed = await tx.deliveryShipment.updateMany({
        where: { id: current.id, status: { in: FROM[input.status] } },
        data: {
          status: input.status, lastEventAt: occurredAt, ...(input.status === "FAILED" ? { failureReason: reason } : {}),
          ...(input.riderName ? { riderName: text(input.riderName, 80) } : {}), ...(input.riderPhone && /^[0-9]{8,15}$/.test(input.riderPhone) ? { riderPhone: input.riderPhone } : {}),
        },
      });
      return { applied: claimed.count === 1, duplicate: false, shipment: await tx.deliveryShipment.findUniqueOrThrow({ where: { id: current.id } }) };
    });
  } catch (error) {
    if (isUniqueViolation(error) && input.externalEventId) {
      const shipment = await scoped.deliveryShipment.findUniqueOrThrow({ where: { id: input.shipmentId } });
      return { applied: false, duplicate: true, shipment };
    }
    throw error;
  }
}

/** The seller calls the courier off before pick-up. The order itself stays out for delivery: book another courier, or mark the delivery failed. */
export async function cancelShipment(prisma: PrismaClient, registry: CourierRegistry, input: { businessId: string; orderId: string; reason: string; actor?: string }): Promise<DeliveryShipment> {
  const scoped = getTenantScopedClient(prisma, input.businessId);
  const job = await scoped.deliveryShipment.findFirst({ where: { orderId: input.orderId, status: { in: LIVE } } });
  if (!job) throw new StoreError("NOT_FOUND", "This order has no delivery job in progress.");
  if (job.status !== "BOOKED") throw new StoreError("WRONG_STATE", "The courier already has the parcel. Mark the delivery as failed or returned instead.");
  const adapter = registry.get(job.courier);
  if (adapter?.capabilities.cancel && adapter.cancel && job.externalId) {
    try { await adapter.cancel(job.externalId); } catch (error) {
      if (error instanceof CourierError) throw new StoreError("INVALID", `The courier would not cancel the job: ${error.message}`);
      throw error;
    }
  }
  const r = await applyShipmentUpdate(prisma, { businessId: input.businessId, shipmentId: job.id, status: "CANCELLED", source: "SELLER", reason: input.reason });
  return r.shipment;
}

// ------------------------------------------------------------------------------------------------------------ reading

export interface ShipmentView {
  id: string;
  courierName: string;
  status: CourierJobStatus;
  statusLabel: string;
  trackingRef: string | null;
  trackingUrl: string | null;
  riderName: string | null;
  riderPhone: string | null;
  failureReason: string | null;
  updatedAt: Date;
  history: { status: CourierJobStatus; label: string; at: Date; source: string; detail: string | null }[];
}

/** The latest delivery job of an order, with its history (what the seller sees). */
export async function shipmentForOrder(scoped: TenantScopedClient, orderId: string): Promise<ShipmentView | null> {
  const s = await scoped.deliveryShipment.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" } });
  if (!s) return null;
  const events = await scoped.deliveryShipmentEvent.findMany({ where: { shipmentId: s.id }, orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }] });
  return {
    id: s.id, courierName: s.courierName, status: s.status, statusLabel: JOB_STATUS_LABEL[s.status], trackingRef: s.trackingRef, trackingUrl: s.trackingUrl, riderName: s.riderName, riderPhone: s.riderPhone,
    failureReason: s.failureReason, updatedAt: s.lastEventAt ?? s.createdAt,
    history: events.map((e: DeliveryShipmentEvent) => ({ status: e.status, label: JOB_STATUS_LABEL[e.status], at: e.occurredAt, source: e.source, detail: e.detail })),
  };
}

/** What a shopper may see: the courier, the state, the tracking link and the rider's name and number. Never the fee, the courier's own ids or internal notes. */
export type PublicShipment = Pick<ShipmentView, "courierName" | "status" | "statusLabel" | "trackingRef" | "trackingUrl" | "riderName" | "riderPhone" | "updatedAt"> & { failureReason: null };
export async function publicShipmentFor(scoped: TenantScopedClient, orderId: string): Promise<PublicShipment | null> {
  const s = await scoped.deliveryShipment.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" } });
  if (!s || s.status === "CANCELLED") return null;
  return { courierName: s.courierName, status: s.status, statusLabel: JOB_STATUS_LABEL[s.status], trackingRef: s.trackingRef, trackingUrl: s.trackingUrl, riderName: s.riderName, riderPhone: s.riderPhone, updatedAt: s.lastEventAt ?? s.createdAt, failureReason: null };
}

// ------------------------------------------------------------------------------------------------------------ courier callbacks

export type CallbackOutcome = { status: "recorded" | "duplicate" | "ignored" } | { status: "rejected"; reason: "UNKNOWN_COURIER" | "BAD_SIGNATURE" | "UNSUPPORTED" };
export const courierInboxProvider = (courierId: string): string => `courier:${courierId}`;

/** The public edge: verify the signature over the exact raw body, then store the event for the worker. Nothing is believed before it is verified. */
export async function receiveCourierCallback(prisma: PrismaClient, registry: CourierRegistry, courierId: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<CallbackOutcome> {
  const adapter = registry.get(courierId);
  if (!adapter) return { status: "rejected", reason: "UNKNOWN_COURIER" };
  if (!adapter.capabilities.callbacks || !adapter.verifyCallback) return { status: "rejected", reason: "UNSUPPORTED" };
  let event: CourierEvent | null;
  try {
    event = adapter.verifyCallback(headers, rawBody);
  } catch (error) {
    if (error instanceof CourierError && error.code === "BAD_SIGNATURE") return { status: "rejected", reason: "BAD_SIGNATURE" };
    throw error;
  }
  if (!event) return { status: "ignored" };
  const r = await recordCallback(prisma, {
    provider: courierInboxProvider(courierId), externalId: event.eventId, signatureVerified: true,
    payload: { externalId: event.externalId, status: event.status, occurredAt: event.occurredAt.toISOString(), ...(event.reason ? { reason: event.reason } : {}), ...(event.riderName ? { riderName: event.riderName } : {}), ...(event.riderPhone ? { riderPhone: event.riderPhone } : {}) },
  });
  return { status: r.inserted ? "recorded" : "duplicate" };
}

/** Worker side: apply a stored, verified event to the job it names. An event for a job we do not know fails (and is retried, then dead-lettered for a person to look at). */
export function courierCallbackHandler(prisma: PrismaClient, courierId: string): CallbackHandler {
  return async (callback) => {
    const p = callback.payload as { externalId: string; status: CourierJobStatus; occurredAt: string; reason?: string; riderName?: string; riderPhone?: string };
    const job = await prisma.deliveryShipment.findFirst({ where: { courier: courierId, externalId: p.externalId } });
    if (!job) throw new Error(`Courier ${courierId} reported on a job we do not have (${p.externalId}).`);
    await applyShipmentUpdate(prisma, {
      businessId: job.businessId, shipmentId: job.id, status: p.status, source: "COURIER", externalEventId: callback.externalId, occurredAt: new Date(p.occurredAt),
      ...(p.reason ? { reason: p.reason } : {}), ...(p.riderName ? { riderName: p.riderName } : {}), ...(p.riderPhone ? { riderPhone: p.riderPhone } : {}),
    });
  };
}

export function buildCourierCallbackHandlers(prisma: PrismaClient, registry: CourierRegistry): Record<string, CallbackHandler> {
  return Object.fromEntries(registry.list().filter((a) => a.capabilities.callbacks).map((a) => [courierInboxProvider(a.id), courierCallbackHandler(prisma, a.id)]));
}

/** Safety net for a missed callback: ask each courier that can be asked about every live job that has been quiet for a while. */
export async function pollQuietShipments(prisma: PrismaClient, registry: CourierRegistry, now: Date = new Date(), quietMinutes = 30): Promise<{ polled: number; updated: number }> {
  const cutoff = new Date(now.getTime() - quietMinutes * 60_000);
  const jobs = await prisma.deliveryShipment.findMany({ where: { status: { in: LIVE }, externalId: { not: null }, OR: [{ lastEventAt: null }, { lastEventAt: { lte: cutoff } }] }, take: 100, orderBy: { lastEventAt: "asc" } });
  let polled = 0;
  let updated = 0;
  for (const job of jobs) {
    const adapter = registry.get(job.courier);
    if (!adapter?.capabilities.poll || !adapter.fetchStatus) continue;
    polled++;
    const ev = await adapter.fetchStatus(job.externalId!).catch(() => null);
    if (!ev || ev.status === job.status) continue;
    const r = await applyShipmentUpdate(prisma, { businessId: job.businessId, shipmentId: job.id, status: ev.status, source: "COURIER", externalEventId: ev.eventId, occurredAt: ev.occurredAt, ...(ev.reason ? { reason: ev.reason } : {}) });
    if (r.applied) updated++;
  }
  return { polled, updated };
}
