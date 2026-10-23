-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD');

-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'DEAD');

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ,
    "lastError" TEXT,
    "publishedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallbackInbox" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "status" "InboxStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ,
    "lastError" TEXT,
    "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ,

    CONSTRAINT "CallbackInbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_eventType_status_idx" ON "OutboxEvent"("eventType", "status");

-- CreateIndex
CREATE INDEX "CallbackInbox_status_availableAt_idx" ON "CallbackInbox"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallbackInbox_provider_externalId_key" ON "CallbackInbox"("provider", "externalId");


-- ============================================================================================
-- Phase 1: outbox / inbox - hand-written part. Published and processed rows are never edited again
-- except by the sweepers; dead rows are replayed (status reset) by an audited admin action.
-- ============================================================================================

-- A PUBLISHED outbox event is immutable history of what was delivered.
CREATE OR REPLACE FUNCTION tradepal_outbox_published_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'TradePal: a PUBLISHED outbox event is immutable.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "OutboxEvent_published_immutable" BEFORE UPDATE ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION tradepal_outbox_published_immutable();

-- A PROCESSED callback is immutable history of what was applied (its dedupe key must stay claimed).
CREATE OR REPLACE FUNCTION tradepal_inbox_processed_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'PROCESSED' THEN
    RAISE EXCEPTION 'TradePal: a PROCESSED callback is immutable.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "CallbackInbox_processed_immutable" BEFORE UPDATE ON "CallbackInbox" FOR EACH ROW EXECUTE FUNCTION tradepal_inbox_processed_immutable();
