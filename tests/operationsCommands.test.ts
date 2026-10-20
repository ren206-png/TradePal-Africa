import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MerchantRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, makeBusiness, seedReference } from "./helpers/phase2.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { postSale } from "../src/domain/accounting.js";
import { getStockLevel } from "../src/domain/stock.js";
import { localDateString } from "../src/domain/dailyClose.js";

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

type Env = Awaited<ReturnType<typeof makeBusiness>>;
function ctxFor(env: Env, role: MerchantRole = "OWNER", whatsappMessageId?: string): CommandContext {
  return {
    prisma, scopedPrisma: env.scoped, businessId: env.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en",
    merchantId: "merchant-1", merchantRole: role, ...(whatsappMessageId ? { whatsappMessageId } : {}),
  };
}
async function fullEnv() {
  const env = await makeBusiness(prisma);
  for (const f of ["catalogV2", "stockV2", "accountingJournals", "dailyClose"]) await enableFlag(prisma, env.businessId, f);
  return env;
}

describe("all new flags OFF: existing behaviour is identical (scenario 25)", () => {
  it("/help is exactly the always-on list, with none of the new commands", async () => {
    const env = await makeBusiness(prisma);
    const reply = await handleCommand(ctxFor(env), "/help");
    expect(reply).toBe(
      [
        "Available commands:",
        "/debt <name> <amount> [due YYYY-MM-DD] - record a customer's debt",
        "/paid <name> <amount> - record a payment against a customer's open debts",
        "/customer <name> - show what a customer currently owes",
        "/debts - list everyone who owes you, biggest first",
        "/today - show today's sales, expenses, and payments",
        "/undo - reverse the most recent transaction",
        "/help - show this message",
        "",
        'You can also just tell me about a sale, expense or debt in plain language, e.g. "sold 2 bread for 500".',
      ].join("\n"),
    );
  });

  it("the new commands answer like any unknown command and write nothing", async () => {
    const env = await makeBusiness(prisma);
    for (const cmd of ["/close", "/close 500", "/products", "/addproduct A b c", "/pack A carton 12", "/receive A 5", "/count A 3", "/count approve", "/adopt", "/reorder", "/reorder accept 1", "/orders", "/sendorder PO-000001", "/acceptorder SO-000001", "/shiporder SO-000001", "/receiveorder PO-000001"]) {
      const first = cmd.split(" ")[0];
      const reply = await handleCommand(ctxFor(env), cmd);
      expect(reply).toContain(`Unrecognized command "${first}".`);
      expect(reply).toContain("Available commands:");
    }
    for (const model of ["product", "productVariant", "stockMovement", "stockBalance", "stockCount", "journalEntry", "dailyClose", "account", "shop"] as const) {
      expect(await (env.scoped[model] as { count: (a: unknown) => Promise<number> }).count({ where: model === "shop" ? { isDefault: false } : {} })).toBe(0);
    }
  });

  it("recording a sale and /undo with every flag off touch only the old tables", async () => {
    const env = await makeBusiness(prisma);
    await handleCommand(ctxFor(env), "/debt Amina 500");
    await handleCommand(ctxFor(env), "/undo");
    expect(await env.scoped.journalEntry.count({ where: {} })).toBe(0);
    expect(await env.scoped.stockMovement.count({ where: {} })).toBe(0);
  });
});

describe("flags ON: /help lists the new commands for that business only", () => {
  it("shows each line only for its own flag", async () => {
    const env = await makeBusiness(prisma);
    await enableFlag(prisma, env.businessId, "dailyClose");
    const help = await handleCommand(ctxFor(env), "/help");
    expect(help).toContain("/close");
    expect(help).not.toContain("/products");
    await enableFlag(prisma, env.businessId, "catalogV2");
    expect(await handleCommand(ctxFor(env), "/help")).toContain("/pack <sku>");
    expect(await handleCommand(ctxFor(env), "/help")).not.toContain("/receive");
  });
});

