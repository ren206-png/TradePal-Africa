import type { MerchantRole, PrismaClient } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";
import {
  assertWithinQuotaIfEnabled,
  BILLING_QUOTA_FEATURE_FLAG_KEY,
  getQuotaStatus,
  QuotaExceededError,
} from "../domain/billing.js";
import {
  DebtOverpaymentError,
  findCustomerByName,
  findOrCreateCustomerByName,
  listOpenDebtsForCustomer,
  recordDebtNote,
  recordPaymentForCustomer,
} from "../domain/debtBook.js";
import { getDailySummary } from "../domain/dailySummary.js";
import { createDeletionRequest } from "../domain/deletion.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import {
  getCatalog,
  getInventoryStatus,
  InvalidStockThresholdError,
  setInventoryItemPrice,
  setLowStockThreshold,
} from "../domain/inventory.js";
import { reverseTransaction, TransactionAlreadyReversedError } from "../domain/ledger.js";
import {
  addStaffMerchant,
  CannotRemoveOwnerError,
  MerchantAlreadyRemovedError,
  MerchantNotFoundError,
  PhoneNumberAlreadyRegisteredError,
  removeStaffMerchant,
  StaffCapExceededError,
  type AddStaffMerchantOutboundGateway,
} from "../domain/merchantIdentity.js";
import {
  confirmMobileMoneyMatch,
  listSuggestedMobileMoneyAlerts,
  MobileMoneyAlertNotFoundError,
  MobileMoneyAlertNotSuggestedError,
  parseMobileMoneyAlertText,
  recordMobileMoneyAlert,
  rejectMobileMoneyMatch,
  suggestMatchForAlert,
} from "../domain/mobileMoneyReconciliation.js";
import { formatMoney, InvalidAmountError, parseAmountToMinorUnits, sumMoney } from "../domain/money.js";
import {
  initiateSubscriptionCheckout,
  PAYMENT_COLLECTION_FEATURE_FLAG_KEY,
  PlanNotFoundError,
} from "../domain/payments.js";
import { initiatePaymentRequest } from "../domain/paymentRequests.js";
import { generateReminderForCustomer, NoOutstandingDebtError } from "../domain/reminders.js";
import type { FlutterwaveDeps } from "../flutterwave/client.js";

const REMINDERS_FEATURE_FLAG_KEY = "reminders";
const MOBILE_MONEY_FEATURE_FLAG_KEY = "mobileMoneyReconciliation";
const STAFF_ACCOUNTS_FEATURE_FLAG_KEY = "staffAccounts";
/** Same flag key as messageDispatcher.ts's STOCK_TRACKING_FEATURE_FLAG_KEY — one flag gates both the AI intent and these commands. */
const STOCK_TRACKING_FEATURE_FLAG_KEY = "stockTracking";
/** Backs /forgetcustomer — see the doc comment above handleForgetCustomer for why this stays off by default (Standard #7). */
const CUSTOMER_DELETION_REQUESTS_FEATURE_FLAG_KEY = "customerDeletionRequests";
/** Backs /setprice and /paylink (Phase 24) — see the doc comment above handlePayLink. */
const CUSTOMER_PAYMENT_LINKS_FEATURE_FLAG_KEY = "customerPaymentLinks";

