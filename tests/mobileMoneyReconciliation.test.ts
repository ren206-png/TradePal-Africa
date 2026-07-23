import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { getTenantScopedClient, type TenantScopedClient } from "../src/db/tenantScope.js";
import { recordTransaction } from "../src/domain/ledger.js";
import {
  confirmMobileMoneyMatch,
  listSuggestedMobileMoneyAlerts,
  MobileMoneyAlertNotFoundError,
  MobileMoneyAlertNotSuggestedError,
  parseMobileMoneyAlertText,
  recordMobileMoneyAlert,
  rejectMobileMoneyMatch,
  suggestMatchForAlert,
} from "../src/domain/mobileMoneyReconciliation.js";

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

describe("parseMobileMoneyAlertText", () => {
  it("parses an M-Pesa style alert", () => {
    const text =
      "QWE1234RTY Confirmed. You have received Ksh1,500.00 from JANE DOE 254712345678 on 7/9/26 at 2:30 PM. New M-PESA balance is Ksh3,000.00.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("M-PESA");
    expect(parsed?.amountMinor).toBe(150000n);
    expect(parsed?.providerTransactionId).toBe("QWE1234RTY");
    expect(parsed?.senderMasked).toContain("JANE DOE");
    expect(parsed?.senderMasked).toContain("5678");
    expect(parsed?.senderMasked).not.toContain("254712345678");
  });

  it("parses a generic MoMo style alert", () => {
    const text = "You have received GHS 50.00 from John Doe (0241234567). Trans ID: ABC123XYZ.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("MOBILE_MONEY");
    expect(parsed?.amountMinor).toBe(5000n);
    expect(parsed?.providerTransactionId).toBe("ABC123XYZ");
  });

  it("returns null (never guesses) for an unrecognized format", () => {
    const parsed = parseMobileMoneyAlertText("Your account was credited. Thanks!", 2);
    expect(parsed).toBeNull();
  });

  it("returns null for plain unrelated text", () => {
    expect(parseMobileMoneyAlertText("hello there", 2)).toBeNull();
  });

  it("parses an MTN MoMo style alert with 'Financial Transaction Id' and no cents in the amount", () => {
    const text =
      "MTN Mobile Money: You have received GHS 5,000 from John Doe (0241234567). Your new balance:GHS10,000. Financial Transaction Id:1234567890.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("MTN_MOMO");
    expect(parsed?.amountMinor).toBe(500000n);
    expect(parsed?.providerTransactionId).toBe("1234567890");
    expect(parsed?.senderMasked).toContain("John Doe");
    expect(parsed?.senderMasked).toContain("4567");
  });

  it("parses an Airtel Money style alert where the transaction id leads the message", () => {
    const text = "TxnId: AB12CD34. You have received UGX5,000.00 from Jane Doe 256701234567. Thank you for using Airtel Money.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("AIRTEL_MONEY");
    expect(parsed?.amountMinor).toBe(500000n);
    expect(parsed?.providerTransactionId).toBe("AB12CD34");
    expect(parsed?.senderMasked).toContain("Jane Doe");
    expect(parsed?.senderMasked).not.toContain("256701234567");
  });

  it("tags an Orange Money alert by brand name even though it shares the generic MoMo shape", () => {
    const text = "You have received SLE 500.00 from Mariama Kamara (23276123456). Orange Money Transaction ID: ORM998877.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("ORANGE_MONEY");
    expect(parsed?.amountMinor).toBe(50000n);
  });

  it("tags an Africell Money alert by brand name even though it shares the generic MoMo shape", () => {
    const text = "You have received SLE 750.00 from Ibrahim Sesay (23278123456). Africell Money Ref No: AFR445566.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("AFRICELL_MONEY");
    expect(parsed?.amountMinor).toBe(75000n);
  });

  it("parses an M-Pesa Till/Business payment alert, which omits 'You have' before 'received'", () => {
    const text =
      "RJ2H3AWJ4S Confirmed. Ksh2,500.00 received from JOHN KAMAU 254722334455 on 7/11/26 at 9:15 AM. New Utility balance is Ksh10,500.00.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("M-PESA");
    expect(parsed?.amountMinor).toBe(250000n);
    expect(parsed?.providerTransactionId).toBe("RJ2H3AWJ4S");
    expect(parsed?.senderMasked).toContain("JOHN KAMAU");
    expect(parsed?.senderMasked).toContain("4455");
    expect(parsed?.senderMasked).not.toContain("254722334455");
  });

  it("still parses the personal-account M-Pesa 'You have received' shape distinctly from the Till shape", () => {
    // Regression guard: the new Till pattern (no "You have") must not swallow or
    // otherwise interfere with matching the pre-existing P2P shape.
    const text =
      "QWE1234RTY Confirmed. You have received Ksh1,500.00 from JANE DOE 254712345678 on 7/9/26 at 2:30 PM. New M-PESA balance is Ksh3,000.00.";
    const parsed = parseMobileMoneyAlertText(text, 2);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("M-PESA");
    expect(parsed?.amountMinor).toBe(150000n);
  });
});

