import { describe, expect, it } from "vitest";
import { MAX_LIST_ENTRIES, parseListMessage } from "../src/ai/listEntry.js";

const SLE = { currencyCode: "SLE", minorUnitExp: 2 };

// The exact message a real shop owner (Ashmia's WardRobe) sent on 2026-10-18 and got "couldn't understand" for.
const ASHMIA = [
  "Sale on 17/10/26",
  "Sneakers 2 pair =1200Sle",
  "Brown show 1 pair =700Sle",
  "T shirt 2 =500Sle",
  "Black short jeans =300Sle",
  "Men easy wear 1=500Sle",
  "Jogger pant 1=400Sle",
  "Debt",
  "Manager =650Sle",
  "Terror=100Sle",
  "Blacker=550Sle",
].join("\n");

describe("parseListMessage", () => {
  it("reads a real shop owner's day: a sale list under 'Sale on <date>' and a 'Debt' section", () => {
    const list = parseListMessage(ASHMIA, SLE);
    expect(list).not.toBeNull();
    expect(list!.unreadable).toEqual([]);
    expect(list!.headingDate).toBe("17/10/26");

    const sales = list!.entries.filter((e) => e.section === "SALE");
    expect(sales.map((e) => [e.name, e.quantity, e.amountMinor, e.unitPriceMinor])).toEqual([
      ["Sneakers pair", 2, 120000n, 60000n],
      ["Brown show pair", 1, 70000n, 70000n],
      ["T shirt", 2, 50000n, 25000n],
      ["Black short jeans", 1, 30000n, 30000n],
      ["Men easy wear", 1, 50000n, 50000n],
      ["Jogger pant", 1, 40000n, 40000n],
    ]);
    expect(sales.reduce((sum, e) => sum + e.amountMinor, 0n)).toBe(360000n); // 3600.00

    const debts = list!.entries.filter((e) => e.section === "DEBT");
    expect(debts.map((e) => [e.name, e.amountMinor])).toEqual([
      ["Manager", 65000n],
      ["Terror", 10000n],
      ["Blacker", 55000n],
    ]);
  });

  it("treats lines before any heading as sales, and reads Expense and Payment sections", () => {
    const list = parseListMessage("Rice 2 =500\nBread =300\nExpenses\nTransport 150\nPayment\nAmina 200", SLE);
    expect(list!.entries.map((e) => [e.section, e.name, e.amountMinor])).toEqual([
      ["SALE", "Rice", 25000n * 2n],
      ["SALE", "Bread", 30000n],
      ["EXPENSE", "Transport", 15000n],
      ["PAYMENT", "Amina", 20000n],
    ]);
  });

  it("keeps the whole name as written when the quantity doesn't divide the total evenly", () => {
    const list = parseListMessage("Sale\nBread 3 =100\nRice =50", SLE);
    expect(list!.entries[0]).toMatchObject({ name: "Bread 3", quantity: 1, amountMinor: 10000n });
  });

  it("reports lines it can't read instead of guessing, and rejects another country's currency", () => {
    const list = parseListMessage("Sale\nRice =500\nBread =300\nsome words with no amount\nShoes =50USD\nTax =200NGN", SLE);
    expect(list!.entries.map((e) => e.name)).toEqual(["Rice", "Bread"]);
    expect(list!.unreadable).toEqual(["some words with no amount", "Shoes =50USD", "Tax =200NGN"]);
  });

  it("accepts amounts with commas and decimals", () => {
    const list = parseListMessage("Sale\nGenerator =1,200.50\nFan =300", SLE);
    expect(list!.entries[0]?.amountMinor).toBe(120050n);
  });

  it("is not a list: fewer than 3 lines, fewer than 2 readable entries, slash commands, or too many entries", () => {
    expect(parseListMessage("Sale\nRice =500", SLE)).toBeNull();
    expect(parseListMessage("Hello there\nhow are you\nthis is a chat", SLE)).toBeNull();
    expect(parseListMessage("/debt Amina 500\nRice =500\nBread =300", SLE)).toBeNull();
    const tooMany = ["Sale", ...Array.from({ length: MAX_LIST_ENTRIES + 1 }, (_, i) => `Item${i} =10`)].join("\n");
    expect(parseListMessage(tooMany, SLE)).toBeNull();
  });
});