export interface CommandContext {
  scopedPrisma: TenantScopedClient;
  /**
   * The raw (unscoped) client — needed only by /addstaff's global
   * phone-number-uniqueness check (mirrors merchantIdentity.ts's
   * changeMerchantPhoneNumber). Every other handler must go through
   * scopedPrisma; do not reach for this for ordinary tenant-scoped reads/writes.
   */
  prisma: PrismaClient;
  businessId: string;
  currencyCode: string;
  minorUnitExp: number;
  timezone: string;
  languageCode: string;
  /** The Merchant.id of whoever sent this message — identity of the acting merchant (Phase 13). */
  merchantId: string;
  /** OWNER vs STAFF (Phase 13) — gates commands like /addstaff to the business owner only. */
  merchantRole: MerchantRole;
  whatsappMessageId?: string;
  /**
   * Phase 14: optional, exactly like every other outboundGateway dep in this
   * codebase (subscriptionExpiry.ts, businessDigest.ts) — only used by
   * /addstaff to proactively notify the newly-added staff member. Omitted in
   * most tests / whenever WhatsApp send credentials aren't configured for
   * this process; /addstaff still succeeds without it, it just skips the
   * notification (the OWNER's own reply already tells them what happened).
   */
  outboundGateway?: AddStaffMerchantOutboundGateway;
  /**
   * Phase 22: optional Flutterwave credentials + checkout redirect URL,
   * mirroring outboundGateway's own optionality — omitted whenever
   * FLUTTERWAVE_SECRET_KEY/FLUTTERWAVE_CHECKOUT_REDIRECT_URL aren't
   * configured for this process (see config/paymentsEnv.ts), in which case
   * /upgrade reports itself unavailable rather than the whole worker
   * refusing to boot over an off-by-default feature.
   */
  flutterwave?: FlutterwaveDeps | undefined;
  paymentsCheckoutRedirectUrl?: string | undefined;
}

const HELP_TEXT = [
  "Available commands:",
  "/debt <name> <amount> [due YYYY-MM-DD] - record a customer's debt",
  "/paid <name> <amount> - record a payment against a customer's open debts",
  "/customer <name> - show what a customer currently owes",
  "/remind <name> - get reminder text to forward to a customer with open debt (if enabled for your account)",
  "/momo <forwarded SMS text> - log a mobile money alert and try to match it to a payment (if enabled for your account)",
  "/confirmmomo <id> - confirm a suggested mobile money match",
  "/rejectmomo <id> - reject a suggested mobile money match",
  "/usage - show how many entries you've logged this month and your plan's monthly limit (if enabled for your account)",
  "/today - show today's sales, expenses, and payments",
  "/undo - reverse the most recent transaction",
  "/addstaff <phone> - let another WhatsApp number log entries for your business too (owner only, if enabled for your account)",
  "/removestaff <phone> - revoke a staff number's access (owner only, if enabled for your account)",
  "/stock - show current estimated stock levels (if enabled for your account)",
  "/lowstock <item name> <threshold|off> - set (or clear with \"off\") a low-stock alert threshold for an item (if enabled for your account)",
  "/forgetcustomer <name> - submit a customer's data-deletion request for review (if enabled for your account)",
  "/upgrade <plan code> - get a payment link to subscribe to a paid plan (owner only, if enabled for your account)",
  "/setprice <item name> <amount> - set the sale price for an item (if enabled for your account)",
  "/paylink <customer name> <amount> - get a payment link to forward to a customer (if enabled for your account)",
  "/catalog - list your priced items as text to forward to a customer (if enabled for your account)",
  "/help - show this message",
].join("\n");

/**
 * Splits "<name...> <amount>" command bodies where the name may itself
 * contain spaces (e.g. "John the tailor 500") — the amount is always the
 * last whitespace-separated token.
 */
function splitNameAndAmount(args: string): { name: string; amountText: string } | null {
  const trimmed = args.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) return null;

  const name = trimmed.slice(0, lastSpace).trim();
  const amountText = trimmed.slice(lastSpace + 1).trim();
  if (!name || !amountText) return null;

  return { name, amountText };
}

async function handleDebt(ctx: CommandContext, args: string): Promise<string> {
  const split = splitNameAndAmount(args);
  if (!split) return 'Usage: /debt <name> <amount>\nExample: "/debt John the tailor 500"';

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountToMinorUnits(split.amountText, ctx.minorUnitExp);
  } catch (error) {
    if (error instanceof InvalidAmountError) return error.message;
    throw error;
  }

  try {
    await assertWithinQuotaIfEnabled(ctx.scopedPrisma, ctx.businessId, ctx.timezone);
  } catch (error) {
    if (error instanceof QuotaExceededError) return error.message;
    throw error;
  }

  const customer = await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, split.name);

  const debt = await recordDebtNote(ctx.scopedPrisma, {
    businessId: ctx.businessId,
    customerId: customer.id,
    customerName: customer.name,
    amountMinor,
    currencyCode: ctx.currencyCode,
    ...(ctx.whatsappMessageId ? { whatsappMessageId: ctx.whatsappMessageId } : {}),
  });

  return `Recorded: ${customer.name} owes ${formatMoney(debt.outstandingAmountMinor, ctx.minorUnitExp)} ${ctx.currencyCode}.`;
}

