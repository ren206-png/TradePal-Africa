import "dotenv/config";
import { prisma } from "../src/db/client.js";
import { BootstrapError, bootstrapOwner } from "../src/admin/ownerBootstrap.js";

/**
 * First-owner bootstrap (admin console). Promotes an EXISTING staff account to platform owner. Run it with deployment credentials, for example:
 *
 *   ADMIN_BOOTSTRAP_ALLOWED=true DATABASE_URL=<public database address> npx tsx scripts/bootstrapOwner.ts \
 *     --identity <staff-id-or-exact-email> --confirm <the same value again>
 *
 * It refuses unless ADMIN_BOOTSTRAP_ALLOWED=true, needs the identity repeated, changes nothing if the account is already an owner, never
 * chooses or prints a password or secret, and writes an audit row and a security event with actor system:bootstrap.
 * Set ADMIN_BOOTSTRAP_ALLOWED on the command line for this one run only (see docs/admin/setup.md).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const identity = arg("identity");
  const confirm = arg("confirm");
  if (!identity || !confirm) {
    console.error("Usage: ADMIN_BOOTSTRAP_ALLOWED=true npx tsx scripts/bootstrapOwner.ts --identity <id-or-email> --confirm <same>");
    process.exitCode = 2;
    return;
  }
  try {
    const out = await bootstrapOwner(prisma, { identity, confirm });
    console.log(out.status === "ALREADY_OWNER" ? `No change: ${out.email} is already a platform owner.` : `Done: ${out.email} is now a platform owner. They must set up their authenticator at next sign-in.`);
  } catch (error) {
    if (error instanceof BootstrapError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main().then(() => prisma.$disconnect()).catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
