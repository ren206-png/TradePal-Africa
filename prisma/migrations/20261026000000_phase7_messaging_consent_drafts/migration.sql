-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ContactPurpose" AS ENUM ('ORDER_UPDATES', 'MARKETING');

-- CreateEnum
CREATE TYPE "ContactConsentStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "ContactConsentBasis" AS ENUM ('ORDER_CHECKOUT', 'INBOUND_MESSAGE', 'WEB_FORM');

-- CreateEnum
CREATE TYPE "OutboundDecision" AS ENUM ('SENT', 'SUPPRESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "PendingActionKind" AS ENUM ('PROPOSAL', 'CLARIFICATION');

-- CreateEnum
CREATE TYPE "PendingActionStatus" AS ENUM ('PENDING', 'EXECUTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING_REVIEW', 'CONFLICT', 'CONFIRMED', 'DISCARDED', 'REJECTED');

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "messageClass" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "category" "TemplateCategory" NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "providerTemplateName" TEXT,
    "approvalReference" TEXT,
    "bodyPreview" TEXT NOT NULL,
    "paramCount" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactConsent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "ContactPurpose" NOT NULL,
    "status" "ContactConsentStatus" NOT NULL,
    "basis" "ContactConsentBasis" NOT NULL,
    "textVersion" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactConsentEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "textVersion" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedNumber" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "blockedBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMPTZ,
    "liftedBy" TEXT,
    "liftReason" TEXT,

    CONSTRAINT "BlockedNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessageLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "messageClass" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "toPhoneHash" TEXT NOT NULL,
    "toPhoneLast4" TEXT NOT NULL,
    "decision" "OutboundDecision" NOT NULL,
    "reason" TEXT,
    "templateKey" TEXT,
    "providerMessageId" TEXT,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingAction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "kind" "PendingActionKind" NOT NULL,
    "status" "PendingActionStatus" NOT NULL DEFAULT 'PENDING',
    "actionDigest" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "amountMinor" BIGINT,
    "currencyCode" TEXT,
    "requiresCode" BOOLEAN NOT NULL DEFAULT false,
    "codeHash" TEXT,
    "question" JSONB,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "resolvedAt" TIMESTAMPTZ,
    "executedRef" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "revokedAt" TIMESTAMPTZ,
    "lastSeenAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineDraft" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "deviceSessionId" TEXT,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "capturedAt" TIMESTAMPTZ NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "conflicts" JSONB,
    "transactionId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertDelivery" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "httpStatus" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_messageClass_language_key" ON "MessageTemplate"("messageClass", "language");

-- CreateIndex
CREATE INDEX "ContactConsent_phone_idx" ON "ContactConsent"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "ContactConsent_businessId_phone_purpose_key" ON "ContactConsent"("businessId", "phone", "purpose");

-- CreateIndex
CREATE INDEX "ContactConsentEvent_consentId_idx" ON "ContactConsentEvent"("consentId");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedNumber_phone_key" ON "BlockedNumber"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessageLog_idempotencyKey_key" ON "OutboundMessageLog"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboundMessageLog_messageClass_createdAt_idx" ON "OutboundMessageLog"("messageClass", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundMessageLog_businessId_createdAt_idx" ON "OutboundMessageLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PendingAction_businessId_status_idx" ON "PendingAction"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PendingAction_merchantId_sourceMessageId_key" ON "PendingAction"("merchantId", "sourceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_tokenHash_key" ON "DeviceSession"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceSession_businessId_merchantId_idx" ON "DeviceSession"("businessId", "merchantId");

-- CreateIndex
CREATE INDEX "OfflineDraft_businessId_status_idx" ON "OfflineDraft"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineDraft_businessId_clientId_key" ON "OfflineDraft"("businessId", "clientId");

-- CreateIndex
CREATE INDEX "AlertDelivery_createdAt_idx" ON "AlertDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "AlertDelivery_kind_status_createdAt_idx" ON "AlertDelivery"("kind", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsentEvent" ADD CONSTRAINT "ContactConsentEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsentEvent" ADD CONSTRAINT "ContactConsentEvent_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "ContactConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAction" ADD CONSTRAINT "PendingAction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSession" ADD CONSTRAINT "DeviceSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineDraft" ADD CONSTRAINT "OfflineDraft_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Phase 7: message templates, consent register, bound confirmations, offline drafts, alert delivery - hand-written part.
-- ============================================================================================

-- ---- value constraints
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_values_check" CHECK (
  "phone" ~ '^[0-9]{8,15}$'
  -- transaction updates and marketing are SEPARATE permissions: a checkout checkbox can never grant marketing
  AND ("purpose" <> 'MARKETING' OR "basis" <> 'ORDER_CHECKOUT'));
