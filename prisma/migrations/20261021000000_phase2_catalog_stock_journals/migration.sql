-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PriceListKind" AS ENUM ('RETAIL', 'WHOLESALE', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "PriceStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('OPENING_BALANCE', 'RECEIPT', 'SALE_FULFILLMENT', 'RETURN_RESTOCK', 'COUNT_ADJUSTMENT', 'SPOILAGE', 'OWNER_WITHDRAWAL', 'DAMAGE_QUARANTINE', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'MANUAL_ADJUSTMENT', 'LEGACY_MIRROR', 'REVERSAL');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('MERCHANT_ENTERED', 'DOCUMENT_SUPPORTED', 'PROVIDER_CONFIRMED', 'RECONCILED', 'MIGRATED_OPENING', 'SYSTEM_DERIVED');

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NegativeStockPolicy" AS ENUM ('ALLOW', 'BLOCK');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "imageUrls" TEXT[],
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "baseUnit" TEXT NOT NULL,
    "trackStock" BOOLEAN NOT NULL DEFAULT true,
    "lowStockThreshold" INTEGER,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "inventoryItemId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantAlias" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackConversion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PriceListKind" NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "customerId" TEXT,
    "status" "PriceStatus" NOT NULL DEFAULT 'ACTIVE',
    "validFrom" TIMESTAMPTZ,
    "validTo" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "packConversionId" TEXT,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceMinor" BIGINT NOT NULL,
    "status" "PriceStatus" NOT NULL DEFAULT 'ACTIVE',
    "validFrom" TIMESTAMPTZ,
    "validTo" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "onHandDelta" INTEGER NOT NULL DEFAULT 0,
    "damagedDelta" INTEGER NOT NULL DEFAULT 0,
    "inTransitDelta" INTEGER NOT NULL DEFAULT 0,
    "unitCostMinor" BIGINT,
    "costCurrency" TEXT,
    "costIncomplete" BOOLEAN NOT NULL DEFAULT false,
    "costMinor" BIGINT,
    "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provenance" "Provenance" NOT NULL DEFAULT 'MERCHANT_ENTERED',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "note" TEXT,
    "idempotencyKey" TEXT,
    "reversalOfMovementId" TEXT,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "inTransit" INTEGER NOT NULL DEFAULT 0,
    "avgCostMinor" BIGINT,
    "uncostedQty" INTEGER NOT NULL DEFAULT 0,
    "costCurrency" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "negativeStock" "NegativeStockPolicy" NOT NULL DEFAULT 'ALLOW',
    "allowBackorder" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "StockPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "openedBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "countedQty" INTEGER NOT NULL,
    "discrepancy" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fromShopId" TEXT NOT NULL,
    "toShopId" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ,
    "receivedAt" TIMESTAMPTZ,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantitySent" INTEGER NOT NULL,
    "quantityReceived" INTEGER,
    "unitCostMinor" BIGINT,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "systemKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ NOT NULL,
    "postedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "memo" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "provenance" "Provenance" NOT NULL DEFAULT 'MERCHANT_ENTERED',
    "evidenceRef" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reversalOfEntryId" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debitMinor" BIGINT NOT NULL DEFAULT 0,
    "creditMinor" BIGINT NOT NULL DEFAULT 0,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyClose" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "expectedCashMinor" BIGINT NOT NULL,
    "countedCashMinor" BIGINT NOT NULL,
    "differenceMinor" BIGINT NOT NULL,
    "summary" JSONB NOT NULL,
    "note" TEXT,
    "closedBy" TEXT,
    "closedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adjustmentEntryId" TEXT,

    CONSTRAINT "DailyClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_businessId_status_idx" ON "Product"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_inventoryItemId_key" ON "ProductVariant"("inventoryItemId");

