import type { Merchant, PrismaClient } from "@prisma/client";
import { getCountryByPhoneNumber } from "../config/countries.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { findOrCreateCustomerByName } from "../domain/debtBook.js";

export class UnsupportedCountryError extends Error {}

export const CONSENT_TEXT_VERSION = "v1";

export const ONBOARDING_TERMS_TEXT =
  "By using TradePal you agree to our Terms of Service and Privacy Policy, and consent to us " +
  "processing your business's transaction data to provide bookkeeping and reminders. Reply YES to " +
  "accept and finish setup.";

export interface OnboardingStepResult {
  merchant: Merchant;
  reply: string;
}

export function isOnboardingComplete(merchant: Merchant): boolean {
  return merchant.onboardingStep === "COMPLETE";
}

export async function findMerchantByPhoneNumber(prisma: PrismaClient, phoneNumber: string): Promise<Merchant | null> {
  return prisma.merchant.findUnique({ where: { phoneNumber } });
}

/**
 * A merchant's WhatsApp number is their identity (KQ6) and its calling code
 * maps 1:1 to one of the supported launch countries (SUPPORTED_COUNTRIES), so
 * country is inferred rather than asked — skipping straight to the
 * business-name question. A number whose calling code isn't one of them
 * means TradePal genuinely isn't available there yet, so no Business/Merchant
 * row is created at all (there is no valid country/currency/timezone to put
 * on one).
 */
export async function startOnboarding(prisma: PrismaClient, phoneNumber: string): Promise<OnboardingStepResult> {
  const country = getCountryByPhoneNumber(phoneNumber);
  if (!country) {
    throw new UnsupportedCountryError(`No supported country matches phone number ${phoneNumber}.`);
  }

  const business = await prisma.business.create({
    data: {
      name: "",
      countryCode: country.code,
      currencyCode: country.currency.code,
      languageCode: country.defaultLanguage,
      timezone: country.defaultTimezone,
    },
  });

  const merchant = await prisma.merchant.create({
    data: { businessId: business.id, phoneNumber, onboardingStep: "AWAITING_BUSINESS_NAME" },
  });

  return {
    merchant,
    reply: `Welcome to TradePal! We noticed you're in ${country.name}. What's the name of your business?`,
  };
}

async function handleAwaitingBusinessName(
  prisma: PrismaClient,
  merchant: Merchant,
  text: string,
): Promise<OnboardingStepResult> {
  const name = text.trim();
  if (!name) {
    return { merchant, reply: "Please reply with your business's name (e.g. \"Amina's Provisions\")." };
  }

  await prisma.business.update({ where: { id: merchant.businessId }, data: { name } });

  const scoped = getTenantScopedClient(prisma, merchant.businessId);
  const updated = await scoped.merchant.update({
    where: { id: merchant.id },
    data: { onboardingStep: "AWAITING_CONSENT" },
  });

  return { merchant: updated, reply: ONBOARDING_TERMS_TEXT };
}

async function handleAwaitingConsent(
  prisma: PrismaClient,
  merchant: Merchant,
  text: string,
): Promise<OnboardingStepResult> {
  const reply = text.trim().toLowerCase();
  if (!/^y(es)?$/.test(reply)) {
    return { merchant, reply: `${ONBOARDING_TERMS_TEXT}\n(Reply YES to continue.)` };
  }

  const scoped = getTenantScopedClient(prisma, merchant.businessId);

  await scoped.consentLog.create({
    data: {
      businessId: merchant.businessId,
      merchantId: merchant.id,
      consentType: "ONBOARDING_TERMS",
      textVersion: CONSENT_TEXT_VERSION,
      channel: "whatsapp",
    },
  });
  await scoped.consentLog.create({
    data: {
      businessId: merchant.businessId,
      merchantId: merchant.id,
      consentType: "DATA_PROCESSING",
      textVersion: CONSENT_TEXT_VERSION,
      channel: "whatsapp",
    },
  });

  const updated = await scoped.merchant.update({
    where: { id: merchant.id },
    data: { onboardingStep: "AWAITING_FIRST_CUSTOMER" },
  });

  return {
    merchant: updated,
    reply:
      "You're all set! Now let's add your first customer — reply with their name " +
      '(e.g. "Amina"), or type SKIP to do this later with /debt <name> <amount>.',
  };
}

export const ONBOARDING_COMPLETE_REPLY =
  "Just tell me about a sale, expense, or debt in plain language, or type /help to see commands.";

async function handleAwaitingFirstCustomer(
  prisma: PrismaClient,
  merchant: Merchant,
  text: string,
): Promise<OnboardingStepResult> {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      merchant,
      reply: 'Please reply with your customer\'s name, or type SKIP to do this later.',
    };
  }

  const scoped = getTenantScopedClient(prisma, merchant.businessId);

  if (/^skip$/i.test(trimmed)) {
    const updated = await scoped.merchant.update({
      where: { id: merchant.id },
      data: { onboardingStep: "COMPLETE" },
    });
    return { merchant: updated, reply: `No problem — you can add customers anytime with /debt <name> <amount>. ${ONBOARDING_COMPLETE_REPLY}` };
  }

  const customer = await findOrCreateCustomerByName(scoped, merchant.businessId, trimmed);
  const updated = await scoped.merchant.update({
    where: { id: merchant.id },
    data: { onboardingStep: "COMPLETE" },
  });

  return {
    merchant: updated,
    reply: `Added ${customer.name} as a customer. You're all set! ${ONBOARDING_COMPLETE_REPLY}`,
  };
}

/** Only valid once `isOnboardingComplete(merchant)` is false. */
export async function continueOnboarding(
  prisma: PrismaClient,
  merchant: Merchant,
  text: string,
): Promise<OnboardingStepResult> {
  switch (merchant.onboardingStep) {
    case "AWAITING_BUSINESS_NAME":
      return handleAwaitingBusinessName(prisma, merchant, text);
    case "AWAITING_CONSENT":
      return handleAwaitingConsent(prisma, merchant, text);
    case "AWAITING_FIRST_CUSTOMER":
      return handleAwaitingFirstCustomer(prisma, merchant, text);
    case "AWAITING_COUNTRY":
    case "AWAITING_LANGUAGE":
    case "COMPLETE":
      throw new Error(
        `Merchant ${merchant.id} is in onboarding step ${merchant.onboardingStep}, which continueOnboarding never produces and should never be resumed from.`,
      );
  }
}
