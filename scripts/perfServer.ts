/**
 * Starts a throwaway, fully synthetic TradePal web surface (in-process Postgres, one seeded shop with 30 listed products, a few hundred
 * sales for the reports) so pages can be measured repeatably. Prints the base URL and a ready-made phone token. Touches nothing real: no
 * network, no credentials, no production database.
 *
 *   npx tsx scripts/perfServer.ts            # then, in another terminal:  npx tsx scripts/perfMeasure.ts http://127.0.0.1:4173
 */
import express from "express";
import { createTestDb } from "../tests/helpers/db.js";
import { enableFlag, seedReference } from "../tests/helpers/phase2.js";
import { makeSeller } from "../tests/helpers/store.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";
import { addPriceRule } from "../src/domain/pricing.js";
import { receiveStock } from "../src/domain/stock.js";
import { listVariant } from "../src/domain/store/storefront.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { createOfflineRouter } from "../src/offline/routes.js";
import { InMemoryLoginRateLimiter } from "../src/admin/rateLimiter.js";
import { postSale } from "../src/domain/accounting.js";
import { issueConnectCode, exchangeConnectCode } from "../src/offline/devices.js";

process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
process.env["REPORTS_WEB_ENABLED"] = "true";
const port = Number(process.env["PORT"] ?? 4173);

const t = await createTestDb();
await seedReference(t.prisma);
const s = await makeSeller(t.prisma, "Perf Shop", { slug: "perf-shop", flags: ["reportsV2", "offlineDrafts"] });
const list = await s.scoped.priceList.findFirstOrThrow({ where: { kind: "RETAIL" } });
for (let i = 2; i <= 30; i++) {
  const p = await createProduct(s.scoped, { businessId: s.businessId, name: `Product number ${i} with a realistic name` });
  const v = await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku: `SKU${i}`, name: "unit", baseUnit: "unit" });
  await receiveStock(s.scoped, { businessId: s.businessId, shopId: s.shopId, variantId: v.id, quantity: 100, unitCostMinor: 1_000n, currencyCode: "NGN" });
  await addPriceRule(s.scoped, { businessId: s.businessId, priceListId: list.id, variantId: v.id, unitPriceMinor: 2_500n });
  await listVariant(t.prisma, s.businessId, v.id);
}
for (let i = 0; i < 400; i++) {
  await postSale(s.scoped, { businessId: s.businessId, currencyCode: "NGN", totalMinor: BigInt(1000 + i), receipts: [{ method: "CASH", amountMinor: BigInt(1000 + i) }], costMinor: 400n, occurredAt: new Date(Date.now() - (i % 60) * 86_400_000), idempotencyKey: `perf-${i}` });
}
const m = await t.prisma.merchant.create({ data: { businessId: s.businessId, phoneNumber: "2348099999999", onboardingStep: "COMPLETE", role: "OWNER" } });
await enableFlag(t.prisma, s.businessId, "reportsV2");
const { code } = await issueConnectCode(t.prisma, { businessId: s.businessId, merchantId: m.id, shared: false });
const claimed = await exchangeConnectCode(t.prisma, code);

const app = express();
const big = () => new InMemoryLoginRateLimiter(1e9, 1000);
app.use(createStorefrontRouter(t.prisma, { limiters: { read: big(), write: big(), order: big() } }));
app.use(createOfflineRouter(t.prisma, { limiters: { exchange: big(), api: big() } }));
app.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ base: `http://127.0.0.1:${port}`, shop: "/shop/perf-shop", token: claimed?.token, note: "synthetic data only; Ctrl-C to stop" }));
});
