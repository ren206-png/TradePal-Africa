import { describe, expect, it } from "vitest";
import { matchBareCommand, withinOneEdit } from "../src/commands/bareCommands.js";

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