describe("catalog and stock commands", () => {
  it("adds a product, declares a pack, receives stock by the carton with cost per carton, and lists it", async () => {
    const env = await fullEnv();
    const c = ctxFor(env);
    expect(await handleCommand(c, "/addproduct COLA330 can Coca Cola 330ml")).toContain("Added COLA330");
    expect(await handleCommand(c, "/addproduct COLA330 can Another")).toContain("already in use");
    expect(await handleCommand(c, "/addproduct bad")).toContain("Usage: /addproduct");
    expect(await handleCommand(c, "/pack COLA330 carton 24")).toBe("OK: 1 carton = 24 can for COLA330.");
    expect(await handleCommand(c, "/pack COLA330 carton 12")).toContain("already declared");
    expect(await handleCommand(c, "/pack NOPE carton 12")).toContain("can't find a product");

    const r = await handleCommand(c, "/receive COLA330 5 carton cost 2400");
    expect(r).toContain("Received 5 carton (120 can)");
    expect(r).toContain("On hand now: 120 can");
    const variant = await env.scoped.productVariant.findFirstOrThrow({ where: { sku: "COLA330" } });
    const level = await getStockLevel(env.scoped, env.shopId, variant.id);
    expect(level.onHand).toBe(120);
    expect(level.avgCostMinor).toBe(10_000n); // cost typed per carton: 2400.00 = 240000 minor, over 24 cans = 10000 minor (100.00) per can
    expect(await handleCommand(c, "/receive COLA330 2 bag")).toContain("no declared conversion");
    expect(await handleCommand(c, "/receive COLA330 abc")).toContain("Usage: /receive");

    const list = await handleCommand(c, "/products");
    expect(list).toContain("COLA330: Coca Cola 330ml");
    expect(list).toContain("1 carton = 24 can");
    expect(list).toContain("120 on hand");
    expect(await handleCommand(c, "/products fanta")).toContain('No product matches "fanta"');
  });

  it("a replayed WhatsApp message receives stock once", async () => {
    const env = await fullEnv();
    await handleCommand(ctxFor(env), "/addproduct RICE bag Rice");
    const c = ctxFor(env, "OWNER", "wamid.same");
    await handleCommand(c, "/receive RICE 10");
    await handleCommand(c, "/receive RICE 10");
    const variant = await env.scoped.productVariant.findFirstOrThrow({ where: { sku: "RICE" } });
    expect((await getStockLevel(env.scoped, env.shopId, variant.id)).onHand).toBe(10);
  });

  it("staff cannot change the catalog or stock, but the owner can", async () => {
    const env = await fullEnv();
    const staff = ctxFor(env, "STAFF");
    for (const cmd of ["/addproduct X y z", "/pack X carton 6", "/receive X 1", "/count X 1", "/count approve"]) {
      expect(await handleCommand(staff, cmd)).toBe("Only the owner or a manager can do that.");
    }
    expect(await env.scoped.product.count({ where: {} })).toBe(0);
  });

  it("walks a stock count: count, explain the difference, approve once", async () => {
    const env = await fullEnv();
    const c = ctxFor(env);
    await handleCommand(c, "/addproduct SALT kg Salt");
    await handleCommand(c, "/receive SALT 20 cost 50");
    expect(await handleCommand(c, "/count")).toContain("Count your stock one product at a time");
    expect(await handleCommand(c, "/count SALT 18")).toContain("books said 20 (-2). Add a reason");
    expect(await handleCommand(c, "/count approve")).toContain("need a reason");
    expect(await handleCommand(c, "/count SALT 18 two bags burst")).toContain("books said 20 (-2). Reason saved.");
    expect(await handleCommand(c, "/count")).toContain("two bags burst");
    expect(await handleCommand(c, "/count approve")).toBe("Count approved. 1 stock difference(s) recorded.");
    const variant = await env.scoped.productVariant.findFirstOrThrow({ where: { sku: "SALT" } });
    expect((await getStockLevel(env.scoped, env.shopId, variant.id)).onHand).toBe(18);
    expect(await handleCommand(c, "/count approve")).toContain("no open stock count");
    // matching counts and cancel
    expect(await handleCommand(c, "/count SALT 18")).toContain("matches your books");
    expect(await handleCommand(c, "/count cancel")).toContain("cancelled");
  });

  it("/adopt brings the earlier stock list over once, without inventing costs", async () => {
    const env = await fullEnv();
    await env.scoped.inventoryItem.create({ data: { businessId: env.businessId, name: "Sugar", normalizedName: "sugar", unit: "bag", estimatedStockQty: 7, priceMinor: 100_000n } });
    expect(await handleCommand(ctxFor(env, "STAFF"), "/adopt")).toContain("Only the owner");
    const first = await handleCommand(ctxFor(env), "/adopt");
    expect(first).toContain("Brought 1 stock item(s)");
    expect(first).toContain("Opening stock recorded for 1. No costs were guessed.");
    expect(first).toContain("1 price(s)");
    expect(await handleCommand(ctxFor(env), "/adopt")).toContain("already in your product list");
    const variant = await env.scoped.productVariant.findFirstOrThrow({ where: { name: "Sugar" } });
    const lvl = await getStockLevel(env.scoped, env.shopId, variant.id);
    expect(lvl).toMatchObject({ onHand: 7, avgCostMinor: null });
  });
});

