import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { seedReference } from "./helpers/phase2.js";
import { makeSeller } from "./helpers/store.js";
import { getStockLevel } from "../src/domain/stock.js";
import { addToBasket } from "../src/domain/store/basket.js";
import { checkoutBasket, loadStoreOrder } from "../src/domain/store/orders.js";
import { runOperationsSweep } from "../src/queue/operationsSweep.js";

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

describe("operations sweep covers the consumer store", () => {
  it("lapses an unconfirmed order and returns its held stock, retires an abandoned basket, and is idempotent", async () => {
    const s = await makeSeller(prisma, "Sweep Shop", { slug: "sweep-shop" });
    const placedAt = new Date();
    const t = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: 5, now: placedAt });
    const r = await checkoutBasket(prisma, { basketToken: t.token, buyer: { name: "Amaka Obi", phone: "08031234567", contactConsent: false }, allowOnline: false, now: placedAt, sellers: [{ businessId: s.businessId, fulfilment: "PICKUP", paymentMethod: "PAY_ON_COLLECTION" }] });
    const o = r.outcomes[0]!;
    if (!o.ok) throw new Error(o.error);
    const abandoned = await addToBasket(prisma, { token: null, businessId: s.businessId, variantId: s.variant.id, unit: "can", quantity: 1, now: placedAt });
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).reserved).toBeGreaterThanOrEqual(5);

    const early = await runOperationsSweep(prisma, new Date(placedAt.getTime() + 60_000));
    expect(early.storeOrdersExpired).toBe(0);
    expect((await loadStoreOrder(s.scoped, o.order.id)).status).toBe("PLACED");

    const later = new Date(placedAt.getTime() + 30 * 86_400_000);
    const res = await runOperationsSweep(prisma, later);
    expect(res.failures).toEqual([]);
    expect(res.storeOrdersExpired).toBeGreaterThanOrEqual(1);
    expect(res.basketsExpired).toBeGreaterThanOrEqual(1);
    expect((await loadStoreOrder(s.scoped, o.order.id)).status).toBe("EXPIRED");
    expect((await getStockLevel(s.scoped, s.shopId, s.variant.id)).reserved).toBe(0);
    expect((await prisma.basket.findFirstOrThrow({ where: { tokenHash: { not: "" }, status: "EXPIRED" } })).status).toBe("EXPIRED");
    expect(abandoned.token).toBeTruthy();

    const again = await runOperationsSweep(prisma, later);
    expect(again.storeOrdersExpired).toBe(0);
    expect(again.basketsExpired).toBe(0);
  });
});
