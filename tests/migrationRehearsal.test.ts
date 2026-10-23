import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { getTenantScopedClient } from "../src/db/tenantScope.js";
import { reverseTransaction } from "../src/domain/ledger.js";

vi.setConfig({ testTimeout: 180_000 });

/**
 * Migration rehearsal (expansion Phase 8, scenario 22): "migration rehearsal preserves balances, ownership, references, subscription
 * status". A database is built from ONLY the migrations that existed before the expansion, filled with a realistic legacy dataset, then
 * every expansion migration is applied in order and the data is compared: row by row for every legacy column, plus the business meaning
 * (balances, owners, references, subscription state). Finally the application itself is run against the migrated data.
 *
 * What this is NOT: a run on a real Postgres server or a restored production backup. It uses the in-process Postgres the rest of the
 * suite uses (PGlite), which is a superuser, has one connection, and takes no locks that matter. `scripts/rehearseMigrations.sh` is the
 * real rehearsal and remains unrun.
 */
const DIR = path.resolve(process.cwd(), "prisma/migrations");
const ALL = fs.readdirSync(DIR).filter((n) => fs.statSync(path.join(DIR, n)).isDirectory()).sort();
const FIRST_EXPANSION = "20261020000000_phase1_payment_purpose";
const LEGACY = ALL.filter((n) => n < FIRST_EXPANSION);
const EXPANSION = ALL.filter((n) => n >= FIRST_EXPANSION);
const sql = (n: string) => fs.readFileSync(path.join(DIR, n, "migration.sql"), "utf8");

let db: PGlite;
// With TEST_PG_ADMIN_URL set, the same rehearsal runs on a REAL local Postgres (as a plain non-superuser owner), see tests/helpers/db.ts.
const REAL_URL = process.env["TEST_PG_ADMIN_URL"];
let realUrl = "";
let realClient: pg.Client | null = null;
let realName = "";
async function makeRealDb(admin: string): Promise<PGlite> {
  realName = `rehearse_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rehearsal_owner') THEN CREATE ROLE rehearsal_owner LOGIN PASSWORD 'x'; END IF; END $$`);
  await a.query(`CREATE DATABASE "${realName}" OWNER rehearsal_owner`);
  await a.end();
  const u = new URL(admin);
  u.username = "rehearsal_owner";
  u.password = "x";
  u.pathname = `/${realName}`;
  realUrl = u.toString();
  realClient = new pg.Client({ connectionString: realUrl, types: { getTypeParser: (oid: number, f?: string) => (oid === 20 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, f as "text")) } as never });
  await realClient.connect();
  return {
    exec: async (t: string) => { await realClient!.query(t); },
    query: async (t: string, p?: unknown[]) => ({ rows: (await realClient!.query(t, p as never[])).rows }),
    close: async () => { await realClient!.end(); const b = new pg.Client({ connectionString: admin }); await b.connect(); await b.query(`DROP DATABASE IF EXISTS "${realName}" WITH (FORCE)`); await b.end(); },
  } as unknown as PGlite;
}
const legacyColumns = new Map<string, string[]>();
type Snapshot = { rowHashes: Record<string, string>; counts: Record<string, number>; meaning: Record<string, unknown> };
let before: Snapshot;
let after: Snapshot;

const T0 = "2026-09-01T10:00:00Z";
const ids = {
  bizNG: "b0000000-0000-4000-8000-000000000001", bizSL: "b0000000-0000-4000-8000-000000000002", bizKE: "b0000000-0000-4000-8000-000000000003",
};

