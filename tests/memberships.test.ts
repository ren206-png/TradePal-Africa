import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, TenantIsolationViolationError } from "../src/db/tenantScope.js";
import { startOnboarding } from "../src/onboarding/onboardingFlow.js";
import { addStaffMerchant, changeMerchantPhoneNumber, removeStaffMerchant } from "../src/domain/merchantIdentity.js";
import {
  NotAMemberError,
  findMembershipDrift,
  listActiveMemberships,
  normalizePhone,
  resolveActiveContext,
  setActiveContext,
  syncMembershipFromMerchant,
} from "../src/domain/memberships.js";

let testDb: TestDb;
let prisma: PrismaClient;
let db: PGlite;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
  db = testDb.db;
  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });
  await prisma.plan.create({ data: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, staffCapCount: null } });
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

let n = 0;
async function business(name?: string) {
  n++;
  return prisma.business.create({
    data: { name: name ?? `Biz ${n}`, countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
}
const phone = () => `2348055${String(++n).padStart(6, "0")}`;

describe("memberships follow the existing WhatsApp flows", () => {
  it("signup creates the business's default shop and an OWNER membership", async () => {
    const number = phone();
    const { merchant } = await startOnboarding(prisma, number);

    const shops = await prisma.shop.findMany({ where: { businessId: merchant.businessId } });
    expect(shops).toHaveLength(1);
    expect(shops[0]).toMatchObject({ name: "Main shop", isDefault: true });
    const membership = await prisma.membership.findUniqueOrThrow({ where: { businessId_phoneNumber: { businessId: merchant.businessId, phoneNumber: number } } });
    expect(membership).toMatchObject({ role: "OWNER", status: "ACTIVE", shopId: shops[0]!.id });
  });

  it("adding, removing and re-adding staff keeps the membership in step; a phone change moves it", async () => {
    const b = await business();
    const owner = await prisma.merchant.create({ data: { businessId: b.id, phoneNumber: phone(), onboardingStep: "COMPLETE" } });
    await syncMembershipFromMerchant(prisma, owner);

    const staffPhone = phone();
    const staff = await addStaffMerchant(prisma, { businessId: b.id, phoneNumber: staffPhone, invitedByMerchantId: owner.id });
    let m = await prisma.membership.findUniqueOrThrow({ where: { businessId_phoneNumber: { businessId: b.id, phoneNumber: staffPhone } } });
    expect(m).toMatchObject({ role: "SALES_CLERK", status: "ACTIVE" });

    await removeStaffMerchant(prisma, { businessId: b.id, phoneNumber: staffPhone, removedByMerchantId: owner.id });
    m = await prisma.membership.findUniqueOrThrow({ where: { id: m.id } });
    expect(m.status).toBe("REVOKED");
    expect(m.revokedAt).not.toBeNull();

    await addStaffMerchant(prisma, { businessId: b.id, phoneNumber: staffPhone, invitedByMerchantId: owner.id }); // reactivation
    m = await prisma.membership.findUniqueOrThrow({ where: { id: m.id } });
    expect(m.status).toBe("ACTIVE");

    const newPhone = phone();
    await changeMerchantPhoneNumber(prisma, { merchantId: staff.id, businessId: b.id, newPhoneNumber: newPhone, reason: "lost phone" });
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: m.id } })).phoneNumber).toBe(newPhone);
    expect(await findMembershipDrift(prisma)).toMatchObject({ mismatchedStatus: [] });
  });

  it("never downgrades a role someone was given on purpose when the legacy merchant is re-synced", async () => {
    const b = await business();
    const staff = await prisma.merchant.create({ data: { businessId: b.id, phoneNumber: phone(), role: "STAFF", onboardingStep: "COMPLETE" } });
    const first = await syncMembershipFromMerchant(prisma, staff);
    await prisma.membership.update({ where: { id: first.id }, data: { role: "MANAGER" } });
    const again = await syncMembershipFromMerchant(prisma, staff);
    expect(again.role).toBe("MANAGER");
  });
});

describe("backfill of existing data (migration 20261020000200)", () => {
  const backfillSql = () => {
    const full = fs.readFileSync(path.resolve(process.cwd(), "prisma/migrations/20261020000200_phase1_shops_memberships/migration.sql"), "utf8");
    return full.slice(full.indexOf("-- Backfill (idempotent)"));
  };

  it("creates a default shop per business and a membership per merchant (OWNER, STAFF->SALES_CLERK, removed->REVOKED), idempotently", async () => {
    const b = await business("Legacy Biz");
    const owner = await prisma.merchant.create({ data: { businessId: b.id, phoneNumber: phone(), role: "OWNER", onboardingStep: "COMPLETE" } });
    const staff = await prisma.merchant.create({ data: { businessId: b.id, phoneNumber: phone(), role: "STAFF", onboardingStep: "COMPLETE" } });
    const gone = await prisma.merchant.create({ data: { businessId: b.id, phoneNumber: phone(), role: "STAFF", onboardingStep: "COMPLETE", removedAt: new Date() } });

    const before = await findMembershipDrift(prisma);
    expect(before.merchantsWithoutMembership).toEqual(expect.arrayContaining([owner.id, staff.id, gone.id]));
    expect(before.businessesWithoutDefaultShop).toContain(b.id);

    await db.exec(backfillSql());
    await db.exec(backfillSql()); // second run changes nothing

    const memberships = await prisma.membership.findMany({ where: { businessId: b.id }, orderBy: { phoneNumber: "asc" } }); // the backfill inserts all rows in one statement (one timestamp), so order by phone
    expect(memberships.map((m) => [m.phoneNumber, m.role, m.status])).toEqual(
      ([
        [owner.phoneNumber, "OWNER", "ACTIVE"],
        [staff.phoneNumber, "SALES_CLERK", "ACTIVE"],
        [gone.phoneNumber, "SALES_CLERK", "REVOKED"],
      ] as string[][]).sort((x, y) => x[0]!.localeCompare(y[0]!)),
    );
    expect(await prisma.shop.count({ where: { businessId: b.id } })).toBe(1);
    const after = await findMembershipDrift(prisma);
    expect(after.merchantsWithoutMembership).toEqual([]);
    expect(after.businessesWithoutDefaultShop).toEqual([]);
  });
});

