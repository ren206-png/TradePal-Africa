-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('PLATFORM_SUBSCRIPTION', 'MERCHANT_SALE');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL DEFAULT 'PLATFORM_SUBSCRIPTION';

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL DEFAULT 'MERCHANT_SALE';

