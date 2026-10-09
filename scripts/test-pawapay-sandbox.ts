/**
 * PawaPay Sandbox Integration Test
 *
 * Exercises the full C2B deposit flow against PawaPay's sandbox environment:
 *   1. Fetch active configuration for Sierra Leone — confirms your token works
 *      and shows which providers + operators are live on your sandbox account.
 *   2. Validate a Sierra Leone phone number via predictProvider — ensures
 *      number format is correct and identifies the operator.
 *   3. Initiate a deposit — requests payment from the test number.
 *   4. Check deposit status — polls until terminal status or timeout.
 *
 * Usage:
 *   PAWAPAY_API_TOKEN=<your-sandbox-token> npx tsx scripts/test-pawapay-sandbox.ts
 *
 * Get your sandbox token:
 *   dashboard.pawapay.io → sign up → API Tokens → copy the sandbox token
 *
 * PawaPay sandbox test numbers for Sierra Leone (from PawaPay docs):
 *   Check https://docs.pawapay.io/v2/docs/sandbox-test-numbers for the full list.
 *   Common pattern: use the sandbox-specific numbers PawaPay provides —
 *   do NOT use a real customer's number in sandbox mode.
 *
 * Sandbox behaviour:
 *   - Customer PIN step is skipped — deposits auto-complete or auto-fail
 *     based on the test phone number used.
 *   - COMPLETED deposits credit your sandbox wallet (not real money).
 *   - Callbacks fire to your configured webhook URL (set in PawaPay dashboard).
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  getActiveConfiguration,
  predictProvider,
  initiateDeposit,
  checkDepositStatus,
  type PawaPayDeps,
} from "../src/pawapay/client.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const apiToken = process.env["PAWAPAY_API_TOKEN"];
if (!apiToken) {
  console.error("PAWAPAY_API_TOKEN is not set. Export it before running this script.");
  process.exit(1);
}

const deps: PawaPayDeps = { apiToken };

// Sierra Leone test phone number — replace with the sandbox test number from
// https://docs.pawapay.io/v2/docs/sandbox-test-numbers once you have access.
// Format: MSISDN with country code (232 = Sierra Leone)
//   Africell/Afrimoney: 23276XXXXXXX
//   Orange Money SL:    23225XXXXXXX or 23234XXXXXXX
const TEST_PHONE_NUMBER = process.env["TEST_PHONE_NUMBER"] ?? "23276000001";

// Amount to collect (SLE — Sierra Leonean Leone). No decimals for Afrimoney.
const TEST_AMOUNT = "100";
const TEST_CURRENCY = "SLE";

// ── Helpers ───────────────────────────────────────────────────────────────────

function divider(label: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(60));
}

async function pollDepositStatus(
  depositId: string,
  intervalMs = 3000,
  maxAttempts = 10,
): Promise<void> {
  console.log(`\nPolling deposit status (${maxAttempts} attempts, ${intervalMs}ms interval)...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const result = await checkDepositStatus(deps, depositId);
    if (!result.found) {
      console.log(`  [${attempt}/${maxAttempts}] NOT_FOUND — deposit never reached PawaPay.`);
      return;
    }

    const { status, providerTransactionId, failureReason } = result.data!;
    console.log(`  [${attempt}/${maxAttempts}] status=${status}`, {
      providerTransactionId,
      failureCode: failureReason?.failureCode,
    });

    if (status === "COMPLETED" || status === "FAILED") {
      console.log(`\n  ✓ Terminal status reached: ${status}`);
      if (status === "COMPLETED") {
        console.log(`    Provider transaction ID: ${providerTransactionId ?? "n/a"}`);
        console.log("    → In production: credit the merchant's account and send WhatsApp notification.");
      } else {
        console.log(`    Failure: ${failureReason?.failureCode} — ${failureReason?.failureMessage}`);
        console.log("    → In production: notify merchant to ask customer to retry.");
      }
      return;
    }
  }

  console.log(`\n  Polling timed out after ${maxAttempts} attempts.`);
  console.log("  → In production: your reconciliation worker picks this up within 15 minutes.");
  console.log(`  → Run manually: checkDepositStatus(deps, "${depositId}")`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("PawaPay Sandbox Integration Test");
  console.log(`API base URL: https://api.sandbox.pawapay.io/v2`);
  console.log(`Test phone:   ${TEST_PHONE_NUMBER}`);
  console.log(`Amount:       ${TEST_AMOUNT} ${TEST_CURRENCY}`);

  // ── Step 1: Active configuration ──────────────────────────────────────────

  divider("Step 1: Active configuration (Sierra Leone)");
  const config = await getActiveConfiguration(deps, "SLE", "DEPOSIT");
  console.log(`Company: ${config.companyName}`);

  const sleCountry = config.countries.find((c) => c.country === "SLE");
  if (!sleCountry) {
    console.warn("Sierra Leone (SLE) not found in active configuration.");
    console.warn("This likely means your sandbox account hasn't been configured with SLE yet.");
    console.warn("Contact PawaPay to enable Sierra Leone providers on your account.");
  } else {
    console.log(`Country: ${sleCountry.displayName.en} (+${sleCountry.prefix})`);
    console.log(`Providers (${sleCountry.providers.length}):`);
    for (const provider of sleCountry.providers) {
      const depositConfig = provider.currencies[0]?.operationTypes.DEPOSIT;
      console.log(`  ${provider.provider} — ${provider.displayName}`);
      if (depositConfig) {
        console.log(`    status:    ${depositConfig.status}`);
        console.log(`    decimals:  ${depositConfig.decimalsInAmount}`);
        console.log(`    limits:    ${depositConfig.minAmount}–${depositConfig.maxAmount} ${provider.currencies[0]?.currency}`);
        console.log(`    authType:  ${depositConfig.authType} / pinPrompt=${depositConfig.pinPrompt ?? "n/a"}`);
      }
    }
  }

  // ── Step 2: Predict provider ──────────────────────────────────────────────

  divider("Step 2: Validate phone number + predict provider");
  const prediction = await predictProvider(deps, TEST_PHONE_NUMBER);
  if (!prediction) {
    console.error(`Phone number ${TEST_PHONE_NUMBER} is invalid — update TEST_PHONE_NUMBER and retry.`);
    process.exit(1);
  }
  console.log("Prediction result:");
  console.log(`  country:     ${prediction.country}`);
  console.log(`  provider:    ${prediction.provider}`);
  console.log(`  phoneNumber: ${prediction.phoneNumber} (sanitized MSISDN)`);

  const { provider, phoneNumber } = prediction;

  // ── Step 3: Initiate deposit ──────────────────────────────────────────────

  divider("Step 3: Initiate deposit");
  // Generate and note the depositId before calling — this is your
  // idempotency handle if the network drops mid-call.
  const depositId = randomUUID();
  console.log(`depositId (store this): ${depositId}`);
  console.log(`Requesting ${TEST_AMOUNT} ${TEST_CURRENCY} from ${phoneNumber} via ${provider}...`);

  const initResult = await initiateDeposit(deps, {
    depositId,
    amount: TEST_AMOUNT,
    currency: TEST_CURRENCY,
    phoneNumber,
    provider,
  });

  console.log("Initiation response:");
  console.log(`  status:  ${initResult.status}`);
  console.log(`  created: ${initResult.created}`);

  if (initResult.status === "REJECTED" || initResult.status === "DUPLICATE_IGNORED") {
    console.error(`  Initiation failed: ${JSON.stringify(initResult.failureReason)}`);
    if (initResult.status === "DUPLICATE_IGNORED") {
      console.error("  depositId was already used — UUIDs should not repeat.");
    }
    process.exit(1);
  }

  if (initResult.status !== "ACCEPTED") {
    console.warn(`  Unexpected status: ${initResult.status} — proceeding to poll anyway.`);
  } else {
    console.log("  ✓ ACCEPTED — customer PIN prompt sent (skipped in sandbox).");
  }

  // ── Step 4: Poll for final status ─────────────────────────────────────────

  divider("Step 4: Poll deposit status");
  await pollDepositStatus(depositId);

  divider("Done");
  console.log("Next steps:");
  console.log("  1. Configure your callback URL in the PawaPay dashboard:");
  console.log("     https://<your-hostname>/webhooks/pawapay");
  console.log("  2. Run this script again — terminal status will also fire as a callback.");
  console.log("  3. Add the PawaPayDeposit Prisma model (see webhookRoute.ts TODO).");
  console.log("  4. Wire domain/paymentRequests.ts-style confirmation logic into the webhook handler.");
}

main().catch((error) => {
  console.error("Test script failed:", error);
  process.exit(1);
});
