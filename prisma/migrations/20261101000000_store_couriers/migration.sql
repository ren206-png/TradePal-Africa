-- CreateEnum
CREATE TYPE "CourierJobStatus" AS ENUM ('BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED', 'RETURNED');

-- CreateTable
CREATE TABLE "DeliveryShipment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "externalId" TEXT,
    "trackingRef" TEXT,
    "trackingUrl" TEXT,
    "riderName" TEXT,
    "riderPhone" TEXT,
    "status" "CourierJobStatus" NOT NULL DEFAULT 'BOOKED',
    "feeMinor" BIGINT,
    "currencyCode" TEXT,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "lastEventAt" TIMESTAMPTZ,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "DeliveryShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryShipmentEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "CourierJobStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "externalEventId" TEXT,
    "detail" TEXT,
    "occurredAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryShipment_orderId_status_idx" ON "DeliveryShipment"("orderId", "status");

-- CreateIndex
CREATE INDEX "DeliveryShipment_businessId_status_idx" ON "DeliveryShipment"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryShipment_businessId_idempotencyKey_key" ON "DeliveryShipment"("businessId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryShipment_courier_externalId_key" ON "DeliveryShipment"("courier", "externalId");

-- CreateIndex
CREATE INDEX "DeliveryShipmentEvent_shipmentId_occurredAt_idx" ON "DeliveryShipmentEvent"("shipmentId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryShipmentEvent_shipmentId_externalEventId_key" ON "DeliveryShipmentEvent"("shipmentId", "externalEventId");

-- AddForeignKey
ALTER TABLE "DeliveryShipment" ADD CONSTRAINT "DeliveryShipment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryShipment" ADD CONSTRAINT "DeliveryShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryShipmentEvent" ADD CONSTRAINT "DeliveryShipmentEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryShipmentEvent" ADD CONSTRAINT "DeliveryShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "DeliveryShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Couriers - hand-written part.
-- ============================================================================================
ALTER TABLE "DeliveryShipment" ADD CONSTRAINT "DeliveryShipment_values_check" CHECK (
  "courier" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'
  AND ("feeMinor" IS NULL OR "feeMinor" >= 0)
  AND ("trackingUrl" IS NULL OR "trackingUrl" ~ '^https://')
  AND ("riderPhone" IS NULL OR "riderPhone" ~ '^[0-9]{8,15}$')
  -- a failed job says why
  AND ("status" <> 'FAILED' OR "failureReason" IS NOT NULL));

-- one live delivery job per order at a time (a failed or cancelled one can be replaced)
CREATE UNIQUE INDEX "DeliveryShipment_one_live_per_order" ON "DeliveryShipment" ("orderId") WHERE "status" IN ('BOOKED', 'PICKED_UP', 'IN_TRANSIT');

-- a finished job stays finished; a job only moves forward
CREATE OR REPLACE FUNCTION tradepal_shipment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."businessId" <> OLD."businessId" OR NEW."orderId" <> OLD."orderId" OR NEW."courier" <> OLD."courier" THEN
    RAISE EXCEPTION 'A delivery job cannot be moved to another order or courier' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF OLD."status" IN ('DELIVERED', 'FAILED', 'CANCELLED', 'RETURNED') THEN
      RAISE EXCEPTION 'A % delivery job is final and cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'IN_TRANSIT' AND NEW."status" IN ('BOOKED', 'PICKED_UP', 'CANCELLED') THEN
      RAISE EXCEPTION 'A delivery job on its way cannot go back to %', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'PICKED_UP' AND NEW."status" IN ('BOOKED', 'CANCELLED') THEN
      RAISE EXCEPTION 'A picked-up delivery job cannot go back to %', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "DeliveryShipment_guard" BEFORE UPDATE ON "DeliveryShipment" FOR EACH ROW EXECUTE FUNCTION tradepal_shipment_guard();

CREATE TRIGGER "DeliveryShipmentEvent_append_only" BEFORE UPDATE OR DELETE ON "DeliveryShipmentEvent" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "DeliveryShipment_no_delete" BEFORE DELETE ON "DeliveryShipment" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "DeliveryShipment_no_truncate" BEFORE TRUNCATE ON "DeliveryShipment" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();
CREATE TRIGGER "DeliveryShipmentEvent_no_truncate" BEFORE TRUNCATE ON "DeliveryShipmentEvent" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DeliveryShipment', 'DeliveryShipmentEvent'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("businessId" = current_setting(''app.current_business_id'', true)) WITH CHECK ("businessId" = current_setting(''app.current_business_id'', true))',
      t);
  END LOOP;
END
$$;

-- default-OFF flags
INSERT INTO "FeatureFlag" ("key", "description", "enabledByDefault")
VALUES ('storeCourier', 'Record and track a courier or rider for delivery orders: the seller books or logs the job, the order page shows the courier and its latest status, and a courier''s status callbacks update the job. Needs the platform switch COURIERS_ENABLED. The shopper''s hand-over code is still what completes an order.', false)
ON CONFLICT ("key") DO NOTHING;
