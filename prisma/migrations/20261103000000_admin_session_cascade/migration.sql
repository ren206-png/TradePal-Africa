-- A session is a temporary record of one sign-in: it goes away with the account it belongs to
-- (accounts are normally disabled, never deleted, so this only matters for a deliberate removal).
-- DropForeignKey
ALTER TABLE "AdminSession" DROP CONSTRAINT "AdminSession_adminUserId_fkey";

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
