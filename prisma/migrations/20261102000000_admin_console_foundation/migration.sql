-- CreateEnum
CREATE TYPE "OwnershipTransferStatus" AS ENUM ('INITIATED', 'ACCEPTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminRole" ADD VALUE 'FINANCE_ADMIN';
ALTER TYPE "AdminRole" ADD VALUE 'MODERATOR';

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "lastSignInAt" TIMESTAMPTZ,
ADD COLUMN     "mfaRequiredAt" TIMESTAMPTZ,
ADD COLUMN     "roleVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "ipHash" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "result" TEXT NOT NULL DEFAULT 'SUCCESS';

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absoluteExpiresAt" TIMESTAMPTZ NOT NULL,
    "mfaVerifiedAt" TIMESTAMPTZ,
    "reauthAt" TIMESTAMPTZ,
    "revokedAt" TIMESTAMPTZ,
    "revokedReason" TEXT,
    "ipHash" TEXT,
    "userAgentHash" TEXT,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminMfaFactor" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'TOTP-SHA1',
    "digits" INTEGER NOT NULL DEFAULT 6,
    "periodSeconds" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ,
    "lastUsedCounter" BIGINT,
    "disabledAt" TIMESTAMPTZ,

    CONSTRAINT "AdminMfaFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ,

    CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "acceptedAt" TIMESTAMPTZ,
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnershipTransfer" (
    "id" TEXT NOT NULL,
    "fromAdminId" TEXT NOT NULL,
    "toAdminId" TEXT NOT NULL,
    "status" "OwnershipTransferStatus" NOT NULL DEFAULT 'INITIATED',
    "initiatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "decidedAt" TIMESTAMPTZ,

    CONSTRAINT "OwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffRoleChange" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "fromRole" "AdminRole",
    "toRole" "AdminRole" NOT NULL,
    "changedById" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffRoleChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT,
    "subjectHash" TEXT,
    "eventType" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "correlationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "subjectBusinessId" TEXT,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "rejectedById" TEXT,
    "decidedAt" TIMESTAMPTZ,
    "executedAt" TIMESTAMPTZ,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "revokedAt" TIMESTAMPTZ,
    "revokedById" TEXT,
    "approvalRequestId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_revokedAt_idx" ON "AdminSession"("adminUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "AdminSession_absoluteExpiresAt_idx" ON "AdminSession"("absoluteExpiresAt");

-- CreateIndex
CREATE INDEX "AdminMfaFactor_adminUserId_idx" ON "AdminMfaFactor"("adminUserId");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_adminUserId_usedAt_idx" ON "AdminRecoveryCode"("adminUserId", "usedAt");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_batchId_idx" ON "AdminRecoveryCode"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffInvitation_tokenHash_key" ON "StaffInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "StaffInvitation_email_idx" ON "StaffInvitation"("email");

-- CreateIndex
CREATE INDEX "StaffInvitation_expiresAt_idx" ON "StaffInvitation"("expiresAt");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_fromAdminId_status_idx" ON "OwnershipTransfer"("fromAdminId", "status");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_toAdminId_status_idx" ON "OwnershipTransfer"("toAdminId", "status");

-- CreateIndex
CREATE INDEX "StaffRoleChange_adminUserId_createdAt_idx" ON "StaffRoleChange"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_adminUserId_createdAt_idx" ON "SecurityEvent"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_subjectHash_createdAt_idx" ON "SecurityEvent"("subjectHash", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_eventType_createdAt_idx" ON "SecurityEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_correlationId_idx" ON "SecurityEvent"("correlationId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_expiresAt_idx" ON "ApprovalRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_actionType_status_idx" ON "ApprovalRequest"("actionType", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_requestedById_createdAt_idx" ON "ApprovalRequest"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_subjectBusinessId_createdAt_idx" ON "ApprovalRequest"("subjectBusinessId", "createdAt");

-- CreateIndex
CREATE INDEX "EntitlementGrant_businessId_expiresAt_idx" ON "EntitlementGrant"("businessId", "expiresAt");

-- CreateIndex
CREATE INDEX "EntitlementGrant_expiresAt_idx" ON "EntitlementGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");

-- CreateIndex
CREATE INDEX "AuditLog_actorType_actorId_createdAt_idx" ON "AuditLog"("actorType", "actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminMfaFactor" ADD CONSTRAINT "AdminMfaFactor_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementGrant" ADD CONSTRAINT "EntitlementGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================
-- Admin-console foundation - hand-written part. Additive only: no existing table, column or row is changed or removed
-- (new nullable/defaulted columns, new tables, new triggers). NOTE for the runbook: the two new AdminRole values above are added
-- in this same migration, so nothing below may refer to them (PostgreSQL cannot use a new enum value in the transaction that adds it).
-- ============================================================================================

-- ---- AuditLog: the new columns are checked without a long lock (NOT VALID, then VALIDATE) ----
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_result_check" CHECK ("result" IN ('SUCCESS', 'FAILURE', 'DENIED')) NOT VALID;
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_result_check";

-- ---- AdminUser: the role version moves with the role, and the last active owner can never be removed ----
CREATE OR REPLACE FUNCTION tradepal_admin_user_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."role" IS DISTINCT FROM OLD."role" THEN
    NEW."roleVersion" := OLD."roleVersion" + 1;
  END IF;
  IF OLD."role" = 'SUPER_ADMIN' AND OLD."disabledAt" IS NULL
     AND (TG_OP = 'DELETE' OR NEW."role" <> 'SUPER_ADMIN' OR NEW."disabledAt" IS NOT NULL) THEN
    -- One owner-reducing change at a time, so two owners demoting each other at the same instant cannot both succeed:
    -- the second waits here, then sees the first one's committed result.
    PERFORM pg_advisory_xact_lock(hashtext('tradepal:last-owner'));
    IF NOT EXISTS (SELECT 1 FROM "AdminUser" WHERE "role" = 'SUPER_ADMIN' AND "disabledAt" IS NULL AND "id" <> OLD."id") THEN
      RAISE EXCEPTION 'TradePal: the last active platform owner cannot be deleted, disabled or demoted. Promote another owner first.'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "AdminUser_guard" BEFORE UPDATE OR DELETE ON "AdminUser" FOR EACH ROW EXECUTE FUNCTION tradepal_admin_user_guard();

-- ---- AdminSession: server-side sessions are for the admin audience only and live for a positive time ----
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_values_check" CHECK (
  "audience" = 'admin'
  AND "absoluteExpiresAt" > "createdAt"
  AND ("revokedAt" IS NULL OR "revokedReason" IS NOT NULL));

-- ---- Second factor: sane TOTP parameters; at most one live factor per admin ----
ALTER TABLE "AdminMfaFactor" ADD CONSTRAINT "AdminMfaFactor_values_check" CHECK (
  "algorithm" IN ('TOTP-SHA1', 'TOTP-SHA256', 'TOTP-SHA512')
  AND "digits" IN (6, 8)
  AND "periodSeconds" BETWEEN 15 AND 120
  AND length("secretCiphertext") > 0);
CREATE UNIQUE INDEX "AdminMfaFactor_one_live_per_admin" ON "AdminMfaFactor" ("adminUserId") WHERE "disabledAt" IS NULL;

ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_hash_check" CHECK (length("codeHash") >= 20);

-- ---- Invitations: email-bound (lower case), expiring, single use; one live invitation per email ----
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_values_check" CHECK (
  "email" = lower("email")
  AND "email" ~ '^[^@\s]+@[^@\s]+$'
  AND "expiresAt" > "createdAt"
  AND length("tokenHash") >= 32
  AND NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  AND ("acceptedAt" IS NULL OR "acceptedById" IS NOT NULL));
CREATE UNIQUE INDEX "StaffInvitation_one_live_per_email" ON "StaffInvitation" ("email") WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- ---- Ownership transfer: two different people, one open transfer per owner, and a decided transfer is final ----
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_values_check" CHECK (
  "fromAdminId" <> "toAdminId"
  AND "expiresAt" > "initiatedAt"
  AND ("status" = 'INITIATED' OR "decidedAt" IS NOT NULL));