describe("recordMobileMoneyAlert", () => {
  it("creates a new alert", async () => {
    const alert = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 10000n,
      currencyCode: "NGN",
      rawText: "raw text 1",
      providerTransactionId: "TXN-DEDUPE-1",
    });

    expect(alert.matchStatus).toBe("UNMATCHED");
    expect(alert.providerTransactionId).toBe("TXN-DEDUPE-1");
  });

  it("is idempotent on providerTransactionId — forwarding the same SMS twice doesn't duplicate", async () => {
    const first = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 20000n,
      currencyCode: "NGN",
      rawText: "raw text 2",
      providerTransactionId: "TXN-DEDUPE-2",
    });
    const second = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 20000n,
      currencyCode: "NGN",
      rawText: "raw text 2 (forwarded again)",
      providerTransactionId: "TXN-DEDUPE-2",
    });

    expect(second.id).toBe(first.id);

    const count = await prisma.mobileMoneyAlert.count({ where: { providerTransactionId: "TXN-DEDUPE-2" } });
    expect(count).toBe(1);
  });
});

describe("suggestMatchForAlert", () => {
  it("suggests a match when exactly one unambiguous candidate transaction exists", async () => {
    const transaction = await recordTransaction(scoped, {
      businessId,
      type: "PAYMENT_RECEIVED",
      amountMinor: 33300n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });

    const alert = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 33300n,
      currencyCode: "NGN",
      rawText: "raw text 3",
    });

    const result = await suggestMatchForAlert(scoped, alert.id);
    expect(result.matchStatus).toBe("SUGGESTED");
    expect(result.matchedTransactionId).toBe(transaction.id);
  });

  it("leaves the alert UNMATCHED when there is no candidate transaction", async () => {
    const alert = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 999999n,
      currencyCode: "NGN",
      rawText: "raw text 4",
    });

    const result = await suggestMatchForAlert(scoped, alert.id);
    expect(result.matchStatus).toBe("UNMATCHED");
    expect(result.matchedTransactionId).toBeNull();
  });

  it("leaves the alert UNMATCHED (refuses to guess) when multiple ambiguous candidates exist", async () => {
    await recordTransaction(scoped, {
      businessId,
      type: "PAYMENT_RECEIVED",
      amountMinor: 44400n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    await recordTransaction(scoped, {
      businessId,
      type: "PAYMENT_RECEIVED",
      amountMinor: 44400n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });

    const alert = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 44400n,
      currencyCode: "NGN",
      rawText: "raw text 5",
    });

    const result = await suggestMatchForAlert(scoped, alert.id);
    expect(result.matchStatus).toBe("UNMATCHED");
  });

  it("throws MobileMoneyAlertNotFoundError for an unknown id", async () => {
    await expect(suggestMatchForAlert(scoped, "does-not-exist")).rejects.toThrow(MobileMoneyAlertNotFoundError);
  });
});

describe("confirmMobileMoneyMatch / rejectMobileMoneyMatch", () => {
  async function makeSuggestedAlert() {
    await recordTransaction(scoped, {
      businessId,
      type: "PAYMENT_RECEIVED",
      amountMinor: 55500n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    const alert = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 55500n,
      currencyCode: "NGN",
      rawText: "raw text 6",
    });
    return suggestMatchForAlert(scoped, alert.id);
  }

  it("confirms a suggested match and records an audit log entry", async () => {
    const suggested = await makeSuggestedAlert();

    const confirmed = await confirmMobileMoneyMatch(scoped, {
      alertId: suggested.id,
      businessId,
      actorType: "MERCHANT",
    });
    expect(confirmed.matchStatus).toBe("CONFIRMED");

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: suggested.id, action: "MOBILE_MONEY_ALERT_CONFIRMED" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("rejects a suggested match, reverting it to UNMATCHED, and records an audit log entry", async () => {
    const suggested = await makeSuggestedAlert();

    const rejected = await rejectMobileMoneyMatch(scoped, {
      alertId: suggested.id,
      businessId,
      actorType: "MERCHANT",
    });
    expect(rejected.matchStatus).toBe("UNMATCHED");
    expect(rejected.matchedTransactionId).toBeNull();

    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: suggested.id, action: "MOBILE_MONEY_ALERT_REJECTED" },
    });
    expect(auditRows).toHaveLength(1);
  });

  it("refuses to confirm/reject an alert that isn't in SUGGESTED status", async () => {
    const alert = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 66600n,
      currencyCode: "NGN",
      rawText: "raw text 7",
    });

    await expect(
      confirmMobileMoneyMatch(scoped, { alertId: alert.id, businessId, actorType: "MERCHANT" }),
    ).rejects.toThrow(MobileMoneyAlertNotSuggestedError);
    await expect(
      rejectMobileMoneyMatch(scoped, { alertId: alert.id, businessId, actorType: "MERCHANT" }),
    ).rejects.toThrow(MobileMoneyAlertNotSuggestedError);
  });

  it("throws MobileMoneyAlertNotFoundError for an unknown id", async () => {
    await expect(
      confirmMobileMoneyMatch(scoped, { alertId: "does-not-exist", businessId, actorType: "MERCHANT" }),
    ).rejects.toThrow(MobileMoneyAlertNotFoundError);
  });
});

describe("listSuggestedMobileMoneyAlerts", () => {
  it("lists only SUGGESTED alerts, most recent first", async () => {
    await recordTransaction(scoped, {
      businessId,
      type: "PAYMENT_RECEIVED",
      amountMinor: 77700n,
      currencyCode: "NGN",
      paymentStatus: "PAID",
    });
    const alert = await recordMobileMoneyAlert(scoped, {
      businessId,
      provider: "M-PESA",
      amountMinor: 77700n,
      currencyCode: "NGN",
      rawText: "raw text 8",
    });
    await suggestMatchForAlert(scoped, alert.id);

    const pending = await listSuggestedMobileMoneyAlerts(scoped);
    expect(pending.some((a) => a.id === alert.id)).toBe(true);
    expect(pending.every((a) => a.matchStatus === "SUGGESTED")).toBe(true);
  });
});