async function handlePaid(ctx: CommandContext, args: string): Promise<string> {
  const split = splitNameAndAmount(args);
  if (!split) return 'Usage: /paid <name> <amount>\nExample: "/paid John the tailor 500"';

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountToMinorUnits(split.amountText, ctx.minorUnitExp);
  } catch (error) {
    if (error instanceof InvalidAmountError) return error.message;
    throw error;
  }

  try {
    await assertWithinQuotaIfEnabled(ctx.scopedPrisma, ctx.businessId, ctx.timezone);
  } catch (error) {
    if (error instanceof QuotaExceededError) return error.message;
    throw error;
  }

  const customer = await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, split.name);

  try {
    const settlements = await recordPaymentForCustomer(ctx.scopedPrisma, {
      businessId: ctx.businessId,
      customerId: customer.id,
      amountMinor,
      ...(ctx.whatsappMessageId ? { whatsappMessageId: ctx.whatsappMessageId } : {}),
    });

    if (settlements.length === 0) {
      return `${customer.name} has no open debt to pay down.`;
    }

    const remaining = sumMoney(settlements.map((s) => s.debt.outstandingAmountMinor));
    return `Applied ${formatMoney(amountMinor, ctx.minorUnitExp)} ${ctx.currencyCode} to ${customer.name}'s debt. Remaining owed: ${formatMoney(remaining, ctx.minorUnitExp)} ${ctx.currencyCode}.`;
  } catch (error) {
    if (error instanceof DebtOverpaymentError) return error.message;
    throw error;
  }
}

async function handleCustomer(ctx: CommandContext, args: string): Promise<string> {
  const name = args.trim();
  if (!name) return "Usage: /customer <name>";

  const customer = await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, name);
  const openDebts = await listOpenDebtsForCustomer(ctx.scopedPrisma, customer.id);

  if (openDebts.length === 0) {
    return `${customer.name} has no open debt.`;
  }

  const totalOwed = sumMoney(openDebts.map((d) => d.outstandingAmountMinor));
  return `${customer.name} owes ${formatMoney(totalOwed, ctx.minorUnitExp)} ${ctx.currencyCode} across ${openDebts.length} debt(s).`;
}

/**
 * KQ2-compliant reminder command: gated behind a FeatureFlag (Non-Negotiable
 * Standard #7 — off by default) rather than shipped unconditionally, since
 * this is new behavior being rolled out gradually. Never messages the
 * customer directly (Standard #9) — it hands the merchant text to forward.
 */
async function handleRemind(ctx: CommandContext, args: string): Promise<string> {
  const name = args.trim();
  if (!name) return "Usage: /remind <name>";

  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, REMINDERS_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /remind command isn't available for your account yet.";
  }

  const customer = await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, name);
  const openDebts = await listOpenDebtsForCustomer(ctx.scopedPrisma, customer.id);

  try {
    const { replyText } = await generateReminderForCustomer(ctx.scopedPrisma, {
      businessId: ctx.businessId,
      customer,
      openDebts,
      languageCode: ctx.languageCode,
      currencyCode: ctx.currencyCode,
      minorUnitExp: ctx.minorUnitExp,
    });
    return replyText;
  } catch (error) {
    if (error instanceof NoOutstandingDebtError) return error.message;
    throw error;
  }
}

/**
 * Mobile money alerts arrive as a merchant forwarding the provider's SMS
 * text verbatim via WhatsApp. This command is two modes in one: with no
 * arguments, it lists alerts currently awaiting confirmation; with a
 * forwarded SMS body, it tries to parse, record, and auto-match it. Gated
 * behind a FeatureFlag (Standard #7) like /remind, since this is new,
 * gradually-rolled-out behavior.
 */