CREATE UNIQUE INDEX "OwnershipTransfer_one_initiated_per_owner" ON "OwnershipTransfer" ("fromAdminId") WHERE "status" = 'INITIATED';

CREATE OR REPLACE FUNCTION tradepal_ownership_transfer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TradePal: an ownership transfer is never deleted.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'INITIATED' THEN
    RAISE EXCEPTION 'TradePal: a decided ownership transfer cannot change.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."fromAdminId" <> OLD."fromAdminId" OR NEW."toAdminId" <> OLD."toAdminId" OR NEW."initiatedAt" <> OLD."initiatedAt" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'TradePal: who is handing over to whom, and when, cannot be edited.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "OwnershipTransfer_guard" BEFORE UPDATE OR DELETE ON "OwnershipTransfer" FOR EACH ROW EXECUTE FUNCTION tradepal_ownership_transfer_guard();

-- ---- Role history and security events: append-only (the audit tables' trigger, truncate rejected too) ----
ALTER TABLE "StaffRoleChange" ADD CONSTRAINT "StaffRoleChange_values_check" CHECK (
  length("reason") >= 3 AND ("fromRole" IS NULL OR "fromRole" <> "toRole"));
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_values_check" CHECK (
  "result" IN ('SUCCESS', 'FAILURE', 'DENIED')
  AND "eventType" ~ '^[A-Z][A-Z0-9_]{2,59}$');

