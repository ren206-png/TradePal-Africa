import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MerchantRole, PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { parseDispatchWords } from "../src/commands/storeCommands.js";
import { CourierRegistry } from "../src/couriers/adapter.js";
import { SimulatorCourier, COURIER_SIMULATOR_ID } from "../src/couriers/simulatorCourier.js";
import { setCourierRegistry } from "../src/couriers/registry.js";
import { confirmStoreOrder } from "../src/domain/store/orders.js";

vi.setConfig({ testTimeout: 60_000 });
let testDb: TestDb;
let prisma: PrismaClient;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  setCourierRegistry(new CourierRegistry().register(new SimulatorCourier("courier-simulator-secret-for-tests")));
}, 60_000);
afterAll(async () => {
  setCourierRegistry(null);
  await testDb.teardown();
});
afterEach(() => {
  delete process.env["COURIERS_ENABLED"];
});

const ctxFor = (s: Seller, role: MerchantRole = "OWNER"): CommandContext => ({
  prisma, scopedPrisma: s.scoped, businessId: s.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m-1", merchantRole: role,
});
async function world(opts: { courier?: boolean } = {}) {
  const s = await makeSeller(prisma, `Courier Cmd ${++k}`, { slug: `courier-cmd-${k}` });
  await enableFlag(prisma, s.businessId, "storefront");
  if (opts.courier !== false) { await enableFlag(prisma, s.businessId, "storeCourier"); process.env["COURIERS_ENABLED"] = "true"; }
  const { order } = await placeStoreOrder(prisma, s, { qty: 2, fulfilment: "DELIVERY" });
  await confirmStoreOrder(prisma, { businessId: s.businessId, orderId: order.id });
  return { s, ctx: ctxFor(s), ref: order.reference, id: order.id };
}

describe("reading a dispatch command", () => {
  it("keywords make a structured booking; plain words stay a delivery reference", () => {
    expect(parseDispatchWords(["via", "manual", "name", "Gokada", "express", "ref", "GK-1", "url", "https://t.example/1", "rider", "Tunde", "Bello", "0803 111 2222"])).toEqual({
      via: "manual", name: "Gokada express", ref: "GK-1", url: "https://t.example/1", riderName: "Tunde Bello", riderPhone: "0803 111 2222",
    });
    expect(parseDispatchWords(["via", "simulator-courier"])).toEqual({ via: "simulator-courier" });
    expect(parseDispatchWords(["Amina", "rider"])).toBeNull(); // must start with a keyword
    expect(parseDispatchWords(["rider", "Amina"])).toEqual({ riderName: "Amina" }); // (the dispatch then asks which courier)
    expect(parseDispatchWords(["TRK-123"])).toBeNull();
    expect(parseDispatchWords([])).toBeNull();
  });
});

