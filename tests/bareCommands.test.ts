import { describe, expect, it } from "vitest";
import { isUndoTypo, matchBareCommand, withinOneEdit } from "../src/commands/bareCommands.js";

describe("withinOneEdit", () => {
  it("accepts one substituted, missing, extra or swapped letter, and nothing further", () => {
    expect(withinOneEdit("stock", "stock")).toBe(true);
    expect(withinOneEdit("stok", "stock")).toBe(true); // missing
    expect(withinOneEdit("stockk", "stock")).toBe(true); // extra
    expect(withinOneEdit("stack", "stock")).toBe(true); // wrong
    expect(withinOneEdit("sotck", "stock")).toBe(true); // swapped
    expect(withinOneEdit("stk", "stock")).toBe(false); // two missing
    expect(withinOneEdit("scoot", "stock")).toBe(false);
    expect(withinOneEdit("abc", "xyz")).toBe(false);
  });
});

describe("matchBareCommand", () => {
  it("recognises the command words exactly, in any case and with trailing punctuation", () => {
    expect(matchBareCommand("Today")).toBe("/today");
    expect(matchBareCommand("  STOCK  ")).toBe("/stock");
    expect(matchBareCommand("Help!")).toBe("/help");
    expect(matchBareCommand("Debts")).toBe("/debts");
    expect(matchBareCommand("Debt")).toBe("/debts");
    expect(matchBareCommand("who owes me?")).toBe("/debts");
    expect(matchBareCommand("undo")).toBe("/undo");
  });

  it("forgives one slipped letter, as people type on a phone", () => {
    for (const [typed, command] of [
      ["tody", "/today"],
      ["todya", "/today"],
      ["todayy", "/today"],
      ["stok", "/stock"],
      ["sotck", "/stock"],
      ["debst", "/debts"],
      ["dets", "/debts"],
      ["owin", "/debts"],
      ["hlep", "/help"],
      ["hep", "/help"],
      ["helpp", "/help"],
      ["lowstok", "/lowstock"],
    ] as const) {
      expect(matchBareCommand(typed), typed).toBe(command);
    }
  });

  it("forgives a slip in 'remind <name>' and keeps the name as typed", () => {
    expect(matchBareCommand("Remind Amina Kamara")).toBe("/remind Amina Kamara");
    expect(matchBareCommand("remnd Amina")).toBe("/remind Amina");
    expect(matchBareCommand("remidn Amina")).toBe("/remind Amina");
  });

  it("never guesses for undo, which reverses an entry: only the exact word works", () => {
    for (const typed of ["undoo", "udo", "undue", "unto", "und"]) expect(matchBareCommand(typed), typed).toBeNull();
  });

  it("leaves ordinary messages, greetings, sales and unrelated words alone", () => {
    for (const text of [
      "hello",
      "hi",
      "hey",
      "good morning",
      "thanks",
      "held",
      "hell",
      "sold 2 bread for 500",
      "sale",
      "paid",
      "remind",
      "reminder",
      "today I sold rice",
      "debit card",
      "",
    ]) {
      expect(matchBareCommand(text), text).toBeNull();
    }
  });
});

describe("isUndoTypo", () => {
  it("flags a one-letter slip of 'undo' so the bot can ask, but never the exact word or unrelated words", () => {
    for (const typed of ["unto", "udno", "undoo", "udo", "und"]) expect(isUndoTypo(typed), typed).toBe(true);
    for (const typed of ["undo", "Undo", "undo!", "hello", "today", "unread", "sold 2 bread", "ok"]) {
      expect(isUndoTypo(typed), typed).toBe(false);
    }
  });
});

import { matchBareCommandWithArgs, matchPlainWord, type BareArgsLookups } from "../src/commands/bareCommands.js";

const lookups: BareArgsLookups = {
  customerExists: async (n) => ["amina", "john the tailor"].includes(n.toLowerCase()),
  customerHasOpenDebt: async (n) => n.toLowerCase() === "amina",
};
const cmd = async (t: string) => (await matchBareCommandWithArgs(t, lookups))?.command ?? null;

