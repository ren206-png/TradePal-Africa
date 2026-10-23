import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { enableFlag, seedReference } from "./helpers/phase2.js";
import { makeSeller, placeStoreOrder, type Seller } from "./helpers/store.js";
import { deliverCallback, drainInbox, simulatorWorld, startPayment } from "./helpers/payments.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { setAdapterRegistry } from "../src/payments/registry.js";
import type { SimulatorAdapter } from "../src/payments/simulatorAdapter.js";
import type { AdapterRegistry } from "../src/payments/adapter.js";
import { completeStoreOrder, confirmStoreOrder, loadStoreOrder, markStoreOrderReady } from "../src/domain/store/orders.js";
import { requestRefund } from "../src/domain/store/refunds.js";
import { unpublishListing } from "../src/domain/moderation.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;
let sim: SimulatorAdapter;
let registry: AdapterRegistry;
let k = 0;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  await seedReference(prisma);
  ({ sim, registry } = simulatorWorld(prisma));
}, 60_000);
afterAll(async () => {
  delete process.env["STOREFRONT_SIMULATOR_ENABLED"];
  setAdapterRegistry(null);
  await testDb.teardown();
});

const ctxFor = (b: { businessId: string; scoped: CommandContext["scopedPrisma"] }): CommandContext => ({
  prisma, scopedPrisma: b.scoped, businessId: b.businessId, currencyCode: "NGN", minorUnitExp: 2, timezone: "Africa/Lagos", languageCode: "en", merchantId: "m-1", merchantRole: "OWNER",
});

async function paidOnlineOrder(s: Seller) {
  const { order } = await placeStoreOrder(prisma, s, { qty: 2, online: true });
  const { attempt } = await startPayment(prisma, registry, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
  await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!));
  await drainInbox(prisma);
  return { order, attempt };
}

