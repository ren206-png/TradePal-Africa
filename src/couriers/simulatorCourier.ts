import { createHmac, timingSafeEqual } from "node:crypto";
import type { CourierAdapter, CourierBooking, CourierBookingRequest, CourierEvent, CourierStatus } from "./adapter.js";
import { CourierError } from "./adapter.js";

/**
 * A pretend courier for development and tests ONLY. It books jobs in memory, signs its callbacks with HMAC-SHA256 over
 * `<timestamp>.<raw body>` (header `x-courier-signature: t=<unix>,v1=<hex>`), and refuses signatures older than five minutes. It joins
 * the registry only when COURIER_SIMULATOR_ENABLED=true and NODE_ENV is not production. It stands for "a courier that behaves as the
 * contract says", not for any real courier.
 */
export const COURIER_SIMULATOR_ID = "simulator-courier";
const TOLERANCE_SECONDS = 300;

interface Job { externalId: string; key: string; reference: string; status: CourierStatus; riderName?: string; riderPhone?: string; reason?: string }

export class SimulatorCourier implements CourierAdapter {
  readonly id = COURIER_SIMULATOR_ID;
  readonly displayName = "Simulator courier (testing only)";
  readonly capabilities = { book: true, cancel: true, callbacks: true, poll: true };
  private readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, string>();
  private seq = 0;
  bookCalls = 0;
  failNextBooking = false;

  constructor(private readonly secret: string, private readonly clock: () => Date = () => new Date()) {}

  async book(req: CourierBookingRequest): Promise<CourierBooking> {
    this.bookCalls++;
    if (this.failNextBooking) { this.failNextBooking = false; throw new CourierError("FAILED", "The courier could not take this job right now."); }
    const known = this.byKey.get(req.idempotencyKey);
    const job = known ? this.jobs.get(known)! : this.create(req);
    return this.bookingOf(job);
  }

  private create(req: CourierBookingRequest): Job {
    const externalId = `sc_${String(++this.seq).padStart(6, "0")}`;
    const job: Job = { externalId, key: req.idempotencyKey, reference: req.reference, status: "BOOKED", riderName: "Test Rider", riderPhone: "2348000000000" };
    this.jobs.set(externalId, job);
    this.byKey.set(req.idempotencyKey, externalId);
    return job;
  }

  private bookingOf(j: Job): CourierBooking {
    return { externalId: j.externalId, trackingRef: j.externalId.toUpperCase(), trackingUrl: `https://track.simulator.test/${j.externalId}`, feeMinor: 150_000n, currencyCode: "NGN", status: j.status, ...(j.riderName ? { riderName: j.riderName } : {}), ...(j.riderPhone ? { riderPhone: j.riderPhone } : {}) };
  }

  async cancel(externalId: string): Promise<void> {
    const j = this.jobs.get(externalId);
    if (!j) throw new CourierError("FAILED", "No such job.");
    if (j.status !== "BOOKED") throw new CourierError("FAILED", "The courier already has the parcel.");
    j.status = "CANCELLED";
  }

  async fetchStatus(externalId: string): Promise<CourierEvent | null> {
    const j = this.jobs.get(externalId);
    if (!j) return null;
    return { eventId: `poll_${j.externalId}_${j.status}`, externalId, status: j.status, occurredAt: this.clock(), ...(j.reason ? { reason: j.reason } : {}) };
  }

  /** Test helper: the courier moves the job on, and returns the signed callback it would send. */
  advance(externalId: string, status: CourierStatus, opts: { eventId?: string; reason?: string; at?: Date; secret?: string; timestamp?: number } = {}): { body: Buffer; headers: Record<string, string> } {
    const j = this.jobs.get(externalId);
    if (j) { j.status = status; if (opts.reason) j.reason = opts.reason; }
    const body = Buffer.from(JSON.stringify({ event_id: opts.eventId ?? `ev_${externalId}_${status}_${++this.seq}`, job_id: externalId, status, occurred_at: (opts.at ?? this.clock()).toISOString(), ...(opts.reason ? { reason: opts.reason } : {}), ...(j?.riderName ? { rider_name: j.riderName } : {}) }));
    return { body, headers: this.sign(body, opts.secret ?? this.secret, opts.timestamp) };
  }

  sign(body: Buffer, secret: string, timestamp: number = Math.floor(this.clock().getTime() / 1000)): Record<string, string> {
    const v1 = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
    return { "content-type": "application/json", "x-courier-signature": `t=${timestamp},v1=${v1}` };
  }

  verifyCallback(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): CourierEvent | null {
    const raw = headers["x-courier-signature"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const m = header ? /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(header) : null;
    if (!m) throw new CourierError("BAD_SIGNATURE", "Missing or malformed signature.");
    const t = Number(m[1]);
    if (Math.abs(Math.floor(this.clock().getTime() / 1000) - t) > TOLERANCE_SECONDS) throw new CourierError("BAD_SIGNATURE", "The signature is too old.");
    const expected = createHmac("sha256", this.secret).update(`${t}.`).update(rawBody).digest();
    const given = Buffer.from(m[2]!, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new CourierError("BAD_SIGNATURE", "The signature does not match.");
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>; } catch { return null; }
    if (typeof body["event_id"] !== "string" || typeof body["job_id"] !== "string" || typeof body["status"] !== "string") return null;
    const status = body["status"] as CourierStatus;
    if (!["BOOKED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "FAILED", "CANCELLED", "RETURNED"].includes(status)) return null;
    const at = new Date(String(body["occurred_at"] ?? ""));
    return {
      eventId: body["event_id"], externalId: body["job_id"], status, occurredAt: Number.isNaN(at.getTime()) ? this.clock() : at,
      ...(typeof body["reason"] === "string" ? { reason: body["reason"].slice(0, 300) } : {}), ...(typeof body["rider_name"] === "string" ? { riderName: body["rider_name"].slice(0, 80) } : {}),
    };
  }
}