async function handleMomo(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, MOBILE_MONEY_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /momo command isn't available for your account yet.";
  }

  const text = args.trim();
  if (!text) {
    const pending = await listSuggestedMobileMoneyAlerts(ctx.scopedPrisma);
    if (pending.length === 0) return "No mobile money alerts are waiting for confirmation.";

    const lines = pending.map(
      (alert) =>
        `${alert.id}: ${formatMoney(alert.amountMinor, ctx.minorUnitExp)} ${alert.currencyCode} from ${alert.senderMasked ?? "unknown sender"} — reply /confirmmomo ${alert.id} or /rejectmomo ${alert.id}`,
    );
    return ["Mobile money alerts awaiting confirmation:", ...lines].join("\n");
  }

  const parsed = parseMobileMoneyAlertText(text, ctx.minorUnitExp);
  if (!parsed) {
    return "Couldn't recognize that mobile money alert's format. Please log it manually with /paid or /debt instead.";
  }

  const alert = await recordMobileMoneyAlert(ctx.scopedPrisma, {
    businessId: ctx.businessId,
    provider: parsed.provider,
    amountMinor: parsed.amountMinor,
    currencyCode: ctx.currencyCode,
    rawText: text,
    ...(parsed.senderMasked ? { senderMasked: parsed.senderMasked } : {}),
    ...(parsed.providerTransactionId ? { providerTransactionId: parsed.providerTransactionId } : {}),
  });

  const matched = await suggestMatchForAlert(ctx.scopedPrisma, alert.id);

  if (matched.matchStatus === "SUGGESTED") {
    return (
      `Logged ${formatMoney(matched.amountMinor, ctx.minorUnitExp)} ${matched.currencyCode} from ${matched.senderMasked ?? "unknown sender"}. ` +
      `This looks like it matches an existing payment — reply /confirmmomo ${matched.id} to confirm, or /rejectmomo ${matched.id} if it's wrong.`
    );
  }

  return (
    `Logged ${formatMoney(matched.amountMinor, ctx.minorUnitExp)} ${matched.currencyCode} from ${matched.senderMasked ?? "unknown sender"}. ` +
    `No matching payment found yet — record the sale or payment as usual (e.g. /paid), and this alert (${matched.id}) stays on file for later matching.`
  );
}

async function handleConfirmMomo(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, MOBILE_MONEY_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /confirmmomo command isn't available for your account yet.";
  }

  const alertId = args.trim();
  if (!alertId) return "Usage: /confirmmomo <id>";

  try {
    const alert = await confirmMobileMoneyMatch(ctx.scopedPrisma, {
      alertId,
      businessId: ctx.businessId,
      actorType: "MERCHANT",
      ...(ctx.whatsappMessageId ? { actorId: ctx.whatsappMessageId } : {}),
    });
    return `Confirmed: ${formatMoney(alert.amountMinor, ctx.minorUnitExp)} ${alert.currencyCode} mobile money alert matched.`;
  } catch (error) {
    if (error instanceof MobileMoneyAlertNotFoundError || error instanceof MobileMoneyAlertNotSuggestedError) {
      return error.message;
    }
    throw error;
  }
}

async function handleRejectMomo(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, MOBILE_MONEY_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /rejectmomo command isn't available for your account yet.";
  }

  const alertId = args.trim();
  if (!alertId) return "Usage: /rejectmomo <id>";

  try {
    const alert = await rejectMobileMoneyMatch(ctx.scopedPrisma, {
      alertId,
      businessId: ctx.businessId,
      actorType: "MERCHANT",
      ...(ctx.whatsappMessageId ? { actorId: ctx.whatsappMessageId } : {}),
    });
    return `Rejected the suggested match for alert ${alert.id}. It's back to unmatched.`;
  } catch (error) {
    if (error instanceof MobileMoneyAlertNotFoundError || error instanceof MobileMoneyAlertNotSuggestedError) {
      return error.message;
    }
    throw error;
  }
}

/**
 * Reports this month's ledger-entry usage against the business's plan cap.
 * Gated behind BILLING_QUOTA_FEATURE_FLAG_KEY like the enforcement itself
 * (Standard #7) — if quota isn't being enforced for this business, there's
 * nothing meaningful to report.
 */
