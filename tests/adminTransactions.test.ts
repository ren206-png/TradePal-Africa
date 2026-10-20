import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { createAdminRouter } from "../src/admin/adminRoutes.js";
import { createAdminUser } from "../src/admin/adminUsers.js";
import { STEP_UP_HEADER } from "../src/admin/platformGuards.js";
import { csvNumber, csvText } from "../src/admin/csv.js";
import { accountNet } from "../src/domain/accounting.js";
import { applyStockMovement } from "../src/domain/inventory.js";
import { recordTransaction } from "../src/domain/ledger.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { fulfilSale, receiveStock } from "../src/domain/stock.js";

const SECRET = "test-secret-do-not-use-in-production";
const PW = "correct-horse";

let testDb: TestDb;
let prisma: PrismaClient;
let app: express.Express;
let env: Awaited<ReturnType<typeof makeBusiness>>;
let other: Awaited<ReturnType<typeof makeBusiness>>;
let saleId: string;
let creditSaleId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function loginAs(email: string) {
  return (await request(app).post("/admin/login").send({ email, password: PW })).body.token as string;
}
async function setFlag(key: string, on: boolean) {
  await prisma.featureFlag.update({ where: { key }, data: { enabledByDefault: on } });
}

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  env = await makeBusiness(prisma, "Panel Shop");
  other = await makeBusiness(prisma, "Other Shop");
  await enableFlag(prisma, env.businessId, "accountingJournals");

  const customer = await env.scoped.customer.create({ data: { businessId: env.businessId, name: "Mama Put" } });
  const item = await env.scoped.inventoryItem.create({ data: { businessId: env.businessId, name: "Rice", normalizedName: "rice", estimatedStockQty: 10 } });
  const sale = await recordTransaction(env.scoped, {
    businessId: env.businessId, type: "SALE", amountMinor: 20_000n, currencyCode: "NGN", paymentStatus: "PAID", customerId: customer.id,
    description: "2 bags rice", whatsappMessageId: "wamid.AAA", items: [{ itemName: "Rice", quantity: 2, unitPriceMinor: 10_000n, inventoryItemId: item.id }],
  });
  await applyStockMovement(env.scoped, env.businessId, item, -2, "SALE", sale.id);
  saleId = sale.id;
  creditSaleId = (await recordTransaction(env.scoped, { businessId: env.businessId, type: "SALE", amountMinor: 6_000n, currencyCode: "NGN", paymentStatus: "CREDIT", customerId: customer.id, description: "=HYPERLINK(\"http://evil\",\"x\")" })).id;
  await recordTransaction(env.scoped, { businessId: env.businessId, type: "EXPENSE", amountMinor: 1_500n, currencyCode: "NGN", paymentStatus: "PAID", description: "+SUM(1,1) transport" });
  await recordTransaction(other.scoped, { businessId: other.businessId, type: "SALE", amountMinor: 999n, currencyCode: "NGN", paymentStatus: "PAID", description: "other tenant secret" });

  for (const [email, role] of [["super@t.test", "SUPER_ADMIN"], ["op@t.test", "OPERATOR"], ["support@t.test", "SUPPORT"], ["analyst@t.test", "ANALYST"]] as const) {
    await createAdminUser(prisma, { email, name: email, role, password: PW });
  }
  app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(prisma, SECRET));
}, 90_000);

afterAll(async () => {
  await testDb.teardown();
});

beforeEach(async () => {
  await setFlag("adminStepUp", false);
  await setFlag("adminSupportAccessRequired", false);
});

