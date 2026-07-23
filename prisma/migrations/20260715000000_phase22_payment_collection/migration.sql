-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "providerCode" TEXT,
ADD COLUMN     "providerReference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_providerReference_key" ON "Invoice"("providerReference");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "PaymentProvider"("code") ON DELETE SET NULL ON UPDATE CASCADE;

