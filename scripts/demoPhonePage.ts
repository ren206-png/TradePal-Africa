/**
 * Serves the phone page (/m/) and the public shop on a throw-away in-memory database with a synthetic seller, so the screens can be
 * tried in a real browser. Nothing here touches a real database, a provider or a phone number.
 *
 *   npx tsx scripts/demoPhonePage.ts [port]
 *
 * Prints a one-time connect code (valid 10 minutes; restart the script for another) and the shop address.
 */
import express from "express";
import { createTestDb } from "../tests/helpers/db.js";
import { enableFlag, seedReference } from "../tests/helpers/phase2.js";
import { makeSeller } from "../tests/helpers/store.js";
import { createOfflineRouter } from "../src/offline/routes.js";
import { createStorefrontRouter } from "../src/storefront/routes.js";
import { issueConnectCode } from "../src/offline/devices.js";
import { createProduct, createVariant } from "../src/domain/catalog.js";

process.env["CATALOG_WEB_ENABLED"] = "true";
process.env["OFFLINE_DRAFTS_ENABLED"] = "true";
process.env["NODE_ENV"] = "development";
const port = Number(process.argv[2] ?? 4181);

const t = await createTestDb();
await seedReference(t.prisma);
const s = await makeSeller(t.prisma, "Demo Provisions", { slug: "demo-provisions" });
for (const f of ["catalogV2", "offlineDrafts"]) await enableFlag(t.prisma, s.businessId, f);
for (const [sku, name, unit] of [["RICE5", "Rice 5 kg", "bag"], ["OIL1L", "Vegetable oil 1 L", "bottle"], ["SOAP", "Bath soap", "piece"]] as const) {
  const p = await createProduct(s.scoped, { businessId: s.businessId, name });
  await createVariant(s.scoped, { businessId: s.businessId, productId: p.id, sku, name, baseUnit: unit });
}
const m = await t.prisma.merchant.create({ data: { businessId: s.businessId, phoneNumber: "2348099990001", onboardingStep: "COMPLETE", role: "OWNER" } });
const { code } = await issueConnectCode(t.prisma, { businessId: s.businessId, merchantId: m.id, shared: false });

const app = express();
app.use(createOfflineRouter(t.prisma));
app.use(createStorefrontRouter(t.prisma, {}));
app.listen(port, "127.0.0.1", () => {
  console.log(`Phone page:  http://127.0.0.1:${port}/m/   (connect code ${code})`);
  console.log(`Public shop: http://127.0.0.1:${port}/shop/demo-provisions`);
});
