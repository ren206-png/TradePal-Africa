-- CreateTable
CREATE TABLE "SupportAccess" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "SupportAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemHeartbeat" (
    "service" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ NOT NULL,
    "meta" JSONB,

    CONSTRAINT "SystemHeartbeat_pkey" PRIMARY KEY ("service")
);

-- CreateIndex
CREATE INDEX "SupportAccess_adminUserId_businessId_expiresAt_idx" ON "SupportAccess"("adminUserId", "businessId", "expiresAt");

-- CreateIndex
CREATE INDEX "SupportAccess_businessId_openedAt_idx" ON "SupportAccess"("businessId", "openedAt");

-- AddForeignKey
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Phase 1: admin console core - hand-written part.
-- ============================================================================================

-- Support-access records are audit evidence: never edited, never deleted (except with a synthetic business).
CREATE TRIGGER "SupportAccess_append_only" BEFORE UPDATE OR DELETE ON "SupportAccess" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "SupportAccess_no_truncate" BEFORE TRUNCATE ON "SupportAccess" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();

-- Default-OFF flags for the two admin-hardening controls (so they appear in the admin Feature flags page).
INSERT INTO "FeatureFlag" ("key", "description", "enabledByDefault")
VALUES
  ('adminStepUp', 'Require a fresh password confirmation (step-up) for sensitive platform-admin actions.', false),
  ('adminSupportAccessRequired', 'Require a recorded, time-boxed reason (support access) before a platform admin can open a merchant''s financial data.', false)
ON CONFLICT ("key") DO NOTHING;
