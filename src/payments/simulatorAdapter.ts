import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  CapabilityError, ProviderRejectedError, ProviderUnavailableError,
  type CallbackVerdict, type Capability, type CreatePaymentRequest, type CreatePaymentResult, type ProviderAdapter, type ProviderPaymentSnapshot,
  type RefundRequest, type RefundResult, type SettlementReport, type StatusQuery,
} from "./adapter.js";
import { PaymentPurposeForbiddenError, assertProviderAllowedForPurpose } from "../domain/paymentPurpose.js";

/**
 * The deterministic merchant-payment SIMULATOR (expansion section 12): a complete, money-free stand-in for a provider, with its own
 * memory of what it was asked (`SimulatorPayment`), signed callbacks (HMAC-SHA256 over the exact body), refunds with provider-side
 * bounds, and test controls to make it fail, hang, go down or report things late. It moves no money and contacts no one. It refuses
 * to run at all when NODE_ENV=production. It does NOT implement a settlement-report pull (a capability error), so the "unsupported
 * operation" path is exercised by a real adapter, not only a mock.
 */
export const SIMULATOR_ID = "simulator" as const;
export const SIMULATOR_SIGNATURE_HEADER = "x-simulator-signature";

const base = { eventId: z.string().min(8).max(100), purpose: z.enum(["MERCHANT_SALE", "PLATFORM_SUBSCRIPTION"]) };
const amount = z.string().regex(/^[0-9]{1,18}$/);
const paymentEvent = z.object({
  ...base, event: z.literal("payment.updated"), sellerBusinessId: z.string().min(1).optional(),
  externalRef: z.string().min(4).max(100), merchantReference: z.string().min(1).max(100), status: z.enum(["PENDING", "SUCCEEDED", "FAILED"]),
  amountMinor: amount, currencyCode: z.string().length(3), destinationKey: z.string().min(1).max(100), feeMinor: amount.optional(),
});
const refundEvent = z.object({
  ...base, event: z.literal("refund.updated"), paymentExternalRef: z.string().min(4).max(100), refundExternalRef: z.string().min(4).max(100),
  status: z.enum(["SUCCEEDED", "FAILED"]), amountMinor: amount, failureReason: z.string().max(200).optional(),
});
const settlementEvent = z.object({
  ...base, event: z.literal("settlement.reported"), reference: z.string().min(4).max(100), destinationKey: z.string().min(1).max(100), currencyCode: z.string().length(3),
  settledAt: z.string().datetime(), grossMinor: amount, feeMinor: amount, netMinor: amount,
  lines: z.array(z.object({ externalRef: z.string().min(4).max(100), grossMinor: amount, feeMinor: amount })).min(1).max(500),
});
const eventSchema = z.discriminatedUnion("event", [paymentEvent, refundEvent, settlementEvent]);

export function signSimulatorBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function validSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signSimulatorBody(rawBody, secret), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type RefundRecord = { key: string; externalRef: string; amountMinor: string; status: "SUCCEEDED" | "PENDING" | "FAILED" };

