import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import cors from "cors";
import type { PrismaClient } from "@prisma/client";
import { adminConsoleEnabled, adminMfaEnforced, mfaEncryptionKeyFromEnv } from "./adminConfig.js";
import { createAdminRouter, type CreateAdminRouterOptions } from "./adminRoutes.js";

/**
 * Mounts the admin API under /admin, but ONLY when the master switch ADMIN_CONSOLE_ENABLED is exactly "true". With the switch off nothing
 * is mounted at all, so every /admin path falls through to the application's ordinary "no such route" answer: it is indistinguishable
 * from a route that never existed (not a 403 that would confirm an admin surface is there).
 *
 * Every admin response also forbids caching, so a shared computer's back button or a proxy cannot show a previous person's page.
 */
export function noStoreForAdmin(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", "Authorization, Origin");
    next();
  };
}

export interface MountAdminOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  env?: NodeJS.ProcessEnv;
  allowedOrigins: string[];
  routerOptions?: CreateAdminRouterOptions;
}

export function mountAdminConsole(app: Express, options: MountAdminOptions): boolean {
  const env = options.env ?? process.env;
  if (!adminConsoleEnabled(env)) return false;
  if (adminMfaEnforced(env) && !mfaEncryptionKeyFromEnv(env)) {
    // Fail closed for the console only: people can sign in with their password but cannot set up their authenticator until the key exists.
    console.error("ADMIN CONSOLE: second factor is enforced but ADMIN_MFA_ENCRYPTION_KEY (64 hex characters) is not set. Staff cannot finish signing in until it is.");
  }
  app.use(
    "/admin",
    noStoreForAdmin(),
    cors({ origin: options.allowedOrigins, credentials: false }),
    createAdminRouter(options.prisma, options.jwtSecret, options.routerOptions ?? {}),
  );
  return true;
}
