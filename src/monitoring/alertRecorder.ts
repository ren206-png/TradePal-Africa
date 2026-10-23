import type { PrismaClient } from "@prisma/client";
import { setAlertDeliveryRecorder } from "./alerts.js";

/** Writes alert delivery outcomes to `AlertDelivery` (append-only). Call once at start-up, in every process that raises alerts. */
export function installAlertDeliveryRecorder(prisma: PrismaClient): void {
  setAlertDeliveryRecorder(async (r) => {
    await prisma.alertDelivery.create({
      data: {
        service: r.service, title: r.title.slice(0, 200), kind: r.kind, channel: r.channel, status: r.status,
        providerMessageId: r.providerMessageId ?? null, httpStatus: r.httpStatus ?? null, error: r.error ?? null,
      },
    });
  });
}

export interface AlertChannelStatus {
  lastDeliveredAt: Date | null;
  lastFailedAt: Date | null;
  lastChannelCheckAt: Date | null;
  lastChannelCheckStatus: string | null;
  failedLast7Days: number;
  recentFailures: { at: Date; title: string; error: string | null; httpStatus: number | null }[];
  /** True when no delivery has been proven in the last 7 days, or the latest attempt failed: someone should run a channel check. */
  needsAttention: boolean;
}

export async function alertChannelStatus(prisma: PrismaClient, now: Date = new Date()): Promise<AlertChannelStatus> {
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const [delivered, failed, check, failedCount, failures, latest] = await Promise.all([
    prisma.alertDelivery.findFirst({ where: { status: "DELIVERED" }, orderBy: { createdAt: "desc" } }),
    prisma.alertDelivery.findFirst({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" } }),
    prisma.alertDelivery.findFirst({ where: { kind: "CHANNEL_CHECK" }, orderBy: { createdAt: "desc" } }),
    prisma.alertDelivery.count({ where: { status: "FAILED", createdAt: { gte: week } } }),
    prisma.alertDelivery.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.alertDelivery.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);
  const provenRecently = !!delivered && delivered.createdAt >= week;
  return {
    lastDeliveredAt: delivered?.createdAt ?? null,
    lastFailedAt: failed?.createdAt ?? null,
    lastChannelCheckAt: check?.createdAt ?? null,
    lastChannelCheckStatus: check?.status ?? null,
    failedLast7Days: failedCount,
    recentFailures: failures.map((f) => ({ at: f.createdAt, title: f.title, error: f.error, httpStatus: f.httpStatus })),
    needsAttention: !provenRecently || latest?.status === "FAILED",
  };
}