-- CreateIndex
CREATE INDEX "ProductVariant_businessId_productId_idx" ON "ProductVariant"("businessId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_businessId_sku_key" ON "ProductVariant"("businessId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_businessId_barcode_key" ON "ProductVariant"("businessId", "barcode");

-- CreateIndex
CREATE INDEX "VariantAlias_variantId_idx" ON "VariantAlias"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantAlias_businessId_normalizedAlias_key" ON "VariantAlias"("businessId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "PackConversion_businessId_idx" ON "PackConversion"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "PackConversion_variantId_normalizedName_key" ON "PackConversion"("variantId", "normalizedName");

-- CreateIndex
CREATE INDEX "PriceList_businessId_kind_status_idx" ON "PriceList"("businessId", "kind", "status");

-- CreateIndex
CREATE INDEX "PriceRule_priceListId_variantId_idx" ON "PriceRule"("priceListId", "variantId");

-- CreateIndex
CREATE INDEX "PriceRule_businessId_idx" ON "PriceRule"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_reversalOfMovementId_key" ON "StockMovement"("reversalOfMovementId");

-- CreateIndex
CREATE INDEX "StockMovement_businessId_variantId_createdAt_idx" ON "StockMovement"("businessId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_sourceType_sourceId_idx" ON "StockMovement"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_businessId_idempotencyKey_key" ON "StockMovement"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StockBalance_businessId_variantId_idx" ON "StockBalance"("businessId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_shopId_variantId_key" ON "StockBalance"("shopId", "variantId");

-- CreateIndex
CREATE INDEX "StockReservation_status_expiresAt_idx" ON "StockReservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "StockReservation_businessId_variantId_idx" ON "StockReservation"("businessId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReservation_businessId_idempotencyKey_key" ON "StockReservation"("businessId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockPolicy_businessId_key" ON "StockPolicy"("businessId");

-- CreateIndex
CREATE INDEX "StockCount_businessId_status_idx" ON "StockCount"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_variantId_key" ON "StockCountLine"("countId", "variantId");

-- CreateIndex
CREATE INDEX "StockTransfer_businessId_status_idx" ON "StockTransfer"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferLine_transferId_variantId_key" ON "StockTransferLine"("transferId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_businessId_code_key" ON "Account"("businessId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Account_businessId_systemKey_key" ON "Account"("businessId", "systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfEntryId_key" ON "JournalEntry"("reversalOfEntryId");

-- CreateIndex
CREATE INDEX "JournalEntry_businessId_occurredAt_idx" ON "JournalEntry"("businessId", "occurredAt");

-- CreateIndex
CREATE INDEX "JournalEntry_sourceType_sourceId_idx" ON "JournalEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_businessId_idempotencyKey_key" ON "JournalEntry"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "JournalLine_businessId_accountId_idx" ON "JournalLine"("businessId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyClose_businessId_businessDate_currencyCode_key" ON "DailyClose"("businessId", "businessDate", "currencyCode");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantAlias" ADD CONSTRAINT "VariantAlias_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantAlias" ADD CONSTRAINT "VariantAlias_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackConversion" ADD CONSTRAINT "PackConversion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackConversion" ADD CONSTRAINT "PackConversion_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_packConversionId_fkey" FOREIGN KEY ("packConversionId") REFERENCES "PackConversion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversalOfMovementId_fkey" FOREIGN KEY ("reversalOfMovementId") REFERENCES "StockMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPolicy" ADD CONSTRAINT "StockPolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromShopId_fkey" FOREIGN KEY ("fromShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toShopId_fkey" FOREIGN KEY ("toShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfEntryId_fkey" FOREIGN KEY ("reversalOfEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Phase 2: catalog, stock, journals, daily close - hand-written part.
-- Constraints, append-only protection, the balanced-journal guarantee, row-level security, default-off flags.
-- ============================================================================================

-- ---- value constraints (enforced in the database, not only in code)
ALTER TABLE "PackConversion"     ADD CONSTRAINT "PackConversion_baseQuantity_check"   CHECK ("baseQuantity" >= 2);
ALTER TABLE "PriceRule"          ADD CONSTRAINT "PriceRule_values_check"              CHECK ("minQuantity" >= 1 AND "unitPriceMinor" > 0 AND ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" > "validFrom"));
ALTER TABLE "PriceList"          ADD CONSTRAINT "PriceList_validity_check"            CHECK ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" > "validFrom");
ALTER TABLE "StockBalance"       ADD CONSTRAINT "StockBalance_nonnegative_check"      CHECK ("reserved" >= 0 AND "damaged" >= 0 AND "inTransit" >= 0 AND "uncostedQty" >= 0);
ALTER TABLE "StockMovement"      ADD CONSTRAINT "StockMovement_nonzero_check"         CHECK ("onHandDelta" <> 0 OR "damagedDelta" <> 0 OR "inTransitDelta" <> 0);
ALTER TABLE "StockReservation"   ADD CONSTRAINT "StockReservation_quantity_check"     CHECK ("quantity" > 0);
ALTER TABLE "StockCountLine"     ADD CONSTRAINT "StockCountLine_discrepancy_check"    CHECK ("countedQty" >= 0 AND "discrepancy" = "countedQty" - "expectedQty");
ALTER TABLE "StockTransferLine"  ADD CONSTRAINT "StockTransferLine_quantity_check"    CHECK ("quantitySent" > 0 AND ("quantityReceived" IS NULL OR "quantityReceived" >= 0));
ALTER TABLE "StockTransfer"      ADD CONSTRAINT "StockTransfer_shops_check"           CHECK ("fromShopId" <> "toShopId");
ALTER TABLE "JournalLine"        ADD CONSTRAINT "JournalLine_one_sided_check"         CHECK (("debitMinor" > 0 AND "creditMinor" = 0) OR ("creditMinor" > 0 AND "debitMinor" = 0));
ALTER TABLE "DailyClose"         ADD CONSTRAINT "DailyClose_difference_check"         CHECK ("differenceMinor" = "countedCashMinor" - "expectedCashMinor" AND "countedCashMinor" >= 0);

-- ---- a posted journal entry balances (debits = credits, at least two lines, every line in the entry's own business).
-- Deferred to commit so an entry and its lines can be inserted in one transaction in any order.
CREATE OR REPLACE FUNCTION tradepal_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  eid text;
  d numeric;
  c numeric;
  n integer;
  foreign_lines integer;
BEGIN
  IF TG_TABLE_NAME = 'JournalEntry' THEN eid := NEW."id"; ELSE eid := NEW."entryId"; END IF;
  SELECT COALESCE(SUM("debitMinor"), 0), COALESCE(SUM("creditMinor"), 0), COUNT(*) INTO d, c, n
    FROM "JournalLine" WHERE "entryId" = eid;
  IF n < 2 THEN
    RAISE EXCEPTION 'TradePal: journal entry % must have at least two lines', eid USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'TradePal: journal entry % is unbalanced (debits % <> credits %)', eid, d, c USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT COUNT(*) INTO foreign_lines
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    JOIN "Account" a ON a."id" = l."accountId"
   WHERE l."entryId" = eid AND (l."businessId" <> e."businessId" OR a."businessId" <> e."businessId");
  IF foreign_lines > 0 THEN
    RAISE EXCEPTION 'TradePal: journal entry % mixes businesses', eid USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "JournalLine_balanced"  AFTER INSERT ON "JournalLine"  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tradepal_journal_balanced();
CREATE CONSTRAINT TRIGGER "JournalEntry_balanced" AFTER INSERT ON "JournalEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tradepal_journal_balanced();

-- ---- append-only: never edited, never deleted (synthetic businesses excepted, like the Phase 1 tables)
CREATE TRIGGER "StockMovement_append_only" BEFORE UPDATE OR DELETE ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "JournalEntry_append_only"  BEFORE UPDATE OR DELETE ON "JournalEntry"  FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "JournalLine_append_only"   BEFORE UPDATE OR DELETE ON "JournalLine"   FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "DailyClose_append_only"    BEFORE UPDATE OR DELETE ON "DailyClose"    FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();

-- ---- delete-protected: status may change, rows may not vanish
CREATE TRIGGER "StockCount_no_delete"        BEFORE DELETE ON "StockCount"        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StockCountLine_no_delete"    BEFORE DELETE ON "StockCountLine"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StockTransfer_no_delete"     BEFORE DELETE ON "StockTransfer"     FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StockTransferLine_no_delete" BEFORE DELETE ON "StockTransferLine" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StockReservation_no_delete"  BEFORE DELETE ON "StockReservation"  FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "Account_no_delete"           BEFORE DELETE ON "Account"           FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'StockMovement','JournalEntry','JournalLine','DailyClose','StockCount','StockCountLine','StockTransfer',
    'StockTransferLine','StockReservation','Account'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- ---- tenant row-level security on every new table (same set as TENANT_SCOPED_MODELS; inert until the role step)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Product','ProductVariant','VariantAlias','PackConversion','PriceList','PriceRule','StockMovement','StockBalance',
    'StockReservation','StockPolicy','StockCount','StockCountLine','StockTransfer','StockTransferLine','Account',
    'JournalEntry','JournalLine','DailyClose'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("businessId" = current_setting(''app.current_business_id'', true)) WITH CHECK ("businessId" = current_setting(''app.current_business_id'', true))',
      t);
  END LOOP;
END
$$;

-- ---- default-OFF flags for the new capabilities
INSERT INTO "FeatureFlag" ("key", "description", "enabledByDefault")
VALUES
  ('catalogV2', 'Products, variants, pack sizes and price lists.', false),
  ('stockV2', 'Movement-based stock with reserved/available, reservations, counts, transfers and costing.', false),
  ('accountingJournals', 'Post balanced journal entries for every transaction.', false),
  ('dailyClose', 'End-of-day cash close with expected vs counted cash.', false)
ON CONFLICT ("key") DO NOTHING;
