import type { PrismaClient } from "@prisma/client";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { findUnjournaledTransactions } from "../domain/accounting.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { findMembershipDrift } from "../domain/memberships.js";
import { ensureDefaultShopFor } from "../domain/shops.js";
import { findLegacyStockDrift, reconcileStock } from "../domain/stock.js";

/**
 * Scheduled data-integrity checks (decision after Phases 1-3: the detectors existed but nobody ran them). Read-only: nothing is corrected
 * here, a person decides. Run daily by the operations sweep and on demand from System health. Bounded to `maxBusinesses`.
 */
export interface IntegrityFinding {
  check: "MEMBERSHIP_DRIFT" | "UNJOURNALED_TRANSACTIONS" | "STOCK_BALANCE_MISMATCH" | "LEGACY_STOCK_DRIFT";
  businessId: string | null;
  count: number;
  detail: string;
}
export interface IntegrityReport {
  ranAt: string;
  businessesChecked: number;
  truncated: boolean;
  findings: IntegrityFinding[];
}

export async function runIntegrityChecks(prisma: PrismaClient, now: Date = new Date(), maxBusinesses = 200): Promise<IntegrityReport> {
  const findings: IntegrityFinding[] = [];
  const drift = await findMembershipDrift(prisma);
  const driftCount = drift.merchantsWithoutMembership.length + drift.mismatchedStatus.length;
  if (driftCount > 0) findings.push({ check: "MEMBERSHIP_DRIFT", businessId: null, count: driftCount, detail: `${drift.merchantsWithoutMembership.length} merchant(s) without a membership, ${drift.mismatchedStatus.length} with a different status.` });

  const businesses = await prisma.business.findMany({ where: { status: "ACTIVE" }, select: { id: true }, orderBy: { createdAt: "asc" }, take: maxBusinesses + 1 });
  const truncated = businesses.length > maxBusinesses;
  for (const { id } of businesses.slice(0, maxBusinesses)) {
    const scoped = getTenantScopedClient(prisma, id);
    if (await isFeatureEnabled(scoped, id, "accountingJournals")) {
      const missing = await findUnjournaledTransactions(scoped, 500);
      if (missing.length > 0) findings.push({ check: "UNJOURNALED_TRANSACTIONS", businessId: id, count: missing.length, detail: `${missing.length} chat entr${missing.length === 1 ? "y has" : "ies have"} no journal entry (run the journal backfill).` });
    }
    if (await isFeatureEnabled(scoped, id, "stockV2")) {
      const mismatches = await reconcileStock(scoped);
      if (mismatches.length > 0) findings.push({ check: "STOCK_BALANCE_MISMATCH", businessId: id, count: mismatches.length, detail: `${mismatches.length} stock balance(s) differ from the sum of their movements. This should never happen.` });
      const shop = await ensureDefaultShopFor(scoped, id);
      const legacy = await findLegacyStockDrift(scoped, shop.id);
      if (legacy.length > 0) findings.push({ check: "LEGACY_STOCK_DRIFT", businessId: id, count: legacy.length, detail: `${legacy.length} item(s) show different quantities in the old chat tracker and the catalog.` });
    }
  }
  return { ranAt: now.toISOString(), businessesChecked: Math.min(businesses.length, maxBusinesses), truncated, findings };
}
