import { PrismaClient } from "@prisma/client";
import { disableAdminUser } from "../src/admin/adminUsers.js";

/** Usage: DATABASE_URL=... npx tsx scripts/disableAdmin.ts someone@example.com. Takes effect on the admin's next request. Never deletes. */
const email = process.argv[2];
if (!email) {
  console.error("Usage: npx tsx scripts/disableAdmin.ts <email>");
  process.exit(2);
}
const prisma = new PrismaClient();
disableAdminUser(prisma, email)
  .then((changed) => console.log(changed ? `Disabled ${email}.` : `${email} was not found or is already disabled.`))
  .finally(() => prisma.$disconnect());
