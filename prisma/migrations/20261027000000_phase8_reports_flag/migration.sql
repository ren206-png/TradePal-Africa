-- Phase 8: the per-business flag for the bookkeeping reports. Data only (no schema change); OFF by default.

-- ============================================================================================
INSERT INTO "FeatureFlag" ("key", "description", "enabledByDefault")
VALUES ('reportsV2', 'Bookkeeping reports on WhatsApp (/report) and as downloads: sales, cash flow, inventory valuation, money owed to you and by you, gross margin with completeness warnings, payment reconciliation, stock discrepancies. Also relabels the "Net" line in /today and the weekly digest as sales minus expenses, not profit.', false)
ON CONFLICT ("key") DO NOTHING;
