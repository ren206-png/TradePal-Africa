-- Phase 28: lower the FREE plan's monthly entry cap from 100 to 50.
-- Data-only migration, no schema change (mirrors the precedent set by
-- 20260714000000_phase17_inventory_item_normalized_name_unique's own
-- UPDATE-only backfill statement). Needed because prisma/seed.ts's
-- upsert only ever runs against a fresh/reset database -- an
-- already-deployed database's existing FREE Plan row would otherwise
-- keep enforcing the old 100/month cap forever.
UPDATE "Plan" SET "entryCapPerMonth" = 50 WHERE "code" = 'FREE';
