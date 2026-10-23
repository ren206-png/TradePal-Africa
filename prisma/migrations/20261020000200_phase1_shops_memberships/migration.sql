-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'MANAGER', 'SALES_CLERK', 'INVENTORY_OPERATOR', 'FINANCE_OPERATOR', 'RESTRICTED_SUPPORT');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterEnum
ALTER TYPE "AdminRole" ADD VALUE 'OPERATOR';

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveContext" (
    "phoneNumber" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shopId" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ActiveContext_pkey" PRIMARY KEY ("phoneNumber")
);

-- CreateIndex
CREATE INDEX "Shop_businessId_idx" ON "Shop"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_businessId_name_key" ON "Shop"("businessId", "name");

-- CreateIndex
CREATE INDEX "Membership_phoneNumber_idx" ON "Membership"("phoneNumber");

-- CreateIndex
CREATE INDEX "Membership_businessId_idx" ON "Membership"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_businessId_phoneNumber_key" ON "Membership"("businessId", "phoneNumber");

-- AddForeignKey
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================================
-- Phase 1: shops & memberships - constraints Prisma cannot express, tenant RLS, and a backfill.
-- (docs/expansion/decisions.md P4)
-- ============================================================================================

-- Exactly one default shop per business.
CREATE UNIQUE INDEX "Shop_one_default_per_business" ON "Shop"("businessId") WHERE "isDefault";

-- Tenant isolation for the two tenant-scoped tables (same policy as the rest; inert for the table owner).
ALTER TABLE "Shop" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Shop"
  USING ("businessId" = current_setting('app.current_business_id', true))
  WITH CHECK ("businessId" = current_setting('app.current_business_id', true));
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Membership"
  USING ("businessId" = current_setting('app.current_business_id', true))
  WITH CHECK ("businessId" = current_setting('app.current_business_id', true));

-- Backfill (idempotent): one default "Main shop" per business, and one membership per existing merchant.
-- Legacy mapping: OWNER -> OWNER, STAFF -> SALES_CLERK; a removed merchant becomes a REVOKED membership.
INSERT INTO "Shop" ("id", "businessId", "name", "isDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, b."id", 'Main shop', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "Business" b
 WHERE NOT EXISTS (SELECT 1 FROM "Shop" s WHERE s."businessId" = b."id");

INSERT INTO "Membership" ("id", "businessId", "shopId", "phoneNumber", "role", "status", "createdAt", "updatedAt", "revokedAt")
SELECT gen_random_uuid()::text,
       m."businessId",
       (SELECT s."id" FROM "Shop" s WHERE s."businessId" = m."businessId" AND s."isDefault"),
       m."phoneNumber",
       (CASE m."role" WHEN 'OWNER' THEN 'OWNER' ELSE 'SALES_CLERK' END)::"MembershipRole",
       (CASE WHEN m."removedAt" IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END)::"MembershipStatus",
       m."createdAt", CURRENT_TIMESTAMP, m."removedAt"
  FROM "Merchant" m
 WHERE NOT EXISTS (SELECT 1 FROM "Membership" x WHERE x."businessId" = m."businessId" AND x."phoneNumber" = m."phoneNumber");