describe("/store courier commands", () => {
  it("while the flag is off they do not exist and a legacy dispatch behaves exactly as before; a structured dispatch is refused clearly", async () => {
    const { ctx, ref } = await world({ courier: false });
    expect(await handleCommand(ctx, "/store couriers")).toContain(`I don't know "/store couriers"`);
    expect(await handleCommand(ctx, `/store track ${ref}`)).toContain(`I don't know "/store track"`);
    expect(await handleCommand(ctx, "/store help")).not.toContain("Couriers (delivery orders)");
    expect(await handleCommand(ctx, `/store dispatch ${ref} via manual name Gokada`)).toContain("Courier tracking is not switched on");
    expect(await handleCommand(ctx, `/store dispatch ${ref} TRK-777`)).toContain("is out for delivery; the stock has left your shelves");
  });

  it("lists couriers, books one, shows tracking, and follows a manual delivery to the end", async () => {
    const { s, ctx, ref, id } = await world();
    expect(await handleCommand(ctx, "/store help")).toContain("Couriers (delivery orders)");
    const list = await handleCommand(ctx, "/store couriers");
    expect(list).toContain("manual - Own rider or other courier");
    expect(list).toContain(`${COURIER_SIMULATOR_ID} - Simulator courier (testing only) (reports its own status)`);

    expect(await handleCommand(ctx, `/store dispatch ${ref} via`)).toContain("Say which courier");
    expect(await handleCommand(ctx, `/store dispatch ${ref} via nobody`)).toContain(`don't know the courier "nobody"`);
    expect(await handleCommand(ctx, `/store dispatch ${ref} via manual ref bad url http://insecure.example`)).toContain("tracking link");
    const booked = await handleCommand(ctx, `/store dispatch ${ref} via manual name Gokada ref GK-9 url https://gokada.example/t/9 rider Tunde 08031112222`);
    expect(booked).toContain(`${ref} is out for delivery with Gokada`);
    expect(booked).toContain("Tracking: GK-9");
    expect(booked).toContain("Rider: Tunde 2348031112222");
    expect(booked).toContain('A courier saying "delivered" does not finish the order');

    expect(await handleCommand(ctx, "/store orders")).toContain(`courier Gokada: booked`);
    expect(await handleCommand(ctx, `/store courier ${ref}`)).toContain("Say what happened");
    expect(await handleCommand(ctx, `/store courier ${ref} picked`)).toContain('is now "picked up"');
    expect(await handleCommand(ctx, `/store courier ${ref} picked`)).toContain("Nothing changed");
    expect(await handleCommand(ctx, `/store courier ${ref} transit`)).toContain('is now "in transit"');
    const track = await handleCommand(ctx, `/store track ${ref}`);
    expect(track).toContain(`${ref}: Gokada, On its way.`);
    expect(track).toContain("Link: https://gokada.example/t/9");
    expect(track).toMatch(/History:\n- .* Booked/);
    expect(await handleCommand(ctx, `/store courier ${ref} failed`)).toContain("Say why it could not be delivered");
    const delivered = await handleCommand(ctx, `/store courier ${ref} delivered`);
    expect(delivered).toContain(`take the buyer's 6-digit code: /store done ${ref} <code>`);
    expect((await s.scoped.storeOrder.findUniqueOrThrow({ where: { id } })).status).toBe("OUT_FOR_DELIVERY");
  });

  it("books a registered courier; a failed delivery is flagged on the orders list and the seller decides what happens to the order", async () => {
    const { ctx, ref } = await world();
    const booked = await handleCommand(ctx, `/store dispatch ${ref} via ${COURIER_SIMULATOR_ID}`);
    expect(booked).toContain("Simulator courier (testing only)");
    expect(booked).toContain("Tracking: SC_");
    const failed = await handleCommand(ctx, `/store courier ${ref} failed nobody at the address`);
    expect(failed).toContain("delivery of");
    expect(failed).toContain("/store failed");
    expect(await handleCommand(ctx, "/store orders")).toContain("(act: /store failed or rebook)");
    expect(await handleCommand(ctx, `/store failed ${ref} nobody at the address`)).toContain("the order is cancelled");
  });

  it("a job can be called off before pick-up and another courier booked", async () => {
    const { ctx, ref } = await world();
    await handleCommand(ctx, `/store dispatch ${ref} via manual`);
    expect(await handleCommand(ctx, `/store courier ${ref} cancel`)).toContain("Say why");
    expect(await handleCommand(ctx, `/store courier ${ref} cancel rider fell ill`)).toContain("is cancelled");
    expect(await handleCommand(ctx, `/store dispatch ${ref} via ${COURIER_SIMULATOR_ID}`)).toContain("is now tracking");
  });

  it("only people who may move orders can use them", async () => {
    const { s, ref } = await world();
    const reader = ctxFor(s, "STAFF"); // a sales clerk has store:fulfil
    expect(await handleCommand(reader, `/store track ${ref}`)).toContain("has no courier recorded");
    const none = await handleCommand(ctxFor(s), `/store track NOPE-1`);
    expect(none).toContain("can't find shop order");
  });
});
