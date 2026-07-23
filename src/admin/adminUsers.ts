import type { AdminRole, AdminUser, PrismaClient } from "@prisma/client";
import { hashAdminPassword } from "./auth.js";

export interface CreateAdminUserInput {
  email: string;
  name: string;
  role: AdminRole;
  password: string;
}

/**
 * AdminUser is deliberately never tenant-scoped (schema docstring) and there
 * is no self-serve admin signup — accounts are provisioned out-of-band
 * (ops script / seed), which is why this takes a plain `PrismaClient`
 * rather than a `TenantScopedClient`.
 */
export async function createAdminUser(prisma: PrismaClient, input: CreateAdminUserInput): Promise<AdminUser> {
  const passwordHash = await hashAdminPassword(input.password);
  return prisma.adminUser.create({
    data: { email: input.email, name: input.name, role: input.role, passwordHash },
  });
}

export async function findAdminUserByEmail(prisma: PrismaClient, email: string): Promise<AdminUser | null> {
  return prisma.adminUser.findUnique({ where: { email } });
}
