import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MerchantRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { tradeWorld, type Biz } from "./helpers/trade.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { addPackConversion } from "../src/domain/catalog.js";
import { getStockLevel } from "../src/domain/stock.js";
import { setPartnerTerms } from "../src/domain/trade/partners.js";

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

const ctxFor = (b: Biz, role: MerchantRole = "OWNER"): CommandContext => ({
  prisma, scopedPrisma: b.scoped, businessId: b.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m-1", merchantRole: role,
});

describe("reorder and trade commands (WhatsApp)", () => {
  it("walks the everyday path: rule, suggestion, draft, send, accept, ship, receive", async () => {
    const w = await tradeWorld(prisma);
    await addPackConversion(w.R.scoped, w.R.businessId, w.rVariant.id, "carton", 24);
    await enableFlag(prisma, w.R.businessId, "reorderRules");
    const R = ctxFor(w.R);
    const W = ctxFor(w.W);

    expect(await handleCommand(R, "/reorder")).toContain("Nothing to reorder right now");
    expect(await handleCommand(R, "/reorder rule COLA fixed 10 60")).toBe("OK: I'll suggest 60 piece of COLA when what you have drops to 10 or less.");
    const list = await handleCommand(R, "/reorder");
    expect(list).toContain("1. COLA: order 60 piece");
    expect(list).toContain("Your reorder point is 10");
    expect(list).toContain("nothing is ordered until you say so");

    expect(await handleCommand(R, "/reorder accept 1 Alpha Wholesale")).toContain('Say which of Alpha Wholesale\'s items this is: add "sku <their code>".');
    expect(await handleCommand(R, "/reorder accept 1 Alpha Wholesale sku NOPE-1")).toContain("does not list an item with code NOPE-1");
    const drafted = await handleCommand(R, "/reorder accept 1 Alpha Wholesale sku COLA-330");
    expect(drafted).toContain("Draft order PO-000001 created for 3 carton of COLA-330");
    expect(drafted).toContain("NOT been sent or paid");
    expect(await handleCommand(R, "/orders")).toContain("PO-000001 buying from Alpha Wholesale: 6600.00 NGN, draft  <- draft, not sent");

    expect(await handleCommand(R, "/sendorder PO-000001")).toContain("Sent PO-000001 to your supplier: 6600.00 NGN");
    expect(await handleCommand(R, "/sendorder PO-000001")).toContain("Only a draft purchase order can be sent");
    expect(await handleCommand(W, "/orders")).toContain("SO-000001 selling to Retail Corner: 6600.00 NGN, requested  <- needs your decision");

    expect(await handleCommand(W, "/acceptorder SO-000001")).toContain("Accepted SO-000001: 6600.00 NGN. The stock is now held");
    expect(await handleCommand(R, "/orders")).toContain("PO-000001 buying from Alpha Wholesale: 6600.00 NGN, accepted, goods not shipped");
    const shipped = await handleCommand(W, "/shiporder SO-000001");
    expect(shipped).toContain("Shipped SO-000001");
    expect(shipped).toContain("Invoice INV-000001: 6600.00 NGN");
    expect(await handleCommand(W, "/shiporder SO-000001")).toContain("already shipped in full");

    expect(await handleCommand(R, "/receiveorder PO-000001")).toContain("Received 72 unit(s) from PO-000001");
    expect(await handleCommand(R, "/receiveorder PO-000001")).toContain("Nothing is waiting to be received");
    expect((await getStockLevel(w.R.scoped, w.R.shopId, w.rVariant.id)).onHand).toBe(72);
    expect(await handleCommand(W, "/orders")).toContain("goods received");
  });

  it("checks permissions: staff cannot send, accept, ship or receive; reorder rules need stock authority", async () => {
    const w = await tradeWorld(prisma);
    await enableFlag(prisma, w.R.businessId, "reorderRules");
    const staffR = ctxFor(w.R, "STAFF");
    const staffW = ctxFor(w.W, "STAFF");
    for (const cmd of ["/sendorder PO-000001", "/receiveorder PO-000001", "/reorder accept 1", "/reorder dismiss 1", "/reorder rule COLA fixed 1 1"]) {
      expect(await handleCommand(staffR, cmd)).toBe("Only the owner or a manager can do that.");
    }
    for (const cmd of ["/acceptorder SO-000001", "/shiporder SO-000001"]) expect(await handleCommand(staffW, cmd)).toBe("Only the owner or a manager can do that.");
    expect(await handleCommand(ctxFor(w.W), "/acceptorder SO-999999")).toContain("can't find that sales order");
    expect(await handleCommand(ctxFor(w.R), "/sendorder PO-999999")).toContain("can't find that purchase order");
    expect(await handleCommand(ctxFor(w.R), "/reorder accept 9")).toContain("no suggestion number 9");
  });

  it("a credit block explains itself, and only the owner can override it, with a reason that is audited", async () => {
    const w = await tradeWorld(prisma);
    await setPartnerTerms(w.W.scoped, w.wPartnerId!, { creditLimitMinor: 100_000n });
    await enableFlag(prisma, w.R.businessId, "reorderRules");
    const R = ctxFor(w.R);
    await handleCommand(R, "/reorder rule COLA fixed 10 24");
    await addPackConversion(w.R.scoped, w.R.businessId, w.rVariant.id, "carton", 24);
    await handleCommand(R, "/reorder");
    await handleCommand(R, "/reorder accept 1 Alpha Wholesale sku COLA-330");
    await handleCommand(R, "/sendorder PO-000001");
    const blocked = await handleCommand(ctxFor(w.W), "/acceptorder SO-000001");
    expect(blocked).toContain("against a limit of 100000");
    expect(blocked).toContain("/acceptorder SO-000001 override <reason>");
    expect(await handleCommand(ctxFor(w.W, "STAFF"), "/acceptorder SO-000001 override trust me")).toBe("Only the owner or a manager can do that.");
    const ok = await handleCommand(ctxFor(w.W), "/acceptorder SO-000001 override long-standing customer, paid last month");
    expect(ok).toContain("Accepted SO-000001");
    expect((await w.W.scoped.auditLog.findFirstOrThrow({ where: { action: "trade.credit.override" } })).actorId).toBe("m-1");
  });

  it("lists nothing and says so when there are no orders; refuses an unpriced order to an unlinked supplier", async () => {
    const w = await tradeWorld(prisma, { link: false });
    expect(await handleCommand(ctxFor(w.R), "/orders")).toBe("No orders yet.");
    const { createPartner } = await import("../src/domain/trade/partners.js");
    const { createPurchaseOrder } = await import("../src/domain/trade/orders.js");
    const manual = await createPartner(w.R.scoped, { businessId: w.R.businessId, name: "Market Trader", role: "SUPPLIER" });
    const po = await createPurchaseOrder(prisma, { businessId: w.R.businessId, partnerId: manual.id, currencyCode: "NGN", lines: [{ variantId: w.rVariant.id, quantity: 5 }] });
    expect(await handleCommand(ctxFor(w.R), `/sendorder ${po.reference}`)).toContain("no prices yet and its supplier is not on TradePal");
  });
});
