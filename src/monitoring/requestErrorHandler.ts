import type { NextFunction, Request, Response } from "express";
import { reportIncident, type AlertEmailDeps } from "./alerts.js";

/**
 * The centralized Express error handler (registered last in server.ts — see the comment there
 * for why it must be last and why it exists at all). Lives in its own module so it can be tested
 * without booting the server.
 *
 * Two kinds of error reach it:
 *  - Client errors (body-parser's malformed JSON → 400, oversized body → 413, ...). These carry a
 *    4xx `status` and are the caller's mistake, not an incident: answer with that status and do
 *    NOT report an incident — otherwise any bot or scanner POSTing bad JSON would turn into a
 *    "server error" alert email (and a misleading 500 in the response).
 *  - Everything else is an unexpected server error: reported as an incident, answered with a
 *    plain 500 that never leaks the stack trace.
 */
export function createRequestErrorHandler(alerts: AlertEmailDeps | undefined, service: string) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const status = clientErrorStatus(err);
    if (status !== undefined) {
      if (res.headersSent) return;
      res.status(status).json({ error: status === 413 ? "Payload too large." : "Invalid request." });
      return;
    }

    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    reportIncident(alerts, { service, title: "Unhandled request error", detail }).catch((reportError) => {
      console.error(`${service}: reportIncident threw while handling a request error:`, reportError);
    });

    // Never leak a stack trace (or any error detail) to the client — the full
    // detail already went to reportIncident/console above for operators.
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error." });
  };
}

/** body-parser/http-errors style errors expose the HTTP status the client should get. */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const code = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : undefined;
  return code !== undefined && code >= 400 && code < 500 ? code : undefined;
}
