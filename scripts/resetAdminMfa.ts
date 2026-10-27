import "dotenv/config";
import { prisma } from "../src/db/client.js";
import { BootstrapError, resetAdminMfaCommand } from "../src/admin/ownerBootstrap.js";

/**
 * Lockout recovery (admin console): removes one person's second factor and recovery codes, ends all their sessions, and makes them
 * enrol again at next sign-in. Use it only after verifying the person out of band. Same guards as bootstrapOwner.ts:
 *
 *   ADMIN_BOOTSTRAP_ALLOWED=true DATABASE_URL=<public database address> npx tsx scripts/resetAdminMfa.ts \
 *     --identity <staff-id-or-exact-email> --confirm <the same value again>
 *
 * Audited with actor system:bootstrap. Prints no secret. Set ADMIN_BOOTSTRAP_ALLOWED for this one run only.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const identity = arg("identity");
  const confirm = arg("confirm");
  if (!identity || !confirm) {
    console.error("Usage: ADMIN_BOOTSTRAP_ALLOWED=true npx tsx scripts/resetAdminMfa.ts --identity <id-or-email> --confirm <same>");
    process.exitCode = 2;
    return;
  }
  try {
    const out = await resetAdminMfaCommand(prisma, { identity, confirm });
    console.log(`Done: the second factor for ${out.email} was removed and ${out.sessionsEnded} session(s) ended. They must set up the authenticator again at next sign-in.`);
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
