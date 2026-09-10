import type { NextFunction, Request, Response } from "express";

/**
 * Express 4 (unlike Express 5) does not catch a rejected Promise returned by
 * an async route handler or middleware — it just becomes an unhandled
 * rejection. Combined with this codebase's own `installCrashReporting`
 * (processGuards.ts), whose `unhandledRejection` listener calls
 * `process.exit(1)`, a single thrown error in ANY unwrapped async admin
 * route — a transient Prisma error, a bug in a domain function, anything —
 * would previously take down the entire server process, not just fail that
 * one request.
 *
 * Wrapping a handler with `asyncHandler` forwards any rejection to
 * `next(err)` instead, so it reaches the centralized error-handling
 * middleware registered last in server.ts, which reports the incident and
 * responds with a generic 500 — isolating the failure to the one request.
 *
 * Works for both terminal route handlers and middleware: `next` is passed
 * through untouched, so a handler that itself calls `next()` on success
 * (e.g. `requireAdminAuth`) keeps working exactly as before.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Req, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