async function handleUsage(ctx: CommandContext): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, BILLING_QUOTA_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "Usage tracking isn't enabled for your account yet.";
  }

  const status = await getQuotaStatus(ctx.scopedPrisma, ctx.businessId, ctx.timezone);
  if (status.plan.entryCapPerMonth === null) {
    return `Plan: ${status.plan.code} (uncapped). Entries logged this month: ${status.usedThisMonth}.`;
  }

  return `Plan: ${status.plan.code}. Entries logged this month: ${status.usedThisMonth}/${status.plan.entryCapPerMonth}.`;
}

async function handleToday(ctx: CommandContext): Promise<string> {
  const summary = await getDailySummary(ctx.scopedPrisma, ctx.timezone);

  return [
    `Today (${ctx.timezone}):`,
    `Transactions: ${summary.transactionCount}`,
    `Sales: ${formatMoney(summary.totalSalesMinor, ctx.minorUnitExp)} ${ctx.currencyCode}`,
    `Expenses: ${formatMoney(summary.totalExpensesMinor, ctx.minorUnitExp)} ${ctx.currencyCode}`,
    `Payments received: ${formatMoney(summary.totalPaymentsReceivedMinor, ctx.minorUnitExp)} ${ctx.currencyCode}`,
    `Net: ${formatMoney(summary.netMinor, ctx.minorUnitExp)} ${ctx.currencyCode}`,
  ].join("\n");
}

async function handleUndo(ctx: CommandContext): Promise<string> {
  const lastTransaction = await ctx.scopedPrisma.transaction.findFirst({
    where: { reversalOfTransactionId: null, reversedBy: null },
    orderBy: { createdAt: "desc" },
  });

  if (!lastTransaction) return "Nothing to undo.";

  try {
    await reverseTransaction(ctx.scopedPrisma, lastTransaction.id, "undone by merchant via /undo");
    return `Undone: ${lastTransaction.type} of ${formatMoney(lastTransaction.amountMinor, ctx.minorUnitExp)} ${ctx.currencyCode}.`;
  } catch (error) {
    if (error instanceof TransactionAlreadyReversedError) return error.message;
    throw error;
  }
}

/**
 * Phase 13 (multi-staff support, KQ6): lets the business OWNER provision a
 * second (or third, ...) WhatsApp number that can log entries and use
 * commands for the same business — closing the shared-phone limitation that
 * single-owner competitor apps don't address either. Gated behind a
 * FeatureFlag (Standard #7) like every other new/risky behavior, and further
 * gated to `role === "OWNER"` once the flag is on, since this changes who can
 * act on a business's behalf. See merchantIdentity.ts's addStaffMerchant for
 * why the new row starts at AWAITING_CONSENT rather than COMPLETE.
 */
async function handleAddStaff(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, STAFF_ACCOUNTS_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /addstaff command isn't available for your account yet.";
  }

  if (ctx.merchantRole !== "OWNER") {
    return "Only the business owner can add staff.";
  }

  const phoneNumber = args.trim().replace(/\D/g, "");
  if (!phoneNumber) return 'Usage: /addstaff <phone number>\nExample: "/addstaff 2348012345678"';

  try {
    const staff = await addStaffMerchant(
      ctx.prisma,
      {
        businessId: ctx.businessId,
        phoneNumber,
        invitedByMerchantId: ctx.merchantId,
      },
      ctx.outboundGateway,
    );
    return `Added ${staff.phoneNumber} as staff. Ask them to message this WhatsApp number to finish setup.`;
  } catch (error) {
    if (error instanceof PhoneNumberAlreadyRegisteredError || error instanceof StaffCapExceededError) return error.message;
    throw error;
  }
}

/**
 * Phase 14 gap closure (disclosed in Phase 13): the counterpart to
 * /addstaff. Same gating shape (feature flag, then owner-only) since this is
 * the second roster-management command — see PHASE_0_FINDINGS.md's Phase 13
 * section for why fine-grained per-command role gating stops here rather
 * than extending to every ordinary operational command.
 */
