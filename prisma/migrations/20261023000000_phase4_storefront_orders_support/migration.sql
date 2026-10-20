-- CreateEnum
CREATE TYPE "ListingChannel" AS ENUM ('STOREFRONT', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "BasketStatus" AS ENUM ('OPEN', 'CHECKED_OUT', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StoreFulfilment" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "StoreOrderStatus" AS ENUM ('PLACED', 'CONFIRMED', 'READY', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StorePaymentMethod" AS ENUM ('PAY_ON_COLLECTION', 'ONLINE_SIMULATED');

-- CreateEnum
CREATE TYPE "StorePaymentState" AS ENUM ('APPLIED', 'HELD');

-- CreateEnum
CREATE TYPE "StoreRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "StoreRefundKind" AS ENUM ('RETURN', 'REFUND_ONLY');

-- CreateEnum
CREATE TYPE "StoreRefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'GOODS_RECEIVED', 'REFUNDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PaymentExceptionType" AS ENUM ('LATE_SUCCESS', 'OVERPAYMENT', 'UNDERPAYMENT', 'CURRENCY_MISMATCH');

-- CreateEnum
CREATE TYPE "PaymentExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportCaseType" AS ENUM ('DELIVERY', 'PRODUCT_COMPLAINT', 'PAYMENT_DISPUTE', 'REFUND', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportParty" AS ENUM ('SELLER', 'PLATFORM', 'PROVIDER');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'ASSIGNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportOpenedBy" AS ENUM ('CONSUMER', 'SELLER', 'ADMIN');

-- CreateEnum
CREATE TYPE "SupportNoteAuthor" AS ENUM ('CONSUMER', 'SELLER', 'ADMIN');

-- CreateTable
CREATE TABLE "Storefront" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "about" TEXT,
    "supportPhone" TEXT,
    "pickupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pickupLocation" TEXT,
    "pickupInstructions" TEXT,
    "deliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reservationMinutes" INTEGER NOT NULL DEFAULT 60,
    "pickupHoldHours" INTEGER NOT NULL DEFAULT 48,
    "returnWindowDays" INTEGER,
    "termsText" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Storefront_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "feeMinor" BIGINT NOT NULL,
    "minOrderMinor" BIGINT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "channel" "ListingChannel" NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Basket" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "BasketStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Basket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BasketLine" (
    "id" TEXT NOT NULL,
    "basketId" TEXT NOT NULL,
    "sellerBusinessId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "addedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BasketLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreOrder" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "basketId" TEXT,
    "status" "StoreOrderStatus" NOT NULL DEFAULT 'PLACED',
    "fulfilment" "StoreFulfilment" NOT NULL,
    "paymentMethod" "StorePaymentMethod" NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerPhone" TEXT NOT NULL,
    "contactConsent" BOOLEAN NOT NULL DEFAULT false,
    "buyerNote" TEXT,
    "addressLine" TEXT,
    "landmark" TEXT,
    "area" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "deliveryZoneId" TEXT,
    "deliveryZoneName" TEXT,
    "deliveryFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "subtotalMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    "accessTokenHash" TEXT NOT NULL,
    "accessExpiresAt" TIMESTAMPTZ NOT NULL,
    "pickupCode" TEXT NOT NULL,
    "reservedUntil" TIMESTAMPTZ,
    "terms" JSONB NOT NULL,
    "deliveryRef" TEXT,
    "carrier" TEXT,
    "cancelReason" TEXT,
    "cancelledBy" TEXT,
    "placedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ,
    "readyAt" TIMESTAMPTZ,
    "dispatchedAt" TIMESTAMPTZ,
    "completedAt" TIMESTAMPTZ,
    "cancelledAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreOrderLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "packBaseQuantity" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "lineTotalMinor" BIGINT NOT NULL,
    "reservationId" TEXT,
    "fulfilMovementId" TEXT,
    "returnedBase" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StoreOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorePayment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "method" "TradePaymentMethod" NOT NULL,
    "evidence" "TradePaymentEvidence" NOT NULL,
    "state" "StorePaymentState" NOT NULL,
    "provider" TEXT,
    "externalId" TEXT,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreCancellationRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "StoreRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreCancellationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRefundRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "StoreRefundKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "StoreRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAmountMinor" BIGINT,
    "approvedAmountMinor" BIGINT,
    "decisionNote" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreRefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRefundLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "quantityBase" INTEGER NOT NULL,
    "receivedBase" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StoreRefundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentException" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "PaymentExceptionType" NOT NULL,
    "status" "PaymentExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "amountMinor" BIGINT NOT NULL,
    "paymentId" TEXT,
    "details" JSONB,
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" "SupportCaseType" NOT NULL,
    "handledBy" "SupportParty" NOT NULL,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "openedBy" "SupportOpenedBy" NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "summary" TEXT NOT NULL,
    "assignedAdminId" TEXT,
    "resolution" TEXT,
    "closedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCaseNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorType" "SupportNoteAuthor" NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Storefront_businessId_key" ON "Storefront"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Storefront_slug_key" ON "Storefront"("slug");

-- CreateIndex
CREATE INDEX "DeliveryZone_businessId_idx" ON "DeliveryZone"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZone_storefrontId_name_key" ON "DeliveryZone"("storefrontId", "name");

-- CreateIndex
CREATE INDEX "Listing_businessId_channel_status_idx" ON "Listing"("businessId", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_variantId_channel_key" ON "Listing"("variantId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Basket_tokenHash_key" ON "Basket"("tokenHash");

-- CreateIndex
CREATE INDEX "BasketLine_basketId_idx" ON "BasketLine"("basketId");

-- CreateIndex
CREATE UNIQUE INDEX "BasketLine_basketId_variantId_unit_key" ON "BasketLine"("basketId", "variantId", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrder_accessTokenHash_key" ON "StoreOrder"("accessTokenHash");

-- CreateIndex
CREATE INDEX "StoreOrder_businessId_status_idx" ON "StoreOrder"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrder_businessId_reference_key" ON "StoreOrder"("businessId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrder_basketId_businessId_key" ON "StoreOrder"("basketId", "businessId");

-- CreateIndex
CREATE INDEX "StoreOrderLine_businessId_idx" ON "StoreOrderLine"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrderLine_orderId_lineNo_key" ON "StoreOrderLine"("orderId", "lineNo");

-- CreateIndex
CREATE INDEX "StorePayment_orderId_idx" ON "StorePayment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "StorePayment_businessId_provider_externalId_key" ON "StorePayment"("businessId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "StoreCancellationRequest_businessId_status_idx" ON "StoreCancellationRequest"("businessId", "status");

-- CreateIndex
CREATE INDEX "StoreRefundRequest_businessId_status_idx" ON "StoreRefundRequest"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StoreRefundLine_requestId_orderLineId_key" ON "StoreRefundLine"("requestId", "orderLineId");

-- CreateIndex
CREATE INDEX "PaymentException_businessId_status_idx" ON "PaymentException"("businessId", "status");

-- CreateIndex
CREATE INDEX "SupportCase_businessId_status_idx" ON "SupportCase"("businessId", "status");

-- CreateIndex
CREATE INDEX "SupportCase_status_handledBy_idx" ON "SupportCase"("status", "handledBy");

-- CreateIndex
CREATE INDEX "SupportCaseNote_caseId_idx" ON "SupportCaseNote"("caseId");

-- AddForeignKey
ALTER TABLE "Storefront" ADD CONSTRAINT "Storefront_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "Storefront"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BasketLine" ADD CONSTRAINT "BasketLine_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "Basket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "Basket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrderLine" ADD CONSTRAINT "StoreOrderLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrderLine" ADD CONSTRAINT "StoreOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrderLine" ADD CONSTRAINT "StoreOrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorePayment" ADD CONSTRAINT "StorePayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorePayment" ADD CONSTRAINT "StorePayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCancellationRequest" ADD CONSTRAINT "StoreCancellationRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCancellationRequest" ADD CONSTRAINT "StoreCancellationRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRefundRequest" ADD CONSTRAINT "StoreRefundRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRefundRequest" ADD CONSTRAINT "StoreRefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRefundLine" ADD CONSTRAINT "StoreRefundLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRefundLine" ADD CONSTRAINT "StoreRefundLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StoreRefundRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentException" ADD CONSTRAINT "PaymentException_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentException" ADD CONSTRAINT "PaymentException_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseNote" ADD CONSTRAINT "SupportCaseNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseNote" ADD CONSTRAINT "SupportCaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SupportCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Phase 4: storefront, store orders, returns, support cases - hand-written part.
-- ============================================================================================

-- ---- value constraints
ALTER TABLE "Storefront" ADD CONSTRAINT "Storefront_values_check" CHECK (
  "slug" ~ '^[a-z0-9][a-z0-9-]{2,39}$' AND "reservationMinutes" > 0 AND "pickupHoldHours" > 0 AND ("returnWindowDays" IS NULL OR "returnWindowDays" >= 0));
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_fee_check" CHECK ("feeMinor" >= 0 AND ("minOrderMinor" IS NULL OR "minOrderMinor" >= 0));
ALTER TABLE "BasketLine" ADD CONSTRAINT "BasketLine_quantity_check" CHECK ("quantity" > 0 AND "quantity" <= 100000);
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_amounts_check" CHECK (
  "subtotalMinor" >= 0 AND "deliveryFeeMinor" >= 0 AND "totalMinor" = "subtotalMinor" + "deliveryFeeMinor"
  AND "paidMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "paidMinor"
  AND ("fulfilment" = 'DELIVERY' OR "deliveryFeeMinor" = 0));
ALTER TABLE "StoreOrderLine" ADD CONSTRAINT "StoreOrderLine_values_check" CHECK (
  "quantity" > 0 AND "packBaseQuantity" >= 1 AND "baseQuantity" = "quantity" * "packBaseQuantity"
  AND "unitPriceMinor" > 0 AND "lineTotalMinor" = "unitPriceMinor" * "quantity" AND "returnedBase" >= 0 AND "returnedBase" <= "baseQuantity");
ALTER TABLE "StorePayment" ADD CONSTRAINT "StorePayment_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "StoreRefundLine" ADD CONSTRAINT "StoreRefundLine_values_check" CHECK ("quantityBase" > 0 AND "receivedBase" >= 0 AND "receivedBase" <= "quantityBase");
ALTER TABLE "PaymentException" ADD CONSTRAINT "PaymentException_amount_check" CHECK ("amountMinor" > 0);

-- ---- a finished order never comes back to life: COMPLETED and CANCELLED are final; EXPIRED can only be re-instated to CONFIRMED
CREATE OR REPLACE FUNCTION tradepal_store_order_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- EXPIRED may be re-instated to CONFIRMED (the resolution of a late payment). CANCELLED and COMPLETED are final.
  IF OLD."status" = 'EXPIRED' AND NEW."status" = 'CONFIRMED' THEN RETURN NEW; END IF;
  IF OLD."status" IN ('CANCELLED', 'EXPIRED', 'COMPLETED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'TradePal: store order % is % and cannot change status', OLD."id", OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "StoreOrder_terminal" BEFORE UPDATE OF "status" ON "StoreOrder" FOR EACH ROW EXECUTE FUNCTION tradepal_store_order_terminal();

-- ---- history is append-only / records cannot be deleted
CREATE TRIGGER "SupportCaseNote_append_only" BEFORE UPDATE OR DELETE ON "SupportCaseNote" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "Storefront_no_delete"        BEFORE DELETE ON "Storefront"        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "DeliveryZone_no_delete"      BEFORE DELETE ON "DeliveryZone"      FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StoreOrder_no_delete"        BEFORE DELETE ON "StoreOrder"        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StoreOrderLine_no_delete"    BEFORE DELETE ON "StoreOrderLine"    FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StorePayment_no_delete"      BEFORE DELETE ON "StorePayment"      FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StoreCancellationRequest_no_delete" BEFORE DELETE ON "StoreCancellationRequest" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StoreRefundRequest_no_delete" BEFORE DELETE ON "StoreRefundRequest" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "StoreRefundLine_no_delete"   BEFORE DELETE ON "StoreRefundLine"   FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PaymentException_no_delete"  BEFORE DELETE ON "PaymentException"  FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "SupportCase_no_delete"       BEFORE DELETE ON "SupportCase"       FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'SupportCaseNote','Storefront','DeliveryZone','StoreOrder','StoreOrderLine','StorePayment','StoreCancellationRequest',
    'StoreRefundRequest','StoreRefundLine','PaymentException','SupportCase'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- ---- tenant row-level security on seller-owned tables. Basket and BasketLine are deliberately NOT tenant data (shopper-owned, token-only).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Storefront','DeliveryZone','Listing','StoreOrder','StoreOrderLine','StorePayment','StoreCancellationRequest','StoreRefundRequest',
    'StoreRefundLine','PaymentException','SupportCase','SupportCaseNote'
  ] LOOP
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
  ('storefront', 'A public mobile-friendly storefront for the merchant, with basket, checkout, pickup or delivery, and order tracking.', false),
  ('storefrontOnlinePayment', 'Online payment at checkout. Only a simulator exists today (never available in production); live checkout stays unavailable until a merchant-settling provider is approved.', false)
ON CONFLICT ("key") DO NOTHING;
