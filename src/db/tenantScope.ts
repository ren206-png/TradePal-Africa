import type { PrismaClient } from "@prisma/client";

/**
 * Models that carry a direct `businessId` column and therefore must be
 * mechanically scoped by the extension below. Kept in sync with
 * prisma/schema.prisma — every model with a `businessId` field belongs here.
 * Reference/master data (Country, Currency, Language, Plan, ...) and
 * AdminUser are deliberately excluded: they are not tenant data.
 */
const TENANT_SCOPED_MODELS = new Set([
  "Merchant",
  "User",
  "Transaction",
  "TransactionItem",
  "Customer",
  "Supplier",
  "Debt",
  "DebtPayment",
  "InventoryItem",
  "InventoryMovement",
  "Reminder",
  "WhatsAppMessage",
  "MobileMoneyAlert",
  "AiParseLog",
  "Subscription",
  "AuditLog",
  "ConsentLog",
  "DeletionRequest",
  "BusinessFeatureFlag",
  "PaymentRequest",
]);

/**
 * Transaction is append-only per Non-Negotiable Standard #2: corrections
 * happen exclusively via a new row with reversalOfTransactionId set. This is
 * the mechanical enforcement referenced in the Transaction model docstring.
 */
const APPEND_ONLY_MODELS = new Set(["Transaction"]);

const BLOCKED_ON_APPEND_ONLY = new Set(["update", "updateMany", "delete", "deleteMany", "upsert"]);

const CREATE_OPERATIONS = new Set(["create", "createManyAndReturn"]);

export class TenantIsolationViolationError extends Error {}

/**
 * Merges businessId in as a flat sibling filter rather than wrapping in AND:
 * findUnique/findUniqueOrThrow require a unique identifier (e.g. `id`) to
 * appear directly at the top level of `where`, so an AND-wrapped filter
 * would fail Prisma's WhereUniqueInput validation. Merging it in last also
 * means our businessId always wins over anything a caller passed in.
 */
function scopeWhere(where: unknown, businessId: string): Record<string, unknown> {
  return { ...(where as object | undefined), businessId };
}

/** Throws if a create payload names a different business than the active scope, instead of
 * silently rewriting it — a mismatch here means a call site has a real bug worth surfacing. */
function assertNotCrossTenantWrite(model: string, row: Record<string, unknown>, businessId: string): void {
  if ("businessId" in row && row["businessId"] !== undefined && row["businessId"] !== businessId) {
    throw new TenantIsolationViolationError(
      `Refusing to create a ${model} row for businessId '${String(row["businessId"])}' from a client scoped to '${businessId}'.`,
    );
  }
}

/**
 * Returns a Prisma Client scoped to a single business. Every query against a
 * tenant-scoped model has `businessId` merged into its `where` clause (so it
 * cannot be widened by a caller-supplied businessId filter), and every create
 * has `businessId` defaulted into its `data` if omitted, or validated against
 * the scope if the caller did supply one — a mismatch throws rather than
 * being silently corrected. This makes cross-tenant data access a mechanical
 * impossibility rather than something that depends on every call site
 * remembering to filter by business — see Non-Negotiable Standard on tenant
 * isolation.
 *
 * Escape hatch: raw queries ($queryRaw/$executeRaw) are not intercepted by
 * this extension and must not be used for tenant-scoped models.
 */
export function getTenantScopedClient<TClient extends PrismaClient>(prisma: TClient, businessId: string) {
  return prisma.$extends({
    name: "tenantScope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const runQuery = query as (args: unknown) => Promise<unknown>;
          if (!model) return runQuery(args);

          if (APPEND_ONLY_MODELS.has(model) && BLOCKED_ON_APPEND_ONLY.has(operation)) {
            throw new TenantIsolationViolationError(
              `${model} is append-only: '${operation}' is not permitted. Create a reversal row instead.`,
            );
          }

          if (!TENANT_SCOPED_MODELS.has(model)) {
            return runQuery(args);
          }

          const scopedArgs = args as Record<string, unknown>;

          if (CREATE_OPERATIONS.has(operation)) {
            const row = scopedArgs["data"] as Record<string, unknown>;
            assertNotCrossTenantWrite(model, row, businessId);
            scopedArgs["data"] = { ...row, businessId };
          } else if (operation === "createMany") {
            const data = scopedArgs["data"];
            scopedArgs["data"] = Array.isArray(data)
              ? data.map((row: Record<string, unknown>) => {
                  assertNotCrossTenantWrite(model, row, businessId);
                  return { ...row, businessId };
                })
              : data;
          } else if ("where" in scopedArgs || operation.startsWith("find") || operation === "aggregate" || operation === "count" || operation === "groupBy") {
            scopedArgs["where"] = scopeWhere(scopedArgs["where"], businessId);
          }

          return runQuery(scopedArgs);
        },
      },
    },
  });
}

export type TenantScopedClient = ReturnType<typeof getTenantScopedClient>;
