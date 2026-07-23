import { PrismaClient } from "@prisma/client";

/**
 * The unscoped client. Reserved for: the webhook handler resolving which
 * business a message belongs to, the admin dashboard (AdminUser is never
 * tenant-scoped), and background jobs that operate across businesses (e.g.
 * subscription billing sweeps). Application code that acts on behalf of a
 * specific business must go through `getTenantScopedClient` instead.
 */
export const prisma = new PrismaClient();
