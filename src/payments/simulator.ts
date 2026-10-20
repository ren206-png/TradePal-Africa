import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallbackInbox, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordCallback } from "../domain/callbackInbox.js";
import { PaymentPurposeForbiddenError, assertProviderAllowedForPurpose } from "../domain/paymentPurpose.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { applyProviderPayment, applyProviderPaymentToBuyer } from "../domain/trade/payments.js";

/**
 * The deterministic merchant-payment SIMULATOR (expansion section 12, Phase 3). It moves no money and talks to no
 * provider. It stands in for a real merchant-settling provider so the whole trade flow (invoice, payment evidence,
 * allocation, journals) can be developed and tested end to end:
 *
 *  - callbacks are signed (HMAC-SHA256 over the exact body); an unsigned or wrongly signed one is refused;
 *  - the purpose is checked against the central policy table: the simulator is MERCHANT_SALE only, and a body that
 *    claims PLATFORM_SUBSCRIPTION is refused (a forged purpose cannot reach subscription money);
 *  - the callback is stored in the durable inbox first and applied later, once per (provider, externalId);
 *  - evidence is labelled SIMULATOR_CONFIRMED, never PROVIDER_CONFIRMED.
 */
export const SIMULATOR_PROVIDER = "simulator" as const;

const eventSchema = z.object({
  event: z.literal("payment.succeeded"),
  externalId: z.string().min(8).max(100),
  purpose: z.enum(["MERCHANT_SALE", "PLATFORM_SUBSCRIPTION"]),
  sellerBusinessId: z.string().min(1),
  invoiceId: z.string().min(1),
  amountMinor: z.string().regex(/^[1-9]\d{0,17}$/),
  currencyCode: z.string().length(3),
});
export type SimulatorPaymentEvent = z.infer<typeof eventSchema>;

export function signSimulatorBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySimulatorSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signSimulatorBody(rawBody, secret), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What a payer's simulated checkout produces: the exact body and its signature, as a provider would send them. */
export function simulateSuccessfulPayment(input: { secret: string; externalId: string; sellerBusinessId: string; invoiceId: string; amountMinor: bigint; currencyCode: string; purpose?: "MERCHANT_SALE" | "PLATFORM_SUBSCRIPTION" }) {
  const body = JSON.stringify({
    event: "payment.succeeded", externalId: input.externalId, purpose: input.purpose ?? "MERCHANT_SALE", sellerBusinessId: input.sellerBusinessId,
    invoiceId: input.invoiceId, amountMinor: input.amountMinor.toString(), currencyCode: input.currencyCode,
  });
  return { body, signature: signSimulatorBody(body, input.secret) };
}

export type SimulatorReceiveResult = { status: "recorded" | "duplicate" } | { status: "rejected"; reason: "BAD_SIGNATURE" | "BAD_BODY" | "PURPOSE_FORBIDDEN" };

/** The HTTP edge: authenticate, check the purpose, persist, acknowledge. Processing happens later from the inbox. */
export async function receiveSimulatorCallback(prisma: PrismaClient, rawBody: string, signature: string, secret: string): Promise<SimulatorReceiveResult> {
  if (!verifySimulatorSignature(rawBody, signature, secret)) return { status: "rejected", reason: "BAD_SIGNATURE" };
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: "rejected", reason: "BAD_BODY" };
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return { status: "rejected", reason: "BAD_BODY" };
  try {
    assertProviderAllowedForPurpose(SIMULATOR_PROVIDER, parsed.data.purpose);
  } catch (error) {
    if (error instanceof PaymentPurposeForbiddenError) return { status: "rejected", reason: "PURPOSE_FORBIDDEN" };
    throw error;
  }
  const r = await recordCallback(prisma, { provider: SIMULATOR_PROVIDER, externalId: parsed.data.externalId, payload: parsed.data, signatureVerified: true });
  return { status: r.inserted ? "recorded" : "duplicate" };
}

/**
 * Inbox handler: applies one stored, verified callback to the seller's invoice and mirrors the payment to the buyer.
 * Never trusts an unverified row. Both halves are idempotent, so a retry after a partial failure converges.
 */
export function simulatorCallbackHandler(prisma: PrismaClient) {
  return async (callback: CallbackInbox): Promise<void> => {
    if (!callback.signatureVerified) throw new Error("Refusing to apply an unverified simulator callback.");
    const event = eventSchema.parse(callback.payload);
    assertProviderAllowedForPurpose(SIMULATOR_PROVIDER, event.purpose);
    const seller = getTenantScopedClient(prisma, event.sellerBusinessId);
    const invoice = await seller.tradeInvoice.findUnique({ where: { id: event.invoiceId } });
    if (!invoice) throw new Error("The invoice named by this callback does not exist for that seller.");
    const { payment } = await applyProviderPayment(prisma, {
      sellerBusinessId: event.sellerBusinessId, invoiceId: event.invoiceId, provider: SIMULATOR_PROVIDER, externalId: event.externalId,
      amountMinor: BigInt(event.amountMinor), currencyCode: event.currencyCode, evidence: "SIMULATOR_CONFIRMED",
    });
    if (payment.state === "APPLIED" && invoice.counterpartInvoiceId) {
      const buyerInvoice = await prisma.tradeInvoice.findUnique({ where: { id: invoice.counterpartInvoiceId } });
      if (buyerInvoice) {
        const mirrored = await applyProviderPaymentToBuyer(prisma, {
          buyerBusinessId: buyerInvoice.businessId, buyerInvoiceId: buyerInvoice.id, provider: SIMULATOR_PROVIDER, externalId: event.externalId,
          amountMinor: BigInt(event.amountMinor), evidence: "SIMULATOR_CONFIRMED", counterpartPaymentId: payment.id,
        });
        if (mirrored && !payment.counterpartPaymentId) await seller.tradePayment.update({ where: { id: payment.id }, data: { counterpartPaymentId: mirrored.id } });
      }
    }
  };
}
