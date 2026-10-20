import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, TENANT_SCOPED_MODELS } from "../src/db/tenantScope.js";
import { reverseTransaction } from "../src/domain/ledger.js";
import { TENANT_DB_ROLE, TENANT_SETTING, withTenantContext } from "../src/db/tenantContext.js";

/**
 * Database-level protection (expansion Phase 1, decisions P3 / G13; scenarios 18, 29, 30). Operations the database
 * must REFUSE are attempted through raw SQL on the in-process Postgres (testDb.db), because the point is that the
 * DATABASE refuses, not that application code is careful. Setup and error-free paths use Prisma.
 */
let testDb: TestDb;
let prisma: PrismaClient;
let db: PGlite;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  db = testDb.db;
  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });
  await prisma.plan.create({ data: { code: "STARTER", name: "Starter", priceMinor: 500000n, currencyCode: "NGN" } });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

let counter = 0;
async function makeBusiness(options: { synthetic?: boolean } = {}) {
  const n = ++counter;
  const business = await prisma.business.create({
    data: {
      name: `Shop ${n}`,
      countryCode: "NG",
      currencyCode: "NGN",
      languageCode: "en",
      timezone: "Africa/Lagos",
      isSynthetic: options.synthetic ?? false,
    },
  });
  const merchant = await prisma.merchant.create({ data: { businessId: business.id, phoneNumber: `23480000${String(n).padStart(5, "0")}` } });
  return { business, merchant };
}

async function sale(businessId: string, amountMinor = 5000n) {
  return prisma.transaction.create({ data: { businessId, type: "SALE", amountMinor, currencyCode: "NGN", paymentStatus: "PAID" } });
}

/** Asserts the database itself refuses this statement. */
async function refused(sql: string, params: unknown[], message: RegExp) {
  await expect(db.query(sql, params)).rejects.toThrow(message);
}
const APPEND_ONLY = /append-only/;
const NOT_PERMITTED = /not permitted/;

