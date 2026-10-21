import { describe, expect, it } from "vitest";
import type { CourierAdapter, CourierBookingRequest } from "../../src/couriers/adapter.js";

/**
 * The checks EVERY courier adapter must pass before it may be added to the registry (see docs/expansion/courier-integration.md). A real
 * adapter supplies a `harness` that talks to the courier's SANDBOX (or a faithful recording of it); the simulator passes it today.
 */
export interface CourierHarness {
  adapter: CourierAdapter;
  /** The courier's own signed callback for a job (as its sandbox would send it). */
  signedCallback(externalId: string, status: "PICKED_UP" | "DELIVERED", eventId: string): { body: Buffer; headers: Record<string, string> };
  /** The same callback signed with the WRONG secret. */
  forgedCallback(externalId: string): { body: Buffer; headers: Record<string, string> };
  /** A callback whose signature is valid but whose timestamp is long past (replay). */
  staleCallback(externalId: string): { body: Buffer; headers: Record<string, string> };
  /** Re-signs a different body with the original headers' timestamp: the signature must no longer match. */
  tamper(signed: { body: Buffer; headers: Record<string, string> }): { body: Buffer; headers: Record<string, string> };
}

export const bookingRequest = (key: string): CourierBookingRequest => ({
  reference: "SO-000001", idempotencyKey: key,
  pickup: { name: "Demo Provisions", phone: "2348030000000", address: "Opposite the market gate" },
  dropoff: { name: "Amaka Obi", phone: "2348031234567", landmark: "Near the blue gate", address: null, area: "Ikeja", latitude: null, longitude: null },
  parcel: { description: "3 x can Cola" },
});

export function describeCourierContract(name: string, make: () => CourierHarness): void {
  describe(`courier contract: ${name}`, () => {
    it("declares an id, a name and capabilities that match what it implements", () => {
      const { adapter } = make();
      expect(adapter.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
      expect(adapter.id).not.toBe("manual");
      expect(adapter.displayName.length).toBeGreaterThan(2);
      if (adapter.capabilities.book) expect(adapter.book).toBeTypeOf("function");
      if (adapter.capabilities.cancel) expect(adapter.cancel).toBeTypeOf("function");
      if (adapter.capabilities.callbacks) expect(adapter.verifyCallback).toBeTypeOf("function");
      if (adapter.capabilities.poll) expect(adapter.fetchStatus).toBeTypeOf("function");
    });

    it("booking is idempotent: the same key is the same job, a new key is a new job", async () => {
      const { adapter } = make();
      if (!adapter.book) return;
      const a = await adapter.book(bookingRequest("key-1"));
      const again = await adapter.book(bookingRequest("key-1"));
      const other = await adapter.book(bookingRequest("key-2"));
      expect(again.externalId).toBe(a.externalId);
      expect(other.externalId).not.toBe(a.externalId);
      expect(a.status).toBe("BOOKED");
      if (a.feeMinor !== undefined) expect(a.feeMinor).toBeGreaterThanOrEqual(0n);
      if (a.trackingUrl) expect(a.trackingUrl).toMatch(/^https:\/\//);
    });

    it("believes only a callback it can verify: forged, tampered and replayed ones are refused", async () => {
      const h = make();
      const { adapter } = h;
      if (!adapter.verifyCallback || !adapter.book) return;
      const job = await adapter.book(bookingRequest("key-cb"));
      const good = h.signedCallback(job.externalId, "PICKED_UP", "evt-1");
      const ev = adapter.verifyCallback(good.headers, good.body);
      expect(ev).toMatchObject({ externalId: job.externalId, status: "PICKED_UP", eventId: expect.any(String) });
      expect(ev!.occurredAt).toBeInstanceOf(Date);
      expect(() => adapter.verifyCallback!(good.headers, Buffer.from("{}"))).toThrow();
      const forged = h.forgedCallback(job.externalId);
      expect(() => adapter.verifyCallback!(forged.headers, forged.body)).toThrow(/signature/i);
      const stale = h.staleCallback(job.externalId);
      expect(() => adapter.verifyCallback!(stale.headers, stale.body)).toThrow();
      const t = h.tamper(good);
      expect(() => adapter.verifyCallback!(t.headers, t.body)).toThrow();
      expect(() => adapter.verifyCallback!({}, good.body)).toThrow();
    });

    it("the same event delivered twice carries the same event id", async () => {
      const h = make();
      if (!h.adapter.verifyCallback || !h.adapter.book) return;
      const job = await h.adapter.book(bookingRequest("key-ev"));
      const a = h.signedCallback(job.externalId, "DELIVERED", "evt-same");
      const b = h.signedCallback(job.externalId, "DELIVERED", "evt-same");
      expect(h.adapter.verifyCallback(a.headers, a.body)!.eventId).toBe(h.adapter.verifyCallback(b.headers, b.body)!.eventId);
    });

    it("answers a status question for a known job and null for an unknown one", async () => {
      const { adapter } = make();
      if (!adapter.fetchStatus || !adapter.book) return;
      const job = await adapter.book(bookingRequest("key-poll"));
      expect(await adapter.fetchStatus(job.externalId)).toMatchObject({ externalId: job.externalId, status: "BOOKED" });
      expect(await adapter.fetchStatus("no-such-job")).toBeNull();
    });
  });
}