async function handleRemoveStaff(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, STAFF_ACCOUNTS_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /removestaff command isn't available for your account yet.";
  }

  if (ctx.merchantRole !== "OWNER") {
    return "Only the business owner can remove staff.";
  }

  const phoneNumber = args.trim().replace(/\D/g, "");
  if (!phoneNumber) return 'Usage: /removestaff <phone number>\nExample: "/removestaff 2348012345678"';

  try {
    const removed = await removeStaffMerchant(ctx.prisma, {
      businessId: ctx.businessId,
      phoneNumber,
      removedByMerchantId: ctx.merchantId,
    });
    return `Removed ${removed.phoneNumber}'s access to this business.`;
  } catch (error) {
    if (
      error instanceof MerchantNotFoundError ||
      error instanceof CannotRemoveOwnerError ||
      error instanceof MerchantAlreadyRemovedError
    ) {
      return error.message;
    }
    throw error;
  }
}

/**
 * Phase 14: read-only stock snapshot, mirroring /today's own shape (a plain-
 * text, no-emoji listing). Gated behind stockTracking (Standard #7) — until
 * a business opts in, there is nothing meaningful to show anyway, since
 * nothing can have created an InventoryItem row yet.
 */
async function handleStock(ctx: CommandContext): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, STOCK_TRACKING_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "Stock tracking isn't available for your account yet.";
  }

  const items = await getInventoryStatus(ctx.scopedPrisma, ctx.businessId);
  if (items.length === 0) return "No stock items tracked yet.";

  const lines = items.map((item) => {
    const unitSuffix = item.unit ? ` ${item.unit}` : "";
    const lowStockSuffix = item.isLowStock ? " (LOW STOCK)" : "";
    return `${item.name}: ${item.estimatedStockQty}${unitSuffix}${lowStockSuffix}`;
  });

  return ["Estimated stock levels:", ...lines].join("\n");
}

/**
 * Sets a per-item low-stock alert threshold. "off" clears it (rather than
 * overloading a numeric 0, which is itself a meaningful threshold — "alert
 * me once this item is completely out"). Uses the same
 * splitNameAndAmount-style "name may contain spaces, last token is the
 * value" parsing as /debt and /paid.
 */
async function handleLowStock(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, STOCK_TRACKING_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "Stock tracking isn't available for your account yet.";
  }

  const split = splitNameAndAmount(args);
  if (!split) return 'Usage: /lowstock <item name> <threshold|off>\nExample: "/lowstock bread 5"';

  let threshold: number | null;
  if (split.amountText.toLowerCase() === "off") {
    threshold = null;
  } else {
    const parsed = Number(split.amountText);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return 'Threshold must be a whole number 0 or greater, or "off" to clear it.';
    }
    threshold = parsed;
  }

  try {
    const item = await setLowStockThreshold(ctx.scopedPrisma, ctx.businessId, split.name, threshold);
    return threshold === null
      ? `Cleared the low-stock alert threshold for ${item.name}.`
      : `Low-stock alert threshold for ${item.name} set to ${threshold}.`;
  } catch (error) {
    if (error instanceof InvalidStockThresholdError) return error.message;
    throw error;
  }
}

/**
 * KQ5 gap closure: the merchant-forwarded on-ramp for a customer's
 * data-deletion request (NDPA/DPA/Act 843 subject-deletion rights — see
 * PHASE_0_FINDINGS.md's KQ5). Mirrors /remind's KQ2 shape exactly — a
 * customer can't message TradePal directly (Standard #9 restricts inbound
 * command handling to registered merchant numbers same as it restricts
 * outbound sends), so a merchant relays the request on their behalf, which
 * is why `requestorType` is always CUSTOMER_VIA_MERCHANT here, never
 * CUSTOMER_DIRECT (that value exists for a hypothetical future direct-intake
 * channel, e.g. a web form, not this command).
 *
 * Gated behind its own FeatureFlag (Standard #7) since this is new,
 * gradually-rolled-out behavior. Deliberately looks up the customer with the
 * non-creating findCustomerByName rather than findOrCreateCustomerByName —
 * see that function's doc comment (debtBook.ts) for why auto-creating here
 * would be wrong. This command only ever creates a PENDING DeletionRequest;
 * resolving it (anonymizing the customer) is an admin-dashboard action
 * (adminRoutes.ts's POST /deletion-requests/:id/complete), never automatic —
 * a human should confirm identity/intent before any data is altered.
 */