describe("explicit active organization / shop (never guessed)", () => {
  it("resolves to none, to the only membership, and to ambiguous when a person belongs to several businesses", async () => {
    const number = phone();
    expect(await resolveActiveContext(prisma, number)).toEqual({ kind: "none" });

    const a = await business("Alpha");
    await prisma.membership.create({ data: { businessId: a.id, phoneNumber: number, role: "OWNER" } });
    expect(await resolveActiveContext(prisma, number)).toMatchObject({ kind: "resolved", businessId: a.id, how: "only_membership" });

    const b = await business("Beta");
    await prisma.membership.create({ data: { businessId: b.id, phoneNumber: number, role: "MANAGER" } });
    const ambiguous = await resolveActiveContext(prisma, number);
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind === "ambiguous") expect(ambiguous.options.map((o) => o.businessName).sort()).toEqual(["Alpha", "Beta"]);

    await setActiveContext(prisma, number, b.id);
    expect(await resolveActiveContext(prisma, number)).toMatchObject({ kind: "resolved", businessId: b.id, how: "explicit_selection" });
  });

  it("forgets a selection once that membership is revoked, and refuses to select a business the person does not belong to", async () => {
    const number = phone();
    const a = await business("Gamma");
    const b = await business("Delta");
    const ma = await prisma.membership.create({ data: { businessId: a.id, phoneNumber: number, role: "OWNER" } });
    await prisma.membership.create({ data: { businessId: b.id, phoneNumber: number, role: "OWNER" } });
    await setActiveContext(prisma, number, a.id);

    await prisma.membership.update({ where: { id: ma.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    expect(await resolveActiveContext(prisma, number)).toMatchObject({ kind: "resolved", businessId: b.id, how: "only_membership" });

    const stranger = await business("Epsilon");
    await expect(setActiveContext(prisma, number, stranger.id)).rejects.toBeInstanceOf(NotAMemberError);
    await expect(setActiveContext(prisma, number, a.id)).rejects.toBeInstanceOf(NotAMemberError); // revoked
    expect((await listActiveMemberships(prisma, number)).map((m) => m.businessId)).toEqual([b.id]);
  });

  it("normalizes phone formatting so '+232 76 123456' and '23276123456' are one person", async () => {
    expect(normalizePhone("+232 76-123456")).toBe("23276123456");
    const a = await business("Zeta");
    await prisma.membership.create({ data: { businessId: a.id, phoneNumber: "23276999999", role: "OWNER" } });
    expect((await listActiveMemberships(prisma, "+232 76 999999")).map((m) => m.businessId)).toEqual([a.id]);
  });
});

describe("structure and isolation", () => {
  it("allows exactly one default shop per business (database-enforced)", async () => {
    const b = await business();
    await prisma.shop.create({ data: { businessId: b.id, name: "Main shop", isDefault: true } });
    await prisma.shop.create({ data: { businessId: b.id, name: "Branch", isDefault: false } });
    await expect(db.query(`INSERT INTO "Shop" (id, "businessId", name, "isDefault", "updatedAt") VALUES (gen_random_uuid()::text, $1, 'Second default', true, now())`, [b.id])).rejects.toThrow(/duplicate key|unique/i);
  });

  it("scopes shops and memberships to the active business like every other tenant table", async () => {
    const a = await business();
    const b = await business();
    await prisma.membership.create({ data: { businessId: a.id, phoneNumber: phone(), role: "OWNER" } });
    await prisma.membership.create({ data: { businessId: b.id, phoneNumber: phone(), role: "OWNER" } });

    const scopedA = getTenantScopedClient(prisma, a.id);
    expect((await scopedA.membership.findMany()).every((m) => m.businessId === a.id)).toBe(true);
    await expect(scopedA.membership.create({ data: { businessId: b.id, phoneNumber: phone(), role: "OWNER" } })).rejects.toBeInstanceOf(TenantIsolationViolationError);
  });

  it("cascades shops and memberships away with an abandoned-onboarding business (the welcome-rollback path)", async () => {
    const number = phone();
    const { merchant } = await startOnboarding(prisma, number);
    await prisma.merchant.delete({ where: { id: merchant.id } });
    await prisma.business.delete({ where: { id: merchant.businessId } });
    expect(await prisma.shop.count({ where: { businessId: merchant.businessId } })).toBe(0);
    expect(await prisma.membership.count({ where: { businessId: merchant.businessId } })).toBe(0);
  });
});
