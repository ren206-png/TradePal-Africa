import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeBusiness, seedReference } from "./helpers/phase2.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { DebtHasPaymentsError, reverseTransaction } from "../src/domain/ledger.js";

vi.setConfig({ testTimeout: 60_000 });
let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});

let n = 0;
async function shop() {
  const b = await makeBusiness(prisma, `Undo Shop ${++n}`);
  const ctx = (msgId?: string): CommandContext => ({
    prisma, scopedPrisma: b.scoped, businessId: b.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m-1", merchantRole: "OWNER",
    ...(msgId ? { whatsappMessageId: msgId } : {}),
  });
  const say = (text: string, msgId = `wamid.${Math.random().toString(36).slice(2)}`) => handleCommand(ctx(msgId), text);
  const debts = (name: string) => b.scoped.debt.findMany({ where: { customer: { name } }, orderBy: { createdAt: "asc" } });
  return { b, say, debts };
}

describe("/undo and the debt book", () => {
  it("taking back a debt removes it: the customer no longer owes it and it leaves /debts", async () => {
    const { say, debts } = await shop();
    expect(await say("/debt Amina 500")).toContain("Amina owes 500.00 NGN");
    expect(await say("/undo")).toBe("Undone: debt of 500.00 NGN for Amina. That debt is removed.");
    expect(await say("/customer Amina")).toBe("Amina has no open debt.");
    expect(await say("/debts")).toContain("Nobody owes you anything");
    const [d] = await debts("Amina");
    expect(d).toMatchObject({ outstandingAmountMinor: 0n, status: "WRITTEN_OFF", originalAmountMinor: 50_000n }); // the record stays
  });

  it("taking back a payment puts the amount back on the debt", async () => {
    const { say, debts } = await shop();
    await say("/debt Amina 500");
    expect(await say("/paid Amina 300")).toContain("Remaining owed: 200.00 NGN");
    expect(await say("/undo")).toBe("Undone: payment of 300.00 NGN from Amina. Amina owes 500.00 NGN again.");
    expect(await say("/customer Amina")).toBe("Amina owes 500.00 NGN across 1 debt(s).");
    expect((await debts("Amina"))[0]).toMatchObject({ outstandingAmountMinor: 50_000n, status: "OPEN" });
    // a part-undone payment leaves the debt part-paid, not open
    await say("/paid Amina 100");
    await say("/paid Amina 150");
    await say("/undo");
    expect((await debts("Amina"))[0]).toMatchObject({ outstandingAmountMinor: 40_000n, status: "PARTIALLY_PAID" });
  });

  it("one /paid that was split across two debts is taken back as ONE action", async () => {
    const { say, debts } = await shop();
    await say("/debt Amina 200");
    await say("/debt Amina 300");
    const paid = await say("/paid Amina 350", "wamid.split-1"); // 200 to the first debt, 150 to the second
    expect(paid).toContain("Remaining owed: 150.00 NGN");
    expect(await say("/undo")).toBe("Undone: payment of 350.00 NGN from Amina. Amina owes 500.00 NGN again.");
    expect((await debts("Amina")).map((d) => [d.outstandingAmountMinor, d.status])).toEqual([[20_000n, "OPEN"], [30_000n, "OPEN"]]);
    // nothing of that payment is left to undo: the next undo takes back the second debt note
    expect(await say("/undo")).toBe("Undone: debt of 300.00 NGN for Amina. That debt is removed.");
  });

  it("a debt with payments on it cannot be taken back until the payments are; a refusal changes nothing", async () => {
    const { b, say, debts } = await shop();
    await say("/debt Amina 500");
    await say("/paid Amina 100");
    const note = await b.scoped.transaction.findFirstOrThrow({ where: { type: "DEBT_NOTE" } });
    const before = await b.scoped.transaction.count();
    await expect(reverseTransaction(b.scoped, note.id)).rejects.toBeInstanceOf(DebtHasPaymentsError);
    expect(await b.scoped.transaction.count()).toBe(before); // no half-written reversal
    expect((await debts("Amina"))[0]).toMatchObject({ outstandingAmountMinor: 40_000n });
    await say("/undo"); // the payment first
    await expect(reverseTransaction(b.scoped, note.id)).resolves.toMatchObject({ amountMinor: -50_000n });
    expect((await debts("Amina"))[0]).toMatchObject({ outstandingAmountMinor: 0n, status: "WRITTEN_OFF" });
  });

  it("the ledger and the debt book agree after every kind of undo, and a sale undoes exactly as before", async () => {
    const { b, say } = await shop();
    await say("/debt Amina 500");
    await say("/paid Amina 200");
    await say("/undo");
    await say("/undo");
    const rows = await b.scoped.transaction.findMany({ where: { type: { in: ["DEBT_NOTE", "PAYMENT_RECEIVED"] } } });
    expect(rows.reduce((s, t) => s + t.amountMinor, 0n)).toBe(0n); // each entry and its reversal net to zero
    const open = await b.scoped.debt.findMany({ where: { status: { in: ["OPEN", "PARTIALLY_PAID"] } } });
    expect(open.reduce((s, d) => s + d.outstandingAmountMinor, 0n)).toBe(0n);
    expect(await say("/undo")).toBe("Nothing to undo.");
    const sale = await b.scoped.transaction.create({ data: { businessId: b.businessId, type: "SALE", amountMinor: 120_000n, currencyCode: "NGN", paymentStatus: "PAID" } });
    void sale;
    expect(await say("/undo")).toBe("Undone: SALE of 1200.00 NGN.");
  });
});