ALTER TABLE "BlockedNumber" ADD CONSTRAINT "BlockedNumber_phone_check" CHECK ("phone" ~ '^[0-9]{8,15}$');
ALTER TABLE "OutboundMessageLog" ADD CONSTRAINT "OutboundMessageLog_values_check" CHECK ("toPhoneLast4" ~ '^[0-9]{4}$' AND "audience" IN ('MERCHANT', 'CONSUMER', 'PARTNER'));
-- a template cannot be marked approved without saying which provider template it is and where the approval can be checked
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_approved_check" CHECK (
  "status" <> 'APPROVED' OR ("providerTemplateName" IS NOT NULL AND "approvalReference" IS NOT NULL));
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_param_check" CHECK ("paramCount" BETWEEN 0 AND 10);
ALTER TABLE "OfflineDraft" ADD CONSTRAINT "OfflineDraft_kind_check" CHECK ("kind" IN ('SALE', 'EXPENSE'));

-- ---- one pending question or proposal per person at a time: a newer message supersedes the older one, so "yes" can only ever mean the latest
CREATE UNIQUE INDEX "PendingAction_one_pending_per_actor" ON "PendingAction" ("merchantId") WHERE "status" = 'PENDING';

-- ---- state guards: an answered proposal, and a confirmed draft, are final
CREATE OR REPLACE FUNCTION tradepal_pending_action_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'A % pending action is final and cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "PendingAction_final" BEFORE UPDATE OF "status" ON "PendingAction" FOR EACH ROW EXECUTE FUNCTION tradepal_pending_action_final();

CREATE OR REPLACE FUNCTION tradepal_draft_confirmed_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'CONFIRMED' AND (NEW."status" <> 'CONFIRMED' OR NEW."payload" IS DISTINCT FROM OLD."payload") THEN
    RAISE EXCEPTION 'A confirmed draft is final: it became a transaction' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "OfflineDraft_confirmed_final" BEFORE UPDATE ON "OfflineDraft" FOR EACH ROW EXECUTE FUNCTION tradepal_draft_confirmed_final();

-- ---- history is append-only / records cannot be deleted
CREATE TRIGGER "ContactConsentEvent_append_only" BEFORE UPDATE OR DELETE ON "ContactConsentEvent" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "OutboundMessageLog_append_only"  BEFORE UPDATE OR DELETE ON "OutboundMessageLog"  FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "AlertDelivery_append_only"       BEFORE UPDATE OR DELETE ON "AlertDelivery"       FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "MessageTemplate_no_delete"  BEFORE DELETE ON "MessageTemplate"  FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ContactConsent_no_delete"   BEFORE DELETE ON "ContactConsent"   FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "BlockedNumber_no_delete"    BEFORE DELETE ON "BlockedNumber"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PendingAction_no_delete"    BEFORE DELETE ON "PendingAction"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "DeviceSession_no_delete"    BEFORE DELETE ON "DeviceSession"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "OfflineDraft_no_delete"     BEFORE DELETE ON "OfflineDraft"     FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'MessageTemplate','ContactConsent','ContactConsentEvent','BlockedNumber','OutboundMessageLog','PendingAction','DeviceSession','OfflineDraft','AlertDelivery'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- ---- tenant row-level security on business-owned tables. Templates, the blocklist, the outbound log and alert delivery are platform data.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ContactConsent','ContactConsentEvent','PendingAction','DeviceSession','OfflineDraft'] LOOP
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
  ('consumerMessaging', 'Allow TradePal to send WhatsApp order updates to a shopper who ticked the box at checkout. Also needs an approved template for the message class and the platform switch. Never marketing.', false),
  ('conversationalConfirmations', 'Preview and confirm AI-read entries before they are saved (bound to the exact action, amount, person and a short expiry), with clarifying questions for unclear units, currency and products.', false),
  ('offlineDrafts', 'Let the owner or staff capture sales and expenses as labelled drafts on a phone without a connection, then review and confirm them once back online.', false)
ON CONFLICT ("key") DO NOTHING;