async function seedLegacy(): Promise<void> {
  const q = (text: string, params: unknown[] = []) => db.query(text, params);
  await q(`INSERT INTO "Currency" (code, name, "minorUnitExp") VALUES ('NGN','Naira',2),('SLE','New Leone',2),('KES','Shilling',2) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO "Country" (code, name, "callingCode", "defaultCurrency", "defaultTimezone") VALUES ('NG','Nigeria','234','NGN','Africa/Lagos'),('SL','Sierra Leone','232','SLE','Africa/Freetown'),('KE','Kenya','254','KES','Africa/Nairobi') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO "Language" (code, name) VALUES ('en','English') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO "Plan" (code, name, "priceMinor", "currencyCode") VALUES ('FREE','Free',0,'NGN'),('STARTER','Starter',500000,'NGN'),('PRO','Pro',1500000,'NGN') ON CONFLICT DO NOTHING`);
  const biz = [[ids.bizNG, "Ade Foods", "NG", "NGN", "Africa/Lagos"], [ids.bizSL, "Fatu Traders", "SL", "SLE", "Africa/Freetown"], [ids.bizKE, "Wanjiru Shop", "KE", "KES", "Africa/Nairobi"]];
  for (const [id, name, c, cur, tz] of biz) await q(`INSERT INTO "Business" (id, name, "countryCode", "currencyCode", "languageCode", timezone, "updatedAt") VALUES ($1,$2,$3,$4,'en',$5,now())`, [id, name, c, cur, tz]);
  // owners and a staff member
  const merchants: [string, string, string, string][] = [["m1", ids.bizNG, "2348011110001", "OWNER"], ["m2", ids.bizNG, "2348011110002", "STAFF"], ["m3", ids.bizSL, "23276000001", "OWNER"], ["m4", ids.bizKE, "254711000001", "OWNER"]];
  for (const [id, b, phone, role] of merchants) await q(`INSERT INTO "Merchant" (id, "businessId", "phoneNumber", role, "updatedAt") VALUES ($1,$2,$3,$4::"MerchantRole",now())`, [id, b, phone, role]);
  for (const [id, b, name] of [["c1", ids.bizNG, "Tunde the tailor"], ["c2", ids.bizNG, "Mama Ngozi"], ["c3", ids.bizSL, "Aminata"]]) await q(`INSERT INTO "Customer" (id, "businessId", name, "updatedAt") VALUES ($1,$2,$3,now())`, [id, b, name]);
  await q(`INSERT INTO "Supplier" (id, "businessId", name) VALUES ('s1',$1,'Lagos Wholesale')`, [ids.bizNG]);
  // transactions: every type, a reversal pair, itemised sale
  const tx = (id: string, b: string, type: string, amt: number, cur: string, status: string, extra: { cust?: string; sup?: string; wa?: string; rev?: string; at?: string } = {}) =>
    q(`INSERT INTO "Transaction" (id, "businessId", type, "amountMinor", "currencyCode", "paymentStatus", "customerId", "supplierId", "whatsappMessageId", "reversalOfTransactionId", "createdAt") VALUES ($1,$2,$3::"TransactionType",$4,$5,$6::"PaymentStatus",$7,$8,$9,$10,$11)`,
      [id, b, type, amt, cur, status, extra.cust ?? null, extra.sup ?? null, extra.wa ?? null, extra.rev ?? null, extra.at ?? T0]);
  await tx("t1", ids.bizNG, "SALE", 150000, "NGN", "PAID", { wa: "wamid.A1" });
  await tx("t2", ids.bizNG, "SALE", 400000, "NGN", "CREDIT", { cust: "c1", wa: "wamid.A2" });
  await tx("t3", ids.bizNG, "PURCHASE", 90000, "NGN", "PAID", { sup: "s1", wa: "wamid.A3" });
  await tx("t4", ids.bizNG, "EXPENSE", 25000, "NGN", "PAID", { wa: "wamid.A4" });
  await tx("t5", ids.bizNG, "PAYMENT_RECEIVED", 100000, "NGN", "PAID", { cust: "c1", wa: "wamid.A5" });
  await tx("t6", ids.bizNG, "DEBT_NOTE", 30000, "NGN", "CREDIT", { cust: "c2", wa: "wamid.A6" });
  await tx("t7", ids.bizNG, "SALE", 70000, "NGN", "PAID", { wa: "wamid.A7" }); // mistaken, reversed below
  await tx("t8", ids.bizNG, "SALE", -70000, "NGN", "PAID", { rev: "t7", wa: "wamid.A8" });
  await tx("t9", ids.bizSL, "SALE", 9900000, "SLE", "PAID", { wa: "wamid.B1" });
  await tx("t10", ids.bizSL, "EXPENSE", 150000, "SLE", "PAID", { wa: "wamid.B2" });
  await tx("t11", ids.bizKE, "SALE", 250000, "KES", "PARTIAL", { wa: "wamid.C1" });
  await q(`INSERT INTO "TransactionItem" (id, "businessId", "transactionId", "itemName", quantity, "unitPriceMinor", "lineTotalMinor") VALUES ('ti1',$1,'t1','Bread',3,50000,150000)`, [ids.bizNG]);
  // debts and a partial payment
  await q(`INSERT INTO "Debt" (id, "businessId", "customerId", "originTransactionId", "originalAmountMinor", "outstandingAmountMinor", "currencyCode", status, "updatedAt") VALUES ('d1',$1,'c1','t2',400000,300000,'NGN','PARTIALLY_PAID',now()),('d2',$1,'c2','t6',30000,30000,'NGN','OPEN',now())`, [ids.bizNG]);
  await q(`INSERT INTO "DebtPayment" (id, "businessId", "debtId", "transactionId", "amountMinor") VALUES ('dp1',$1,'d1','t5',100000)`, [ids.bizNG]);
  // inventory
  await q(`INSERT INTO "InventoryItem" (id, "businessId", name, "normalizedName", "estimatedStockQty", "updatedAt") VALUES ('i1',$1,'Bread','bread',47,now()),('i2',$1,'Flour','flour',12,now())`, [ids.bizNG]);
  await q(`INSERT INTO "InventoryMovement" (id, "businessId", "inventoryItemId", "quantityDelta", source, "transactionId") VALUES ('im1',$1,'i1',50,'PURCHASE'::"MovementSource",NULL),('im2',$1,'i1',-3,'SALE'::"MovementSource",'t1')`, [ids.bizNG]);
  // subscriptions in every state, with invoices
  const sub = (id: string, b: string, plan: string, status: string, start: string, end: string) => q(`INSERT INTO "Subscription" (id, "businessId", "planCode", status, "currentPeriodStart", "currentPeriodEnd") VALUES ($1,$2,$3,$4::"SubscriptionStatus",$5,$6)`, [id, b, plan, status, start, end]);
  await sub("sub1", ids.bizNG, "STARTER", "ACTIVE", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");
  await sub("sub2", ids.bizSL, "PRO", "PAST_DUE", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
  await sub("sub3", ids.bizKE, "STARTER", "PENDING", "2026-09-15T00:00:00Z", "2026-10-15T00:00:00Z");
  await q(`INSERT INTO "PaymentProvider" (code, "countryCode", config, enabled) VALUES ('FLUTTERWAVE','NG','{}',true)`);
  await q(`INSERT INTO "Invoice" (id, "subscriptionId", "amountMinor", "currencyCode", status, "dueDate", "paidAt", "providerCode", "providerReference") VALUES
    ('inv1','sub1',500000,'NGN','PAID','2026-09-01T00:00:00Z','2026-09-01T09:00:00Z','FLUTTERWAVE','tx-ref-1'),
    ('inv2','sub2',1500000,'SLE','PENDING','2026-09-01T00:00:00Z',NULL,'FLUTTERWAVE','tx-ref-2'),
    ('inv3','sub3',500000,'KES','FAILED','2026-09-15T00:00:00Z',NULL,NULL,NULL)`);
  await q(`INSERT INTO "AuditLog" (id, "actorType", action, "entityType", "businessId") VALUES ('al1','MERCHANT'::"ActorType",'TRANSACTION_CREATED','Transaction',$1),('al2','ADMIN'::"ActorType",'FLAG_CHANGED','FeatureFlag',NULL)`, [ids.bizNG]);
  await q(`INSERT INTO "WebhookEvent" (id, "waMessageId", payload, status) VALUES ('w1','wamid.A1','{"a":1}','PROCESSED'),('w2','wamid.A9','{"a":2}','PENDING')`);
  await q(`INSERT INTO "PaymentRequest" (id, "businessId", description, "amountMinor", "currencyCode", status) VALUES ('pr1',$1,'Order 17',50000,'NGN','PENDING')`, [ids.bizNG]);
  await q(`INSERT INTO "ConsentLog" (id, "businessId", "merchantId", "consentType", "textVersion", channel) VALUES ('cl1',$1,'m1','ONBOARDING_TERMS'::"ConsentType",'v1','whatsapp')`, [ids.bizNG]);
  await q(`INSERT INTO "FeatureFlag" (key, description, "enabledByDefault") VALUES ('voiceTranscription','legacy flag',false) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO "BusinessFeatureFlag" (id, "businessId", "flagKey", enabled) VALUES ('bf1',$1,'voiceTranscription',true)`, [ids.bizNG]);
}

const TABLES = ["Currency", "Country", "Language", "Plan", "Business", "Merchant", "Customer", "Supplier", "Transaction", "TransactionItem", "Debt", "DebtPayment", "InventoryItem", "InventoryMovement", "Subscription", "Invoice", "AuditLog", "WebhookEvent", "PaymentRequest", "ConsentLog", "FeatureFlag", "BusinessFeatureFlag", "PaymentProvider"];

/** The expansion legitimately ADDS rows to the flag table; what must not change is the rows that existed before. */
const ONLY_EXISTING: Record<string, string> = { FeatureFlag: `WHERE key = 'voiceTranscription'` };

async function snapshot(): Promise<Snapshot> {
  const rowHashes: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const cols = legacyColumns.get(t)!.map((c) => `"${c}"`).join(", ");
    const r = await db.query<{ h: string | null; n: number }>(`SELECT md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS h, count(*)::int AS n FROM (SELECT ${cols} FROM "${t}" ${ONLY_EXISTING[t] ?? ""}) x`);
    rowHashes[t] = r.rows[0]!.h ?? "";
    counts[t] = r.rows[0]!.n;
  }
  const one = async <T>(text: string) => (await db.query<T>(text)).rows;
  const meaning = {
    // balances: what each business sold, spent, is owed, and holds in stock (reversals netted)
    salesByBusiness: await one(`SELECT "businessId", sum("amountMinor")::text AS net FROM "Transaction" WHERE type='SALE' GROUP BY 1 ORDER BY 1`),
    debtOutstanding: await one(`SELECT "businessId", sum("outstandingAmountMinor")::text AS owed FROM "Debt" GROUP BY 1 ORDER BY 1`),
    stock: await one(`SELECT "businessId", sum("estimatedStockQty")::text AS units FROM "InventoryItem" GROUP BY 1 ORDER BY 1`),
    // ownership: which phone belongs to which business and with what role
    owners: await one(`SELECT "phoneNumber", "businessId", role::text FROM "Merchant" ORDER BY 1`),
    // references: external ids that other systems hold
    references: await one(`SELECT "whatsappMessageId" FROM "Transaction" WHERE "whatsappMessageId" IS NOT NULL ORDER BY 1`),
    invoiceRefs: await one(`SELECT id, "providerReference", status, "amountMinor"::text FROM "Invoice" ORDER BY 1`),
    // subscription status
    subscriptions: await one(`SELECT id, "businessId", "planCode", status::text, "currentPeriodEnd"::text FROM "Subscription" ORDER BY 1`),
    reversalLinks: await one(`SELECT id, "reversalOfTransactionId" FROM "Transaction" WHERE "reversalOfTransactionId" IS NOT NULL`),
  };
  return { rowHashes, counts, meaning };
}

beforeAll(async () => {
  db = REAL_URL ? await makeRealDb(REAL_URL) : new PGlite();
  for (const n of LEGACY) await db.exec(sql(n));
  for (const t of TABLES) {
    const r = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
    legacyColumns.set(t, r.rows.map((x) => x.column_name));
  }
  await seedLegacy();
  before = await snapshot();
  for (const n of EXPANSION) await db.exec(sql(n));
  after = await snapshot();
}, 180_000);
afterAll(async () => {
  await db.close();
});

describe("the legacy database is what we think it is", () => {
  it("has the legacy dataset and is built from the pre-expansion migrations only", () => {
    expect(LEGACY.length).toBeGreaterThanOrEqual(12);
    expect(EXPANSION.length).toBeGreaterThanOrEqual(12);
    expect(before.counts).toMatchObject({ Business: 3, Merchant: 4, Transaction: 11, Debt: 2, InventoryItem: 2, Subscription: 3, Invoice: 3 });
  });
});

describe("after every expansion migration (scenario 22)", () => {
  it("every legacy row is byte-for-byte what it was, in every legacy column of every legacy table", () => {
    const changed = Object.keys(before.counts).filter((t) => before.counts[t] !== after.counts[t] || before.rowHashes[t] !== after.rowHashes[t]);
    expect(changed.map((t) => `${t}: ${before.counts[t]} -> ${after.counts[t]}`)).toEqual([]);
  });

  it("balances are identical: sales (reversals netted), debts owed, stock on hand", () => {
    expect(after.meaning["salesByBusiness"]).toEqual(before.meaning["salesByBusiness"]);
    expect(after.meaning["debtOutstanding"]).toEqual(before.meaning["debtOutstanding"]);
    expect(after.meaning["stock"]).toEqual(before.meaning["stock"]);
    expect(before.meaning["salesByBusiness"]).toEqual(expect.arrayContaining([{ businessId: ids.bizNG, net: "550000" }])); // 150000 + 400000 + 70000 - 70000
  });

  it("ownership is identical, and every merchant has a membership with the matching role in a default shop of their own business", async () => {
    expect(after.meaning["owners"]).toEqual(before.meaning["owners"]);
    const shops = await db.query<{ businessId: string; n: number }>(`SELECT "businessId", count(*)::int AS n FROM "Shop" WHERE "isDefault" GROUP BY 1`);
    expect(shops.rows.map((r) => [r.businessId, r.n]).sort()).toEqual([[ids.bizNG, 1], [ids.bizSL, 1], [ids.bizKE, 1]].sort());
    const members = await db.query<{ phoneNumber: string; businessId: string; role: string; status: string }>(`SELECT "phoneNumber", "businessId", role::text, status::text FROM "Membership" ORDER BY 1`);
    expect(members.rows).toEqual([
      { phoneNumber: "23276000001", businessId: ids.bizSL, role: "OWNER", status: "ACTIVE" },
      { phoneNumber: "2348011110001", businessId: ids.bizNG, role: "OWNER", status: "ACTIVE" },
      { phoneNumber: "2348011110002", businessId: ids.bizNG, role: "SALES_CLERK", status: "ACTIVE" },
      { phoneNumber: "254711000001", businessId: ids.bizKE, role: "OWNER", status: "ACTIVE" },
    ]);
  });

  it("external references are unchanged: WhatsApp message ids, reversal links, invoice references", () => {
    expect(after.meaning["references"]).toEqual(before.meaning["references"]);
    expect(after.meaning["reversalLinks"]).toEqual(before.meaning["reversalLinks"]);
    expect(after.meaning["invoiceRefs"]).toEqual(before.meaning["invoiceRefs"]);
  });

  it("subscription status, plan and period are unchanged, and none was silently put on a plan version or set to cancel", async () => {
    expect(after.meaning["subscriptions"]).toEqual(before.meaning["subscriptions"]);
    const r = await db.query<{ planVersionId: string | null; pendingPlanVersionId: string | null; cancelAtPeriodEnd: boolean }>(`SELECT "planVersionId", "pendingPlanVersionId", "cancelAtPeriodEnd" FROM "Subscription"`);
    expect(r.rows.every((x) => x.planVersionId === null && x.pendingPlanVersionId === null && x.cancelAtPeriodEnd === false)).toBe(true);
  });

  it("a legacy PAID invoice reports what was paid, so the billing screens and refund limits are not left at zero", async () => {
    const r = await db.query<{ id: string; status: string; amountMinor: string; paidMinor: string }>(`SELECT id, status, "amountMinor"::text, "paidMinor"::text FROM "Invoice" ORDER BY id`);
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(by["inv1"]).toMatchObject({ status: "PAID", paidMinor: "500000" });
    expect(by["inv2"]!.paidMinor).toBe("0");
    expect(by["inv3"]!.paidMinor).toBe("0");
  });

  it("nothing new is switched on: every new flag is OFF, the one legacy per-business override survives, and no journal or stock rows appeared", async () => {
    const on = await db.query<{ key: string }>(`SELECT key FROM "FeatureFlag" WHERE "enabledByDefault"`);
    expect(on.rows).toEqual([]);
    const flags = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "FeatureFlag"`);
    expect(flags.rows[0]!.n).toBeGreaterThan(15);
    const override = await db.query(`SELECT enabled FROM "BusinessFeatureFlag" WHERE "flagKey"='voiceTranscription'`);
    expect(override.rows).toEqual([{ enabled: true }]);
    for (const t of ["JournalEntry", "StockMovement", "StoreOrder", "TradeOrder", "PaymentIntent", "ContactConsent", "OutboundMessageLog", "OfflineDraft"]) {
      const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`);
      expect(n.rows[0]!.n, t).toBe(0);
    }
  });

  it("the new protections apply to the old rows too: a posted transaction cannot be edited or deleted, and a correction is still a new row", async () => {
    await expect(db.query(`UPDATE "Transaction" SET "amountMinor" = 1 WHERE id = 't1'`)).rejects.toThrow(/append-only|not permitted/i);
    await expect(db.query(`DELETE FROM "Transaction" WHERE id = 't1'`)).rejects.toThrow(/append-only|not permitted/i);
    await db.query(`INSERT INTO "Transaction" (id, "businessId", type, "amountMinor", "currencyCode", "paymentStatus", "reversalOfTransactionId") VALUES ('t99',$1,'SALE'::"TransactionType",-150000,'NGN','PAID'::"PaymentStatus",'t1')`, [ids.bizNG]);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Transaction" WHERE "reversalOfTransactionId" = 't1'`);
    expect(n.rows[0]!.n).toBe(1);
  });
});

