-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PaymentSubjectType" AS ENUM ('STORE_ORDER', 'TRADE_INVOICE');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('OPEN', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'UNKNOWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AllocationState" AS ENUM ('APPLIED', 'HELD', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ProviderRefundStatus" AS ENUM ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('POSTED', 'MISMATCH');

-- CreateEnum
CREATE TYPE "ProviderExceptionType" AS ENUM ('UNKNOWN_REFERENCE', 'WRONG_TENANT', 'PURPOSE_MISMATCH', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DESTINATION_MISMATCH', 'CONTRADICTORY_STATUS', 'UNRESOLVED_ATTEMPT', 'REFUND_FAILED', 'SETTLEMENT_MISMATCH', 'DUPLICATE_COLLECTION');

-- CreateEnum
CREATE TYPE "MarketplaceStatus" AS ENUM ('OFF', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ListingModeration" AS ENUM ('VISIBLE', 'UNPUBLISHED');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('PROHIBITED_ITEM', 'COUNTERFEIT', 'MISLEADING_PRICE', 'SCAM', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ModerationActionType" AS ENUM ('UNPUBLISH_LISTING', 'REINSTATE_LISTING', 'SUSPEND_SELLER', 'REINSTATE_SELLER');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED');

-- AlterTable
ALTER TABLE "Storefront" ADD COLUMN     "marketplaceNote" TEXT,
ADD COLUMN     "marketplaceStatus" "MarketplaceStatus" NOT NULL DEFAULT 'OFF';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "category" TEXT,
ADD COLUMN     "moderation" "ListingModeration" NOT NULL DEFAULT 'VISIBLE',
ADD COLUMN     "moderationReason" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "arrangementRef" TEXT NOT NULL,
    "destinationKey" TEXT NOT NULL,
    "destinationLabel" TEXT NOT NULL,
    "credentialRef" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMPTZ,
    "lastSuccessAt" TIMESTAMPTZ,
    "openUntil" TIMESTAMPTZ,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL DEFAULT 'MERCHANT_SALE',
    "subjectType" "PaymentSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'OPEN',
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalRef" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "capturedMinor" BIGINT NOT NULL DEFAULT 0,
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    "feeMinor" BIGINT,
    "checkoutUrl" TEXT,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMPTZ,
    "lastPolledAt" TIMESTAMPTZ,
    "settledAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttemptEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "fromStatus" "PaymentAttemptStatus",
    "toStatus" "PaymentAttemptStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttemptEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "subjectType" "PaymentSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "state" "AllocationState" NOT NULL,
    "storePaymentId" TEXT,
    "tradePaymentId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRefund" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "ProviderRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "externalRef" TEXT,
    "reason" TEXT NOT NULL,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "storeRefundRequestId" TEXT,
    "storeOrderId" TEXT,
    "storeExceptionId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ProviderRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSettlement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "settledAt" TIMESTAMPTZ NOT NULL,
    "status" "SettlementStatus" NOT NULL,
    "evidence" "TradePaymentEvidence" NOT NULL,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSettlementLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL,

    CONSTRAINT "ProviderSettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderException" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "type" "ProviderExceptionType" NOT NULL,
    "status" "PaymentExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "provider" TEXT,
    "attemptId" TEXT,
    "intentId" TEXT,
    "amountMinor" BIGINT,
    "currencyCode" TEXT,
    "details" JSONB,
    "fingerprint" TEXT NOT NULL,
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulatorPayment" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "merchantReference" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "destinationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "behaviour" TEXT NOT NULL DEFAULT 'NORMAL',
    "refunds" JSONB NOT NULL DEFAULT '[]',
    "settledReference" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulatorPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceReport" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "listingId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT NOT NULL,
    "contact" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "listingId" TEXT,
    "reportId" TEXT,
    "type" "ModerationActionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'OPEN',
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_businessId_provider_key" ON "ProviderConnection"("businessId", "provider");

-- CreateIndex
CREATE INDEX "PaymentIntent_businessId_subjectType_subjectId_idx" ON "PaymentIntent"("businessId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "PaymentIntent_businessId_status_idx" ON "PaymentIntent"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_businessId_idempotencyKey_key" ON "PaymentIntent"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentAttempt_intentId_idx" ON "PaymentAttempt"("intentId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_status_nextPollAt_idx" ON "PaymentAttempt"("status", "nextPollAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_provider_externalRef_key" ON "PaymentAttempt"("provider", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_businessId_idempotencyKey_key" ON "PaymentAttempt"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentAttemptEvent_attemptId_idx" ON "PaymentAttemptEvent"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_attemptId_key" ON "PaymentAllocation"("attemptId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_businessId_subjectType_subjectId_idx" ON "PaymentAllocation"("businessId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ProviderRefund_attemptId_idx" ON "ProviderRefund"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRefund_businessId_idempotencyKey_key" ON "ProviderRefund"("businessId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSettlement_businessId_provider_reference_key" ON "ProviderSettlement"("businessId", "provider", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSettlementLine_attemptId_key" ON "ProviderSettlementLine"("attemptId");

-- CreateIndex
CREATE INDEX "ProviderSettlementLine_settlementId_idx" ON "ProviderSettlementLine"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderException_fingerprint_key" ON "ProviderException"("fingerprint");

-- CreateIndex
CREATE INDEX "ProviderException_status_createdAt_idx" ON "ProviderException"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SimulatorPayment_externalRef_key" ON "SimulatorPayment"("externalRef");

-- CreateIndex
CREATE INDEX "MarketplaceReport_status_createdAt_idx" ON "MarketplaceReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceReport_businessId_idx" ON "MarketplaceReport"("businessId");

-- CreateIndex
CREATE INDEX "ModerationAction_businessId_createdAt_idx" ON "ModerationAction"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Appeal_status_createdAt_idx" ON "Appeal"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttemptEvent" ADD CONSTRAINT "PaymentAttemptEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttemptEvent" ADD CONSTRAINT "PaymentAttemptEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRefund" ADD CONSTRAINT "ProviderRefund_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRefund" ADD CONSTRAINT "ProviderRefund_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRefund" ADD CONSTRAINT "ProviderRefund_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSettlement" ADD CONSTRAINT "ProviderSettlement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSettlement" ADD CONSTRAINT "ProviderSettlement_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSettlementLine" ADD CONSTRAINT "ProviderSettlementLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSettlementLine" ADD CONSTRAINT "ProviderSettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "ProviderSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSettlementLine" ADD CONSTRAINT "ProviderSettlementLine_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ModerationAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================
-- Phase 5: merchant-provider payments, settlement, exceptions, marketplace moderation - hand-written part.
-- ============================================================================================

-- ---- value constraints
-- Merchant sales only: a payment intent can never be created for platform subscription money (scenario 14, enforced by the database).
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_values_check" CHECK (
  "purpose" = 'MERCHANT_SALE' AND "amountMinor" > 0 AND "paidMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "paidMinor");
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_values_check" CHECK (
  "amountMinor" > 0 AND "capturedMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "capturedMinor"
  AND ("status" <> 'SUCCEEDED' OR "capturedMinor" > 0) AND ("feeMinor" IS NULL OR ("feeMinor" >= 0 AND "feeMinor" <= "capturedMinor")));
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "ProviderRefund" ADD CONSTRAINT "ProviderRefund_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "ProviderSettlement" ADD CONSTRAINT "ProviderSettlement_amounts_check" CHECK (
  "grossMinor" > 0 AND "feeMinor" >= 0 AND "netMinor" >= 0 AND "grossMinor" = "feeMinor" + "netMinor");
ALTER TABLE "ProviderSettlementLine" ADD CONSTRAINT "ProviderSettlementLine_values_check" CHECK ("grossMinor" > 0 AND "feeMinor" >= 0 AND "feeMinor" <= "grossMinor");

-- ---- at most ONE active attempt per intent (scenario 11): a retry or fallback cannot create a second collection while one may still collect
CREATE UNIQUE INDEX "PaymentAttempt_one_active_per_intent" ON "PaymentAttempt" ("intentId") WHERE "status" IN ('CREATED', 'PENDING', 'UNKNOWN');

-- ---- state guards: what the provider reported as final stays final; a settled-out intent never comes back
CREATE OR REPLACE FUNCTION tradepal_attempt_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('SUCCEEDED', 'FAILED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'A % payment attempt is final and cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "PaymentAttempt_terminal" BEFORE UPDATE OF "status" ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION tradepal_attempt_terminal();

CREATE OR REPLACE FUNCTION tradepal_intent_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'OPEN' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'A % payment intent is final and cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "PaymentIntent_terminal" BEFORE UPDATE OF "status" ON "PaymentIntent" FOR EACH ROW EXECUTE FUNCTION tradepal_intent_terminal();

-- ---- history is append-only / records cannot be deleted
CREATE TRIGGER "PaymentAttemptEvent_append_only" BEFORE UPDATE OR DELETE ON "PaymentAttemptEvent" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "ModerationAction_append_only"    BEFORE UPDATE OR DELETE ON "ModerationAction"    FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "ProviderConnection_no_delete"       BEFORE DELETE ON "ProviderConnection"       FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PaymentIntent_no_delete"            BEFORE DELETE ON "PaymentIntent"            FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PaymentAttempt_no_delete"           BEFORE DELETE ON "PaymentAttempt"           FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PaymentAllocation_no_delete"        BEFORE DELETE ON "PaymentAllocation"        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ProviderRefund_no_delete"           BEFORE DELETE ON "ProviderRefund"           FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ProviderSettlement_no_delete"       BEFORE DELETE ON "ProviderSettlement"       FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ProviderSettlementLine_no_delete"   BEFORE DELETE ON "ProviderSettlementLine"   FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ProviderException_no_delete"        BEFORE DELETE ON "ProviderException"        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "MarketplaceReport_no_delete"        BEFORE DELETE ON "MarketplaceReport"        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "Appeal_no_delete"                   BEFORE DELETE ON "Appeal"                   FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ProviderConnection','PaymentIntent','PaymentAttempt','PaymentAttemptEvent','PaymentAllocation','ProviderRefund','ProviderSettlement',
    'ProviderSettlementLine','ProviderException','MarketplaceReport','ModerationAction','Appeal'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- ---- tenant row-level security on merchant-owned tables. ProviderException, MarketplaceReport and SimulatorPayment are deliberately NOT tenant data
-- (an unknown reference has no tenant; a public report is not the seller's; the simulator is a provider-side stand-in).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ProviderConnection','PaymentIntent','PaymentAttempt','PaymentAttemptEvent','PaymentAllocation','ProviderRefund','ProviderSettlement',
    'ProviderSettlementLine','ModerationAction','Appeal'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("businessId" = current_setting(''app.current_business_id'', true)) WITH CHECK ("businessId" = current_setting(''app.current_business_id'', true))',
      t);
  END LOOP;
END
$$;

-- ---- default-OFF flag (separate from the storefront: discovery is a different exposure)
INSERT INTO "FeatureFlag" ("key", "description", "enabledByDefault")
VALUES
  ('marketplace', 'Public marketplace discovery for this merchant''s shop and listings, with reporting and moderation. Separate from having a storefront.', false)
ON CONFLICT ("key") DO NOTHING;
