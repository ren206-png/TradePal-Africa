import type { CourierJobStatus } from "@prisma/client";

/**
 * The contract a courier integration implements. TradePal does not choose or recommend a courier: a real adapter is added by a reviewed
 * change once a courier is chosen (see docs/expansion/courier-integration.md for what it must satisfy and how to prove it). Until then
 * every seller can use the built-in `manual` courier, which records who is delivering and lets the seller (or a courier's own link) tell
 * TradePal how it is going.
 *
 * Rules every adapter must follow (and `tests/courierContract.test.ts` checks for any adapter you hand it):
 *  - `book` is idempotent on `idempotencyKey`: asking twice for the same key returns the SAME booking, never a second job;
 *  - a callback is only believed if `verifyCallback` proves it came from the courier (signature over the exact raw body); an unverifiable
 *    callback is refused and nothing is recorded as fact;
 *  - an event carries the courier's own event id, so a repeated delivery of the same callback is recognised;
 *  - an adapter never sees a seller's cost, stock, or another order, and never completes an order: only the shopper's hand-over code does.
 */
export type CourierStatus = CourierJobStatus;

export interface CourierBookingRequest {
  /** The seller's order reference, e.g. SO-000012: shown to the courier. */
  reference: string;
  idempotencyKey: string;
  pickup: { name: string; phone: string | null; address: string | null };
  dropoff: { name: string; phone: string; landmark: string | null; address: string | null; area: string | null; latitude: number | null; longitude: number | null };
  parcel: { description: string };
}

export interface CourierBooking {
  externalId: string;
  trackingRef?: string;
  trackingUrl?: string;
  /** What the courier charges the SELLER, in minor units (never added to the shopper's total). */
  feeMinor?: bigint;
  currencyCode?: string;
  riderName?: string;
  riderPhone?: string;
  status: CourierStatus;
}

export interface CourierEvent {
  /** The courier's own id for this event: the same event delivered twice carries the same id. */
  eventId: string;
  externalId: string;
  status: CourierStatus;
  occurredAt: Date;
  reason?: string;
  riderName?: string;
  riderPhone?: string;
}

export interface CourierCapabilities {
  /** Can TradePal ask the courier to take a job? */
  book: boolean;
  cancel: boolean;
  /** Does the courier send status callbacks? */
  callbacks: boolean;
  /** Can TradePal ask the courier for the current status (used when a callback is missed)? */
  poll: boolean;
}

export interface CourierAdapter {
  readonly id: string; // lowercase letters, digits, dash or underscore
  readonly displayName: string;
  readonly capabilities: CourierCapabilities;
  book?(req: CourierBookingRequest): Promise<CourierBooking>;
  cancel?(externalId: string): Promise<void>;
  fetchStatus?(externalId: string): Promise<CourierEvent | null>;
  /** Throws when the signature is wrong; returns null for a well-formed message that is not a status event (e.g. a ping). */
  verifyCallback?(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): CourierEvent | null;
}

export class CourierError extends Error {
  readonly code: "UNKNOWN_COURIER" | "UNSUPPORTED" | "BAD_SIGNATURE" | "FAILED" | "NOT_ENABLED";
  constructor(code: CourierError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export class CourierRegistry {
  private readonly adapters = new Map<string, CourierAdapter>();
  register(adapter: CourierAdapter): this {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(adapter.id)) throw new Error(`Invalid courier id '${adapter.id}'.`);
    if (adapter.id === MANUAL_COURIER_ID) throw new Error("'manual' is built in and cannot be replaced.");
    this.adapters.set(adapter.id, adapter);
    return this;
  }
  get(id: string): CourierAdapter | null {
    return this.adapters.get(id) ?? null;
  }
  list(): CourierAdapter[] {
    return [...this.adapters.values()];
  }
}

export const MANUAL_COURIER_ID = "manual";
export const MANUAL_COURIER_NAME = "Own rider or other courier";

export const JOB_STATUS_LABEL: Record<CourierStatus, string> = {
  BOOKED: "Booked",
  PICKED_UP: "Picked up",
  IN_TRANSIT: "On its way",
  DELIVERED: "Delivered (reported by the courier)",
  FAILED: "Could not be delivered",
  CANCELLED: "Cancelled",
  RETURNED: "Returned to the seller",
};
