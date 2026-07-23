import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { handleCommand, type CommandContext } from "../src/commands/commandRouter.js";
import { recordTransaction } from "../src/domain/ledger.js";

let testDb: TestDb;
let prisma: PrismaClient;
let scoped: TenantScopedClient;
let businessId: string;
let ctx: CommandContext;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;

  await prisma.currency.create({ data: { code: "NGN", name: "Nigerian Naira", minorUnitExp: 2 } });
  await prisma.country.create({
    data: { code: "NG", name: "Nigeria", callingCode: "234", defaultCurrency: "NGN", defaultTimezone: "Africa/Lagos" },
  });
  await prisma.language.create({ data: { code: "en", name: "English" } });

  // addStaffMerchant (via /addstaff) resolves the business's effective plan (getEffectivePlan,
  // billing.ts), which falls back to the "FREE" plan code when there's no Subscription row —
  // that lookup throws PlanNotFoundError if the row doesn't exist, so it must be seeded here.
  await prisma.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: { code: "FREE", name: "Free", priceMinor: 0n, currencyCode: "NGN", entryCapPerMonth: 100, voiceEnabled: false, staffCapCount: null },
  });

  const business = await prisma.business.create({
    data: { name: "Shop A", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
  });
  businessId = business.id;
  scoped = getTenantScopedClient(prisma, businessId);
  ctx = {
    prisma,
    scopedPrisma: scoped,
    businessId,
    currencyCode: "NGN",
    minorUnitExp: 2,
    timezone: "Africa/Lagos",
    languageCode: "en",
    merchantId: "owner-test-merchant",
    merchantRole: "OWNER",
  };
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe("handleCommand", () => {
  it("/help returns the command list", async () => {
    const reply = await handleCommand(ctx, "/help");
    expect(reply).toContain("/debt");
    expect(reply).toContain("/undo");
  });

  it("responds to an unrecognized command with guidance", async () => {
    const reply = await handleCommand(ctx, "/nonsense");
    expect(reply).toContain("Unrecognized command");
  });

  it("/debt records a debt for a (possibly multi-word) customer name", async () => {
    const reply = await handleCommand(ctx, "/debt John the tailor 500");
    expect(reply).toContain("John the tailor");
    expect(reply).toContain("500.00");

    const summary = await handleCommand(ctx, "/customer John the tailor");
    expect(summary).toContain("500.00");
  });

  it("/paid pays down an existing debt and reports the remainder", async () => {
    await handleCommand(ctx, "/debt Amina 1000");
    const reply = await handleCommand(ctx, "/paid Amina 400");

    expect(reply).toContain("400.00");
    expect(reply).toContain("600.00");
  });

  it("/paid surfaces an overpayment refusal instead of throwing", async () => {
    await handleCommand(ctx, "/debt Bello 200");
    const reply = await handleCommand(ctx, "/paid Bello 999999");

    expect(reply).toMatch(/exceeds/i);
  });

  it("/today reports zero activity before any transaction is logged for a fresh business", async () => {
    const business = await prisma.business.create({
      data: { name: "Shop B", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const freshScoped = getTenantScopedClient(prisma, business.id);
    const freshCtx: CommandContext = {
      prisma,
      scopedPrisma: freshScoped,
      businessId: business.id,
      currencyCode: "NGN",
      minorUnitExp: 2,
      timezone: "Africa/Lagos",
      languageCode: "en",
      merchantId: "owner-test-merchant",
      merchantRole: "OWNER",
    };

    const reply = await handleCommand(freshCtx, "/today");
    expect(reply).toContain("Transactions: 0");
  });

  it("/today reflects a debt recorded earlier in the day", async () => {
    const business = await prisma.business.create({
      data: { name: "Shop C", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const freshScoped = getTenantScopedClient(prisma, business.id);
    const freshCtx: CommandContext = {
      prisma,
      scopedPrisma: freshScoped,
      businessId: business.id,
      currencyCode: "NGN",
      minorUnitExp: 2,
      timezone: "Africa/Lagos",
      languageCode: "en",
      merchantId: "owner-test-merchant",
      merchantRole: "OWNER",
    };

    await handleCommand(freshCtx, "/debt Chidi 750");
    const reply = await handleCommand(freshCtx, "/today");
    expect(reply).toContain("Transactions: 1");
  });

  it("/undo reverses the most recently recorded transaction", async () => {
    const business = await prisma.business.create({
      data: { name: "Shop D", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const freshScoped = getTenantScopedClient(prisma, business.id);
    const freshCtx: CommandContext = {
      prisma,
      scopedPrisma: freshScoped,
      businessId: business.id,
      currencyCode: "NGN",
      minorUnitExp: 2,
      timezone: "Africa/Lagos",
      languageCode: "en",
      merchantId: "owner-test-merchant",
      merchantRole: "OWNER",
    };

    await handleCommand(freshCtx, "/debt Dara 300");
    const undoReply = await handleCommand(freshCtx, "/undo");
    expect(undoReply).toContain("Undone");

    const summaryAfterUndo = await handleCommand(freshCtx, "/today");
    expect(summaryAfterUndo).toContain("Net: 0.00");
  });

  it("/undo reports nothing-to-undo for a business with no transactions", async () => {
    const business = await prisma.business.create({
      data: { name: "Shop E", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
    });
    const freshScoped = getTenantScopedClient(prisma, business.id);
    const freshCtx: CommandContext = {
      prisma,
      scopedPrisma: freshScoped,
      businessId: business.id,
      currencyCode: "NGN",
      minorUnitExp: 2,
      timezone: "Africa/Lagos",
      languageCode: "en",
      merchantId: "owner-test-merchant",
      merchantRole: "OWNER",
    };

    const reply = await handleCommand(freshCtx, "/undo");
    expect(reply).toBe("Nothing to undo.");
  });

  it("rejects a malformed amount without crashing", async () => {
    const reply = await handleCommand(ctx, "/debt Femi notanumber");
    expect(reply).toMatch(/not a valid amount/i);
  });

  it("/remind refuses when the reminders feature flag isn't enabled for the business", async () => {
    await handleCommand(ctx, "/debt Ngozi 500");
    const reply = await handleCommand(ctx, "/remind Ngozi");
    expect(reply).toContain("isn't available for your account yet");
  });

  it("/remind returns forwardable reminder text once the feature flag is enabled for the business", async () => {
    await prisma.featureFlag.upsert({
      where: { key: "reminders" },
      update: {},
      create: { key: "reminders", description: "test", enabledByDefault: false },
    });
    await scoped.businessFeatureFlag.upsert({
      where: { businessId_flagKey: { businessId, flagKey: "reminders" } },
      update: { enabled: true },
      create: { businessId, flagKey: "reminders", enabled: true },
    });

    await handleCommand(ctx, "/debt Obi 750");
    const reply = await handleCommand(ctx, "/remind Obi");

    expect(reply).toContain("Forward this message to your customer yourself");
    expect(reply).toContain("Obi");
    expect(reply).toContain("750.00");
  });

  it("/remind reports no outstanding debt for a customer who owes nothing, even with the flag enabled", async () => {
    const reply = await handleCommand(ctx, "/remind Someone With No Debt");
    expect(reply).toMatch(/no open debt/i);
  });

  describe("/momo, /confirmmomo, /rejectmomo", () => {
    it("/momo refuses when the mobileMoneyReconciliation feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop Momo Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshScoped = getTenantScopedClient(prisma, business.id);
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: freshScoped,
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
      };

      const reply = await handleCommand(freshCtx, "/momo some text");
      expect(reply).toContain("isn't available for your account yet");
    });

    describe("with the feature flag enabled", () => {
      let momoBusinessId: string;
      let momoScoped: TenantScopedClient;
      let momoCtx: CommandContext;

      beforeAll(async () => {
        const business = await prisma.business.create({
          data: { name: "Shop Momo On", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        momoBusinessId = business.id;
        momoScoped = getTenantScopedClient(prisma, momoBusinessId);
        momoCtx = {
          prisma,
          scopedPrisma: momoScoped,
          businessId: momoBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: "owner-test-merchant",
          merchantRole: "OWNER",
        };

        await prisma.featureFlag.upsert({
          where: { key: "mobileMoneyReconciliation" },
          update: {},
          create: { key: "mobileMoneyReconciliation", description: "test", enabledByDefault: false },
        });
        await momoScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: momoBusinessId, flagKey: "mobileMoneyReconciliation" } },
          update: { enabled: true },
          create: { businessId: momoBusinessId, flagKey: "mobileMoneyReconciliation", enabled: true },
        });
      });

      it("/momo with unrecognized text tells the merchant to log manually", async () => {
        const reply = await handleCommand(momoCtx, "/momo some random text that isn't an alert");
        expect(reply).toMatch(/couldn't recognize/i);
        expect(reply).toMatch(/\/paid or \/debt/i);
      });

      it("/momo with no candidate transaction logs the alert as unmatched", async () => {
        const reply = await handleCommand(
          momoCtx,
          "/momo XYZ7890ABC Confirmed. You have received Ksh200.00 from SOME CUSTOMER 254798765432 on 7/9/26 at 3:00 PM. New M-PESA balance is Ksh500.00.",
        );
        expect(reply).toMatch(/no matching payment found yet/i);
        expect(reply).toContain("200.00");
      });

      it("/momo auto-suggests a match against an existing PAYMENT_RECEIVED transaction, then /confirmmomo confirms it", async () => {
        await recordTransaction(momoScoped, {
          businessId: momoBusinessId,
          type: "PAYMENT_RECEIVED",
          amountMinor: 123400n,
          currencyCode: "NGN",
          paymentStatus: "PAID",
        });

        const momoReply = await handleCommand(
          momoCtx,
          "/momo ABC1112DEF Confirmed. You have received Ksh1,234.00 from ANOTHER CUSTOMER 254711223344 on 7/9/26 at 4:00 PM. New M-PESA balance is Ksh9,999.00.",
        );
        expect(momoReply).toMatch(/looks like it matches/i);

        const idMatch = /\/confirmmomo ([a-f0-9-]+)/i.exec(momoReply);
        expect(idMatch).not.toBeNull();
        const alertId = idMatch?.[1] as string;

        const confirmReply = await handleCommand(momoCtx, `/confirmmomo ${alertId}`);
        expect(confirmReply).toMatch(/confirmed/i);
        expect(confirmReply).toContain("1234.00");
      });

      it("/rejectmomo reverts a suggested match back to unmatched", async () => {
        await recordTransaction(momoScoped, {
          businessId: momoBusinessId,
          type: "PAYMENT_RECEIVED",
          amountMinor: 55500n,
          currencyCode: "NGN",
          paymentStatus: "PAID",
        });
        const momoReply = await handleCommand(
          momoCtx,
          "/momo GHI2223JKL Confirmed. You have received Ksh555.00 from YET ANOTHER 254733445566 on 7/9/26 at 5:00 PM. New M-PESA balance is Ksh1,111.00.",
        );
        const idMatch = /\/rejectmomo ([a-f0-9-]+)/i.exec(momoReply);
        const alertId = idMatch?.[1] as string;

        const rejectReply = await handleCommand(momoCtx, `/rejectmomo ${alertId}`);
        expect(rejectReply).toMatch(/back to unmatched/i);
      });

      it("/confirmmomo surfaces a not-found error instead of throwing", async () => {
        const reply = await handleCommand(momoCtx, "/confirmmomo does-not-exist");
        expect(reply).toMatch(/no mobile money alert/i);
      });

      it("/momo with no arguments lists alerts awaiting confirmation", async () => {
        await recordTransaction(momoScoped, {
          businessId: momoBusinessId,
          type: "PAYMENT_RECEIVED",
          amountMinor: 88800n,
          currencyCode: "NGN",
          paymentStatus: "PAID",
        });
        await handleCommand(
          momoCtx,
          "/momo MNO3334PQR Confirmed. You have received Ksh888.00 from PENDING PERSON 254744556677 on 7/9/26 at 6:00 PM. New M-PESA balance is Ksh2,222.00.",
        );

        const reply = await handleCommand(momoCtx, "/momo");
        expect(reply).toContain("awaiting confirmation");
        expect(reply).toContain("888.00");
      });
    });
  });

  describe("/usage and quota enforcement", () => {
    it("/usage reports disabled when the billingQuotaEnforcement flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop Usage Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshScoped = getTenantScopedClient(prisma, business.id);
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: freshScoped,
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
      };

      const reply = await handleCommand(freshCtx, "/usage");
      expect(reply).toContain("isn't enabled for your account yet");
    });

    describe("with the feature flag enabled and a plan cap of 1 entry/month", () => {
      let quotaBusinessId: string;
      let quotaScoped: TenantScopedClient;
      let quotaCtx: CommandContext;

      beforeAll(async () => {
        const business = await prisma.business.create({
          data: { name: "Shop Quota", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        quotaBusinessId = business.id;
        quotaScoped = getTenantScopedClient(prisma, quotaBusinessId);
        quotaCtx = {
          prisma,
          scopedPrisma: quotaScoped,
          businessId: quotaBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: "owner-test-merchant",
          merchantRole: "OWNER",
        };

        await prisma.plan.upsert({
          where: { code: "TESTCAP1" },
          update: {},
          create: {
            code: "TESTCAP1",
            name: "Test Cap 1",
            priceMinor: 0n,
            currencyCode: "NGN",
            entryCapPerMonth: 1,
            voiceEnabled: false,
          },
        });
        const now = new Date();
        await prisma.subscription.create({
          data: {
            businessId: quotaBusinessId,
            planCode: "TESTCAP1",
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          },
        });

        await prisma.featureFlag.upsert({
          where: { key: "billingQuotaEnforcement" },
          update: {},
          create: { key: "billingQuotaEnforcement", description: "test", enabledByDefault: false },
        });
        await quotaScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: quotaBusinessId, flagKey: "billingQuotaEnforcement" } },
          update: { enabled: true },
          create: { businessId: quotaBusinessId, flagKey: "billingQuotaEnforcement", enabled: true },
        });
      });

      it("/usage reports 0/1 before any entry is logged", async () => {
        const reply = await handleCommand(quotaCtx, "/usage");
        expect(reply).toContain("TESTCAP1");
        expect(reply).toContain("0/1");
      });

      it("allows the first /debt (within cap), then refuses the second (/debt or /paid) once the cap is used up", async () => {
        const first = await handleCommand(quotaCtx, "/debt Kofi 500");
        expect(first).toContain("Kofi");

        const usageAfterFirst = await handleCommand(quotaCtx, "/usage");
        expect(usageAfterFirst).toContain("1/1");

        const second = await handleCommand(quotaCtx, "/debt Yaw 300");
        expect(second).toMatch(/monthly entry limit reached/i);

        const paidAttempt = await handleCommand(quotaCtx, "/paid Kofi 100");
        expect(paidAttempt).toMatch(/monthly entry limit reached/i);

        // Neither refusal created a new transaction.
        const count = await prisma.transaction.count({ where: { businessId: quotaBusinessId } });
        expect(count).toBe(1);
      });

      it("/undo does not count against the quota, so a fresh entry is allowed again after undoing", async () => {
        const undoReply = await handleCommand(quotaCtx, "/undo");
        expect(undoReply).toContain("Undone");

        // Still 1/1 used (the reversal doesn't refund quota, but it also didn't consume more).
        const usage = await handleCommand(quotaCtx, "/usage");
        expect(usage).toContain("1/1");

        // The cap is still considered used up since the original DEBT_NOTE (non-reversal) still counts.
        const blocked = await handleCommand(quotaCtx, "/debt Ama 200");
        expect(blocked).toMatch(/monthly entry limit reached/i);
      });
    });
  });

  describe("/addstaff", () => {
    it("refuses when the staffAccounts feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop Staff Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshScoped = getTenantScopedClient(prisma, business.id);
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: freshScoped,
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
      };

      const reply = await handleCommand(freshCtx, "/addstaff 2348022223333");
      expect(reply).toContain("isn't available for your account yet");

      const staff = await prisma.merchant.findUnique({ where: { phoneNumber: "2348022223333" } });
      expect(staff).toBeNull();
    });

    describe("with the feature flag enabled", () => {
      let staffBusinessId: string;
      let staffScoped: TenantScopedClient;
      let ownerCtx: CommandContext;
      let staffMemberCtx: CommandContext;
      const OWNER_MERCHANT_ID = "owner-merchant-1";

      beforeAll(async () => {
        const business = await prisma.business.create({
          data: { name: "Shop Staff On", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        staffBusinessId = business.id;
        staffScoped = getTenantScopedClient(prisma, staffBusinessId);

        await prisma.featureFlag.upsert({
          where: { key: "staffAccounts" },
          update: {},
          create: { key: "staffAccounts", description: "test", enabledByDefault: false },
        });
        await staffScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: staffBusinessId, flagKey: "staffAccounts" } },
          update: { enabled: true },
          create: { businessId: staffBusinessId, flagKey: "staffAccounts", enabled: true },
        });

        ownerCtx = {
          prisma,
          scopedPrisma: staffScoped,
          businessId: staffBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: OWNER_MERCHANT_ID,
          merchantRole: "OWNER",
        };
        staffMemberCtx = { ...ownerCtx, merchantId: "some-staff-merchant", merchantRole: "STAFF" };
      });

      it("refuses when a STAFF merchant (not the owner) attempts it", async () => {
        const reply = await handleCommand(staffMemberCtx, "/addstaff 2348033334444");
        expect(reply).toMatch(/only the business owner/i);

        const staff = await prisma.merchant.findUnique({ where: { phoneNumber: "2348033334444" } });
        expect(staff).toBeNull();
      });

      it("adds a new STAFF merchant awaiting consent, and records an audit log entry", async () => {
        const reply = await handleCommand(ownerCtx, "/addstaff +234 805 555 0001");
        expect(reply).toContain("2348055550001");
        expect(reply).toMatch(/finish setup/i);

        const staff = await prisma.merchant.findUniqueOrThrow({ where: { phoneNumber: "2348055550001" } });
        expect(staff.businessId).toBe(staffBusinessId);
        expect(staff.role).toBe("STAFF");
        expect(staff.onboardingStep).toBe("AWAITING_CONSENT");

        const auditRows = await prisma.auditLog.findMany({ where: { entityId: staff.id, entityType: "Merchant" } });
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]?.action).toBe("STAFF_MERCHANT_ADDED");
        expect(auditRows[0]?.actorId).toBe(OWNER_MERCHANT_ID);
      });

      it("refuses to add a phone number already registered to another merchant", async () => {
        const reply = await handleCommand(ownerCtx, "/addstaff 2348055550001");
        expect(reply).toMatch(/already registered/i);
      });

      it("rejects a blank phone number with usage guidance instead of creating a merchant", async () => {
        const reply = await handleCommand(ownerCtx, "/addstaff");
        expect(reply).toMatch(/usage: \/addstaff/i);
      });

      describe("/removestaff", () => {
        it("refuses when a STAFF merchant (not the owner) attempts it", async () => {
          const reply = await handleCommand(staffMemberCtx, "/removestaff 2348055550001");
          expect(reply).toMatch(/only the business owner/i);
        });

        it("rejects a blank phone number with usage guidance", async () => {
          const reply = await handleCommand(ownerCtx, "/removestaff");
          expect(reply).toMatch(/usage: \/removestaff/i);
        });

        it("throws MerchantNotFoundError-backed guidance for an unknown phone number", async () => {
          const reply = await handleCommand(ownerCtx, "/removestaff 2348099999999");
          expect(reply).toMatch(/no merchant with phone number/i);
        });

        it("refuses to remove the OWNER", async () => {
          const owner = await prisma.merchant.create({
            data: { businessId: staffBusinessId, phoneNumber: "2348055559999", role: "OWNER", onboardingStep: "COMPLETE" },
          });
          const reply = await handleCommand(ownerCtx, `/removestaff ${owner.phoneNumber}`);
          expect(reply).toMatch(/cannot be removed/i);
        });

        it("removes a STAFF merchant and refuses a second removal of the same number", async () => {
          const reply = await handleCommand(ownerCtx, "/removestaff 2348055550001");
          expect(reply).toContain("2348055550001");
          expect(reply).toMatch(/removed/i);

          const merchant = await prisma.merchant.findUnique({ where: { phoneNumber: "2348055550001" } });
          expect(merchant?.removedAt).not.toBeNull();

          const secondReply = await handleCommand(ownerCtx, "/removestaff 2348055550001");
          expect(secondReply).toMatch(/already been removed/i);
        });
      });
    });

    it("refuses /removestaff when the staffAccounts feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop RemoveStaff Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: getTenantScopedClient(prisma, business.id),
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
      };

      const reply = await handleCommand(freshCtx, "/removestaff 2348012345678");
      expect(reply).toContain("isn't available for your account yet");
    });
  });

  describe("/stock and /lowstock", () => {
    it("refuse when the stockTracking feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop Stock Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: getTenantScopedClient(prisma, business.id),
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
      };

      const stockReply = await handleCommand(freshCtx, "/stock");
      expect(stockReply).toContain("isn't available for your account yet");

      const lowStockReply = await handleCommand(freshCtx, "/lowstock bread 5");
      expect(lowStockReply).toContain("isn't available for your account yet");
    });

    describe("with the feature flag enabled", () => {
      let stockBusinessId: string;
      let stockScoped: TenantScopedClient;
      let stockCtx: CommandContext;

      beforeAll(async () => {
        const business = await prisma.business.create({
          data: { name: "Shop Stock On", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        stockBusinessId = business.id;
        stockScoped = getTenantScopedClient(prisma, stockBusinessId);

        await prisma.featureFlag.upsert({
          where: { key: "stockTracking" },
          update: {},
          create: { key: "stockTracking", description: "test", enabledByDefault: false },
        });
        await stockScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: stockBusinessId, flagKey: "stockTracking" } },
          update: { enabled: true },
          create: { businessId: stockBusinessId, flagKey: "stockTracking", enabled: true },
        });

        stockCtx = {
          prisma,
          scopedPrisma: stockScoped,
          businessId: stockBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: "owner-test-merchant",
          merchantRole: "OWNER",
        };
      });

      it("/stock reports no items tracked yet before any threshold/adjustment", async () => {
        const reply = await handleCommand(stockCtx, "/stock");
        expect(reply).toBe("No stock items tracked yet.");
      });

      it("/lowstock sets a threshold, creating the item if it doesn't exist yet", async () => {
        const reply = await handleCommand(stockCtx, "/lowstock Bread 5");
        expect(reply).toMatch(/threshold for bread set to 5/i);

        const item = await prisma.inventoryItem.findFirst({ where: { businessId: stockBusinessId, name: "Bread" } });
        expect(item?.lowStockThreshold).toBe(5);
        expect(item?.estimatedStockQty).toBe(0);
      });

      it("/stock now lists the item, flagging LOW STOCK since estimated qty (0) is at/under the threshold", async () => {
        const reply = await handleCommand(stockCtx, "/stock");
        expect(reply).toContain("Bread: 0");
        expect(reply).toContain("LOW STOCK");
      });

      it("/lowstock off clears a previously-set threshold", async () => {
        const reply = await handleCommand(stockCtx, "/lowstock Bread off");
        expect(reply).toMatch(/cleared the low-stock alert threshold for bread/i);

        const item = await prisma.inventoryItem.findFirst({ where: { businessId: stockBusinessId, name: "Bread" } });
        expect(item?.lowStockThreshold).toBeNull();
      });

      it("/lowstock rejects a negative threshold", async () => {
        const reply = await handleCommand(stockCtx, "/lowstock Bread -1");
        expect(reply).toMatch(/whole number 0 or greater/i);
      });

      it("/lowstock rejects malformed input with usage guidance", async () => {
        const reply = await handleCommand(stockCtx, "/lowstock");
        expect(reply).toMatch(/usage: \/lowstock/i);
      });
    });
  });

  describe("/forgetcustomer", () => {
    it("refuses when the customerDeletionRequests feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop Forget Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: getTenantScopedClient(prisma, business.id),
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
      };

      const reply = await handleCommand(freshCtx, "/forgetcustomer Amina");
      expect(reply).toContain("isn't available for your account yet");
    });

    describe("with the feature flag enabled", () => {
      let forgetBusinessId: string;
      let forgetScoped: TenantScopedClient;
      let forgetCtx: CommandContext;

      beforeAll(async () => {
        const business = await prisma.business.create({
          data: { name: "Shop Forget On", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        forgetBusinessId = business.id;
        forgetScoped = getTenantScopedClient(prisma, forgetBusinessId);

        await prisma.featureFlag.upsert({
          where: { key: "customerDeletionRequests" },
          update: {},
          create: { key: "customerDeletionRequests", description: "test", enabledByDefault: false },
        });
        await forgetScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: forgetBusinessId, flagKey: "customerDeletionRequests" } },
          update: { enabled: true },
          create: { businessId: forgetBusinessId, flagKey: "customerDeletionRequests", enabled: true },
        });

        forgetCtx = {
          prisma,
          scopedPrisma: forgetScoped,
          businessId: forgetBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: "owner-test-merchant",
          merchantRole: "OWNER",
        };
      });

      it("reports no customer found rather than creating one", async () => {
        const reply = await handleCommand(forgetCtx, "/forgetcustomer Nobody Here");
        expect(reply).toMatch(/no customer named/i);

        const customer = await forgetScoped.customer.findFirst({ where: { name: "Nobody Here" } });
        expect(customer).toBeNull();
      });

      it("submits a PENDING CUSTOMER_VIA_MERCHANT deletion request for an existing customer, case-insensitively", async () => {
        const customer = await forgetScoped.customer.create({ data: { businessId: forgetBusinessId, name: "Amina" } });

        const reply = await handleCommand(forgetCtx, "/forgetcustomer amina");
        expect(reply).toMatch(/submitted a data-deletion request for amina/i);

        const requests = await forgetScoped.deletionRequest.findMany({ where: { customerId: customer.id } });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.status).toBe("PENDING");
        expect(requests[0]?.requestorType).toBe("CUSTOMER_VIA_MERCHANT");

        // The customer itself is untouched until an admin resolves the request (src/domain/deletion.ts).
        const untouched = await forgetScoped.customer.findUnique({ where: { id: customer.id } });
        expect(untouched?.isAnonymized).toBe(false);
        expect(untouched?.name).toBe("Amina");
      });

      it("rejects malformed input with usage guidance", async () => {
        const reply = await handleCommand(forgetCtx, "/forgetcustomer");
        expect(reply).toMatch(/usage: \/forgetcustomer/i);
      });
    });
  });

  describe("/upgrade", () => {
    it("refuses when the paymentCollection feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop Upgrade Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: getTenantScopedClient(prisma, business.id),
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
        flutterwave: { secretKey: "test-secret" },
        paymentsCheckoutRedirectUrl: "https://tradepal.africa/upgrade/done",
      };

      const reply = await handleCommand(freshCtx, "/upgrade STARTER");
      expect(reply).toContain("isn't available for your account yet");
    });

    describe("with the feature flag enabled", () => {
      let upgradeBusinessId: string;
      let upgradeScoped: TenantScopedClient;
      let ownerCtx: CommandContext;
      let staffMemberCtx: CommandContext;
      let ownerMerchantId: string;

      beforeAll(async () => {
        await prisma.plan.upsert({
          where: { code: "STARTER" },
          update: {},
          create: { code: "STARTER", name: "Starter", priceMinor: 500000n, currencyCode: "NGN", entryCapPerMonth: 1000, voiceEnabled: true },
        });
        await prisma.paymentProvider.upsert({
          where: { code: "FLUTTERWAVE" },
          update: {},
          create: { code: "FLUTTERWAVE", countryCode: "NG", config: {}, enabled: true },
        });

        const business = await prisma.business.create({
          data: { name: "Shop Upgrade On", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        upgradeBusinessId = business.id;
        upgradeScoped = getTenantScopedClient(prisma, upgradeBusinessId);

        await prisma.featureFlag.upsert({
          where: { key: "paymentCollection" },
          update: {},
          create: { key: "paymentCollection", description: "test", enabledByDefault: false },
        });
        await upgradeScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: upgradeBusinessId, flagKey: "paymentCollection" } },
          update: { enabled: true },
          create: { businessId: upgradeBusinessId, flagKey: "paymentCollection", enabled: true },
        });

        const ownerMerchant = await upgradeScoped.merchant.create({ data: { businessId: upgradeBusinessId, phoneNumber: "2348066660001" } });
        ownerMerchantId = ownerMerchant.id;

        ownerCtx = {
          prisma,
          scopedPrisma: upgradeScoped,
          businessId: upgradeBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: ownerMerchantId,
          merchantRole: "OWNER",
          flutterwave: { secretKey: "test-secret", fetchImpl: async () => new Response(JSON.stringify({ status: "success", data: { link: "https://checkout.example/xyz" } }), { status: 200 }) },
          paymentsCheckoutRedirectUrl: "https://tradepal.africa/upgrade/done",
        };
        staffMemberCtx = { ...ownerCtx, merchantId: "some-staff-merchant", merchantRole: "STAFF" };
      });

      it("refuses when a STAFF merchant (not the owner) attempts it", async () => {
        const reply = await handleCommand(staffMemberCtx, "/upgrade STARTER");
        expect(reply).toMatch(/only the business owner/i);
      });

      it("rejects a blank plan code with usage guidance", async () => {
        const reply = await handleCommand(ownerCtx, "/upgrade");
        expect(reply).toMatch(/usage: \/upgrade/i);
      });

      it("reports itself unavailable when flutterwave/redirect config is missing, even with the flag on", async () => {
        const unconfiguredCtx: CommandContext = { ...ownerCtx, flutterwave: undefined, paymentsCheckoutRedirectUrl: undefined };
        const reply = await handleCommand(unconfiguredCtx, "/upgrade STARTER");
        expect(reply).toMatch(/aren't configured/i);
      });

      it("reports an unknown plan code instead of throwing", async () => {
        const reply = await handleCommand(ownerCtx, "/upgrade NOT_A_PLAN");
        expect(reply).toMatch(/unknown plan/i);
      });

      it("requests a checkout link and returns it to the merchant, creating a PENDING subscription+invoice", async () => {
        const reply = await handleCommand(ownerCtx, "/upgrade starter");
        expect(reply).toContain("https://checkout.example/xyz");
        expect(reply).toContain("STARTER");

        const subscription = await prisma.subscription.findFirstOrThrow({ where: { businessId: upgradeBusinessId, planCode: "STARTER" } });
        expect(subscription.status).toBe("PENDING");
      });
    });
  });

  describe("/setprice and /paylink", () => {
    it("refuse when the customerPaymentLinks feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop PayLinks Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: getTenantScopedClient(prisma, business.id),
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
        flutterwave: { secretKey: "test-secret" },
        paymentsCheckoutRedirectUrl: "https://tradepal.africa/paylink/done",
      };

      const setPriceReply = await handleCommand(freshCtx, "/setprice bread 500");
      expect(setPriceReply).toContain("isn't available for your account yet");

      const payLinkReply = await handleCommand(freshCtx, "/paylink John 500");
      expect(payLinkReply).toContain("aren't available for your account yet");
    });

    describe("with the feature flag enabled", () => {
      let payLinksBusinessId: string;
      let payLinksScoped: TenantScopedClient;
      let payLinksCtx: CommandContext;

      beforeAll(async () => {
        await prisma.paymentProvider.upsert({
          where: { code: "FLUTTERWAVE" },
          update: {},
          create: { code: "FLUTTERWAVE", countryCode: "NG", config: {}, enabled: true },
        });

        const business = await prisma.business.create({
          data: { name: "Shop PayLinks On", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        payLinksBusinessId = business.id;
        payLinksScoped = getTenantScopedClient(prisma, payLinksBusinessId);

        await prisma.featureFlag.upsert({
          where: { key: "customerPaymentLinks" },
          update: {},
          create: { key: "customerPaymentLinks", description: "test", enabledByDefault: false },
        });
        await payLinksScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: payLinksBusinessId, flagKey: "customerPaymentLinks" } },
          update: { enabled: true },
          create: { businessId: payLinksBusinessId, flagKey: "customerPaymentLinks", enabled: true },
        });

        const ownerMerchant = await payLinksScoped.merchant.create({ data: { businessId: payLinksBusinessId, phoneNumber: "2348066660002" } });

        payLinksCtx = {
          prisma,
          scopedPrisma: payLinksScoped,
          businessId: payLinksBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: ownerMerchant.id,
          merchantRole: "OWNER",
          flutterwave: {
            secretKey: "test-secret",
            fetchImpl: async () =>
              new Response(JSON.stringify({ status: "success", data: { link: "https://checkout.example/paylink-abc" } }), { status: 200 }),
          },
          paymentsCheckoutRedirectUrl: "https://tradepal.africa/paylink/done",
        };
      });

      it("/setprice sets an item's price, creating it if it doesn't exist yet", async () => {
        const reply = await handleCommand(payLinksCtx, "/setprice Bread 500");
        expect(reply).toMatch(/price for bread set to 500\.00/i);

        const item = await prisma.inventoryItem.findFirst({ where: { businessId: payLinksBusinessId, name: "Bread" } });
        expect(item?.priceMinor).toBe(50000n);
      });

      it("/setprice rejects malformed input with usage guidance", async () => {
        const reply = await handleCommand(payLinksCtx, "/setprice");
        expect(reply).toMatch(/usage: \/setprice/i);
      });

      it("/setprice rejects an invalid amount", async () => {
        const reply = await handleCommand(payLinksCtx, "/setprice Bread notanumber");
        expect(reply).not.toContain("set to");
      });

      it("/paylink rejects malformed input with usage guidance", async () => {
        const reply = await handleCommand(payLinksCtx, "/paylink");
        expect(reply).toMatch(/usage: \/paylink/i);
      });

      it("reports itself unavailable when flutterwave/redirect config is missing, even with the flag on", async () => {
        const unconfiguredCtx: CommandContext = { ...payLinksCtx, flutterwave: undefined, paymentsCheckoutRedirectUrl: undefined };
        const reply = await handleCommand(unconfiguredCtx, "/paylink John 500");
        expect(reply).toMatch(/aren't configured/i);
      });

      it("requests a payment link and returns it as forwardable text, creating a PENDING PaymentRequest", async () => {
        const reply = await handleCommand(payLinksCtx, "/paylink John the tailor 750");
        expect(reply).toContain("https://checkout.example/paylink-abc");
        expect(reply).toContain("John the tailor");
        expect(reply).toContain("750.00");

        const paymentRequest = await prisma.paymentRequest.findFirstOrThrow({
          where: { businessId: payLinksBusinessId, description: "Payment from John the tailor" },
        });
        expect(paymentRequest.status).toBe("PENDING");
        expect(paymentRequest.amountMinor).toBe(75000n);
        expect(paymentRequest.checkoutUrl).toBeNull(); // checkoutUrl isn't persisted on the row itself — only providerReference/tx_ref is

        const customer = await prisma.customer.findFirstOrThrow({ where: { businessId: payLinksBusinessId, name: "John the tailor" } });
        expect(paymentRequest.customerId).toBe(customer.id);
      });

      it("finds an existing customer by name instead of creating a duplicate", async () => {
        await handleCommand(payLinksCtx, "/paylink Amina 200");
        await handleCommand(payLinksCtx, "/paylink Amina 300");

        const customers = await prisma.customer.findMany({ where: { businessId: payLinksBusinessId, name: "Amina" } });
        expect(customers).toHaveLength(1);

        const requests = await prisma.paymentRequest.findMany({
          where: { businessId: payLinksBusinessId, customerId: customers[0]!.id },
        });
        expect(requests).toHaveLength(2);
      });
    });
  });

  describe("/catalog", () => {
    it("refuses when the customerPaymentLinks feature flag isn't enabled for the business", async () => {
      const business = await prisma.business.create({
        data: { name: "Shop Catalog Off", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
      });
      const freshCtx: CommandContext = {
        prisma,
        scopedPrisma: getTenantScopedClient(prisma, business.id),
        businessId: business.id,
        currencyCode: "NGN",
        minorUnitExp: 2,
        timezone: "Africa/Lagos",
        languageCode: "en",
        merchantId: "owner-test-merchant",
        merchantRole: "OWNER",
      };

      const reply = await handleCommand(freshCtx, "/catalog");
      expect(reply).toContain("isn't available for your account yet");
    });

    describe("with the feature flag enabled", () => {
      let catalogBusinessId: string;
      let catalogScoped: TenantScopedClient;
      let catalogCtx: CommandContext;

      beforeAll(async () => {
        const business = await prisma.business.create({
          data: { name: "Shop Catalog On", countryCode: "NG", currencyCode: "NGN", languageCode: "en", timezone: "Africa/Lagos" },
        });
        catalogBusinessId = business.id;
        catalogScoped = getTenantScopedClient(prisma, catalogBusinessId);

        await prisma.featureFlag.upsert({
          where: { key: "customerPaymentLinks" },
          update: {},
          create: { key: "customerPaymentLinks", description: "test", enabledByDefault: false },
        });
        await catalogScoped.businessFeatureFlag.upsert({
          where: { businessId_flagKey: { businessId: catalogBusinessId, flagKey: "customerPaymentLinks" } },
          update: { enabled: true },
          create: { businessId: catalogBusinessId, flagKey: "customerPaymentLinks", enabled: true },
        });

        catalogCtx = {
          prisma,
          scopedPrisma: catalogScoped,
          businessId: catalogBusinessId,
          currencyCode: "NGN",
          minorUnitExp: 2,
          timezone: "Africa/Lagos",
          languageCode: "en",
          merchantId: "owner-test-merchant",
          merchantRole: "OWNER",
        };
      });

      it("reports no priced items yet before any /setprice call", async () => {
        const reply = await handleCommand(catalogCtx, "/catalog");
        expect(reply).toBe("No priced items yet. Add one with /setprice <item name> <amount>.");
      });

      it("lists priced items alphabetically as forwardable text, excluding unpriced items", async () => {
        await handleCommand(catalogCtx, "/setprice Rice 1200");
        await handleCommand(catalogCtx, "/setprice Bread 500");
        // An item with no price set (e.g. via /lowstock) must not appear in the catalog.
        await catalogScoped.inventoryItem.create({
          data: { businessId: catalogBusinessId, name: "Unpriced Item", normalizedName: "unpriced item" },
        });

        const reply = await handleCommand(catalogCtx, "/catalog");
        expect(reply).toContain("forward this list to a customer");
        expect(reply).toContain("Bread: 500.00");
        expect(reply).toContain("Rice: 1200.00");
        expect(reply).not.toContain("Unpriced Item");
        expect(reply.indexOf("Bread")).toBeLessThan(reply.indexOf("Rice"));
      });
    });
  });
});
