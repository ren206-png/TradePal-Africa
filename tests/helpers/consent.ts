import type { PrismaClient } from "@prisma/client";
import { digitsOnly, recordOrderUpdatesConsent } from "../../src/messaging/consent.js";

/** An order-updates consent that is also VERIFIED (the shopper has messaged TradePal from the number): the only kind that may be sent to. */
export async function recordVerifiedConsent(prisma: PrismaClient, input: Parameters<typeof recordOrderUpdatesConsent>[1]): Promise<void> {
  await recordOrderUpdatesConsent(prisma, input);
  await prisma.contactConsent.updateMany({ where: { businessId: input.businessId, phone: digitsOnly(input.phone) }, data: { verifiedAt: new Date() } });
}
