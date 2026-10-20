import type { NextFunction, Request, Response } from "express";

/**
 * A NUL character (U+0000) in a path, query or body is valid HTTP but Postgres refuses it in text, which used to surface as an unhandled
 * database error and a 500. No legitimate request contains one, so it is refused up front with a plain 400. (Phase 8 security finding.)
 * Mount BEFORE routes and AFTER the body parsers. Walks parsed bodies to a bounded depth.
 */
function hasNul(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (depth > 6 || value === null || typeof value !== "object") return false;
  for (const v of Array.isArray(value) ? value : Object.values(value as object)) if (hasNul(v, depth + 1)) return true;
  return false;
}

export function rejectNulBytes(req: Request, res: Response, next: NextFunction): void {
  let url = req.originalUrl;
  try {
    url = decodeURIComponent(req.originalUrl);
  } catch {
    // a malformed escape is left to the routes (they treat it as an unknown id)
  }
  if (url.includes("\u0000") || hasNul(req.query) || hasNul(req.params) || hasNul(req.body)) {
    res.status(400).type("text/plain").send("Bad request.");
    return;
  }
  next();
}