CREATE TRIGGER "StaffRoleChange_append_only" BEFORE UPDATE OR DELETE ON "StaffRoleChange" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "SecurityEvent_append_only" BEFORE UPDATE OR DELETE ON "SecurityEvent" FOR EACH ROW EXECUTE FUNCTION tradepal_append_only();
CREATE TRIGGER "StaffRoleChange_no_truncate" BEFORE TRUNCATE ON "StaffRoleChange" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();
CREATE TRIGGER "SecurityEvent_no_truncate" BEFORE TRUNCATE ON "SecurityEvent" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();

-- ---- Two-person approval: the request is frozen; the requester can never decide it; states only move forward ----
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_values_check" CHECK (
  "payloadHash" ~ '^[0-9a-f]{64}$'
  AND length("reason") >= 10
  AND "expiresAt" > "createdAt"
  AND ("approvedById" IS NULL OR "approvedById" <> "requestedById")
  AND ("rejectedById" IS NULL OR "rejectedById" <> "requestedById")
  AND ("status" = 'PENDING' OR "status" = 'CANCELLED' OR "status" = 'EXPIRED' OR "decidedAt" IS NOT NULL)
  AND ("status" NOT IN ('APPROVED', 'EXECUTED') OR "approvedById" IS NOT NULL)
  AND ("status" <> 'REJECTED' OR "rejectedById" IS NOT NULL)
  AND ("status" <> 'EXECUTED' OR "executedAt" IS NOT NULL)
  AND NOT ("approvedById" IS NOT NULL AND "rejectedById" IS NOT NULL));

CREATE OR REPLACE FUNCTION tradepal_approval_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TradePal: an approval request is never deleted. Cancel it instead.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."actionType" <> OLD."actionType" OR NEW."targetType" <> OLD."targetType" OR NEW."targetId" <> OLD."targetId"
     OR NEW."subjectBusinessId" IS DISTINCT FROM OLD."subjectBusinessId" OR NEW."reason" <> OLD."reason"
     OR NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."payloadHash" <> OLD."payloadHash"
     OR NEW."requestedById" <> OLD."requestedById" OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'TradePal: an approval request is frozen once made. Cancel it and make a new one.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PENDING'  AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('EXECUTED', 'CANCELLED', 'EXPIRED'))) THEN
    RAISE EXCEPTION 'TradePal: an approval request cannot move from % to %.', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" IN ('REJECTED', 'EXECUTED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'TradePal: a % approval request is final.', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- who decided cannot be rewritten once set
  IF OLD."approvedById" IS NOT NULL AND NEW."approvedById" IS DISTINCT FROM OLD."approvedById" THEN
    RAISE EXCEPTION 'TradePal: the approver cannot be changed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ApprovalRequest_guard" BEFORE UPDATE OR DELETE ON "ApprovalRequest" FOR EACH ROW EXECUTE FUNCTION tradepal_approval_guard();
CREATE TRIGGER "ApprovalRequest_no_truncate" BEFORE TRUNCATE ON "ApprovalRequest" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();

-- ---- Complimentary access: a stated reason, an end date, and only revocation may change a grant ----
ALTER TABLE "EntitlementGrant" ADD CONSTRAINT "EntitlementGrant_values_check" CHECK (
  length("reason") >= 10
  AND "expiresAt" > "startsAt"
  AND ("revokedAt" IS NULL OR "revokedById" IS NOT NULL));

CREATE OR REPLACE FUNCTION tradepal_entitlement_grant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."businessId" <> OLD."businessId" OR NEW."planCode" <> OLD."planCode" OR NEW."reason" <> OLD."reason"
     OR NEW."grantedById" <> OLD."grantedById" OR NEW."startsAt" <> OLD."startsAt" OR NEW."expiresAt" <> OLD."expiresAt"
     OR NEW."approvalRequestId" IS DISTINCT FROM OLD."approvalRequestId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'TradePal: a complimentary grant cannot be edited. Revoke it and grant again.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TradePal: a revoked grant is final.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "EntitlementGrant_guard" BEFORE UPDATE ON "EntitlementGrant" FOR EACH ROW EXECUTE FUNCTION tradepal_entitlement_grant_guard();
CREATE TRIGGER "EntitlementGrant_no_delete" BEFORE DELETE ON "EntitlementGrant" FOR EACH ROW EXECUTE FUNCTION tradepal_no_delete();
CREATE TRIGGER "EntitlementGrant_no_truncate" BEFORE TRUNCATE ON "EntitlementGrant" FOR EACH STATEMENT EXECUTE FUNCTION tradepal_reject_truncate();

-- EntitlementGrant belongs to one business, so it joins the tenant row-level policy like its sibling EntitlementEvent.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "EntitlementGrant" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON "EntitlementGrant" USING ("businessId" = current_setting(''app.current_business_id'', true)) WITH CHECK ("businessId" = current_setting(''app.current_business_id'', true))';
END
$$;
