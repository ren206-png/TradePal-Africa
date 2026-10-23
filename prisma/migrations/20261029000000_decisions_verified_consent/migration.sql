-- AlterTable: shopper order-update consent is verified by the shopper messaging TradePal from the number (double opt-in without an extra template).
ALTER TABLE "ContactConsent" ADD COLUMN "verifiedAt" TIMESTAMPTZ,
ADD COLUMN "verifyCodeHash" TEXT;

-- Consent recorded before this migration was never verified, so it is NOT treated as verified (nothing was ever sent on it).
