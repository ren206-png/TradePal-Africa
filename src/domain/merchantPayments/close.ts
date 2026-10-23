import type { PaymentSubjectType } from "@prisma/client";
import type { TenantScopedClient } from "../../db/tenantScope.js";

/**
 * Closes every open payment intent for a subject (the order expired or was cancelled, or it was completed another way). Kept in its
 * own import-free module so the order lifecycle can call it without pulling in the payment layer (which itself depends on orders).
 * Once closed, a payment that still arrives for that subject is HELD as an exception, never applied silently.
 */
export async function closeIntentsForSubject(scoped: TenantScopedClient, subjectType: PaymentSubjectType, subjectId: string, status: "EXPIRED" | "CANCELLED"): Promise<number> {
  return (await scoped.paymentIntent.updateMany({ where: { subjectType, subjectId, status: "OPEN" }, data: { status } })).count;
}
