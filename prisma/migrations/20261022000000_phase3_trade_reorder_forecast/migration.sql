-- CreateEnum
CREATE TYPE "TradePartnerRole" AS ENUM ('SUPPLIER', 'CUSTOMER', 'BOTH');

-- CreateEnum
CREATE TYPE "PartnerLinkStatus" AS ENUM ('NONE', 'INVITED', 'LINKED', 'REVOKED');

-- CreateEnum
CREATE TYPE "BusinessLinkStatus" AS ENUM ('INVITED', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderAcceptance" AS ENUM ('DRAFT', 'REQUESTED', 'QUOTED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GoodsMovementStatus" AS ENUM ('NOT_SHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DISPATCHED', 'PARTIALLY_RECEIVED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "TradeInvoiceStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('OUT', 'IN');

-- CreateEnum
CREATE TYPE "TradePaymentMethod" AS ENUM ('CASH', 'MOBILE_MONEY', 'BANK', 'OTHER');

-- CreateEnum
CREATE TYPE "TradePaymentEvidence" AS ENUM ('MERCHANT_RECORDED', 'COUNTERPARTY_REPORTED', 'COUNTERPARTY_CONFIRMED', 'SIMULATOR_CONFIRMED', 'PROVIDER_CONFIRMED');

-- CreateEnum
CREATE TYPE "TradePaymentState" AS ENUM ('PROPOSED', 'APPLIED', 'HELD', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReorderMode" AS ENUM ('FIXED', 'DAYS_OF_COVER');

-- CreateEnum
CREATE TYPE "SuggestionMethod" AS ENUM ('TIER1_FIXED', 'TIER1_COVER', 'TIER2_FORECAST');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'DISMISSED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "GateAction" AS ENUM ('ENABLED', 'DISABLED', 'REJECTED');

-- CreateTable
CREATE TABLE "TradePartner" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "phone" TEXT,
    "role" "TradePartnerRole" NOT NULL DEFAULT 'SUPPLIER',
    "linkStatus" "PartnerLinkStatus" NOT NULL DEFAULT 'NONE',
    "linkedBusinessId" TEXT,
    "linkId" TEXT,
    "paymentTermsDays" INTEGER,
    "creditLimitMinor" BIGINT,
    "blockWhenOverdueDays" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradePartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessLink" (
    "id" TEXT NOT NULL,
    "inviterBusinessId" TEXT NOT NULL,
    "inviteeBusinessId" TEXT,
    "inviterPartnerId" TEXT NOT NULL,
    "inviteePartnerId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" "BusinessLinkStatus" NOT NULL DEFAULT 'INVITED',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdBy" TEXT,
    "acceptedBy" TEXT,
    "acceptedAt" TIMESTAMPTZ,
    "revokedBy" TEXT,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListShare" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "PriceListShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeOrder" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "partnerId" TEXT NOT NULL,
    "counterpartOrderId" TEXT,
    "reference" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "acceptance" "OrderAcceptance" NOT NULL DEFAULT 'DRAFT',
    "movement" "GoodsMovementStatus" NOT NULL DEFAULT 'NOT_SHIPPED',
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "paymentTermsDays" INTEGER,
    "validUntil" TIMESTAMPTZ,
    "holdUntil" TIMESTAMPTZ,
    "note" TEXT,
    "frozenTerms" JSONB,
    "acceptedAt" TIMESTAMPTZ,
    "closedAt" TIMESTAMPTZ,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TradeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeOrderLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" TEXT,
    "counterpartVariantId" TEXT,
    "description" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "packBaseQuantity" INTEGER NOT NULL DEFAULT 1,
    "quantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "lineTotalMinor" BIGINT NOT NULL,
    "shippedBase" INTEGER NOT NULL DEFAULT 0,
    "receivedBase" INTEGER NOT NULL DEFAULT 0,
    "reservationId" TEXT,
    "counterpartLineId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "number" INTEGER NOT NULL,
    "waybillRef" TEXT,
    "carrier" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'DISPATCHED',
    "dispatchedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "counterpartShipmentId" TEXT,
    "createdBy" TEXT,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "acceptedBase" INTEGER NOT NULL DEFAULT 0,
    "damagedBase" INTEGER NOT NULL DEFAULT 0,
    "shortBase" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ShipmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "note" TEXT,
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "shipmentLineId" TEXT NOT NULL,
    "acceptedBase" INTEGER NOT NULL,
    "damagedBase" INTEGER NOT NULL DEFAULT 0,
    "shortBase" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "valueMinor" BIGINT NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeInvoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "partnerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "counterpartInvoiceId" TEXT,
    "number" TEXT NOT NULL,
    "externalNumber" TEXT,
    "currencyCode" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "creditedMinor" BIGINT NOT NULL DEFAULT 0,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "TradeInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMPTZ,

    CONSTRAINT "TradeInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeInvoiceLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "packBaseQuantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "lineTotalMinor" BIGINT NOT NULL,

    CONSTRAINT "TradeInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradePayment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "method" "TradePaymentMethod" NOT NULL,
    "evidence" "TradePaymentEvidence" NOT NULL,
    "state" "TradePaymentState" NOT NULL,
    "reference" TEXT,
    "provider" TEXT,
    "externalId" TEXT,
    "reason" TEXT,
    "counterpartPaymentId" TEXT,
    "journalEntryId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMPTZ,

    CONSTRAINT "TradePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "externalNumber" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "counterpartCreditNoteId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReorderRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "mode" "ReorderMode" NOT NULL,
    "reorderPoint" INTEGER,
    "reorderQuantity" INTEGER,
    "targetCoverDays" INTEGER,
    "windowDays" INTEGER,
    "preferredPartnerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ReorderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReorderSuggestion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "ruleId" TEXT,
    "method" "SuggestionMethod" NOT NULL,
    "suggestedBaseQty" INTEGER NOT NULL,
    "inputs" JSONB NOT NULL,
    "arithmetic" TEXT NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PROPOSED',
    "draftOrderId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ,
    "decidedBy" TEXT,

    CONSTRAINT "ReorderSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastPrediction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "horizonDays" INTEGER NOT NULL,
    "periodStart" TIMESTAMPTZ NOT NULL,
    "periodEnd" TIMESTAMPTZ NOT NULL,
    "predictionMilli" INTEGER NOT NULL,
    "baselineMilli" INTEGER NOT NULL,
    "suggestedReorderQty" INTEGER NOT NULL,
    "inputs" JSONB NOT NULL,
    "runAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastScore" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "actualMilli" INTEGER NOT NULL,
    "absErrorMilli" INTEGER NOT NULL,
    "apeBps" INTEGER,
    "baselineAbsErrorMilli" INTEGER NOT NULL,
    "baselineApeBps" INTEGER,
    "stockout" BOOLEAN NOT NULL,
    "scoredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastGateConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "minScoredWeeks" INTEGER,
    "minImprovementBps" INTEGER,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastGateConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastGateEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "action" "GateAction" NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "correlationId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastGateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradePartner_businessId_role_idx" ON "TradePartner"("businessId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "TradePartner_businessId_normalizedName_key" ON "TradePartner"("businessId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessLink_tokenHash_key" ON "BusinessLink"("tokenHash");

-- CreateIndex
CREATE INDEX "BusinessLink_inviterBusinessId_status_idx" ON "BusinessLink"("inviterBusinessId", "status");

-- CreateIndex
CREATE INDEX "BusinessLink_inviteeBusinessId_status_idx" ON "BusinessLink"("inviteeBusinessId", "status");

-- CreateIndex
CREATE INDEX "PriceListShare_businessId_idx" ON "PriceListShare"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListShare_priceListId_linkId_key" ON "PriceListShare"("priceListId", "linkId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeOrder_counterpartOrderId_key" ON "TradeOrder"("counterpartOrderId");

-- CreateIndex
CREATE INDEX "TradeOrder_businessId_side_acceptance_idx" ON "TradeOrder"("businessId", "side", "acceptance");

-- CreateIndex
CREATE INDEX "TradeOrder_partnerId_idx" ON "TradeOrder"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeOrder_businessId_reference_key" ON "TradeOrder"("businessId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "TradeOrderLine_counterpartLineId_key" ON "TradeOrderLine"("counterpartLineId");

-- CreateIndex
CREATE INDEX "TradeOrderLine_businessId_idx" ON "TradeOrderLine"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeOrderLine_orderId_lineNo_key" ON "TradeOrderLine"("orderId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_counterpartShipmentId_key" ON "Shipment"("counterpartShipmentId");

-- CreateIndex
CREATE INDEX "Shipment_businessId_idx" ON "Shipment"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_orderId_number_key" ON "Shipment"("orderId", "number");

-- CreateIndex
CREATE INDEX "ShipmentLine_businessId_idx" ON "ShipmentLine"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentLine_shipmentId_orderLineId_key" ON "ShipmentLine"("shipmentId", "orderLineId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_businessId_shipmentId_idx" ON "GoodsReceipt"("businessId", "shipmentId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_businessId_idx" ON "GoodsReceiptLine"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeInvoice_counterpartInvoiceId_key" ON "TradeInvoice"("counterpartInvoiceId");

-- CreateIndex
CREATE INDEX "TradeInvoice_businessId_side_status_idx" ON "TradeInvoice"("businessId", "side", "status");

-- CreateIndex
CREATE INDEX "TradeInvoice_orderId_idx" ON "TradeInvoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeInvoice_businessId_number_key" ON "TradeInvoice"("businessId", "number");

-- CreateIndex
CREATE INDEX "TradeInvoiceLine_invoiceId_idx" ON "TradeInvoiceLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "TradePayment_counterpartPaymentId_key" ON "TradePayment"("counterpartPaymentId");

-- CreateIndex
CREATE INDEX "TradePayment_businessId_state_idx" ON "TradePayment"("businessId", "state");

-- CreateIndex
CREATE INDEX "TradePayment_invoiceId_idx" ON "TradePayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "TradePayment_businessId_provider_externalId_key" ON "TradePayment"("businessId", "provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_counterpartCreditNoteId_key" ON "CreditNote"("counterpartCreditNoteId");

-- CreateIndex
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_businessId_number_key" ON "CreditNote"("businessId", "number");

-- CreateIndex
CREATE INDEX "ReorderRule_businessId_idx" ON "ReorderRule"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderRule_shopId_variantId_key" ON "ReorderRule"("shopId", "variantId");

-- CreateIndex
CREATE INDEX "ReorderSuggestion_businessId_status_idx" ON "ReorderSuggestion"("businessId", "status");

-- CreateIndex
CREATE INDEX "ReorderSuggestion_shopId_variantId_idx" ON "ReorderSuggestion"("shopId", "variantId");

-- CreateIndex
CREATE INDEX "ForecastPrediction_businessId_periodEnd_idx" ON "ForecastPrediction"("businessId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastPrediction_shopId_variantId_method_periodStart_key" ON "ForecastPrediction"("shopId", "variantId", "method", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastScore_predictionId_key" ON "ForecastScore"("predictionId");

-- CreateIndex
CREATE INDEX "ForecastGateEvent_businessId_createdAt_idx" ON "ForecastGateEvent"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "TradePartner" ADD CONSTRAINT "TradePartner_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessLink" ADD CONSTRAINT "BusinessLink_inviterBusinessId_fkey" FOREIGN KEY ("inviterBusinessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessLink" ADD CONSTRAINT "BusinessLink_inviteeBusinessId_fkey" FOREIGN KEY ("inviteeBusinessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListShare" ADD CONSTRAINT "PriceListShare_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListShare" ADD CONSTRAINT "PriceListShare_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeOrder" ADD CONSTRAINT "TradeOrder_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeOrder" ADD CONSTRAINT "TradeOrder_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeOrderLine" ADD CONSTRAINT "TradeOrderLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeOrderLine" ADD CONSTRAINT "TradeOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeOrderLine" ADD CONSTRAINT "TradeOrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeInvoice" ADD CONSTRAINT "TradeInvoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeInvoice" ADD CONSTRAINT "TradeInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeInvoiceLine" ADD CONSTRAINT "TradeInvoiceLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeInvoiceLine" ADD CONSTRAINT "TradeInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TradeInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradePayment" ADD CONSTRAINT "TradePayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradePayment" ADD CONSTRAINT "TradePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TradeInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TradeInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderSuggestion" ADD CONSTRAINT "ReorderSuggestion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderSuggestion" ADD CONSTRAINT "ReorderSuggestion_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderSuggestion" ADD CONSTRAINT "ReorderSuggestion_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastPrediction" ADD CONSTRAINT "ForecastPrediction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastPrediction" ADD CONSTRAINT "ForecastPrediction_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastPrediction" ADD CONSTRAINT "ForecastPrediction_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastScore" ADD CONSTRAINT "ForecastScore_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastScore" ADD CONSTRAINT "ForecastScore_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "ForecastPrediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastGateEvent" ADD CONSTRAINT "ForecastGateEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Phase 3: B2B procurement, reorder engine, forecasting - hand-written part.
-- ============================================================================================

-- ---- value constraints
ALTER TABLE "TradeOrderLine" ADD CONSTRAINT "TradeOrderLine_values_check" CHECK (
  "quantity" > 0 AND "packBaseQuantity" >= 1 AND "baseQuantity" = "quantity" * "packBaseQuantity"
  AND "unitPriceMinor" >= 0 AND "lineTotalMinor" = "unitPriceMinor" * "quantity"
  AND "shippedBase" >= 0 AND "shippedBase" <= "baseQuantity"
  AND "receivedBase" >= 0 AND "receivedBase" <= "shippedBase");
ALTER TABLE "TradeOrder" ADD CONSTRAINT "TradeOrder_total_check" CHECK ("totalMinor" >= 0);
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_values_check" CHECK (
  "baseQuantity" > 0 AND "acceptedBase" >= 0 AND "damagedBase" >= 0 AND "shortBase" >= 0
  AND "acceptedBase" + "damagedBase" + "shortBase" <= "baseQuantity");
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_values_check" CHECK (
  "acceptedBase" >= 0 AND "damagedBase" >= 0 AND "shortBase" >= 0 AND "acceptedBase" + "damagedBase" + "shortBase" > 0 AND "valueMinor" >= 0);
ALTER TABLE "TradeInvoice" ADD CONSTRAINT "TradeInvoice_amounts_check" CHECK (
  "totalMinor" > 0 AND "creditedMinor" >= 0 AND "paidMinor" >= 0 AND "creditedMinor" + "paidMinor" <= "totalMinor");
ALTER TABLE "TradeInvoiceLine" ADD CONSTRAINT "TradeInvoiceLine_values_check" CHECK ("baseQuantity" > 0 AND "lineTotalMinor" >= 0 AND "unitPriceMinor" > 0 AND "packBaseQuantity" >= 1);
ALTER TABLE "TradePayment" ADD CONSTRAINT "TradePayment_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "TradePartner" ADD CONSTRAINT "TradePartner_terms_check" CHECK (
  ("paymentTermsDays" IS NULL OR "paymentTermsDays" >= 0) AND ("creditLimitMinor" IS NULL OR "creditLimitMinor" >= 0) AND ("blockWhenOverdueDays" IS NULL OR "blockWhenOverdueDays" >= 0));
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_mode_check" CHECK (
  ("mode" = 'FIXED' AND "reorderPoint" IS NOT NULL AND "reorderPoint" >= 0 AND "reorderQuantity" IS NOT NULL AND "reorderQuantity" > 0)
  OR ("mode" = 'DAYS_OF_COVER' AND "targetCoverDays" IS NOT NULL AND "targetCoverDays" > 0 AND "windowDays" IS NOT NULL AND "windowDays" > 0));
ALTER TABLE "ReorderSuggestion" ADD CONSTRAINT "ReorderSuggestion_qty_check" CHECK ("suggestedBaseQty" > 0);
ALTER TABLE "ForecastPrediction" ADD CONSTRAINT "ForecastPrediction_values_check" CHECK (
  "horizonDays" > 0 AND "periodEnd" > "periodStart" AND "predictionMilli" >= 0 AND "baselineMilli" >= 0 AND "suggestedReorderQty" >= 0);
ALTER TABLE "ForecastScore" ADD CONSTRAINT "ForecastScore_values_check" CHECK ("actualMilli" >= 0 AND "absErrorMilli" >= 0 AND "baselineAbsErrorMilli" >= 0);
ALTER TABLE "ForecastGateConfig" ADD CONSTRAINT "ForecastGateConfig_singleton_check" CHECK ("id" = 1 AND ("minScoredWeeks" IS NULL OR "minScoredWeeks" > 0) AND ("minImprovementBps" IS NULL OR "minImprovementBps" >= 0));
INSERT INTO "ForecastGateConfig" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING; -- thresholds stay NULL: no invented defaults

-- ---- acceptance freezes terms, enforced by the database:
-- (1) an order can only become ACCEPTED if it has lines and every line is priced (draft lines from a reorder suggestion may be unpriced);
-- (2) once an order is ACCEPTED (or beyond), a line's quantity, pack and price can no longer change.
CREATE OR REPLACE FUNCTION tradepal_order_accept_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."acceptance" = 'ACCEPTED' AND OLD."acceptance" <> 'ACCEPTED' THEN
    IF NOT EXISTS (SELECT 1 FROM "TradeOrderLine" WHERE "orderId" = NEW."id")
       OR EXISTS (SELECT 1 FROM "TradeOrderLine" WHERE "orderId" = NEW."id" AND "unitPriceMinor" <= 0) THEN
      RAISE EXCEPTION 'TradePal: order % cannot be accepted: it needs at least one line and every line must be priced', NEW."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "TradeOrder_accept_guard" BEFORE UPDATE OF "acceptance" ON "TradeOrder" FOR EACH ROW EXECUTE FUNCTION tradepal_order_accept_guard();

CREATE OR REPLACE FUNCTION tradepal_order_line_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT "acceptance"::text INTO st FROM "TradeOrder" WHERE "id" = NEW."orderId";
  IF st IN ('ACCEPTED') AND (NEW."quantity" <> OLD."quantity" OR NEW."unitPriceMinor" <> OLD."unitPriceMinor"
     OR NEW."packBaseQuantity" <> OLD."packBaseQuantity" OR NEW."unit" <> OLD."unit" OR NEW."variantId" IS DISTINCT FROM OLD."variantId") THEN
    RAISE EXCEPTION 'TradePal: the terms of an accepted order are frozen (line %)', NEW."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "TradeOrderLine_frozen" BEFORE UPDATE ON "TradeOrderLine" FOR EACH ROW EXECUTE FUNCTION tradepal_order_line_frozen();

-- ---- one open suggestion per (shop, variant, method): a re-run supersedes instead of piling up
CREATE UNIQUE INDEX "ReorderSuggestion_one_open_per_method" ON "ReorderSuggestion" ("shopId", "variantId", "method") WHERE "status" = 'PROPOSED';

-- ---- history is append-only
CREATE TRIGGER "GoodsReceipt_append_only"      BEFORE UPDATE OR DELETE ON "GoodsReceipt"      FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "GoodsReceiptLine_append_only"  BEFORE UPDATE OR DELETE ON "GoodsReceiptLine"  FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "ForecastPrediction_append_only" BEFORE UPDATE OR DELETE ON "ForecastPrediction" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "ForecastScore_append_only"     BEFORE UPDATE OR DELETE ON "ForecastScore"     FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "ForecastGateEvent_append_only" BEFORE UPDATE OR DELETE ON "ForecastGateEvent" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();

-- ---- status may change, rows may not vanish
CREATE TRIGGER "TradePartner_no_delete"    BEFORE DELETE ON "TradePartner"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "BusinessLink_no_delete"    BEFORE DELETE ON "BusinessLink"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PriceListShare_no_delete"  BEFORE DELETE ON "PriceListShare"  FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "TradeOrder_no_delete"      BEFORE DELETE ON "TradeOrder"      FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
-- order lines of a DRAFT order carry no financial effect and may be edited by replacement; from REQUESTED on they are protected
CREATE OR REPLACE FUNCTION tradepal_order_line_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT "acceptance"::text INTO st FROM "TradeOrder" WHERE "id" = OLD."orderId";
  IF st = 'DRAFT' OR tradepal_is_synthetic(OLD."businessId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'TradePal: DELETE on "TradeOrderLine" is not permitted once an order has left DRAFT' USING ERRCODE = 'integrity_constraint_violation';
END
$$;
CREATE TRIGGER "TradeOrderLine_no_delete"  BEFORE DELETE ON "TradeOrderLine"  FOR EACH ROW EXECUTE FUNCTION tradepal_order_line_no_delete();
CREATE TRIGGER "Shipment_no_delete"        BEFORE DELETE ON "Shipment"        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ShipmentLine_no_delete"    BEFORE DELETE ON "ShipmentLine"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "TradeInvoice_no_delete"    BEFORE DELETE ON "TradeInvoice"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "TradeInvoiceLine_no_delete" BEFORE DELETE ON "TradeInvoiceLine" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "TradePayment_no_delete"    BEFORE DELETE ON "TradePayment"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "CreditNote_no_delete"      BEFORE DELETE ON "CreditNote"      FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ReorderSuggestion_no_delete" BEFORE DELETE ON "ReorderSuggestion" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'GoodsReceipt','GoodsReceiptLine','ForecastPrediction','ForecastScore','ForecastGateEvent','TradePartner','BusinessLink','PriceListShare',
    'TradeOrder','TradeOrderLine','Shipment','ShipmentLine','TradeInvoice','TradeInvoiceLine','TradePayment','CreditNote','ReorderSuggestion'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- ---- tenant row-level security (inert until the role step). BusinessLink has two parties, so its policy admits either.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TradePartner','PriceListShare','TradeOrder','TradeOrderLine','Shipment','ShipmentLine','GoodsReceipt','GoodsReceiptLine','TradeInvoice',
    'TradeInvoiceLine','TradePayment','CreditNote','ReorderRule','ReorderSuggestion','ForecastPrediction','ForecastScore','ForecastGateEvent'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("businessId" = current_setting(''app.current_business_id'', true)) WITH CHECK ("businessId" = current_setting(''app.current_business_id'', true))',
      t);
  END LOOP;
END
$$;
ALTER TABLE "BusinessLink" ENABLE ROW LEVEL SECURITY;
CREATE POLICY link_parties ON "BusinessLink"
  USING ("inviterBusinessId" = current_setting('app.current_business_id', true) OR "inviteeBusinessId" = current_setting('app.current_business_id', true))
  WITH CHECK ("inviterBusinessId" = current_setting('app.current_business_id', true) OR "inviteeBusinessId" = current_setting('app.current_business_id', true));

-- ---- the per-merchant forecast gate can only be opened through the promotion-gate function.
-- That function sets a transaction-local marker; any other attempt (application code, a manual UPDATE) is refused here.
CREATE OR REPLACE FUNCTION tradepal_forecast_gate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'BusinessFeatureFlag' THEN
    IF NEW."flagKey" = 'reorderForecastLive' AND NEW."enabled" = true
       AND (TG_OP = 'INSERT' OR OLD."enabled" IS DISTINCT FROM true)
       AND COALESCE(current_setting('app.forecast_gate_open', true), '') <> 'on' THEN
      RAISE EXCEPTION 'TradePal: the forecast gate can only be opened through the promotion gate (thresholds checked, audited)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."key" = 'reorderForecastLive' AND NEW."enabledByDefault" = true THEN
    RAISE EXCEPTION 'TradePal: the forecast gate is per merchant and can never be on by default' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "BusinessFeatureFlag_forecast_gate" BEFORE INSERT OR UPDATE ON "BusinessFeatureFlag" FOR EACH ROW EXECUTE FUNCTION tradepal_forecast_gate_guard();
CREATE TRIGGER "FeatureFlag_forecast_gate" BEFORE INSERT OR UPDATE ON "FeatureFlag" FOR EACH ROW EXECUTE FUNCTION tradepal_forecast_gate_guard();

-- ---- default-OFF flags
INSERT INTO "FeatureFlag" ("key", "description", "enabledByDefault")
VALUES
  ('tradeOrders', 'B2B purchase and sales orders with linked partners, shipments, goods receipts, invoices and payment tracking.', false),
  ('reorderRules', 'Tier 1 reorder suggestions (deterministic, draft purchase orders only).', false),
  ('reorderForecastShadow', 'Tier 2 demand forecasts, written in shadow mode and never shown to the merchant.', false),
  ('reorderForecastLive', 'Per-merchant promotion gate: forecasting replaces the Tier 1 quantity. Only the owner can open it, and only above the configured thresholds.', false)
ON CONFLICT ("key") DO NOTHING;
