import type { Shop } from "@prisma/client";
import type { TenantScopedClient } from "../db/tenantScope.js";

/** The business's default shop, created on first use. Tenant-scoped counterpart of memberships.ensureDefaultShop. */
export async function ensureDefaultShopFor(scoped: TenantScopedClient, businessId: string): Promise<Shop> {
  const existing = await scoped.shop.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  try {
    return await scoped.shop.create({ data: { businessId, name: "Main shop", isDefault: true } });
  } catch (error) {
    // A concurrent caller created it first (unique index on the default shop): read theirs.
    const raced = await scoped.shop.findFirst({ where: { isDefault: true } });
    if (raced) return raced;
    throw error;
  }
}