export class SimulatorAdapter implements ProviderAdapter {
  readonly id = SIMULATOR_ID;
  readonly evidence = "SIMULATOR_CONFIRMED" as const;
  readonly callbackAuth = "STRONG" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["createPayment", "getStatus", "refund", "getRefundStatus"]);

  /** Test control: while true every call fails as if the provider were down. */
  outage = false;
  /** Test control: the next createPayment is NOT recorded but throws as a timeout (the caller cannot tell whether it went through). */
  dropNextCreate = false;

  constructor(private readonly prisma: PrismaClient, private readonly secret: string) {}

  private guard(): void {
    if (process.env["NODE_ENV"] === "production") throw new ProviderUnavailableError(this.id, "The simulator is never available in production.");
    if (this.outage) throw new ProviderUnavailableError(this.id);
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    this.guard();
    if (this.dropNextCreate) {
      this.dropNextCreate = false;
      throw new ProviderUnavailableError(this.id, "The request timed out.");
    }
    if (req.amountMinor <= 0n) throw new ProviderRejectedError(this.id, "Amount must be positive.");
    const existing = await this.prisma.simulatorPayment.findFirst({ where: { merchantReference: req.merchantReference } });
    if (existing) return { externalRef: existing.externalRef, status: "PENDING", checkoutUrl: null };
    const externalRef = `sim_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.prisma.simulatorPayment.create({ data: { externalRef, merchantReference: req.merchantReference, amountMinor: req.amountMinor, currencyCode: req.currencyCode, destinationKey: req.destinationKey } });
    return { externalRef, status: "PENDING", checkoutUrl: null };
  }

  async getStatus(q: StatusQuery): Promise<ProviderPaymentSnapshot> {
    this.guard();
    const p = q.externalRef
      ? await this.prisma.simulatorPayment.findUnique({ where: { externalRef: q.externalRef } })
      : await this.prisma.simulatorPayment.findFirst({ where: { merchantReference: q.merchantReference } });
    if (!p) return { status: "NOT_FOUND", externalRef: q.externalRef, merchantReference: q.merchantReference, amountMinor: null, currencyCode: null, destinationKey: null, feeMinor: null };
    return { status: p.status as "PENDING" | "SUCCEEDED" | "FAILED", externalRef: p.externalRef, merchantReference: p.merchantReference, amountMinor: p.amountMinor, currencyCode: p.currencyCode, destinationKey: p.destinationKey, feeMinor: p.status === "SUCCEEDED" ? p.feeMinor : null };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    this.guard();
    const p = await this.prisma.simulatorPayment.findUnique({ where: { externalRef: req.externalRef } });
    if (!p || p.status !== "SUCCEEDED") throw new ProviderRejectedError(this.id, "There is no collected payment to refund.");
    const records = (p.refunds as RefundRecord[]) ?? [];
    const prior = records.find((r) => r.key === req.idempotencyKey);
    if (prior) return { externalRef: prior.externalRef, status: prior.status };
    const refunded = records.filter((r) => r.status !== "FAILED").reduce((n, r) => n + BigInt(r.amountMinor), 0n);
    if (req.amountMinor <= 0n || refunded + req.amountMinor > p.amountMinor) throw new ProviderRejectedError(this.id, "That is more than the provider holds for this payment.");
    const status: RefundRecord["status"] = p.behaviour === "REFUND_FAILS" ? "FAILED" : p.behaviour === "REFUND_PENDING" ? "PENDING" : "SUCCEEDED";
    const rec: RefundRecord = { key: req.idempotencyKey, externalRef: `simr_${randomUUID().replace(/-/g, "").slice(0, 16)}`, amountMinor: req.amountMinor.toString(), status };
    await this.prisma.simulatorPayment.update({ where: { id: p.id }, data: { refunds: [...records, rec] as never, refundedMinor: status === "FAILED" ? p.refundedMinor : p.refundedMinor + req.amountMinor } });
    return { externalRef: rec.externalRef, status, ...(status === "FAILED" ? { failureReason: "The simulated provider could not send the refund." } : {}) };
  }

  async getRefundStatus(q: { externalRef: string; paymentExternalRef: string }): Promise<RefundResult> {
    this.guard();
    const p = await this.prisma.simulatorPayment.findUnique({ where: { externalRef: q.paymentExternalRef } });
    const rec = ((p?.refunds as RefundRecord[]) ?? []).find((r) => r.externalRef === q.externalRef);
    if (!rec) throw new ProviderRejectedError(this.id, "No such refund.");
    return { externalRef: rec.externalRef, status: rec.status };
  }

  async fetchSettlements(): Promise<SettlementReport[]> {
    throw new CapabilityError(this.id, "settlementReport");
  }

  receiveCallback(rawBody: string, headers: Record<string, string | undefined>): CallbackVerdict {
    if (!validSignature(rawBody, headers[SIMULATOR_SIGNATURE_HEADER], this.secret)) return { ok: false, reason: "BAD_SIGNATURE" };
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: "BAD_BODY" };
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "BAD_BODY" };
    const e = parsed.data;
    try {
      assertProviderAllowedForPurpose(this.id, e.purpose);
    } catch (error) {
      if (error instanceof PaymentPurposeForbiddenError) return { ok: false, reason: "PURPOSE_FORBIDDEN", eventId: e.eventId, detail: `claimed ${e.purpose}` };
      throw error;
    }
    if (e.event === "payment.updated") {
      return {
        ok: true,
        event: {
          kind: "payment", eventId: e.eventId, purpose: e.purpose, ...(e.sellerBusinessId ? { sellerBusinessId: e.sellerBusinessId } : {}),
          snapshot: { status: e.status, externalRef: e.externalRef, merchantReference: e.merchantReference, amountMinor: BigInt(e.amountMinor), currencyCode: e.currencyCode, destinationKey: e.destinationKey, feeMinor: e.feeMinor ? BigInt(e.feeMinor) : null },
        },
      };
    }
    if (e.event === "refund.updated") {
      return { ok: true, event: { kind: "refund", eventId: e.eventId, purpose: e.purpose, paymentExternalRef: e.paymentExternalRef, refundExternalRef: e.refundExternalRef, status: e.status, amountMinor: BigInt(e.amountMinor), ...(e.failureReason ? { failureReason: e.failureReason } : {}) } };
    }
    return {
      ok: true,
      event: {
        kind: "settlement", eventId: e.eventId, purpose: e.purpose,
        report: { reference: e.reference, destinationKey: e.destinationKey, currencyCode: e.currencyCode, settledAt: new Date(e.settledAt), grossMinor: BigInt(e.grossMinor), feeMinor: BigInt(e.feeMinor), netMinor: BigInt(e.netMinor), lines: e.lines.map((l) => ({ externalRef: l.externalRef, grossMinor: BigInt(l.grossMinor), feeMinor: BigInt(l.feeMinor) })) },
      },
    };
  }

  // ----------------------------------------------------------------------------- test and development controls

  /** What the provider would POST to us: the exact body and its signature. */
  signedEvent(event: Record<string, unknown>): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(event);
    return { body, headers: { [SIMULATOR_SIGNATURE_HEADER]: signSimulatorBody(body, this.secret) } };
  }

  /** The payer finished: records the outcome provider-side and returns the signed callback the provider would send. */
  async completePayment(externalRef: string, opts: { status?: "SUCCEEDED" | "FAILED"; amountMinor?: bigint; currencyCode?: string; destinationKey?: string; feeMinor?: bigint; eventId?: string; sellerBusinessId?: string; purpose?: "MERCHANT_SALE" | "PLATFORM_SUBSCRIPTION" } = {}) {
    const p = await this.prisma.simulatorPayment.findUniqueOrThrow({ where: { externalRef } });
    const status = opts.status ?? "SUCCEEDED";
    const updated = await this.prisma.simulatorPayment.update({ where: { id: p.id }, data: { status, feeMinor: opts.feeMinor ?? p.feeMinor } });
    return this.signedEvent({
      event: "payment.updated", eventId: opts.eventId ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`, purpose: opts.purpose ?? "MERCHANT_SALE",
      ...(opts.sellerBusinessId ? { sellerBusinessId: opts.sellerBusinessId } : {}), externalRef, merchantReference: p.merchantReference, status,
      amountMinor: (opts.amountMinor ?? p.amountMinor).toString(), currencyCode: opts.currencyCode ?? p.currencyCode, destinationKey: opts.destinationKey ?? p.destinationKey,
      ...(updated.feeMinor > 0n ? { feeMinor: updated.feeMinor.toString() } : {}),
    });
  }

  async setBehaviour(externalRef: string, behaviour: "NORMAL" | "REFUND_FAILS" | "REFUND_PENDING"): Promise<void> {
    await this.prisma.simulatorPayment.update({ where: { externalRef }, data: { behaviour } });
  }

  /** The provider reports its payout of the given collected payments, minus its fee per payment. */
  async settle(input: { reference: string; destinationKey: string; externalRefs: string[]; feePerPaymentMinor?: bigint; eventId?: string; amountOverrideMinor?: bigint }) {
    const payments = await this.prisma.simulatorPayment.findMany({ where: { externalRef: { in: input.externalRefs } } });
    const fee = input.feePerPaymentMinor ?? 0n;
    const lines = payments.map((p) => ({ externalRef: p.externalRef, grossMinor: (input.amountOverrideMinor ?? p.amountMinor - p.refundedMinor).toString(), feeMinor: fee.toString() }));
    const gross = lines.reduce((n, l) => n + BigInt(l.grossMinor), 0n);
    const totalFee = fee * BigInt(lines.length);
    await this.prisma.simulatorPayment.updateMany({ where: { externalRef: { in: input.externalRefs } }, data: { settledReference: input.reference } });
    return this.signedEvent({
      event: "settlement.reported", eventId: input.eventId ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`, purpose: "MERCHANT_SALE", reference: input.reference, destinationKey: input.destinationKey,
      currencyCode: payments[0]?.currencyCode ?? "NGN", settledAt: new Date().toISOString(), grossMinor: gross.toString(), feeMinor: totalFee.toString(), netMinor: (gross - totalFee).toString(), lines,
    });
  }

  refundEvent(input: { paymentExternalRef: string; refundExternalRef: string; status: "SUCCEEDED" | "FAILED"; amountMinor: bigint; eventId?: string }) {
    return this.signedEvent({ event: "refund.updated", eventId: input.eventId ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`, purpose: "MERCHANT_SALE", paymentExternalRef: input.paymentExternalRef, refundExternalRef: input.refundExternalRef, status: input.status, amountMinor: input.amountMinor.toString() });
  }
}
