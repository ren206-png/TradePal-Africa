import type { AlertEmailDeps } from "./alerts.js";
import { reportIncident } from "./alerts.js";

/**
 * The "crash" half of the monitoring system's "crash or bug" mandate,
 * complementing the "bug" half (messageDispatcher.ts's try/catch/finally,
 * and each worker's upgraded `.on("failed", ...)` — see those files' own
 * comments). An `uncaughtException` or `unhandledRejection` means something
 * escaped every other error boundary this process has; Node's own guidance
 * (https://nodejs.org/api/process.html#warning-using-uncaughtexception-correctly)
 * is that the process is now in an undefined state and must not be kept
 * alive to "self-heal" in place — doing so risks corrupting in-flight work
 * far worse than a clean restart would.
 *
 * The actual "fix it automatically" step here is deliberately NOT "patch the
 * bug" (this codebase never writes or deploys its own code — there is no
 * safe rollback if an automated fix were wrong) but "hand off to the
 * platform's own restart policy": `process.exit(1)` on a crash-looping
 * container is exactly what Railway (or any process supervisor) is already
 * built to detect and restart from, cleanly, with no custom recovery logic
 * of this codebase's own to get wrong. Alerting happens first — best-effort,
 * bounded by reportIncident's own timeout — so the exit always reports "what
 * has been done" before the platform takes over.
 */
export function installCrashReporting(service: string, alerts: AlertEmailDeps | undefined): void {
  const handleFatal = (title: string, error: unknown): void => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);

    reportIncident(alerts, { service, title, detail })
      .catch((reportError) => {
        // reportIncident itself is designed to never throw, but guard anyway —
        // a crash handler must not itself crash without ever calling exit.
        console.error(`installCrashReporting: reportIncident threw for '${service}':`, reportError);
      })
      .finally(() => {
        process.exit(1);
      });
  };

  process.on("uncaughtException", (error) => {
    handleFatal("Uncaught exception", error);
  });

  process.on("unhandledRejection", (reason) => {
    handleFatal("Unhandled promise rejection", reason);
  });
}

/** One resource this process must drain/close before it exits — an HTTP server no longer accepting connections, a BullMQ Worker finishing its active job, a Prisma client disconnecting, etc. */
export interface ShutdownTarget {
  /** Short, log-friendly name — identifies which target failed to close, if one does. */
  name: string;
  close: () => Promise<void>;
}

/**
 * The deploy-time counterpart to installCrashReporting above: that function
 * handles an *unplanned* fatal error, this one handles a *planned* shutdown.
 * Every entrypoint in this codebase (server.ts, worker.ts, and the three
 * hourly-sweep workers) previously had no `SIGTERM`/`SIGINT` listener at
 * all — Railway sends `SIGTERM` on every redeploy, and Node's default
 * behavior with no listener is to terminate immediately, killing whatever
 * HTTP request or BullMQ job happened to be in flight rather than letting it
 * finish. That's the gap this closes.
 *
 * Idempotent against repeat signals (a second `SIGTERM` while already
 * shutting down is a no-op, not a second overlapping shutdown attempt).
 * Bounded by `timeoutMs` (default 10s) so a target that hangs (e.g. a
 * keep-alive HTTP connection `server.close()` is still waiting on) can never
 * wedge the container forever — Railway's own supervisor would eventually
 * SIGKILL it anyway, so forcing an exit here just makes that outcome
 * deliberate and logged instead of silent.
 */
export function installGracefulShutdown(service: string, targets: ShutdownTarget[], timeoutMs = 10_000): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`${service}: received ${signal} — shutting down gracefully (up to ${timeoutMs}ms)...`);

    const forceExitTimer = setTimeout(() => {
      console.error(`${service}: graceful shutdown exceeded ${timeoutMs}ms — forcing exit.`);
      process.exit(1);
    }, timeoutMs);
    // Never itself the reason the process stays alive if everything else finishes first.
    forceExitTimer.unref();

    void Promise.allSettled(
      targets.map((target) =>
        target.close().catch((error: unknown) => {
          console.error(`${service}: error closing '${target.name}' during shutdown:`, error);
        }),
      ),
    ).then(() => {
      clearTimeout(forceExitTimer);
      console.log(`${service}: graceful shutdown complete.`);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
