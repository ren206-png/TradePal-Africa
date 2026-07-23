import "dotenv/config";
import type { AdminRole } from "@prisma/client";
import { prisma } from "../src/db/client.js";
import { createAdminUser, findAdminUserByEmail } from "../src/admin/adminUsers.js";

/**
 * One-off provisioning CLI for the first (or any subsequent) AdminUser.
 * There is deliberately no self-serve admin signup endpoint (AdminUser is
 * internal TradePal staff, never tenant-scoped) — this script is the only
 * way to create one, run manually against the target environment:
 *
 *   npx tsx scripts/createAdminUser.ts <email> <name> <role> <password>
 *   npx tsx scripts/createAdminUser.ts ops@tradepal.africa "Ops Lead" SUPER_ADMIN 'a-strong-password'
 *
 * <role> must be one of SUPER_ADMIN | ANALYST | SUPPORT.
 */
const VALID_ROLES: readonly AdminRole[] = ["SUPER_ADMIN", "ANALYST", "SUPPORT"];

async function main(): Promise<void> {
  const [email, name, role, password] = process.argv.slice(2);

  if (!email || !name || !role || !password) {
    console.error("Usage: npx tsx scripts/createAdminUser.ts <email> <name> <role> <password>");
    console.error(`<role> must be one of: ${VALID_ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (!VALID_ROLES.includes(role as AdminRole)) {
    console.error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const existing = await findAdminUserByEmail(prisma, email);
  if (existing) {
    console.error(`An AdminUser with email ${email} already exists (id: ${existing.id}).`);
    process.exitCode = 1;
    return;
  }

  const admin = await createAdminUser(prisma, { email, name, role: role as AdminRole, password });
  console.log(`Created AdminUser ${admin.id} (${admin.email}, ${admin.role}).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
