-- PawaPay mobile-money collection: one PawaPayDeposit per PaymentRequest, keyed by the
-- PawaPay depositId. The payer's phone number is deliberately NOT stored (Standard #9) — only
-- its last 4 digits.
-- CreateTable
CREATE TABLE "PawaPayDeposit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "payerPhoneLast4" TEXT NOT NULL,
    "providerTransactionId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PawaPayDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PawaPayDeposit_paymentRequestId_key" ON "PawaPayDeposit"("paymentRequestId");

-- CreateIndex
CREATE INDEX "PawaPayDeposit_businessId_idx" ON "PawaPayDeposit"("businessId");

-- CreateIndex
CREATE INDEX "PawaPayDeposit_status_createdAt_idx" ON "PawaPayDeposit"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PawaPayDeposit" ADD CONSTRAINT "PawaPayDeposit_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- PaymentRequest.providerCode has a foreign key to PaymentProvider, so the PAWAPAY provider row
-- must exist before the first /collect. countryCode is informational only (PawaPay serves several
-- countries; the supported set lives in src/pawapay/countries.ts). Idempotent.
INSERT INTO "PaymentProvider" ("code", "countryCode", "config", "enabled")
VALUES ('PAWAPAY', 'SL', '{"countries":["SL","LR","GM"]}', true)
ON CONFLICT ("code") DO NOTHING;
