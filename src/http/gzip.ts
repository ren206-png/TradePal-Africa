import { gzipSync } from "node:zlib";
import type { NextFunction, Request, Response } from "express";

/**
 * Minimal gzip for the small, public, SECRET-FREE pages (Phase 8: a 26 KB shop page cost about 4 seconds on a 2G link uncompressed and
 * about 0.5 seconds compressed). Deliberately narrow:
 *  - only for requests the caller opts in (`applies`), so a page that carries an order link, a pickup code or a token is never compressed
 *    (compressing secrets next to attacker-influenced text is the BREACH pattern);
 *  - only whole in-memory bodies of 1 KB or more, only for text-like types, only when the client sent Accept-Encoding: gzip;
 *  - `Vary: Accept-Encoding` is always set, so a cache never hands a compressed body to a client that did not ask.
 */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json))/;

export function gzipSelected(applies: (req: Request) => boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!applies(req)) return next();
    res.vary("Accept-Encoding");
    if (!/\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""))) return next();
    const send = res.send.bind(res);
    res.send = ((body?: unknown): Response => {
      const type = String(res.getHeader("Content-Type") ?? "");
      const buf = typeof body === "string" ? Buffer.from(body) : Buffer.isBuffer(body) ? body : null;
      if (!buf || buf.length < 1024 || !COMPRESSIBLE.test(type) || res.getHeader("Content-Encoding") || res.statusCode === 204 || res.statusCode === 304) return send(body as never);
      res.setHeader("Content-Encoding", "gzip");
      res.removeHeader("Content-Length");
      return send(gzipSync(buf));
    }) as Response["send"];
    next();
  };
}