async function handleForgetCustomer(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, CUSTOMER_DELETION_REQUESTS_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /forgetcustomer command isn't available for your account yet.";
  }

  const name = args.trim();
  if (!name) return "Usage: /forgetcustomer <name>";

  const customer = await findCustomerByName(ctx.scopedPrisma, name);
  if (!customer) return `No customer named "${name}" found.`;

  await createDeletionRequest(ctx.scopedPrisma, {
    businessId: ctx.businessId,
    customerId: customer.id,
    requestorType: "CUSTOMER_VIA_MERCHANT",
    description: `Deletion requested via WhatsApp /forgetcustomer for customer ${customer.name}.`,
  });

  return `Submitted a data-deletion request for ${customer.name}. It'll be reviewed and actioned by our support team.`;
}

/**
 * Phase 22: the merchant-facing on-ramp for TradePal's first money-moving
 * feature. Gated behind paymentCollection (Standard #7) and, once the flag
 * is on, owner-only (same shape as /addstaff//removestaff) — a plan upgrade
 * is a billing decision for the business, not something a STAFF number
 * should be able to trigger. Returns a Flutterwave-hosted checkout link;
 * the Subscription this creates stays PENDING (not entitled to anything —
 * see billing.ts's getEffectivePlan) until the Flutterwave webhook confirms
 * payment (src/domain/payments.ts's confirmSubscriptionPayment).
 */
async function handleUpgrade(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, PAYMENT_COLLECTION_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "The /upgrade command isn't available for your account yet.";
  }

  if (ctx.merchantRole !== "OWNER") {
    return "Only the business owner can upgrade the subscription plan.";
  }

  const planCode = args.trim().toUpperCase();
  if (!planCode) return 'Usage: /upgrade <plan code>\nExample: "/upgrade STARTER"';

  if (!ctx.flutterwave || !ctx.paymentsCheckoutRedirectUrl) {
    return "Plan upgrades aren't configured for your account yet. Please contact support.";
  }

  try {
    const result = await initiateSubscriptionCheckout(
      ctx.prisma,
      {
        businessId: ctx.businessId,
        planCode,
        initiatedByMerchantId: ctx.merchantId,
        redirectUrl: ctx.paymentsCheckoutRedirectUrl,
      },
      ctx.flutterwave,
    );
    return `Complete your payment here to activate the ${planCode} plan: ${result.checkoutUrl}`;
  } catch (error) {
    if (error instanceof PlanNotFoundError) return `Unknown plan "${planCode}". Contact support for available plans.`;
    throw error;
  }
}

/**
 * Phase 24: sets the sale price for a catalog item, powering /paylink's
 * amount-collection flow (a merchant still types the amount explicitly on
 * /paylink itself — this command only records a reference price on the
 * item). Mirrors /lowstock's found-or-create-by-name shape exactly.
 */
async function handleSetPrice(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, CUSTOMER_PAYMENT_LINKS_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "Item pricing isn't available for your account yet.";
  }

  const split = splitNameAndAmount(args);
  if (!split) return 'Usage: /setprice <item name> <amount>\nExample: "/setprice bread 500"';

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountToMinorUnits(split.amountText, ctx.minorUnitExp);
  } catch (error) {
    if (error instanceof InvalidAmountError) return error.message;
    throw error;
  }

  const item = await setInventoryItemPrice(ctx.scopedPrisma, ctx.businessId, split.name, amountMinor);
  return `Price for ${item.name} set to ${formatMoney(amountMinor, ctx.minorUnitExp)}.`;
}

/**
 * Phase 24: TradePal's first feature that lets a merchant collect payment
 * from their *own* customer (as opposed to /upgrade, which collects the
 * merchant's own subscription payment). Standard #9 forbids ever storing or
 * messaging a customer's WhatsApp number directly, so — exactly like
 * /remind — this only ever returns forwardable text; nothing here sends
 * anything to the customer automatically. The Flutterwave webhook confirms
 * payment later (src/domain/paymentRequests.ts's confirmPaymentRequestPayment),
 * the same asynchronous shape as /upgrade's checkout link.
 */
