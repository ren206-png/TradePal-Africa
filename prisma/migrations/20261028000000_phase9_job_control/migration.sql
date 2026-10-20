-- CreateTable
CREATE TABLE "JobControl" (
    "jobClass" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "changedBy" TEXT,
    "changedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobControl_pkey" PRIMARY KEY ("jobClass")
);

-- ============================================================================================
-- Phase 9: pausable background job classes - hand-written part.
-- ============================================================================================
CREATE TRIGGER "JobControl_no_delete" BEFORE DELETE ON "JobControl" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "JobControl_no_truncate" BEFORE TRUNCATE ON "JobControl" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();
