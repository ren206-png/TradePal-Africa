import type { PrismaClient } from "@prisma/client";

/**
 * The AI-provider part of the system-health view (admin-console Phase 3), built from the usage ledger: for each provider, when a call last
 * succeeded and how many requests were refused in the last 24 hours, split into authentication refusals (HTTP 401/403: a rejected key) and
 * billing refusals (HTTP 402: no balance). Counts only; no prompt, key or message ever appears here.
 *
 * Honest limit: Anthropic reports "no credit" as an HTTP 400, which the ledger cannot tell apart from other bad requests. Those are
 * classified at call time and sent as their own incident (src/ai/failureClass.ts); here they appear only under `otherRefusals24h`.
 */
export interface AiProviderStatus {
  provider: "ANTHROPIC" | "DEEPSEEK";
  lastSuccessfulCallAt: Date | null;
  lastFailedCallAt: Date | null;
  authRefusals24h: number;
  billingRefusals24h: number;
  otherRefusals24h: number;
}

const PROVIDERS = ["ANTHROPIC", "DEEPSEEK"] as const;

export async function aiProviderStatus(prisma: PrismaClient, now: Date): Promise<AiProviderStatus[]> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const out: AiProviderStatus[] = [];
  for (const provider of PROVIDERS) {
    const lastOk = await prisma.aiUsageLedger.findFirst({ where: { provider, phase: "COMMIT" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const lastFail = await prisma.aiUsageLedger.findFirst({ where: { provider, phase: "RELEASE", errorClass: { not: null } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const recent = await prisma.aiUsageLedger.groupBy({
      by: ["httpStatus"],
      where: { provider, phase: "RELEASE", errorClass: { not: null }, createdAt: { gte: since } },
      _count: { _all: true },
    });
    let auth = 0, billing = 0, other = 0;
    for (const r of recent) {
      const n = r._count._all;
      if (r.httpStatus === 401 || r.httpStatus === 403) auth += n;
      else if (r.httpStatus === 402) billing += n;
      else other += n;
    }
    out.push({ provider, lastSuccessfulCallAt: lastOk?.createdAt ?? null, lastFailedCallAt: lastFail?.createdAt ?? null, authRefusals24h: auth, billingRefusals24h: billing, otherRefusals24h: other });
  }
  return out;
}

/** What is configured in THIS environment, as yes/no only. Never a value, never part of a value. */
export function configurationPresence(env: NodeJS.ProcessEnv): Record<string, boolean | string> {
  const has = (...names: string[]) => names.every((n) => Boolean(env[n]));
  return {
    environment: env["NODE_ENV"] ?? "unknown",
    alertEmail: has("ALERT_EMAIL_API_KEY", "ALERT_EMAIL_TO"),
    anthropic: has("ANTHROPIC_API_KEY"),
    deepseek: has("DEEPSEEK_API_KEY"),
    whatsapp: has("WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"),
    whatsappWebhookSecret: has("WHATSAPP_APP_SECRET"),
    pawapayConfigured: has("PAWAPAY_API_TOKEN"),
    // the deployment-level switch for real subscription charges; this view can show it but nothing here can change it
    pawapayBillingProductionActivated: env["PAWAPAY_BILLING_PRODUCTION_ACTIVATED"] === "true",
    outboxSweep: env["OUTBOX_SWEEP_ENABLED"] === "true",
    heartbeatWriting: env["HEARTBEAT_ENABLED"] === "true",
  };
}
