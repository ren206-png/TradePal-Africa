import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import {
  FeatureFlagNotFoundError,
  isFeatureEnabled,
  listFeatureFlags,
  listFeatureFlagStatesForBusiness,
  removeFeatureFlagOverrideForBusiness,
  setFeatureFlagForBusiness,
  setFeatureFlagGlobalDefault,
} from "../src/domain/featureFlags.js";

let testDb: TestDb;
let prisma: PrismaClient;
let scoped: TenantScopedClient;
let businessId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  const business = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessId = business.id;
  scoped = getTenantScopedClient(prisma, businessId);
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("isFeatureEnabled", () => {
  it("returns false for a flag with no FeatureFlag row at all", async () => {
    expect(await isFeatureEnabled(scoped, businessId, "nonexistent")).toBe(false);
  });

  it("falls back to the flag's global enabledByDefault when no per-business override exists", async () => {
    await prisma.featureFlag.create({
      data: { key: "off-by-default", description: "test flag", enabledByDefault: false },
    });
    await prisma.featureFlag.create({
      data: { key: "on-by-default", description: "test flag", enabledByDefault: true },
    });

    expect(await isFeatureEnabled(scoped, businessId, "off-by-default")).toBe(false);
    expect(await isFeatureEnabled(scoped, businessId, "on-by-default")).toBe(true);
  });

  it("a per-business override wins over the global default in both directions", async () => {
    await prisma.featureFlag.create({
      data: { key: "override-test", description: "test flag", enabledByDefault: false },
    });

    expect(await isFeatureEnabled(scoped, businessId, "override-test")).toBe(false);

    await setFeatureFlagForBusiness(scoped, businessId, "override-test", true);
    expect(await isFeatureEnabled(scoped, businessId, "override-test")).toBe(true);

    await setFeatureFlagForBusiness(scoped, businessId, "override-test", false);
    expect(await isFeatureEnabled(scoped, businessId, "override-test")).toBe(false);
  });
});

describe("setFeatureFlagForBusiness", () => {
  it("throws FeatureFlagNotFoundError for a key with no FeatureFlag row", async () => {
    await expect(setFeatureFlagForBusiness(scoped, businessId, "does-not-exist", true)).rejects.toBeInstanceOf(
      FeatureFlagNotFoundError,
    );
  });

  it("records one AuditLog row per call", async () => {
    await prisma.featureFlag.create({
      data: { key: "audited-flag", description: "test flag", enabledByDefault: false },
    });

    await setFeatureFlagForBusiness(scoped, businessId, "audited-flag", true, {
      reason: "manual QA",
      changedByAdminUserId: "admin-1",
    });

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "BusinessFeatureFlag", entityId: "audited-flag" },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("BUSINESS_FEATURE_FLAG_SET");
    expect(auditRows[0]?.actorType).toBe("ADMIN");
    expect(auditRows[0]?.actorId).toBe("admin-1");
    expect(auditRows[0]?.metadata).toMatchObject({ enabled: true, reason: "manual QA" });
  });
});

describe("removeFeatureFlagOverrideForBusiness", () => {
  it("deletes an existing override and records an AuditLog row", async () => {
    await prisma.featureFlag.create({
      data: { key: "removable-flag", description: "test flag", enabledByDefault: false },
    });
    await setFeatureFlagForBusiness(scoped, businessId, "removable-flag", true);

    const removed = await removeFeatureFlagOverrideForBusiness(scoped, businessId, "removable-flag", {
      reason: "reverting to default",
    });
    expect(removed).toBe(true);
    expect(await isFeatureEnabled(scoped, businessId, "removable-flag")).toBe(false);

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "BusinessFeatureFlag", entityId: "removable-flag", action: "BUSINESS_FEATURE_FLAG_OVERRIDE_REMOVED" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("is idempotent — returns false and records nothing when there was no override", async () => {
    await prisma.featureFlag.create({
      data: { key: "never-overridden", description: "test flag", enabledByDefault: false },
    });

    const removed = await removeFeatureFlagOverrideForBusiness(scoped, businessId, "never-overridden");
    expect(removed).toBe(false);

    const auditRows = await prisma.auditLog.findMany({
      where: { businessId, entityType: "BusinessFeatureFlag", entityId: "never-overridden" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("throws FeatureFlagNotFoundError for a key with no FeatureFlag row", async () => {
    await expect(removeFeatureFlagOverrideForBusiness(scoped, businessId, "does-not-exist")).rejects.toBeInstanceOf(
      FeatureFlagNotFoundError,
    );
  });
});

describe("listFeatureFlags", () => {
  it("returns every FeatureFlag row, ordered by key", async () => {
    const flags = await listFeatureFlags(prisma);
    const keys = flags.map((flag) => flag.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("off-by-default");
    expect(keys).toContain("on-by-default");
  });
});

describe("setFeatureFlagGlobalDefault", () => {
  it("flips the global default, which a business with no override immediately picks up", async () => {
    await prisma.featureFlag.create({
      data: { key: "rollout-flag", description: "test flag", enabledByDefault: false },
    });
    expect(await isFeatureEnabled(scoped, businessId, "rollout-flag")).toBe(false);

    const updated = await setFeatureFlagGlobalDefault(prisma, "rollout-flag", true);
    expect(updated.enabledByDefault).toBe(true);
    expect(await isFeatureEnabled(scoped, businessId, "rollout-flag")).toBe(true);
  });

  it("a business with its own override keeps its choice even after the global default flips", async () => {
    await prisma.featureFlag.create({
      data: { key: "rollout-with-override", description: "test flag", enabledByDefault: false },
    });
    await setFeatureFlagForBusiness(scoped, businessId, "rollout-with-override", false);

    await setFeatureFlagGlobalDefault(prisma, "rollout-with-override", true);
    expect(await isFeatureEnabled(scoped, businessId, "rollout-with-override")).toBe(false);
  });

  it("throws FeatureFlagNotFoundError for a key with no FeatureFlag row", async () => {
    await expect(setFeatureFlagGlobalDefault(prisma, "does-not-exist", true)).rejects.toBeInstanceOf(
      FeatureFlagNotFoundError,
    );
  });

  it("records no AuditLog row — global reference-data changes aren't attributed to a business", async () => {
    await prisma.featureFlag.create({
      data: { key: "unaudited-rollout", description: "test flag", enabledByDefault: false },
    });
    await setFeatureFlagGlobalDefault(prisma, "unaudited-rollout", true);

    const auditRows = await prisma.auditLog.findMany({
      where: { entityType: "FeatureFlag", entityId: "unaudited-rollout" },
    });
    expect(auditRows).toHaveLength(0);
  });
});

describe("listFeatureFlagStatesForBusiness", () => {
  it("merges every flag with this business's override (or null) and the effective boolean", async () => {
    await prisma.featureFlag.create({
      data: { key: "merged-no-override", description: "test flag", enabledByDefault: true },
    });
    await prisma.featureFlag.create({
      data: { key: "merged-with-override", description: "test flag", enabledByDefault: true },
    });
    await setFeatureFlagForBusiness(scoped, businessId, "merged-with-override", false);

    const states = await listFeatureFlagStatesForBusiness(scoped, businessId);

    const noOverride = states.find((state) => state.key === "merged-no-override");
    expect(noOverride?.override).toBeNull();
    expect(noOverride?.effective).toBe(true);

    const withOverride = states.find((state) => state.key === "merged-with-override");
    expect(withOverride?.override).toBe(false);
    expect(withOverride?.effective).toBe(false);
  });
});