describe("/close", () => {
  async function today(env: Env) {
    return localDateString(new Date(), "Africa/Lagos");
  }

  it("needs accounting on, and an owner or manager", async () => {
    const env = await makeBusiness(prisma);
    await enableFlag(prisma, env.businessId, "dailyClose");
    expect(await handleCommand(ctxFor(env), "/close")).toContain("needs accounting turned on");
    await enableFlag(prisma, env.businessId, "accountingJournals");
    expect(await handleCommand(ctxFor(env, "STAFF"), "/close")).toBe("Only the owner or a manager can do that.");
  });

  it("previews the day, closes it when the count matches, and refuses a second close", async () => {
    const env = await fullEnv();
    const c = { businessId: env.businessId, currencyCode: "NGN" };
    await postSale(env.scoped, { ...c, idempotencyKey: "close-1", occurredAt: new Date(), totalMinor: 20_000n, receipts: [{ method: "CASH", amountMinor: 20_000n }] });
    await postSale(env.scoped, { ...c, idempotencyKey: "close-2", occurredAt: new Date(), totalMinor: 5_000n, receipts: [{ method: "MOBILE_MONEY", amountMinor: 5_000n }] });
    const preview = await handleCommand(ctxFor(env), "/close");
    expect(preview).toContain(`Day ${await today(env)}`);
    expect(preview).toContain("Cash expected in the drawer: 200.00 NGN");
    expect(preview).toContain("Cash sales: 200.00 NGN");
    expect(preview).toContain("Mobile money sales: 50.00 NGN");
    expect(preview).toContain("Count the cash in your drawer, then reply: /close <amount>");

    expect(await handleCommand(ctxFor(env), "/close abc")).toMatch(/amount/i);
    const done = await handleCommand(ctxFor(env), "/close 200");
    expect(done).toContain("closed.");
    expect(done).toContain("matches your records");
    expect(await handleCommand(ctxFor(env), "/close 200")).toContain("already closed");
    expect(await handleCommand(ctxFor(env), "/close")).toContain("is already closed: expected 200.00 NGN, counted 200.00 NGN");
  });

  it("a shortfall asks for a reason, then records it", async () => {
    const env = await fullEnv();
    await postSale(env.scoped, { businessId: env.businessId, currencyCode: "NGN", idempotencyKey: "short-1", occurredAt: new Date(), totalMinor: 20_000n, receipts: [{ method: "CASH", amountMinor: 20_000n }] });
    const asks = await handleCommand(ctxFor(env), "/close 190");
    expect(asks).toContain("Say why");
    expect(asks).toContain("/close 190 <short reason>");
    const done = await handleCommand(ctxFor(env), "/close 190 gave wrong change");
    expect(done).toContain("You are SHORT by 10.00 NGN");
    expect(done).toContain("recorded with your reason");
  });

  it("warns that receipts with no recorded method are not counted as cash", async () => {
    const env = await fullEnv();
    await postSale(env.scoped, { businessId: env.businessId, currencyCode: "NGN", idempotencyKey: "unspec-1", occurredAt: new Date(), totalMinor: 8_000n, receipts: [{ method: "UNSPECIFIED", amountMinor: 8_000n }] });
    const preview = await handleCommand(ctxFor(env), "/close");
    expect(preview).toContain("did not say how they were paid: 80.00 NGN");
    expect(preview).toContain("NOT counted as cash");
    expect(preview).toContain("Cash expected in the drawer: 0.00 NGN");
  });

  it("closes an earlier day by date and rejects a future one", async () => {
    const env = await fullEnv();
    expect(await handleCommand(ctxFor(env), "/close 2020-01-05 0")).toContain("Day 2020-01-05 closed.");
    expect(await handleCommand(ctxFor(env), "/close 2999-01-01")).toContain("not happened yet");
    expect(await handleCommand(ctxFor(env), "/close 2026-02-30")).toContain("does not exist");
  });
});
