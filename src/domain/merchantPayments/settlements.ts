import type { PrismaClient, TradePaymentEvidence } from "@prisma/client";
import { getTenantScopedClient, withScopedTransaction } from "../../db/tenantScope.js";
import type { SettlementReport } from "../../payments/adapter.js";
import { postJournal } from "../accounting.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { raiseProviderException } from "./common.js";

/**
 * Settlement: the provider paying collected money out to the merchant (expansion section 12). It is a balance-sheet movement
 * (Dr bank for the net, Dr payment fees for the fee, Cr provider clearing for the gross), never a second sale and never revenue
 * (scenario 13). Payment completion and settlement completion are separate: an attempt is paid when the provider says so, and
 * settled when a settlement report lists it. A report that does not add up, or names another merchant's money, posts nothing
 * and raises an exception.
 */
export async function recordSettlementReport(
  prisma: PrismaClient,
  input: { provider: string; report: SettlementReport; evidence: Extract<TradePaymentEvidence, "SIMULATOR_CONFIRMED" | "PROVIDER_CONFIRMED">; eventId?: string; now?: Date },
): Promise<{ status: "POSTED" | "REPLAY" | "EXCEPTION"; settlementId?: string }> {
  const now = input.now ?? new Date();
  const { report, provider } = input;
  const fp = (k: string) => `settlement:${provider}:${report.reference}:${k}`;
  const refs = report.lines.map((l) => l.externalRef);
  const attempts = await prisma.paymentAttempt.findMany({ where: { provider, externalRef: { in: refs } }, include: { connection: true } });

  const fail = async (type: "SETTLEMENT_MISMATCH" | "DESTINATION_MISMATCH" | "CURRENCY_MISMATCH" | "UNKNOWN_REFERENCE" | "WRONG_TENANT", why: string, businessId?: string) => {
    await raiseProviderException(prisma, { type, fingerprint: fp(type), provider, businessId: businessId ?? null, amountMinor: report.grossMinor, currencyCode: report.currencyCode, details: { reference: report.reference, why, eventId: input.eventId ?? null } });
    return { status: "EXCEPTION" as const };
  };

  if (attempts.length !== new Set(refs).size) return fail("UNKNOWN_REFERENCE", "The report lists a payment we have no record of.");
  const businessIds = new Set(attempts.map((a) => a.businessId));
  if (businessIds.size !== 1) return fail("WRONG_TENANT", "One settlement may only cover one merchant's payments.");
  const businessId = [...businessIds][0]!;
  const connection = attempts[0]!.connection;
  if (connection.provider !== provider) return fail("SETTLEMENT_MISMATCH", "Wrong provider.", businessId);
  if (report.destinationKey !== connection.destinationKey) return fail("DESTINATION_MISMATCH", "The payout is for a different account than this merchant's connection.", businessId);
  if (attempts.some((a) => a.currencyCode !== report.currencyCode)) return fail("CURRENCY_MISMATCH", "The report is in a different currency from the payments.", businessId);

  const scoped = getTenantScopedClient(prisma, businessId);
  const already = await scoped.providerSettlement.findFirst({ where: { provider, reference: report.reference } });
  if (already) return { status: "REPLAY", settlementId: already.id };

  const grossSum = report.lines.reduce((n, l) => n + l.grossMinor, 0n);
  const feeSum = report.lines.reduce((n, l) => n + l.feeMinor, 0n);
  if (grossSum !== report.grossMinor || feeSum !== report.feeMinor || report.grossMinor - report.feeMinor !== report.netMinor) return fail("SETTLEMENT_MISMATCH", "The report's totals do not add up to its lines.", businessId);
  for (const l of report.lines) {
    const a = attempts.find((x) => x.externalRef === l.externalRef)!;
    if (a.status !== "SUCCEEDED") return fail("SETTLEMENT_MISMATCH", `Payment ${l.externalRef} is not a collected payment on our side.`, businessId);
    if (a.settledAt !== null) return fail("SETTLEMENT_MISMATCH", `Payment ${l.externalRef} was already settled.`, businessId);
    if (l.grossMinor <= 0n || l.grossMinor > a.capturedMinor || l.feeMinor < 0n || l.feeMinor > l.grossMinor) return fail("SETTLEMENT_MISMATCH", `Payment ${l.externalRef} has impossible amounts.`, businessId);
  }

  const settlementId = await withScopedTransaction(scoped, async (tx) => {
    const created = await tx.providerSettlement.createMany({
      data: [{ businessId, connectionId: connection.id, provider, reference: report.reference, grossMinor: report.grossMinor, feeMinor: report.feeMinor, netMinor: report.netMinor, currencyCode: report.currencyCode, settledAt: report.settledAt, status: "POSTED", evidence: input.evidence }],
      skipDuplicates: true,
    });
    const row = await tx.providerSettlement.findFirstOrThrow({ where: { provider, reference: report.reference } });
    if (created.count !== 1) return row.id; // a concurrent delivery already posted it
    await tx.providerSettlementLine.createMany({ data: report.lines.map((l) => ({ businessId, settlementId: row.id, attemptId: attempts.find((a) => a.externalRef === l.externalRef)!.id, grossMinor: l.grossMinor, feeMinor: l.feeMinor })) });
    for (const l of report.lines) {
      const a = attempts.find((x) => x.externalRef === l.externalRef)!;
      await tx.paymentAttempt.updateMany({ where: { id: a.id, settledAt: null }, data: { settledAt: report.settledAt, feeMinor: l.feeMinor } });
    }
    if (await isFeatureEnabled(tx, businessId, "accountingJournals")) {
      const entry = await postJournal(tx, {
        businessId, currencyCode: report.currencyCode, kind: "PROVIDER_SETTLEMENT", occurredAt: report.settledAt, idempotencyKey: `settlement:${row.id}`,
        source: { type: "PROVIDER_SETTLEMENT", id: row.id }, memo: `Settlement ${report.reference} from ${provider}`, evidenceRef: `${provider}:${report.reference}`,
        lines: [
          ...(report.netMinor > 0n ? [{ account: "BANK" as const, debitMinor: report.netMinor }] : []),
          ...(report.feeMinor > 0n ? [{ account: "PAYMENT_FEES" as const, debitMinor: report.feeMinor }] : []),
          { account: "PROVIDER_CLEARING" as const, creditMinor: report.grossMinor },
        ],
      });
      await tx.providerSettlement.update({ where: { id: row.id }, data: { journalEntryId: entry.entry.id } });
    }
    return row.id;
  });
  void now;
  return { status: "POSTED", settlementId };
}
