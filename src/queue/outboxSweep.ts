import type { PrismaClient } from "@prisma/client";
import { reportIncident, type AlertEmailDeps } from "../monitoring/alerts.js";
import { processInbox, type CallbackHandler } from "../domain/callbackInbox.js";
import { processOutbox, type OutboxHandler } from "../domain/outbox.js";

/**
 * Periodically delivers pending outbox events and processes received provider callbacks (expansion Phase 1).
 * The handler registries are empty today (later phases register their event types), so enabling the sweep is a
 * harmless no-op until then, and it is OFF unless OUTBOX_SWEEP_ENABLED=true. An overlapping tick is skipped, and
 * dead-lettered work raises an incident so it cannot sit unnoticed.
 */
const SWEEP_INTERVAL_MS = 10_000;
const FIRST_SWEEP_DELAY_MS = 20_000;

export interface OutboxSweepDeps {
  prisma: PrismaClient;
  outboxHandlers: Readonly<Record<string, OutboxHandler>>;
  callbackHandlers: Readonly<Record<string, CallbackHandler>>;
  alerts?: AlertEmailDeps | undefined;
  intervalMs?: number;
}

export function outboxSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["OUTBOX_SWEEP_ENABLED"] === "true";
}

export function startOutboxSweep(deps: OutboxSweepDeps): { stop(): void } {
  let running = false;

  async function sweep(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const outbox = await processOutbox(deps.prisma, deps.outboxHandlers);
      const inbox = await processInbox(deps.prisma, deps.callbackHandlers);
      if (outbox.dead > 0 || inbox.dead > 0) {
        await reportIncident(deps.alerts, {
          service: "worker",
          title: "Outbox/inbox items dead-lettered",
          detail: `outbox: ${JSON.stringify(outbox)}; inbox: ${JSON.stringify(inbox)}. They exhausted their retry budget and need a human (dead-letter replay in the admin console).`,
        });
      }
    } catch (error) {
      console.error("outbox sweep failed (will retry next interval):", error);
    } finally {
      running = false;
    }
  }

  const first = setTimeout(() => void sweep(), FIRST_SWEEP_DELAY_MS);
  const interval = setInterval(() => void sweep(), deps.intervalMs ?? SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}