describe("/store with online payments and the marketplace", () => {
  it("refunds money the provider collected THROUGH the provider, and books it only when the provider confirms", async () => {
    const s = await makeSeller(prisma, `Online Shop ${++k}`, { slug: `online-shop-${k}` });
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    const ctx = ctxFor(s);
    const { order, attempt } = await paidOnlineOrder(s);
    expect(await handleCommand(ctx, "/store payments")).toContain(`${order.reference}: 200.00 NGN - succeeded, collected by the provider, not paid out yet`);
    await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: order.id });
    const code = (await loadStoreOrder(s.scoped, order.id)).pickupCode;
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: order.id, code });
    await requestRefund(prisma, { businessId: s.businessId, orderId: order.id, kind: "REFUND_ONLY", reason: "One can was dented", requestedAmountMinor: 5_000n });
    const rid = /#([0-9a-f]{6}) REFUND/.exec(await handleCommand(ctx, "/store requests"))?.[1];
    expect(rid).toBeTruthy();
    expect(await handleCommand(ctx, `/store refund approve ${rid} 50`)).toContain("Approved a refund of 50.00 NGN");
    const out = await handleCommand(ctx, `/store refund pay ${rid} cash`);
    expect(out).toContain("sent back through the payment provider and recorded");
    expect(await loadStoreOrder(s.scoped, order.id)).toMatchObject({ refundedMinor: 5_000n });
    expect((await prisma.simulatorPayment.findUniqueOrThrow({ where: { externalRef: attempt.externalRef! } })).refundedMinor).toBe(5_000n);
    expect(await s.scoped.providerRefund.count({ where: { attemptId: attempt.id, status: "SUCCEEDED" } })).toBe(1);
    expect(await handleCommand(ctx, `/store refund pay ${rid} cash`)).toContain("already sent and recorded");

    // a provider that cannot refund leaves the books alone and says so
    const b = await paidOnlineOrder(s);
    await markStoreOrderReady(prisma, { businessId: s.businessId, orderId: b.order.id });
    await completeStoreOrder(prisma, { businessId: s.businessId, orderId: b.order.id, code: (await loadStoreOrder(s.scoped, b.order.id)).pickupCode });
    await requestRefund(prisma, { businessId: s.businessId, orderId: b.order.id, kind: "REFUND_ONLY", reason: "Wrong flavour sent", requestedAmountMinor: 7_000n });
    const rid2 = /#([0-9a-f]{6}) REFUND/.exec(await handleCommand(ctx, "/store requests"))?.[1];
    await handleCommand(ctx, `/store refund approve ${rid2} 70`);
    await sim.setBehaviour(b.attempt.externalRef!, "REFUND_FAILS");
    const failed = await handleCommand(ctx, `/store refund pay ${rid2}`);
    expect(failed).toContain("could not send the refund");
    expect(failed).toContain("NOT recorded");
    expect(await loadStoreOrder(s.scoped, b.order.id)).toMatchObject({ refundedMinor: 0n });
    expect(await prisma.providerException.count({ where: { attemptId: b.attempt.id, type: "REFUND_FAILED", status: "OPEN" } })).toBe(1);
  });

  it("a held late payment is refunded through the provider that collected it", async () => {
    const s = await makeSeller(prisma, `Late Shop ${++k}`, { slug: `late-shop-${k}` });
    await enableFlag(prisma, s.businessId, "storefrontOnlinePayment");
    const ctx = ctxFor(s);
    const { order } = await placeStoreOrder(prisma, s, { qty: 1, online: true });
    const { attempt } = await startPayment(prisma, registry, { businessId: s.businessId, subjectType: "STORE_ORDER", subjectId: order.id });
    await handleCommand(ctx, `/store cancel ${order.reference} Out of stock`);
    await deliverCallback(prisma, registry, await sim.completePayment(attempt.externalRef!));
    await drainInbox(prisma);
    const held = await handleCommand(ctx, "/store requests");
    const eid = /#([0-9a-f]{6}) PAYMENT/.exec(held)?.[1];
    expect(held).toContain("late success");
    expect(await handleCommand(ctx, `/store payment ${eid} refund`)).toContain("sent back through the payment provider");
    expect(await handleCommand(ctx, "/store requests")).not.toContain("PAYMENT");
    expect((await prisma.simulatorPayment.findUniqueOrThrow({ where: { externalRef: attempt.externalRef! } })).refundedMinor).toBe(10_000n);
  });

  it("runs the marketplace opt-in, publishing, a takedown and an appeal from WhatsApp", async () => {
    const s = await makeSeller(prisma, `Market Shop ${++k}`, { slug: `market-shop-${k}` });
    const ctx = ctxFor(s);
    expect(await handleCommand(ctx, "/store marketplace on")).toContain("not switched on for your account");
    await enableFlag(prisma, s.businessId, "marketplace");
    expect(await handleCommand(ctx, "/store marketplace")).toContain("publish at least one item");
    expect(await handleCommand(ctx, "/store publish COLA")).toContain("Say the category");
    expect(await handleCommand(ctx, "/store publish COLA spaceships")).toContain("Choose a category");
    expect(await handleCommand(ctx, "/store categories")).toContain("Groceries");
    expect(await handleCommand(ctx, "/store publish COLA food")).toContain('published on the marketplace under "Food and drink"');
    expect(await handleCommand(ctx, "/store marketplace on")).toContain("You are on the marketplace");
    expect(await handleCommand(ctx, "/store marketplace")).toContain("ACTIVE. 1 item(s) published");

    const listing = await s.scoped.listing.findFirstOrThrow({ where: { channel: "MARKETPLACE" } });
    await unpublishListing(prisma, { listingId: listing.id, adminUserId: "admin-1", reason: "Reported as counterfeit and confirmed" });
    expect(await handleCommand(ctx, "/store publish COLA food")).toContain("A TradePal moderator unpublished this item");
    const mod = await handleCommand(ctx, "/store moderation");
    expect(mod).toContain("Unpublished by a moderator: COLA");
    expect(mod).toContain("/store appeal");
    expect(await handleCommand(ctx, "/store appeal no")).toContain("Say why");
    expect(await handleCommand(ctx, "/store appeal These are genuine goods and I have the supplier invoice.")).toContain("Your appeal was sent");
    expect(await handleCommand(ctx, "/store appeal I am appealing the same thing once more today")).toContain("already appealed");
    expect(await handleCommand(ctx, "/store moderation")).toContain("Appeal");
    expect(await handleCommand(ctx, "/store unpublish COLA")).toContain("no longer on the marketplace");
    expect(await handleCommand(ctx, "/store marketplace off")).toContain("off the marketplace");
  });
});

void confirmStoreOrder;
