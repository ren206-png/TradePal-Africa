-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductImage_productId_removedAt_idx" ON "ProductImage"("productId", "removedAt");

-- CreateIndex
CREATE INDEX "ProductImage_businessId_idx" ON "ProductImage"("businessId");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Product photos - hand-written part.
-- ============================================================================================
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_values_check" CHECK (
  "contentType" IN ('image/jpeg', 'image/png', 'image/webp')
  AND "position" BETWEEN 0 AND 9
  AND "width" BETWEEN 1 AND 4000 AND "height" BETWEEN 1 AND 4000
  AND "bytes" BETWEEN 1 AND 1048576
  AND "sha256" ~ '^[0-9a-f]{64}$'
  -- a live photo holds exactly the bytes it says; a removed one has had its bytes emptied
  AND ("removedAt" IS NOT NULL OR octet_length("data") = "bytes"));

-- the same picture is stored once per product
CREATE UNIQUE INDEX "ProductImage_one_per_hash" ON "ProductImage" ("productId", "sha256") WHERE "removedAt" IS NULL;

CREATE OR REPLACE FUNCTION tradepal_product_image_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."businessId" <> OLD."businessId" OR NEW."productId" <> OLD."productId" OR NEW."sha256" <> OLD."sha256" OR NEW."contentType" <> OLD."contentType" THEN
    RAISE EXCEPTION 'A product photo cannot be moved or changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."removedAt" IS NOT NULL AND (NEW."removedAt" IS DISTINCT FROM OLD."removedAt" OR NEW."data" <> OLD."data") THEN
    RAISE EXCEPTION 'A removed product photo is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."removedAt" IS NULL AND NEW."removedAt" IS NULL AND NEW."data" <> OLD."data" THEN
    RAISE EXCEPTION 'The bytes of a product photo cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ProductImage_guard" BEFORE UPDATE ON "ProductImage" FOR EACH ROW EXECUTE FUNCTION tradepal_product_image_guard();
CREATE TRIGGER "ProductImage_no_delete" BEFORE DELETE ON "ProductImage" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "ProductImage_no_truncate" BEFORE TRUNCATE ON "ProductImage" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();

ALTER TABLE "ProductImage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProductImage" USING ("businessId" = current_setting('app.current_business_id', true)) WITH CHECK ("businessId" = current_setting('app.current_business_id', true));
