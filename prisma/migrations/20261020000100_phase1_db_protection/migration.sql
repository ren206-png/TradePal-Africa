-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "isSynthetic" BOOLEAN NOT NULL DEFAULT false;


-- ============================================================================================
-- Phase 1: database-level protection (expansion decisions P3, G13; docs/expansion/db-protection.md)
--
-- Until now "append-only ledger" and "tenant isolation" lived only in the Prisma client extension
-- (src/db/tenantScope.ts); any code holding the raw client, or plain SQL, bypassed them. These objects
-- enforce the same rules inside Postgres:
--   1. Append-only / delete-protected financial tables (triggers).
--   2. Hard delete only for synthetic businesses ("isSynthetic", immutable) or one with no financial trail.
--   3. Row-level-security policies for per-tenant isolation (inert for the table owner; activated per
--      request by src/db/tenantContext.ts running under the non-owner role "tradepal_tenant").
-- Break-glass for a genuine one-off repair: see the runbook (a DBA disables a trigger inside a logged transaction).
-- ============================================================================================

-- True when the business exists and is flagged synthetic.
CREATE OR REPLACE FUNCTION tradepal_is_synthetic(biz text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT "isSynthetic" FROM "Business" WHERE id = biz), false)
$$;

-- Append-only: UPDATE is never allowed; DELETE only for a synthetic business's rows.
CREATE OR REPLACE FUNCTION tradepal_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tradepal_is_synthetic(to_jsonb(OLD) ->> 'businessId') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'TradePal: % on "%" is not permitted: this table is append-only. Post a reversal or adjustment instead.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

-- Same rule, except one backfill-style UPDATE is allowed: linking a line item to an inventory item once
-- (inventoryItemId NULL -> value, every other column unchanged). Used by the retroactive stock backfill.
CREATE OR REPLACE FUNCTION tradepal_transaction_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."inventoryItemId" IS NULL
     AND (to_jsonb(NEW) - 'inventoryItemId') = (to_jsonb(OLD) - 'inventoryItemId') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND tradepal_is_synthetic(OLD."businessId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'TradePal: % on "TransactionItem" is not permitted: line items are append-only (only a one-time inventory link is allowed).', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

-- Delete-protected (status columns legitimately change, rows must never vanish): DELETE only for synthetic businesses.
CREATE OR REPLACE FUNCTION tradepal_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tradepal_is_synthetic(to_jsonb(OLD) ->> 'businessId') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'TradePal: DELETE on "%" is not permitted: financial records are never hard-deleted. Reverse, cancel or anonymize instead.', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

-- Invoice has no businessId; resolve it through its Subscription.
CREATE OR REPLACE FUNCTION tradepal_invoice_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tradepal_is_synthetic((SELECT "businessId" FROM "Subscription" WHERE id = OLD."subscriptionId")) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'TradePal: DELETE on "Invoice" is not permitted: financial records are never hard-deleted.'
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

-- A business may be hard-deleted only if it is synthetic OR has no financial trail at all (abandoned onboarding:
-- no transaction, debt, subscription or payment request, e.g. the welcome-message rollback in messageDispatcher).
-- The synthetic flag is set at creation and can never be changed afterwards.
CREATE OR REPLACE FUNCTION tradepal_business_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isSynthetic" THEN RETURN OLD; END IF;
    IF NOT EXISTS (SELECT 1 FROM "Transaction"    WHERE "businessId" = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM "Debt"           WHERE "businessId" = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM "Subscription"   WHERE "businessId" = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM "PaymentRequest" WHERE "businessId" = OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'TradePal: a business with a financial trail is never hard-deleted. Suspend it, or anonymize its personal data.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."isSynthetic" IS DISTINCT FROM OLD."isSynthetic" THEN
    RAISE EXCEPTION 'TradePal: Business.isSynthetic is set at creation and cannot be changed.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Transaction_append_only"      BEFORE UPDATE OR DELETE ON "Transaction"       FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "InventoryMovement_append_only" BEFORE UPDATE OR DELETE ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "AuditLog_append_only"         BEFORE UPDATE OR DELETE ON "AuditLog"          FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "ConsentLog_append_only"       BEFORE UPDATE OR DELETE ON "ConsentLog"        FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "DebtPayment_append_only"      BEFORE UPDATE OR DELETE ON "DebtPayment"       FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "AiUsageLedger_append_only"    BEFORE UPDATE OR DELETE ON "AiUsageLedger"     FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "TransactionItem_guard"        BEFORE UPDATE OR DELETE ON "TransactionItem"   FOR EACH ROW EXECUTE FUNCTION tradepal_transaction_item_guard();
CREATE TRIGGER "Debt_no_delete"               BEFORE DELETE ON "Debt"                        FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "Subscription_no_delete"       BEFORE DELETE ON "Subscription"               FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PaymentRequest_no_delete"     BEFORE DELETE ON "PaymentRequest"              FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "PawaPayDeposit_no_delete"     BEFORE DELETE ON "PawaPayDeposit"              FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "Invoice_no_delete"            BEFORE DELETE ON "Invoice"                     FOR EACH ROW EXECUTE FUNCTION tradepal_invoice_no_delete();
CREATE TRIGGER "Business_guard"               BEFORE UPDATE OR DELETE ON "Business"          FOR EACH ROW EXECUTE FUNCTION tradepal_business_guard();

-- TRUNCATE bypasses row-level triggers, so every protected table also gets a statement-level guard.
CREATE OR REPLACE FUNCTION tradepal_reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TradePal: TRUNCATE on "%" is not permitted: financial records are never bulk-erased.', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Transaction','TransactionItem','InventoryMovement','AuditLog','ConsentLog','DebtPayment','AiUsageLedger',
    'Debt','Subscription','Invoice','PaymentRequest','PawaPayDeposit','Business'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- Per-tenant row-level security on every table that carries a businessId (the same set as TENANT_SCOPED_MODELS
-- in src/db/tenantScope.ts; tests/dbProtection.test.ts keeps the two lists in sync). The policy compares the
-- row's businessId to the transaction-local setting app.current_business_id. The table owner bypasses RLS, so
-- this is inert until a request runs under the non-owner role (see src/db/tenantContext.ts).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Merchant','User','Transaction','TransactionItem','Customer','Supplier','Debt','DebtPayment',
    'InventoryItem','InventoryMovement','Reminder','WhatsAppMessage','MobileMoneyAlert','AiParseLog',
    'Subscription','AuditLog','ConsentLog','DeletionRequest','BusinessFeatureFlag','PaymentRequest',
    'PawaPayDeposit','AiUsageLedger'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("businessId" = current_setting(''app.current_business_id'', true)) WITH CHECK ("businessId" = current_setting(''app.current_business_id'', true))',
      t);
  END LOOP;
END
$$;
