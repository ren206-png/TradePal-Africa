-- DeepSeek Integration Phase 3 (INTEGRATION_DESIGN.md §3): additive-only.
-- New two-phase, append-only cost ledger (AiUsageLedger) plus one new
-- nullable column on Plan. No destructive changes; no existing table is
-- altered except the additive Plan column below.

-- CreateEnum
CREATE TYPE "AIProviderId" AS ENUM ('ANTHROPIC', 'DEEPSEEK');
CREATE TYPE "AIUsagePhase" AS ENUM ('RESERVE', 'COMMIT', 'RELEASE');

-- CreateTable
CREATE TABLE "AiUsageLedger" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,       -- groups a RESERVE row with its terminal COMMIT/RELEASE row
    "phase" "AIUsagePhase" NOT NULL,
    "businessId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,         -- validated against the AIFeature TS union at the app layer, not a DB enum, so adding a feature tag needs no migration
    "provider" "AIProviderId" NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "resolvedModel" TEXT NOT NULL,
    "estimatedCostMicroUsd" BIGINT,  -- set on RESERVE rows only
    "actualCostMicroUsd" BIGINT,     -- set on COMMIT rows only
    "promptHash" TEXT NOT NULL,      -- sha256 hex of the prompt text; never the prompt itself (Constraint #5)
    "idempotencyKey" TEXT NOT NULL,  -- the same waMessageId already used for BullMQ-level dedupe (src/queue/inboundMessageQueue.ts:18) — no new concept, see Phase 0 §0.3
    "httpStatus" INTEGER,
    "errorClass" TEXT,               -- populated on RELEASE only: mirrors AIResult's own kind union
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "AiUsageLedger_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AiUsageLedger" ADD CONSTRAINT "AiUsageLedger_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "AiUsageLedger_businessId_createdAt_idx" ON "AiUsageLedger"("businessId", "createdAt");
CREATE INDEX "AiUsageLedger_requestId_idx" ON "AiUsageLedger"("requestId");
CREATE INDEX "AiUsageLedger_idempotencyKey_provider_idx" ON "AiUsageLedger"("idempotencyKey", "provider");

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN "aiDeepseekMonthlyBudgetMicroUsd" BIGINT;
-- NULL = uncapped, matching Plan.entryCapPerMonth's existing null-is-uncapped convention (prisma/schema.prisma, Phase 0 §0.4).
