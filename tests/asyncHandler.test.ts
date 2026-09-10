import { describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { asyncHandler } from "../src/admin/asyncHandler.js";

/**
 * Regression coverage for the "no centralized Express error handling" gap:
 * Express 4 does not catch a rejected Promise returned by an async
 * handler/middleware on its own, so before this wrapper (and a terminal
 * error-handling middleware), a thrown error here would become an
 * unhandled rejection — which, combined with installCrashReporting's own
 * `unhandledRejection` listener, would exit the whole process instead of
 * just failing the one request. These tests build a minimal Express app
 * (no DB, no real server process) and assert the failure stays scoped to
 * the single response.
 */
function buildApp() {
  const app = express();

  app.get(
    "/ok",
    asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    }),
  );

  app.get(
    "/boom",
    asyncHandler(async () => {
      throw new Error("boom from route handler");
    }),
  );

  app.get(
    "/rejected",
    asyncHandler(async () => {
      await Promise.reject(new Error("boom from a rejected promise, not a throw"));
    }),
  );

  // Middleware-flavored usage (mirrors requireAdminAuth): calls next() on
  // success, and the wrapper must still forward a thrown error to next(err)
  // when it's used as middleware rather than a terminal handler.
  app.get(
    "/middleware-ok",
    asyncHandler(async (_req: Request, _res: Response, next: NextFunction) => {
      next();
    }),
    (_req, res) => res.json({ passedThrough: true }),
  );

  app.get(
    "/middleware-boom",
    asyncHandler(async () => {
      throw new Error("boom from middleware");
    }),
    (_req, res) => res.json({ shouldNeverReachHere: true }),
  );

  // A terminal error-handling middleware, same shape as the one registered
  // in server.ts — proves the forwarded error is actually reachable and
  // isolated to a normal 500 response, not a crash.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Internal server error.", detail });
  });

  return app;
}

describe("asyncHandler", () => {
  it("passes through a successful async handler unchanged", async () => {
    const app = buildApp();
    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("forwards a thrown error to next(err) instead of becoming an unhandled rejection", async () => {
    const unhandledRejectionSpy = vi.fn();
    process.on("unhandledRejection", unhandledRejectionSpy);

    const app = buildApp();
    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("boom from route handler");
    expect(unhandledRejectionSpy).not.toHaveBeenCalled();

    process.off("unhandledRejection", unhandledRejectionSpy);
  });

  it("forwards a rejected promise (not just a synchronous throw) to next(err)", async () => {
    const app = buildApp();
    const res = await request(app).get("/rejected");
    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("boom from a rejected promise, not a throw");
  });

  it("still calls next() through to the next middleware on success (middleware usage)", async () => {
    const app = buildApp();
    const res = await request(app).get("/middleware-ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ passedThrough: true });
  });

  it("forwards an error thrown from middleware usage, without ever reaching the next handler", async () => {
    const app = buildApp();
    const res = await request(app).get("/middleware-boom");
    expect(res.status).toBe(500);
    expect(res.body.shouldNeverReachHere).toBeUndefined();
  });

  it("a request to a route that keeps failing does not affect a subsequent unrelated request", async () => {
    const app = buildApp();
    const failed = await request(app).get("/boom");
    expect(failed.status).toBe(500);

    const stillWorks = await request(app).get("/ok");
    expect(stillWorks.status).toBe(200);
    expect(stillWorks.body).toEqual({ ok: true });
  });
});
