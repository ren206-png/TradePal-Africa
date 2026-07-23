import { PrismaClient } from "@prisma/client";
import { SUPPORTED_COUNTRIES } from "../src/config/countries.js";

const prisma = new PrismaClient();

/**
 * Reference/master data only (Currency, Country, Language, CountryConfig,
 * Plan) — derived from the same SUPPORTED_COUNTRIES the app itself reads
 * from, so the DB and the app config can't drift apart. No Business or
 * Merchant rows: those are created by the onboarding flow, never by seeding.
 */
async function main(): Promise<void> {
  await prisma.language.upsert({ where: { code: "en" }, update: {}, create: { code: "en", name: "English" } });

  for (const country of SUPPORTED_COUNTRIES) {
    await prisma.currency.upsert({
      where: { code: country.currency.code },
      update: {},
      create: {
        code: country.currency.code,
        name: country.currency.name,
        minorUnitExp: country.currency.minorUnitExp,
      },
    });

    await prisma.country.upsert({
      where: { code: country.code },
      update: {},
      create: {
        code: country.code,
        name: country.name,
        callingCode: country.callingCode,
        defaultCurrency: country.currency.code,
        defaultTimezone: country.defaultTimezone,
      },
    });

    await prisma.countryConfig.upsert({
      where: { countryCode: country.code },
      update: {},
      create: {
        countryCode: country.code,
        defaultLanguage: country.defaultLanguage,
        voiceEnabled: country.voiceEnabled,
      },
    });
  }

  await prisma.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: {
      code: "FREE",
      name: "Free",
      priceMinor: 0n,
      currencyCode: "NGN",
      entryCapPerMonth: 100,
      voiceEnabled: false,
    },
  });

  // Phase 22: the first plan a business can actually pay for via /upgrade
  // (src/domain/payments.ts) — every plan before this was assignable only by
  // an admin (planAdmin.ts), since payment collection didn't exist yet.
  // Priced in NGN like FREE; a real deployment would seed one STARTER row per
  // launch-country currency, which this phase doesn't attempt.
  await prisma.plan.upsert({
    where: { code: "STARTER" },
    update: {},
    create: {
      code: "STARTER",
      name: "Starter",
      priceMinor: 500000n, // NGN 5,000.00
      currencyCode: "NGN",
      entryCapPerMonth: 1000,
      voiceEnabled: true,
    },
  });

  // Non-Negotiable Standard #7: every FeatureFlag is off by default and rolled out
  // per-business via BusinessFeatureFlag. "reminders" backs the /remind command (KQ2).
  await prisma.featureFlag.upsert({
    where: { key: "reminders" },
    update: {},
    create: {
      key: "reminders",
      description: "Enables the /remind command, which generates reminder text for a merchant to forward to a customer with open debt.",
      enabledByDefault: false,
    },
  });

  // Phase 3: mobile money alert reconciliation. Backs /momo, /confirmmomo, /rejectmomo.
  await prisma.featureFlag.upsert({
    where: { key: "mobileMoneyReconciliation" },
    update: {},
    create: {
      key: "mobileMoneyReconciliation",
      description: "Enables /momo (log + auto-match a forwarded mobile money SMS alert), /confirmmomo, and /rejectmomo.",
      enabledByDefault: false,
    },
  });

  // Phase 4: monthly plan entry-cap enforcement. Backs /usage and the quota
  // check in /debt, /paid, and the AI free-text logging path.
  await prisma.featureFlag.upsert({
    where: { key: "billingQuotaEnforcement" },
    update: {},
    create: {
      key: "billingQuotaEnforcement",
      description:
        "Enforces each business's plan.entryCapPerMonth against ledger entries logged this month, and enables /usage.",
      enabledByDefault: false,
    },
  });

  // Phase 7: notifies a business's merchant(s) via WhatsApp when the hourly
  // subscription-expiry sweep (src/domain/subscriptionExpiry.ts) flips their
  // subscription to PAST_DUE, closing the "silently falls back to FREE with
  // nobody told why" gap disclosed in Phase 6.
  await prisma.featureFlag.upsert({
    where: { key: "subscriptionLapseNotification" },
    update: {},
    create: {
      key: "subscriptionLapseNotification",
      description:
        "Sends a WhatsApp text message to a business's registered merchant(s) when their subscription lapses to PAST_DUE.",
      enabledByDefault: false,
    },
  });

  // Voice-note transcription (src/messageDispatcher.ts's resolveVoiceNote, src/stt/provider.ts):
  // a business only gets this once this flag, CountryConfig.voiceEnabled for its
  // country, AND its plan's Plan.voiceEnabled are all true (see doc comment on
  // resolveVoiceNote for the full three-gate story).
  await prisma.featureFlag.upsert({
    where: { key: "voiceTranscription" },
    update: {},
    create: {
      key: "voiceTranscription",
      description:
        "Transcribes an inbound WhatsApp voice note (via OpenAI Whisper) and feeds the transcript into the same command/free-text pipeline as typed messages, instead of always replying that voice isn't supported.",
      enabledByDefault: false,
    },
  });

  // Phase 12: proactive weekly financial-health nudge (src/domain/businessDigest.ts) —
  // sends a WhatsApp summary of the completed week's sales/expenses/net plus the
  // business's largest open debt to every registered merchant, once a week.
  await prisma.featureFlag.upsert({
    where: { key: "weeklyBusinessDigest" },
    update: {},
    create: {
      key: "weeklyBusinessDigest",
      description:
        "Sends a WhatsApp message to a business's registered merchant(s) once a week summarizing the completed week's transactions (sales/expenses/net) and its largest open debt.",
      enabledByDefault: false,
    },
  });

  // Phase 13: multi-staff support. Backs /addstaff and (Phase 14) /removestaff
  // (src/commands/commandRouter.ts), which let a business's OWNER provision and later
  // revoke a second WhatsApp number (role STAFF) that can log entries and use commands
  // for the same business.
  await prisma.featureFlag.upsert({
    where: { key: "staffAccounts" },
    update: {},
    create: {
      key: "staffAccounts",
      description:
        "Enables /addstaff and /removestaff, letting a business's OWNER register and revoke additional WhatsApp numbers (role STAFF) that act on the same business.",
      enabledByDefault: false,
    },
  });

  // Phase 14: stock/inventory tracking. Backs the STOCK_ADJUSTMENT AI intent
  // (src/ai/applyParsedIntent.ts) plus /stock and /lowstock (src/commands/commandRouter.ts).
  await prisma.featureFlag.upsert({
    where: { key: "stockTracking" },
    update: {},
    create: {
      key: "stockTracking",
      description:
        "Enables InventoryItem/InventoryMovement tracking: the STOCK_ADJUSTMENT AI intent, and the /stock and /lowstock commands.",
      enabledByDefault: false,
    },
  });

  // Phase 16 (KQ5 gap closure): the merchant-facing on-ramp for a customer's
  // data-deletion request. Backs /forgetcustomer (src/commands/commandRouter.ts),
  // which creates a PENDING DeletionRequest for an admin to review and resolve
  // via the admin dashboard's POST /deletion-requests/:id/complete|reject
  // (src/admin/adminRoutes.ts).
  await prisma.featureFlag.upsert({
    where: { key: "customerDeletionRequests" },
    update: {},
    create: {
      key: "customerDeletionRequests",
      description:
        "Enables /forgetcustomer, letting a merchant submit a customer's data-deletion request (NDPA/DPA/Act 843) for admin review.",
      enabledByDefault: false,
    },
  });

  // Phase 22: first feature in this codebase that moves real money. Backs
  // /upgrade (src/commands/commandRouter.ts), which requests a Flutterwave-
  // hosted checkout link (src/domain/payments.ts) for a paid Plan; the
  // Flutterwave webhook route then activates the Subscription once payment
  // is confirmed.
  await prisma.featureFlag.upsert({
    where: { key: "paymentCollection" },
    update: {},
    create: {
      key: "paymentCollection",
      description:
        "Enables /upgrade, letting a business OWNER request a Flutterwave-hosted checkout link to subscribe to a paid Plan.",
      enabledByDefault: false,
    },
  });

  // Phase 24: reuses the same Flutterwave integration as paymentCollection above, but for a
  // merchant to collect payment from their own customer (/setprice, /paylink) instead of paying
  // TradePal itself.
  await prisma.featureFlag.upsert({
    where: { key: "customerPaymentLinks" },
    update: {},
    create: {
      key: "customerPaymentLinks",
      description:
        "Enables /setprice and /paylink, letting a merchant set item prices and generate a Flutterwave-hosted payment link to forward to a customer.",
      enabledByDefault: false,
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
