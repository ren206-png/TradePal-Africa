-- CreateEnum
CREATE TYPE "PlanVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "BillingAttemptStatus" AS ENUM ('INITIATED', 'ACCEPTED', 'PROCESSING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BillingRefundStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EntitlementEventKind" AS ENUM ('GRANTED', 'EXTENDED', 'PLAN_CHANGE_SCHEDULED', 'PLAN_CHANGED', 'CANCEL_REQUESTED', 'CANCELLED', 'EXPIRY_NOTED', 'MANUAL_ADJUSTMENT', 'REFUND_REVOKED');

-- CreateEnum
CREATE TYPE "BillingExceptionType" AS ENUM ('DUPLICATE_PAYMENT', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'UNKNOWN_DEPOSIT', 'ENVIRONMENT_MISMATCH', 'PAYMENT_AFTER_CANCELLATION', 'UNRESOLVED_ATTEMPT', 'REFUND_FAILED', 'CALLBACK_AUTH_FAILED');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelledAt" TIMESTAMPTZ,
ADD COLUMN     "pendingPlanVersionId" TEXT,
ADD COLUMN     "planVersionId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "cancelledAt" TIMESTAMPTZ,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "paidMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "periodEnd" TIMESTAMPTZ,
ADD COLUMN     "periodStart" TIMESTAMPTZ,
ADD COLUMN     "planVersionId" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "refundedMinor" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "billingPeriodDays" INTEGER NOT NULL DEFAULT 30,
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "features" TEXT[],
    "entryCapPerMonth" INTEGER,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "staffCapCount" INTEGER,
    "aiDeepseekMonthlyBudgetMicroUsd" BIGINT,
    "note" TEXT,
    "createdBy" TEXT,
    "publishedAt" TIMESTAMPTZ,
    "retiredAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PAWAPAY',
    "environment" TEXT NOT NULL,
    "providerCode" TEXT,
    "status" "BillingAttemptStatus" NOT NULL DEFAULT 'INITIATED',
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "capturedMinor" BIGINT NOT NULL DEFAULT 0,
    "payerPhoneLast4" TEXT,
    "providerTransactionId" TEXT,
    "failureCode" TEXT,
    "initiatedBy" TEXT,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "BillingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAllocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planVersionId" TEXT,
    "periodStart" TIMESTAMPTZ NOT NULL,
    "periodEnd" TIMESTAMPTZ NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingRefund" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "BillingRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "revokeEntitlement" BOOLEAN NOT NULL DEFAULT false,
    "failureCode" TEXT,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "BillingRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "kind" "EntitlementEventKind" NOT NULL,
    "fromPlanCode" TEXT,
    "toPlanCode" TEXT,
    "periodStart" TIMESTAMPTZ,
    "periodEnd" TIMESTAMPTZ,
    "source" TEXT NOT NULL,
    "invoiceId" TEXT,
    "adminUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingException" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "type" "BillingExceptionType" NOT NULL,
    "status" "PaymentExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "attemptId" TEXT,
    "invoiceId" TEXT,
    "amountMinor" BIGINT,
    "details" JSONB,
    "fingerprint" TEXT NOT NULL,
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSwitch" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL DEFAULT 'PLATFORM_SUBSCRIPTION',
    "newAttemptsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSigningKey" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "pem" TEXT NOT NULL,
    "fetchedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderSigningKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAccountBinding" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "boundAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAccountBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_planCode_version_key" ON "PlanVersion"("planCode", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PlanPrice_planVersionId_countryCode_key" ON "PlanPrice"("planVersionId", "countryCode");

-- CreateIndex
CREATE INDEX "BillingAttempt_invoiceId_idx" ON "BillingAttempt"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingAttempt_status_nextPollAt_idx" ON "BillingAttempt"("status", "nextPollAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAllocation_attemptId_key" ON "BillingAllocation"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAllocation_invoiceId_key" ON "BillingAllocation"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingRefund_invoiceId_idx" ON "BillingRefund"("invoiceId");

-- CreateIndex
CREATE INDEX "EntitlementEvent_businessId_createdAt_idx" ON "EntitlementEvent"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingException_fingerprint_key" ON "BillingException"("fingerprint");

-- CreateIndex
CREATE INDEX "BillingException_status_createdAt_idx" ON "BillingException"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSwitch_provider_countryCode_purpose_key" ON "BillingSwitch"("provider", "countryCode", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSigningKey_provider_environment_keyId_key" ON "ProviderSigningKey"("provider", "environment", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccountBinding_provider_environment_key" ON "BillingAccountBinding"("provider", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_reference_key" ON "Invoice"("reference");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanVersionId_fkey" FOREIGN KEY ("pendingPlanVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_planCode_fkey" FOREIGN KEY ("planCode") REFERENCES "Plan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_countryCode_fkey" FOREIGN KEY ("countryCode") REFERENCES "Country"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAttempt" ADD CONSTRAINT "BillingAttempt_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAttempt" ADD CONSTRAINT "BillingAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "BillingAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingRefund" ADD CONSTRAINT "BillingRefund_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingRefund" ADD CONSTRAINT "BillingRefund_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingRefund" ADD CONSTRAINT "BillingRefund_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "BillingAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementEvent" ADD CONSTRAINT "EntitlementEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Phase 6: platform subscriptions through pawaPay, plan versions, entitlement history - hand-written part.
-- ============================================================================================

-- ---- value constraints
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_values_check" CHECK (
  "billingPeriodDays" BETWEEN 1 AND 366 AND "graceDays" BETWEEN 0 AND 30 AND "version" >= 1);
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_price_check" CHECK ("priceMinor" > 0);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_billing_amounts_check" CHECK ("paidMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "paidMinor");
ALTER TABLE "BillingAttempt" ADD CONSTRAINT "BillingAttempt_values_check" CHECK (
  "amountMinor" > 0 AND "capturedMinor" >= 0 AND "environment" IN ('SANDBOX', 'PRODUCTION') AND ("status" <> 'COMPLETED' OR "capturedMinor" > 0));
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_values_check" CHECK ("amountMinor" > 0 AND "periodEnd" > "periodStart");
ALTER TABLE "BillingRefund" ADD CONSTRAINT "BillingRefund_amount_check" CHECK ("amountMinor" > 0);
-- TradePal billing money is its own purpose: a billing switch can never be created for merchant sales (scenario 14, in the database).
ALTER TABLE "BillingSwitch" ADD CONSTRAINT "BillingSwitch_purpose_check" CHECK ("purpose" = 'PLATFORM_SUBSCRIPTION');

-- ---- one active charge per invoice: a retry cannot start a second collection while one may still complete
CREATE UNIQUE INDEX "BillingAttempt_one_active_per_invoice" ON "BillingAttempt" ("invoiceId") WHERE "status" IN ('INITIATED', 'ACCEPTED', 'PROCESSING', 'UNKNOWN');

-- ---- state guards
CREATE OR REPLACE FUNCTION tradepal_billing_attempt_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('COMPLETED', 'FAILED', 'REJECTED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'A % billing attempt is final and cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "BillingAttempt_terminal" BEFORE UPDATE OF "status" ON "BillingAttempt" FOR EACH ROW EXECUTE FUNCTION tradepal_billing_attempt_terminal();

-- a paid invoice is never un-paid: it can only be partly or fully refunded
CREATE OR REPLACE FUNCTION tradepal_invoice_paid_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'PAID' AND NEW."status" NOT IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RAISE EXCEPTION 'A paid invoice cannot become %', NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('PARTIALLY_REFUNDED', 'REFUNDED') AND NEW."status" NOT IN ('PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RAISE EXCEPTION 'A refunded invoice cannot become %', NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "Invoice_paid_final" BEFORE UPDATE OF "status" ON "Invoice" FOR EACH ROW EXECUTE FUNCTION tradepal_invoice_paid_final();

-- a published plan version, and its prices, are frozen: only PUBLISHED -> RETIRED is allowed afterwards
CREATE OR REPLACE FUNCTION tradepal_plan_version_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    IF NOT (OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED') AND NEW."status" <> OLD."status" THEN
      RAISE EXCEPTION 'A % plan version cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."billingPeriodDays" <> OLD."billingPeriodDays" OR NEW."graceDays" <> OLD."graceDays" OR NEW."features" IS DISTINCT FROM OLD."features"
       OR NEW."entryCapPerMonth" IS DISTINCT FROM OLD."entryCapPerMonth" OR NEW."voiceEnabled" <> OLD."voiceEnabled" OR NEW."staffCapCount" IS DISTINCT FROM OLD."staffCapCount"
       OR NEW."aiDeepseekMonthlyBudgetMicroUsd" IS DISTINCT FROM OLD."aiDeepseekMonthlyBudgetMicroUsd" OR NEW."planCode" <> OLD."planCode" OR NEW."version" <> OLD."version" THEN
      RAISE EXCEPTION 'A published plan version is frozen: create a new version instead' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "PlanVersion_frozen" BEFORE UPDATE ON "PlanVersion" FOR EACH ROW EXECUTE FUNCTION tradepal_plan_version_frozen();

CREATE OR REPLACE FUNCTION tradepal_plan_price_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  SELECT "status"::text INTO v FROM "PlanVersion" WHERE "id" = COALESCE(NEW."planVersionId", OLD."planVersionId");
  IF v IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Prices of a published plan version are frozen: create a new version instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER "PlanPrice_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "PlanPrice" FOR EACH ROW EXECUTE FUNCTION tradepal_plan_price_frozen();

-- ---- history is append-only / records cannot be deleted
CREATE TRIGGER "EntitlementEvent_append_only" BEFORE UPDATE OR DELETE ON "EntitlementEvent" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "BillingAllocation_append_only" BEFORE UPDATE OR DELETE ON "BillingAllocation" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "PlanVersion_no_delete"       BEFORE DELETE ON "PlanVersion"       FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "BillingAttempt_no_delete"    BEFORE DELETE ON "BillingAttempt"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "BillingRefund_no_delete"     BEFORE DELETE ON "BillingRefund"     FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "BillingException_no_delete"  BEFORE DELETE ON "BillingException"  FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "BillingSwitch_no_delete"     BEFORE DELETE ON "BillingSwitch"     FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "BillingAccountBinding_no_delete" BEFORE DELETE ON "BillingAccountBinding" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'PlanVersion','PlanPrice','BillingAttempt','BillingAllocation','BillingRefund','EntitlementEvent','BillingException','BillingSwitch','BillingAccountBinding'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- ---- tenant row-level security on business-owned tables. Plans, prices, switches, keys, exceptions and the account binding are platform data.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BillingAttempt','BillingAllocation','BillingRefund','EntitlementEvent'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("businessId" = current_setting(''app.current_business_id'', true)) WITH CHECK ("businessId" = current_setting(''app.current_business_id'', true))',
      t);
  END LOOP;
END
$$;

-- ---- default-OFF flags
INSERT INTO "FeatureFlag" ("key", "description", "enabledByDefault")
VALUES
  ('pawapayBilling', 'Subscription renewal through pawaPay (TradePal''s own billing). Disabled for production until the owner''s activation conditions are met; never used for merchant sales.', false),
  ('subscriptionEntitlements', 'Enforce subscription entitlements: grace period, and restriction of new premium operations after expiry. Servicing of existing payments, orders and data is never restricted.', false)
ON CONFLICT ("key") DO NOTHING;