describe("append-only financial tables (scenario 29)", () => {
  it("rejects UPDATE, DELETE and TRUNCATE on Transaction at the database", async () => {
    const { business } = await makeBusiness();
    const t = await sale(business.id);

    await refused(`UPDATE "Transaction" SET "amountMinor" = 1 WHERE id = $1`, [t.id], APPEND_ONLY);
    await refused(`DELETE FROM "Transaction" WHERE id = $1`, [t.id], APPEND_ONLY);
    await refused(`DELETE FROM "Transaction" WHERE "businessId" = $1`, [business.id], APPEND_ONLY);
    await refused(`TRUNCATE "Transaction" CASCADE`, [], /TRUNCATE/);

    const stillThere = await prisma.transaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(stillThere.amountMinor).toBe(5000n); // survived all of it, unchanged
  });

  it("still allows INSERT, so corrections are reversals (scenario 30: the original stays intact)", async () => {
    const { business } = await makeBusiness();
    const original = await sale(business.id, 12000n);
    const reversal = await reverseTransaction(getTenantScopedClient(prisma, business.id), original.id, "mistake");

    expect(reversal.amountMinor).toBe(-12000n);
    expect(reversal.reversalOfTransactionId).toBe(original.id);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: original.id } })).amountMinor).toBe(12000n);
    expect(await prisma.transaction.count({ where: { businessId: business.id } })).toBe(2);
  });

  it.each(["InventoryMovement", "AuditLog", "ConsentLog", "DebtPayment", "AiUsageLedger"])("%s has append-only and truncate guards", async (table) => {
    const { rows } = await db.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgrelid = '"${table}"'::regclass AND NOT tgisinternal`);
    expect(rows.map((r) => r.tgname)).toEqual(expect.arrayContaining([`${table}_append_only`, `${table}_no_truncate`]));
  });

  it("AuditLog rows cannot be edited or removed", async () => {
    const { business } = await makeBusiness();
    const entry = await prisma.auditLog.create({
      data: { businessId: business.id, actorType: "SYSTEM", action: "TEST", entityType: "Business", entityId: business.id },
    });
    await refused(`UPDATE "AuditLog" SET action = 'EDITED' WHERE id = $1`, [entry.id], APPEND_ONLY);
    await refused(`DELETE FROM "AuditLog" WHERE id = $1`, [entry.id], APPEND_ONLY);
  });
});

describe("transaction line items", () => {
  it("allows linking an inventory item exactly once, and nothing else", async () => {
    const { business } = await makeBusiness();
    const t = await sale(business.id);
    const item = await prisma.inventoryItem.create({ data: { businessId: business.id, name: "Rice", normalizedName: "rice" } });
    const line = await prisma.transactionItem.create({
      data: { businessId: business.id, transactionId: t.id, itemName: "Rice", quantity: 2, unitPriceMinor: 2500n, lineTotalMinor: 5000n },
    });

    await refused(`UPDATE "TransactionItem" SET quantity = 3 WHERE id = $1`, [line.id], APPEND_ONLY);
    await refused(`UPDATE "TransactionItem" SET "lineTotalMinor" = 1, "inventoryItemId" = $2 WHERE id = $1`, [line.id, item.id], APPEND_ONLY);

    const linked = await prisma.transactionItem.update({ where: { id: line.id }, data: { inventoryItemId: item.id } });
    expect(linked.inventoryItemId).toBe(item.id);

    await refused(`UPDATE "TransactionItem" SET "inventoryItemId" = NULL WHERE id = $1`, [line.id], APPEND_ONLY);
    await refused(`DELETE FROM "TransactionItem" WHERE id = $1`, [line.id], APPEND_ONLY);
  });
});

describe("delete-protected records (status may change, rows may not vanish)", () => {
  it("Debt, Subscription, Invoice and PaymentRequest cannot be deleted, but their status can change", async () => {
    const { business } = await makeBusiness();
    const customer = await prisma.customer.create({ data: { businessId: business.id, name: "Amina" } });
    const debt = await prisma.debt.create({
      data: { businessId: business.id, customerId: customer.id, originalAmountMinor: 100n, outstandingAmountMinor: 100n, currencyCode: "NGN" },
    });
    const now = new Date();
    const subscription = await prisma.subscription.create({
      data: { businessId: business.id, planCode: "STARTER", status: "ACTIVE", currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) },
    });
    const invoice = await prisma.invoice.create({
      data: { subscriptionId: subscription.id, amountMinor: 500000n, currencyCode: "NGN", status: "PENDING", dueDate: now },
    });
    const paymentRequest = await prisma.paymentRequest.create({
      data: { businessId: business.id, customerId: customer.id, description: "x", amountMinor: 100n, currencyCode: "NGN", status: "PENDING" },
    });

    // status updates are legitimate and still work
    await prisma.debt.update({ where: { id: debt.id }, data: { outstandingAmountMinor: 0n, status: "PAID" } });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "PAID" } });
    await prisma.paymentRequest.update({ where: { id: paymentRequest.id }, data: { status: "PAID" } });

    await refused(`DELETE FROM "Debt" WHERE id = $1`, [debt.id], NOT_PERMITTED);
    await refused(`DELETE FROM "Invoice" WHERE id = $1`, [invoice.id], NOT_PERMITTED);
    await refused(`DELETE FROM "PaymentRequest" WHERE id = $1`, [paymentRequest.id], NOT_PERMITTED);
    await refused(`DELETE FROM "Subscription" WHERE id = $1`, [subscription.id], NOT_PERMITTED);
    await refused(`TRUNCATE "Invoice"`, [], /TRUNCATE/);
  });
});

describe("hard delete is for synthetic or empty businesses only (decision G13)", () => {
  it("lets a synthetic business's financial rows and the business itself be removed", async () => {
    const { business } = await makeBusiness({ synthetic: true });
    const t = await sale(business.id);
    await db.query(`DELETE FROM "Transaction" WHERE id = $1`, [t.id]); // allowed: synthetic
    await db.query(`DELETE FROM "Merchant" WHERE "businessId" = $1`, [business.id]);
    await db.query(`DELETE FROM "Business" WHERE id = $1`, [business.id]);
    expect(await prisma.business.count({ where: { id: business.id } })).toBe(0);
  });

  it("refuses to delete a real business that has a financial trail", async () => {
    const { business } = await makeBusiness();
    await sale(business.id);
    await db.query(`DELETE FROM "Merchant" WHERE "businessId" = $1`, [business.id]);
    await refused(`DELETE FROM "Business" WHERE id = $1`, [business.id], /financial trail/);
  });

  it("allows deleting an abandoned-onboarding business with no financial trail", async () => {
    const { business } = await makeBusiness();
    await db.query(`DELETE FROM "Merchant" WHERE "businessId" = $1`, [business.id]);
    await db.query(`DELETE FROM "Business" WHERE id = $1`, [business.id]);
    expect(await prisma.business.count({ where: { id: business.id } })).toBe(0);
  });

  it("makes isSynthetic immutable, so a real business can never be relabelled to unlock deletion", async () => {
    const real = await makeBusiness();
    const synthetic = await makeBusiness({ synthetic: true });
    await refused(`UPDATE "Business" SET "isSynthetic" = true WHERE id = $1`, [real.business.id], /cannot be changed/);
    await refused(`UPDATE "Business" SET "isSynthetic" = false WHERE id = $1`, [synthetic.business.id], /cannot be changed/);
    await expect(prisma.business.update({ where: { id: real.business.id }, data: { name: "Renamed" } })).resolves.toBeDefined(); // ordinary edits still work
  });
});

describe("row-level security: a second layer of tenant isolation (scenario 18)", () => {
  let a: { business: { id: string } };
  let b: { business: { id: string } };

  beforeAll(async () => {
    await db.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TENANT_DB_ROLE}') THEN CREATE ROLE ${TENANT_DB_ROLE} NOLOGIN; END IF; END $$`);
    await db.exec(`GRANT USAGE ON SCHEMA public TO ${TENANT_DB_ROLE}`);
    await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TENANT_DB_ROLE}`);
    a = await makeBusiness();
    b = await makeBusiness();
    await prisma.customer.create({ data: { businessId: a.business.id, name: "A's customer" } });
    await prisma.customer.create({ data: { businessId: b.business.id, name: "B's customer" } });
  });

  it("covers exactly the tenant-scoped models (the two lists cannot drift apart)", async () => {
    const { rows } = await db.query<{ tablename: string }>(`SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'`);
    expect(rows.map((r) => r.tablename).sort()).toEqual([...TENANT_SCOPED_MODELS].sort());
  });

  it("returns only the active tenant's rows under the tenant role, whatever the query asks for", async () => {
    const seenByA = await withTenantContext(prisma, a.business.id, (tx) => tx.customer.findMany(), { enforceRls: true });
    expect(seenByA.map((c) => c.name)).toEqual(["A's customer"]);
    const seenByB = await withTenantContext(prisma, b.business.id, (tx) => tx.customer.findMany({ where: {} }), { enforceRls: true });
    expect(seenByB.map((c) => c.name)).toEqual(["B's customer"]);
    // an explicit attempt to read the other tenant's rows still finds nothing
    const crossRead = await withTenantContext(prisma, a.business.id, (tx) => tx.customer.findMany({ where: { businessId: b.business.id } }), { enforceRls: true });
    expect(crossRead).toEqual([]);
  });

  it("refuses to write another tenant's rows, and fails closed when no tenant is set", async () => {
    await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${TENANT_DB_ROLE}`);
      await tx.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [a.business.id]);
      await expect(
        tx.query(`INSERT INTO "Customer" (id, "businessId", name, "updatedAt") VALUES (gen_random_uuid()::text, $1, 'Smuggled', now())`, [b.business.id]),
      ).rejects.toThrow(/row-level security/);
    });
    await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${TENANT_DB_ROLE}`);
      const none = await tx.query(`SELECT id FROM "Customer"`); // no tenant set at all
      expect(none.rows).toEqual([]);
    });
  });

  it("leaves the owner path unchanged until the role is adopted, and the setting never leaks between requests", async () => {
    const everyone = await prisma.customer.findMany({ where: { businessId: { in: [a.business.id, b.business.id] } } });
    expect(everyone).toHaveLength(2);
    await withTenantContext(prisma, a.business.id, async () => undefined);
    const rows = await prisma.$queryRaw<{ current_setting: string | null }[]>`SELECT current_setting('app.current_business_id', true) AS current_setting`;
    expect(rows[0]?.current_setting ?? "").toBe("");
  });
});
