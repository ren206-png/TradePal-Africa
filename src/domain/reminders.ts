import type { Customer, Debt, Reminder } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import { formatMoney, sumMoney } from "./money.js";

export class NoOutstandingDebtError extends Error {}

export interface GenerateReminderInput {
  businessId: string;
  customer: Customer;
  openDebts: Debt[];
  languageCode: string;
  currencyCode: string;
  minorUnitExp: number;
}

export interface GeneratedReminder {
  reminder: Reminder;
  /** Full text the merchant should forward — includes the forwarding instruction (Non-Negotiable
   * Standard #9: TradePal's outbound gateway is architecturally incapable of messaging the
   * customer directly, per Phase 0 KQ2), not just the raw reminder copy. */
  replyText: string;
}

/**
 * KQ2-compliant reminder: generates plain-language reminder text for a
 * merchant to copy/forward to a customer themselves — TradePal never
 * messages the customer directly. Requires at least one open debt; refuses
 * (rather than silently generating a reminder about nothing) otherwise.
 */
export async function generateReminderForCustomer(
  scopedPrisma: TenantScopedClient,
  input: GenerateReminderInput,
): Promise<GeneratedReminder> {
  if (input.openDebts.length === 0) {
    throw new NoOutstandingDebtError(`${input.customer.name} has no open debt to send a reminder about.`);
  }

  const totalOwedMinor = sumMoney(input.openDebts.map((d) => d.outstandingAmountMinor));
  const oldestDebt = input.openDebts[0];

  const generatedText =
    `Hi ${input.customer.name}, this is a friendly reminder that you have an outstanding balance of ` +
    `${formatMoney(totalOwedMinor, input.minorUnitExp)} ${input.currencyCode}. Please reach out to arrange payment. Thank you!`;

  const reminder = await scopedPrisma.reminder.create({
    data: {
      businessId: input.businessId,
      customerId: input.customer.id,
      debtId: oldestDebt?.id ?? null,
      languageCode: input.languageCode,
      generatedText,
      deliveredToMerchantAt: new Date(),
    },
  });

  const replyText = [
    "Forward this message to your customer yourself — TradePal cannot message customers directly:",
    "",
    generatedText,
  ].join("\n");

  return { reminder, replyText };
}