async function handlePayLink(ctx: CommandContext, args: string): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, CUSTOMER_PAYMENT_LINKS_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "Payment links aren't available for your account yet.";
  }

  const split = splitNameAndAmount(args);
  if (!split) return 'Usage: /paylink <customer name> <amount>\nExample: "/paylink John the tailor 500"';

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountToMinorUnits(split.amountText, ctx.minorUnitExp);
  } catch (error) {
    if (error instanceof InvalidAmountError) return error.message;
    throw error;
  }

  if (!ctx.flutterwave || !ctx.paymentsCheckoutRedirectUrl) {
    return "Payment links aren't configured for your account yet. Please contact support.";
  }

  const customer = await findOrCreateCustomerByName(ctx.scopedPrisma, ctx.businessId, split.name);
  const result = await initiatePaymentRequest(
    ctx.prisma,
    {
      businessId: ctx.businessId,
      customerId: customer.id,
      description: `Payment from ${customer.name}`,
      amountMinor,
      currencyCode: ctx.currencyCode,
      initiatedByMerchantId: ctx.merchantId,
      redirectUrl: ctx.paymentsCheckoutRedirectUrl,
    },
    ctx.flutterwave,
  );

  return `Send this link to ${customer.name} to collect ${formatMoney(amountMinor, ctx.minorUnitExp)}:\n${result.checkoutUrl}`;
}

/**
 * Phase 25: lists every item priced via /setprice as one block of
 * forwardable text — the natural complement to /paylink. Reuses
 * CUSTOMER_PAYMENT_LINKS_FEATURE_FLAG_KEY rather than a new flag, since a
 * catalog is meaningless without priced items, which only exist once that
 * flag (and therefore /setprice) is already enabled. Same Standard #9 shape
 * as /remind and /paylink: nothing here is sent anywhere automatically.
 */
async function handleCatalog(ctx: CommandContext): Promise<string> {
  const enabled = await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, CUSTOMER_PAYMENT_LINKS_FEATURE_FLAG_KEY);
  if (!enabled) {
    return "Your catalog isn't available for your account yet.";
  }

  const items = await getCatalog(ctx.scopedPrisma, ctx.businessId);
  if (items.length === 0) {
    return "No priced items yet. Add one with /setprice <item name> <amount>.";
  }

  const lines = items.map((item) => `- ${item.name}: ${formatMoney(item.priceMinor, ctx.minorUnitExp)}`);
  return ["Your catalog (forward this list to a customer):", ...lines].join("\n");
}

export async function handleCommand(ctx: CommandContext, rawText: string): Promise<string> {
  const trimmed = rawText.trim();
  const firstSpace = trimmed.indexOf(" ");
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

  switch (command) {
    case "/debt":
      return handleDebt(ctx, args);
    case "/paid":
      return handlePaid(ctx, args);
    case "/customer":
      return handleCustomer(ctx, args);
    case "/remind":
      return handleRemind(ctx, args);
    case "/momo":
      return handleMomo(ctx, args);
    case "/confirmmomo":
      return handleConfirmMomo(ctx, args);
    case "/rejectmomo":
      return handleRejectMomo(ctx, args);
    case "/usage":
      return handleUsage(ctx);
    case "/today":
      return handleToday(ctx);
    case "/undo":
      return handleUndo(ctx);
    case "/addstaff":
      return handleAddStaff(ctx, args);
    case "/removestaff":
      return handleRemoveStaff(ctx, args);
    case "/stock":
      return handleStock(ctx);
    case "/lowstock":
      return handleLowStock(ctx, args);
    case "/forgetcustomer":
      return handleForgetCustomer(ctx, args);
    case "/upgrade":
      return handleUpgrade(ctx, args);
    case "/setprice":
      return handleSetPrice(ctx, args);
    case "/paylink":
      return handlePayLink(ctx, args);
    case "/catalog":
      return handleCatalog(ctx);
    case "/help":
      return HELP_TEXT;
    default:
      return `Unrecognized command "${command}". ${HELP_TEXT}`;
  }
}