describe("the application runs against the migrated legacy data", () => {
  it("answers /today, /debt and /undo for a legacy merchant, and keeps every expansion command off", async () => {
    // a Prisma client over the same in-process database (the schema engine cannot talk to PGlite, the query engine can)
    const server = REAL_URL ? null : new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 10 });
    if (server) await server.start();
    const port = server ? server.getServerConn().split(":").pop() : "";
    const prisma = new PrismaClient({ datasourceUrl: REAL_URL ? realUrl : `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` });
    try {
      const scoped = getTenantScopedClient(prisma, ids.bizNG);
      const ctx: CommandContext = { prisma, scopedPrisma: scoped, businessId: ids.bizNG, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m1", merchantRole: "OWNER" };
      expect(await handleCommand(ctx, "/today")).toContain("Today (Africa/Lagos)");
      expect(await handleCommand(ctx, "/debts")).toMatch(/Tunde|Mama Ngozi/);
      for (const c of ["/store", "/report sales", "/plans", "/connect", "/close"]) expect(await handleCommand(ctx, c), c).toContain("Unrecognized command");
      // the legacy bookkeeping still reverses cleanly on a legacy row
      const last = await scoped.transaction.findFirstOrThrow({ where: { id: "t4" } });
      const reversal = await reverseTransaction(scoped, last.id, "rehearsal");
      expect(reversal.amountMinor).toBe(-25000n);
      // plan lookups and the subscription state still work for a legacy subscription (no plan version)
      const { getEntitlement } = await import("../src/domain/subscriptions/entitlements.js");
      const e = await getEntitlement(scoped, ids.bizNG, new Date("2026-09-15T00:00:00Z"));
      expect(e.state).toBeDefined();
    } finally {
      await prisma.$disconnect();
      if (server) await server.stop();
    }
  });
});