describe("commands with a name or an amount, typed without the slash", () => {
  it("reads a debt payment only for a customer who owes money; anything else is left to the normal reader", async () => {
    expect(await cmd("paid Amina 300")).toBe("/paid Amina 300");
    expect(await cmd("Paid amina 1,500")).toBe("/paid amina 1500");
    expect(await cmd("paid Amina 300.50.")).toBe("/paid Amina 300.50");
    expect(await cmd("paid transport 1500")).toBeNull(); // an expense
    expect(await cmd("paid John the tailor 500")).toBeNull(); // exists, but owes nothing here
    expect(await cmd("paid 500")).toBeNull();
  });

  it("looks a customer up only if they exist, and treats a sentence as a sentence", async () => {
    expect(await cmd("customer Amina")).toBe("/customer Amina");
    expect(await cmd("Customer john the tailor")).toBe("/customer john the tailor");
    expect(await cmd("customer Zed")).toBeNull();
    expect(await cmd("customer paid 500")).toBeNull();
  });

  it("records a debt with a name and an amount (and a due date), but not a sentence about one", async () => {
    expect(await cmd("debt Amina 500")).toBe("/debt Amina 500");
    expect(await cmd("debt John the tailor 12,000 due 2026-11-30")).toBe("/debt John the tailor 12000 due 2026-11-30");
    expect(await cmd("debt collected from Amina 500")).toBeNull();
    expect(await cmd("debt 500")).toBeNull();
    expect(await cmd("debt Amina")).toBeNull();
  });

  it("staff, stock alert, price, payment link and the other commands with an argument", async () => {
    expect(await cmd("add staff 0803 123 4567")).toBe("/addstaff 0803 123 4567");
    expect(await cmd("addstaff +2348031234567")).toBe("/addstaff +2348031234567");
    expect(await cmd("remove staff 08031234567")).toBe("/removestaff 08031234567");
    expect(await cmd("add staff Tunde")).toBeNull();
    expect(await cmd("low stock rice 5")).toBe("/lowstock rice 5");
    expect(await cmd("lowstock rice OFF")).toBe("/lowstock rice off");
    expect(await cmd("set price rice 4,500")).toBe("/setprice rice 4500");
    expect(await cmd("paylink Amina 500")).toBe("/paylink Amina 500");
    expect(await cmd("collect Amina 500 08031234567")).toBe("/collect Amina 500 08031234567");
    expect(await cmd("collect Amina 500")).toBeNull();
    expect(await cmd("confirm momo 12")).toBe("/confirmmomo 12");
    expect(await cmd("rejectmomo 12")).toBe("/rejectmomo 12");
    expect(await cmd("upgrade starter")).toBe("/upgrade starter");
    expect(await cmd("forget customer Amina")).toBe("/forgetcustomer Amina");
    expect(await cmd("close 190 gave wrong change")).toBe("/close 190 gave wrong change");
    expect(await cmd("close shop")).toBeNull();
  });

  it("never touches a slash command, an ordinary entry, a long message, or a typo of a verb that changes records", async () => {
    expect(await cmd("/paid Amina 300")).toBeNull();
    for (const t of ["sold 2 bags of rice for 12000", "bought stock 45000", "paid transport 1500", "Amina paid me 300", "received 10 bags of rice", "x".repeat(200)]) expect(await cmd(t), t).toBeNull();
    expect(await cmd("pay Amina 300")).toBeNull();
    expect(await cmd("paidd Amina 300")).toBeNull();
    expect(await cmd("debtt Amina 500")).toBeNull();
  });

  it("tells the person how it was read, and how to check it when a record was written", async () => {
    expect((await matchBareCommandWithArgs("paid Amina 300", lookups))!.hint).toBe('(I read that as: /paid Amina 300. Not what you meant? Check with /customer Amina.)');
    expect((await matchBareCommandWithArgs("add staff 08031234567", lookups))!.hint).toBe("(I read that as: /addstaff 08031234567.)");
  });

  it("single words for commands that take nothing more", () => {
    expect(matchPlainWord("Usage")).toBe("/usage");
    expect(matchPlainWord("catalog!")).toBe("/catalog");
    expect(matchPlainWord("products")).toBe("/products");
    expect(matchPlainWord("rice")).toBeNull();
  });
});