describe("viewing transactions, with provenance and status", () => {
  it("lists a business's transactions with status, provenance and journal link; never another tenant's", async () => {
    const t = await loginAs("support@t.test");
    const r = await request(app).get(`/admin/businesses/${env.businessId}/transactions`).set(auth(t));
    expect(r.status).toBe(200);
    expect(r.body.transactions).toHaveLength(3);
    const sale = r.body.transactions.find((x: { id: string }) => x.id === saleId);
    expect(sale).toMatchObject({ type: "SALE", amountMinor: "20000", status: "POSTED", itemCount: 1, counterparty: "Mama Put", provenance: { label: "MERCHANT_ENTERED", channel: "WHATSAPP", reference: "wamid.AAA" } });
    expect(sale.journalEntryId).toEqual(expect.any(String));
    expect(JSON.stringify(r.body)).not.toContain("other tenant secret");
  });

  it("filters by type and paginates", async () => {
    const t = await loginAs("support@t.test");
    const sales = await request(app).get(`/admin/businesses/${env.businessId}/transactions?type=SALE`).set(auth(t));
    expect(sales.body.transactions).toHaveLength(2);
    const page = await request(app).get(`/admin/businesses/${env.businessId}/transactions?take=1&skip=0`).set(auth(t));
    expect(page.body.transactions).toHaveLength(1);
    expect(page.body.pagination.hasMore).toBe(true);
  });

  it("shows detail with items, stock movements and the balanced journal", async () => {
    const token = await loginAs("op@t.test");
    const r = await request(app).get(`/admin/businesses/${env.businessId}/transactions/${saleId}`).set(auth(token));
    expect(r.status).toBe(200);
    expect(r.body.transaction.items[0]).toMatchObject({ itemName: "Rice", quantity: 2, lineTotalMinor: "20000" });
    expect(r.body.transaction.stockMovements[0]).toMatchObject({ quantityDelta: -2, source: "SALE" });
    const debit = r.body.journal.lines.reduce((s: bigint, l: { debitMinor: string }) => s + BigInt(l.debitMinor), 0n);
    const credit = r.body.journal.lines.reduce((s: bigint, l: { creditMinor: string }) => s + BigInt(l.creditMinor), 0n);
    expect(debit).toBe(credit);
    expect((await request(app).get(`/admin/businesses/${other.businessId}/transactions/${saleId}`).set(auth(token))).status).toBe(404); // wrong tenant
    expect((await request(app).get(`/admin/businesses/nope/transactions`).set(auth(token))).status).toBe(404);
  });

  it("is closed to merchants'-books-blind roles and unauthenticated callers", async () => {
    expect((await request(app).get(`/admin/businesses/${env.businessId}/transactions`)).status).toBe(401);
    const analyst = await loginAs("analyst@t.test");
    for (const path of ["transactions", "stock-movements", "journals", "transactions.csv"]) {
      expect((await request(app).get(`/admin/businesses/${env.businessId}/${path}`).set(auth(analyst))).status).toBe(403);
    }
  });

  it("lists the new stock log and the legacy one, and the journals", async () => {
    const token = await loginAs("support@t.test");
    const product = await createProduct(env.scoped, { businessId: env.businessId, name: "Beans" });
    const v = await createVariant(env.scoped, { businessId: env.businessId, productId: product.id, sku: "ADM-BEANS", name: "b", baseUnit: "kg" });
    const common = { businessId: env.businessId, shopId: env.shopId, variantId: v.id, currencyCode: "NGN" };
    await receiveStock(env.scoped, { ...common, quantity: 9, unitCostMinor: 100n });
    await fulfilSale(env.scoped, { ...common, quantity: 4 });
    const v2 = await request(app).get(`/admin/businesses/${env.businessId}/stock-movements`).set(auth(token));
    expect(v2.body.log).toBe("v2");
    expect(v2.body.movements.map((m: { kind: string }) => m.kind)).toEqual(["SALE_FULFILLMENT", "RECEIPT"]);
    expect(v2.body.movements[0]).toMatchObject({ sku: "ADM-BEANS", onHandDelta: -4, costMinor: "400", provenance: "MERCHANT_ENTERED" });
    const legacy = await request(app).get(`/admin/businesses/${env.businessId}/stock-movements?log=legacy`).set(auth(token));
    expect(legacy.body.movements[0]).toMatchObject({ item: "Rice", quantityDelta: -2, source: "SALE" });
    const j = await request(app).get(`/admin/businesses/${env.businessId}/journals`).set(auth(token));
    expect(j.body.journals.length).toBeGreaterThanOrEqual(3);
    expect(j.body.journals[0].lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("void = reverse (scenario 30)", () => {
  it("creates a balanced reversal, leaves the original intact, restores stock and receivables, and audits it", async () => {
    const token = await loginAs("op@t.test");
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: saleId } });
    const arBefore = await accountNet(env.scoped, "AR", { currencyCode: "NGN" });

    const r = await request(app).post(`/admin/businesses/${env.businessId}/transactions/${saleId}/reverse`).set(auth(token)).set("x-correlation-id", "corr-abc-12345").send({ reason: "Customer returned both bags, ticket 77" });
    expect(r.status).toBe(201);
    expect(r.headers["x-correlation-id"]).toBe("corr-abc-12345");
    const reversalId = r.body.reversal.id as string;
    expect(r.body.reversal.amountMinor).toBe("-20000");

    // original untouched
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: saleId } })).toEqual(before);
    // listing shows REVERSED + REVERSAL
    const list = await request(app).get(`/admin/businesses/${env.businessId}/transactions`).set(auth(token));
    expect(list.body.transactions.find((x: { id: string }) => x.id === saleId)).toMatchObject({ status: "REVERSED", reversedByTransactionId: reversalId });
    expect(list.body.transactions.find((x: { id: string }) => x.id === reversalId)).toMatchObject({ status: "REVERSAL", reversalOfTransactionId: saleId });
    // stock back
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { businessId: env.businessId, normalizedName: "rice" } })).estimatedStockQty).toBe(10);
    // books: the sale's revenue is cancelled, other credit-sale receivable untouched
    expect(await accountNet(env.scoped, "UNCLASSIFIED_FUNDS", { currencyCode: "NGN" })).toBe(-1_500n); // only the expense remains
    expect(await accountNet(env.scoped, "AR", { currencyCode: "NGN" })).toBe(arBefore);
    const tb = await env.scoped.journalLine.aggregate({ _sum: { debitMinor: true, creditMinor: true } });
    expect(tb._sum.debitMinor).toBe(tb._sum.creditMinor);

    // audit: specific row (in the merchant's own history, with actor, reason, correlation id) + generic row
    const rows = await prisma.auditLog.findMany({ where: { businessId: env.businessId, action: { in: ["admin.transaction.reversed", "admin.write POST /businesses/:id/transactions/:txnId/reverse"] } } });
    expect(rows).toHaveLength(2);
    const specific = rows.find((x) => x.action === "admin.transaction.reversed")!;
    expect(specific).toMatchObject({ actorType: "ADMIN", entityType: "Transaction", entityId: saleId });
    expect(specific.metadata).toMatchObject({ reason: "Customer returned both bags, ticket 77", reversalTransactionId: reversalId, correlationId: "corr-abc-12345" });
    expect(rows.find((x) => x.action.startsWith("admin.write"))?.metadata).toMatchObject({ correlationId: "corr-abc-12345", reason: "Customer returned both bags, ticket 77" });
  });

  it("refuses a second reversal, reversing a reversal, a short reason, and an unknown transaction", async () => {
    const token = await loginAs("super@t.test");
    const again = await request(app).post(`/admin/businesses/${env.businessId}/transactions/${saleId}/reverse`).set(auth(token)).send({ reason: "trying again for the same one" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_REVERSED");
    const reversal = await prisma.transaction.findFirstOrThrow({ where: { reversalOfTransactionId: saleId } });
    expect((await request(app).post(`/admin/businesses/${env.businessId}/transactions/${reversal.id}/reverse`).set(auth(token)).send({ reason: "reversing the reversal" })).status).toBe(409);
    expect((await request(app).post(`/admin/businesses/${env.businessId}/transactions/${creditSaleId}/reverse`).set(auth(token)).send({ reason: "short" })).status).toBe(400);
    expect((await request(app).post(`/admin/businesses/${env.businessId}/transactions/nope/reverse`).set(auth(token)).send({ reason: "a valid long enough reason" })).status).toBe(404);
    expect((await request(app).post(`/admin/businesses/${other.businessId}/transactions/${creditSaleId}/reverse`).set(auth(token)).send({ reason: "wrong tenant on purpose" })).status).toBe(404);
  });

  it("only roles with the reverse permission may (SUPPORT and ANALYST may not)", async () => {
    for (const email of ["support@t.test", "analyst@t.test"]) {
      const r = await request(app).post(`/admin/businesses/${env.businessId}/transactions/${creditSaleId}/reverse`).set(auth(await loginAs(email))).send({ reason: "should not be allowed to" });
      expect(r.status).toBe(403);
    }
    expect((await prisma.transaction.count({ where: { reversalOfTransactionId: creditSaleId } }))).toBe(0);
  });

  it("requires step-up when the flag is on, and a support-access reason when that flag is on", async () => {
    await setFlag("adminStepUp", true);
    const token = await loginAs("super@t.test");
    const blocked = await request(app).post(`/admin/businesses/${env.businessId}/transactions/${creditSaleId}/reverse`).set(auth(token)).send({ reason: "step-up should be needed" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("STEP_UP_REQUIRED");
    const su = await request(app).post("/admin/step-up").set(auth(token)).send({ password: PW });

    await setFlag("adminSupportAccessRequired", true);
    const noAccess = await request(app).post(`/admin/businesses/${env.businessId}/transactions/${creditSaleId}/reverse`).set(auth(token)).set(STEP_UP_HEADER, su.body.stepUpToken).send({ reason: "support access should be needed" });
    expect(noAccess.body.code).toBe("SUPPORT_ACCESS_REQUIRED");
    await request(app).post(`/admin/businesses/${env.businessId}/support-access`).set(auth(token)).send({ reason: "Merchant asked us to void this credit sale" });
    const ok = await request(app).post(`/admin/businesses/${env.businessId}/transactions/${creditSaleId}/reverse`).set(auth(token)).set(STEP_UP_HEADER, su.body.stepUpToken).send({ reason: "Merchant asked us to void this credit sale" });
    expect(ok.status).toBe(201);
    expect(await accountNet(env.scoped, "AR", { currencyCode: "NGN" })).toBe(0n);
  });

  it("there is no way to delete a transaction through the admin API", async () => {
    const token = await loginAs("super@t.test");
    for (const method of ["delete", "put", "patch"] as const) {
      const r = await request(app)[method](`/admin/businesses/${env.businessId}/transactions/${saleId}`).set(auth(token));
      expect([404, 405]).toContain(r.status);
    }
    expect(await prisma.transaction.findUnique({ where: { id: saleId } })).not.toBeNull();
  });
});

describe("correlation id and the audit guarantee for admin writes (scenario 28)", () => {
  it("every successful existing admin write leaves an admin.write row with actor, target, reason and correlation id", async () => {
    const token = await loginAs("super@t.test");
    const r = await request(app).post(`/admin/businesses/${other.businessId}/suspend`).set(auth(token)).set("x-correlation-id", "corr-suspend-001").send({ reason: "policy violation test" });
    expect(r.status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { businessId: other.businessId, action: "admin.write POST /businesses/:id/suspend" } });
    expect(row).toMatchObject({ actorType: "ADMIN", entityType: "Business", entityId: other.businessId });
    expect(row.metadata).toMatchObject({ correlationId: "corr-suspend-001", status: 200, reason: "policy violation test" });
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: "super@t.test" } });
    expect(row.actorId).toBe(admin.id);
    await request(app).post(`/admin/businesses/${other.businessId}/reinstate`).set(auth(token)).send({});
  });

  it("failed writes leave no generic row, and a bad correlation id is replaced", async () => {
    const token = await loginAs("super@t.test");
    const before = await prisma.auditLog.count({ where: { action: { startsWith: "admin.write" } } });
    const bad = await request(app).post(`/admin/businesses/does-not-exist/suspend`).set(auth(token)).set("x-correlation-id", "<script>").send({ reason: "nonexistent business" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "admin.write" } } })).toBe(before);
    expect(bad.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads are not audited as writes", async () => {
    const token = await loginAs("super@t.test");
    const before = await prisma.auditLog.count({ where: { action: { startsWith: "admin.write" } } });
    await request(app).get(`/admin/businesses/${env.businessId}/transactions`).set(auth(token));
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "admin.write" } } })).toBe(before);
  });
});

