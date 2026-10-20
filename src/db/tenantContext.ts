import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Database-level tenant isolation (second layer; expansion decision P3).
 *
 * `getTenantScopedClient` (tenantScope.ts) scopes queries in application code. Postgres row-level-security
 * policies (migration 20261020000100_phase1_db_protection) enforce the same rule in the database, but the
 * table owner bypasses RLS, so they only bite when a request runs under a non-owner role. This helper runs
 * a unit of work in a transaction that (1) sets the transaction-local tenant, and (optionally) (2) downshifts
 * to the non-owner role, so a query that forgot its businessId filter returns nothing instead of another
 * business's rows.
 *
 * Activation (a runbook step, not automatic): create the role once, `CREATE ROLE tradepal_tenant NOLOGIN` with
 * SELECT/INSERT/UPDATE/DELETE on the tenant tables, then pass `{ enforceRls: true }` from the code paths being
 * migrated. Until then `enforceRls` defaults to false and behaviour is unchanged.
 */
export const TENANT_DB_ROLE = "tradepal_tenant";
export const TENANT_SETTING = "app.current_business_id";

export interface TenantContextOptions {
  /** Downshift to TENANT_DB_ROLE for the transaction so row-level security actually applies. */
  enforceRls?: boolean;
}

export async function withTenantContext<T>(
  prisma: PrismaClient,
  businessId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TenantContextOptions = {},
): Promise<T> {
  if (!businessId) throw new Error("withTenantContext requires a businessId.");
  return prisma.$transaction(async (tx) => {
    // is_local = true: the setting disappears when the transaction ends, so it can never leak to the next request.
    await tx.$executeRaw`SELECT set_config(${TENANT_SETTING}, ${businessId}, true)`;
    if (options.enforceRls) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${TENANT_DB_ROLE}`);
    return work(tx);
  });
}
