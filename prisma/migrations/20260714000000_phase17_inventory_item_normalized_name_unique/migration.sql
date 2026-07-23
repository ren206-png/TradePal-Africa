-- Phase 17: close the InventoryItem same-name collision race.
--
-- `InventoryItem.name` was never `@unique` (unlike Merchant.phoneNumber), so
-- `findOrCreateInventoryItem`'s prior check-then-create had no DB backstop:
-- two concurrent writers naming the same brand-new item for the first time
-- could both miss the SELECT and both proceed to INSERT, producing two rows
-- for what should be one item. Postgres has no case-insensitive unique
-- constraint without `citext`/an expression index, so we add a plain
-- application-maintained `normalizedName` column (lower(trim(name))) and
-- put the unique constraint on that instead.

-- AlterTable: add the column nullable first so existing rows can be backfilled.
ALTER TABLE "InventoryItem" ADD COLUMN "normalizedName" TEXT;

-- Backfill existing rows from their current `name`.
UPDATE "InventoryItem" SET "normalizedName" = lower(trim("name"));

-- If any business already has two rows that collide once normalized (e.g.
-- "Bread" and "bread"), this constraint will fail to create — that is a
-- pre-existing data-quality issue this migration surfaces rather than
-- silently papering over; see PHASE_0_FINDINGS.md's Phase 17 section for the
-- disclosed manual-cleanup step required in that case before deploying.
ALTER TABLE "InventoryItem" ALTER COLUMN "normalizedName" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_businessId_normalizedName_key" ON "InventoryItem"("businessId", "normalizedName");