describe("formula-safe CSV export", () => {
  it("neutralises formula-leading text, keeps numbers numeric, escapes quotes and audits the export", async () => {
    const token = await loginAs("support@t.test");
    const r = await request(app).get(`/admin/businesses/${env.businessId}/transactions.csv`).set(auth(token));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toContain("attachment");
    expect(r.headers["x-export-truncated"]).toBe("false");
    const text = r.text;
    expect(text.split("\r\n")[0]).toBe('"id","created_at","type","status","amount_minor","currency","payment_status","counterparty","description","reversal_of","provenance","reference"');
    // the malicious descriptions are defused with a leading apostrophe inside the quotes
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(text).toContain(`"'+SUM(1,1) transport"`);
    expect(text).not.toMatch(/,"=HYPERLINK/);
    // a reversal's negative amount stays a plain number, never text-prefixed
    expect(text).toMatch(/,-20000,/);
    expect(text).not.toContain(`'-20000`);
    expect(text).not.toContain("other tenant secret");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { businessId: env.businessId, action: "admin.transactions.exported" } });
    expect(audit.metadata).toMatchObject({ truncated: false });
    expect((audit.metadata as { rows: number }).rows).toBeGreaterThanOrEqual(3);
  });

  it("csvText and csvNumber unit rules", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd", "  =spaced"]) expect(csvText(bad).startsWith(`"'`)).toBe(true);
    expect(csvText("fine text")).toBe('"fine text"');
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
    expect(csvText("line1\nline2")).toBe('"line1 line2"');
    expect(csvText(null)).toBe('""');
    expect(csvNumber(-5n)).toBe("-5");
    expect(() => csvNumber("=1+1")).toThrow();
    expect(() => csvNumber("1.5")).toThrow();
  });

  it("respects the date window", async () => {
    const token = await loginAs("support@t.test");
    const r = await request(app).get(`/admin/businesses/${env.businessId}/transactions.csv?from=2999-01-01`).set(auth(token));
    expect(r.text.trim().split("\r\n")).toHaveLength(1); // header only
  });
});
