import { randomBytes } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { generate } from "otplib";
import type { PrismaClient } from "@prisma/client";
import { createAdminRouter, type CreateAdminRouterOptions } from "../../src/admin/adminRoutes.js";
import { decryptSecret } from "../../src/admin/mfa.js";

export const SECRET = "test-secret-do-not-use-in-production";
export const PW = "correct-horse-battery";
export const MFA_KEY = randomBytes(32);

/** A mutable clock the admin router reads (sessions, re-authentication, second-factor time steps), so expiry rules need no waiting. */
export class TestClock {
  private ms = Date.now();
  now = (): Date => new Date(this.ms);
  advance(minutes: number): void { this.ms += minutes * 60_000; }
}

export interface Harness {
  clock: TestClock;
  http: () => ReturnType<typeof request>;
  login(email: string, password?: string): Promise<request.Response>;
  /** A token that has finished signing in (password and, when it applies, the second factor, enrolling first if needed). */
  signedIn(email: string): Promise<{ token: string; sessionId: string }>;
  auth(token: string): { Authorization: string };
  /** A code for the authenticator secret at the harness clock. */
  code(secret: string): Promise<string>;
  close(): void;
}

export interface HarnessOptions extends Partial<CreateAdminRouterOptions> {
  enforceMfa?: boolean;
  requireSession?: boolean;
  withKey?: boolean;
}

export function buildHarness(prisma: PrismaClient, options: HarnessOptions = {}): Harness {
  const clock = new TestClock();
  const { enforceMfa = true, requireSession = true, withKey = true, ...rest } = options;
  const router = createAdminRouter(prisma, SECRET, {
    ...rest,
    auth: { enforceMfa, requireSession, ...(withKey ? { mfaEncryptionKey: MFA_KEY } : {}), now: clock.now, ...(rest.auth ?? {}) },
    staff: { publicBaseUrl: "https://admin.example.test", ...(rest.staff ?? {}) },
    platform: { ...(rest.platform ?? {}), now: clock.now } as never,
  });
  const app = express();
  app.use(express.json());
  app.use("/admin", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "unhandled", detail: String(err).slice(0, 200) });
  });
  const server = app.listen(0, "127.0.0.1");
  server.keepAliveTimeout = 120_000;
  const http = () => request(server);
  const h: Harness = {
    clock,
    http,
    login: (email, password = PW) => http().post("/admin/login").send({ email, password }),
    auth: (token) => ({ Authorization: `Bearer ${token}` }),
    code: (secret) => generate({ secret, epoch: Math.floor(clock.now().getTime() / 1000) }),
    signedIn: async (email) => {
      const res = await h.login(email);
      if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
      const token = res.body.token as string;
      const state = res.body.mfa.state as string;
      if (state === "ENROLMENT_REQUIRED") {
        const start = await http().post("/admin/mfa/enroll/start").set(h.auth(token)).send({});
        await http().post("/admin/mfa/enroll/confirm").set(h.auth(token)).send({ code: await h.code(start.body.secret as string) });
      } else if (state === "CHALLENGE_REQUIRED") {
        clock.advance(1); // a fresh time step, so the replay guard does not see the previous sign-in's code again
        const secret = await secretFor(prisma, email);
        await http().post("/admin/mfa/challenge").set(h.auth(token)).send({ code: await h.code(secret) });
      }
      return { token, sessionId: (jwt.decode(token) as { jti: string }).jti };
    },
    close: () => { server.close(); },
  };
  return h;
}

/** The authenticator secret of an enrolled person, decrypted for a test. */
export async function secretFor(prisma: PrismaClient, email: string): Promise<string> {
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
  const f = await prisma.adminMfaFactor.findFirstOrThrow({ where: { adminUserId: admin.id, disabledAt: null, confirmedAt: { not: null } } });
  return decryptSecret(MFA_KEY, f.secretCiphertext);
}
