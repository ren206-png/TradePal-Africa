import type { PrismaClient } from "@prisma/client";

/**
 * Background job classes an operator may pause during an incident (Phase 9). A paused class skips its SCHEDULED runs; an admin's manual
 * trigger still works. Inbound WhatsApp processing and payment callbacks are deliberately NOT pausable: stopping them loses money or
 * messages, and the inbox/outbox keep retrying anyway.
 */
export const JOB_CLASSES = [
  { id: "operations-sweep", label: "Operations sweep (reservation and order expiry, payment reconciliation, forecasts, reorder suggestions)" },
  { id: "outbox-sweep", label: "Outbox and callback inbox processing" },
  { id: "webhook-redrive", label: "Re-queue of stuck inbound WhatsApp messages" },
  { id: "subscription-expiry", label: "Subscription lapse sweep (hourly)" },
  { id: "payment-request-expiry", label: "Payment request expiry and pawaPay deposit reconcile (hourly)" },
  { id: "business-digest", label: "Weekly business digest" },
] as const;
export type JobClassId = (typeof JOB_CLASSES)[number]["id"];
export const isJobClass = (s: string): s is JobClassId => JOB_CLASSES.some((j) => j.id === s);

/** Fails OPEN: if the table cannot be read, the job runs (a broken pause switch must never stop reconciliation). */
export async function isJobPaused(prisma: PrismaClient, jobClass: JobClassId): Promise<boolean> {
  try {
    return (await prisma.jobControl.findUnique({ where: { jobClass } }))?.paused === true;
  } catch (error) {
    console.error(`job control: could not read the pause state of ${jobClass}; running it:`, (error as Error).message);
    return false;
  }
}

export async function setJobPaused(prisma: PrismaClient, jobClass: JobClassId, paused: boolean, by: string, reason: string): Promise<void> {
  await prisma.jobControl.upsert({ where: { jobClass }, create: { jobClass, paused, reason, changedBy: by }, update: { paused, reason, changedBy: by, changedAt: new Date() } });
}
