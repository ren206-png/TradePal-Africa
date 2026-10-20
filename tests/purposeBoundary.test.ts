import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PURPOSES,
  PaymentPurposeForbiddenError,
  assertProviderAllowedForPurpose,
  isProviderAllowedForPurpose,
} from "../src/domain/paymentPurpose.js";
import { initiatePawaPayCollection } from "../src/domain/pawapayCollection.js";
import { initiatePaymentRequest } from "../src/domain/paymentRequests.js";

/**
 * Scenarios 13 and 14 (expansion plan): subscription money and merchant-sale money never mix, and the
 * pawaPay adapter cannot be reached for a merchant sale however the request is forged.
 */
describe("payment purpose policy", () => {
  it("pins the policy table: pawaPay and Flutterwave serve subscriptions only; only the simulator serves merchant sales", () => {
    const table = Object.fromEntries(
      PAYMENT_PROVIDER_IDS.map((p) => [p, PAYMENT_PURPOSES.filter((purpose) => isProviderAllowedForPurpose(p, purpose))]),
    );
    expect(table).toEqual({
      pawapay: ["PLATFORM_SUBSCRIPTION"],
      flutterwave: ["PLATFORM_SUBSCRIPTION"],
      simulator: ["MERCHANT_SALE"],
    });
  });

  it("throws a typed error, before any side effect, when a provider is used for a forbidden purpose", () => {
    expect(() => assertProviderAllowedForPurpose("pawapay", "MERCHANT_SALE")).toThrow(PaymentPurposeForbiddenError);
    expect(() => assertProviderAllowedForPurpose("flutterwave", "MERCHANT_SALE")).toThrow(PaymentPurposeForbiddenError);
    expect(() => assertProviderAllowedForPurpose("simulator", "PLATFORM_SUBSCRIPTION")).toThrow(PaymentPurposeForbiddenError);
    expect(() => assertProviderAllowedForPurpose("pawapay", "PLATFORM_SUBSCRIPTION")).not.toThrow();
  });
});

describe("the guarded merchant-sale entry points refuse without touching the database or a provider", () => {
  // Passing null for prisma and the provider deps proves the refusal happens before ANY use of either.
  it("pawaPay collection", async () => {
    await expect(initiatePawaPayCollection(null as never, {} as never, null as never)).rejects.toThrow(PaymentPurposeForbiddenError);
  });
  it("Flutterwave payment request", async () => {
    await expect(initiatePaymentRequest(null as never, {} as never, null as never)).rejects.toThrow(PaymentPurposeForbiddenError);
  });
});

describe("architecture: quarantined implementations cannot be used from app code", () => {
  const srcDir = path.resolve(process.cwd(), "src");
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? sourceFiles(full) : e.name.endsWith(".ts") ? [full] : [];
    });
  }

  it.each([
    ["initiatePawaPayCollectionQuarantined", "pawapayCollection.ts"],
    ["initiatePaymentRequestQuarantined", "paymentRequests.ts"],
  ])("%s is referenced only by its own module", (symbol, owner) => {
    const offenders = sourceFiles(srcDir)
      .filter((f) => path.basename(f) !== owner)
      .filter((f) => fs.readFileSync(f, "utf8").includes(symbol));
    expect(offenders).toEqual([]);
  });

  it("merchant-sale initiators are never called with a flag-only guard: every caller sits behind the purpose lock", () => {
    const router = fs.readFileSync(path.join(srcDir, "commands/commandRouter.ts"), "utf8");
    expect(router).toContain('isProviderAllowedForPurpose("pawapay", "MERCHANT_SALE")');
    expect(router).toContain('isProviderAllowedForPurpose("flutterwave", "MERCHANT_SALE")');
  });
});
