import { Router, type RequestHandler, type Response } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "./asyncHandler.js";
import { issueAdminJwt, verifyAdminPassword } from "./auth.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { correlationIdOf } from "./adminAudit.js";
import { findAdminUserByEmail } from "./adminUsers.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "./rateLimiter.js";
import { revokeAdminToken } from "./tokenRevocation.js";
import { platformPermissionsFor } from "../auth/permissions.js";
import {
  DEFAULT_SESSION_POLICY, adminMfaEnforced, mfaEncryptionKeyFromEnv, sessionPolicyFromEnv, type AdminSessionPolicy,
} from "./adminConfig.js";
import {
  createAdminSession, markSessionMfaVerified, markSessionReauth, reauthIsFresh, revokeAdminSession,
} from "./adminSessions.js";
import {
  MfaError, confirmEnrolment, hasConfirmedFactor, hasConfirmedTotp, regenerateRecoveryCodes, startEnrolment, useRecoveryCode, verifyTotp,
} from "./mfa.js";
import {
  WhatsappCodeError, confirmWhatsappEnrolment, hasConfirmedWhatsapp, hasLiveWhatsappCode, removeWhatsappFactor, sendWhatsappCode,
  startWhatsappEnrolment, verifyWhatsappCode, whatsappMethodInfo, type WhatsappCodeDeps, type WhatsappCodeSender, type WhatsappMethodInfo,
} from "./whatsappCodes.js";
import { callerHashes, recordSecurityEvent, type SecurityEventInput } from "./securityEvents.js";

/**
 * Staff sign-in, second factor, recovery, re-authentication and sign-out (admin-console Phase 2).
 *
 * The flow: POST /login checks the password and opens a server-side session. If this person must pass a second factor the session
 * is "half open": it can reach only /session, the /mfa/* routes and /logout until the factor is passed, and it expires if that does
 * not happen in time. Responses never say whether an email exists, and every outcome is a security event (without secrets).
 */
export interface AdminAuthContext {
  prisma: PrismaClient;
  jwtSecret: string;
  policy: AdminSessionPolicy;
  enforceMfa: boolean;
  mfaKey: Buffer | undefined;
  /** Delivers WhatsApp sign-in codes; absent means that second-factor option is not offered. */
  whatsappSender: WhatsappCodeSender | undefined;
  now: () => Date;
  limiters: { loginEmail: LoginRateLimiter; loginIp: LoginRateLimiter; mfa: LoginRateLimiter; reauth: LoginRateLimiter };
}

export interface AdminAuthRouteOptions {
  policy?: AdminSessionPolicy;
  enforceMfa?: boolean;
  mfaEncryptionKey?: Buffer;
  whatsappCodeSender?: WhatsappCodeSender;
  now?: () => Date;
  loginRateLimiter?: LoginRateLimiter;
  loginIpRateLimiter?: LoginRateLimiter;
  mfaRateLimiter?: LoginRateLimiter;
  reauthRateLimiter?: LoginRateLimiter;
}

/** Defaults for a router built without options (tests, and anywhere that does not opt in): no enforcement, no key, in-memory limits. */
export function buildAuthContext(prisma: PrismaClient, jwtSecret: string, options: AdminAuthRouteOptions = {}): AdminAuthContext {
  return {
    prisma,
    jwtSecret,
    policy: options.policy ?? DEFAULT_SESSION_POLICY,
    enforceMfa: options.enforceMfa ?? false,
    mfaKey: options.mfaEncryptionKey,
    whatsappSender: options.whatsappCodeSender,
    now: options.now ?? (() => new Date()),
    limiters: {
      loginEmail: options.loginRateLimiter ?? new InMemoryLoginRateLimiter(),
      // The strict per-address limit is set by the caller that serves real traffic (server.ts passes one explicitly). A router built without
      // one (tests, local tools that make many sign-ins from one address) gets a limit too high to matter.
      loginIp: options.loginIpRateLimiter ?? new InMemoryLoginRateLimiter(100_000, 15 * 60_000),
      mfa: options.mfaRateLimiter ?? new InMemoryLoginRateLimiter(5, 10 * 60_000),
      reauth: options.reauthRateLimiter ?? new InMemoryLoginRateLimiter(5, 10 * 60_000),
    },
  };
}

/** What server.ts uses: everything from the environment. */
export function authOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<AdminAuthRouteOptions, "policy" | "enforceMfa" | "mfaEncryptionKey"> {
  const key = mfaEncryptionKeyFromEnv(env);
  return { policy: sessionPolicyFromEnv(env), enforceMfa: adminMfaEnforced(env), ...(key ? { mfaEncryptionKey: key } : {}) };
}

const loginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).strict();
const codeBody = z.object({ code: z.string().min(6).max(16) }).strict();
const reauthBody = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(16).optional() }).strict();

export type MfaState = "NOT_REQUIRED" | "ENROLMENT_REQUIRED" | "CHALLENGE_REQUIRED" | "VERIFIED";

async function mfaStateFor(ctx: AdminAuthContext, adminUserId: string, applies: boolean, verified: boolean): Promise<MfaState> {
  if (!applies) return "NOT_REQUIRED";
  if (verified) return "VERIFIED";
  return (await hasConfirmedFactor(ctx.prisma, adminUserId)) ? "CHALLENGE_REQUIRED" : "ENROLMENT_REQUIRED";
}

function tooMany(res: Response, retryAfterSeconds: number): void {
  res.status(429).set("Retry-After", String(retryAfterSeconds)).json({ error: "Too many attempts. Try again later." });
}

function whatsappDeps(ctx: AdminAuthContext): WhatsappCodeDeps {
  return { prisma: ctx.prisma, jwtSecret: ctx.jwtSecret, key: ctx.mfaKey, sender: ctx.whatsappSender, now: ctx.now };
}

/** The second-factor options this person has and is offered: the sign-in screens read it to show the right choices. */
async function methodsFor(ctx: AdminAuthContext, adminUserId: string): Promise<{ totp: boolean; whatsapp: WhatsappMethodInfo }> {
  return { totp: await hasConfirmedTotp(ctx.prisma, adminUserId), whatsapp: await whatsappMethodInfo(whatsappDeps(ctx), adminUserId) };
}

/**
 * Adding a second way to sign in when one already exists is a sensitive change: it needs a session that passed the factor AND a fresh
 * confirmation. (With no factor yet, a half-open session may set up the first one.) Answers 403 and returns true when blocked.
 */
async function blockedFromAddingMethod(ctx: AdminAuthContext, req: AuthenticatedAdminRequest, res: Response, adminUserId: string): Promise<boolean> {
  if (!(await hasConfirmedFactor(ctx.prisma, adminUserId))) return false;
  if (!req.adminSession?.mfaVerifiedAt) {
    res.status(403).json({ error: "Finish signing in first.", code: "MFA_REQUIRED" });
    return true;
  }
  if (!reauthIsFresh(req.adminSession, ctx.policy, ctx.now())) {
    res.status(403).json({ error: "Please confirm your password and code to continue.", code: "REAUTH_REQUIRED" });
    return true;
  }
  return false;
}

const whatsappErrorStatus: Record<WhatsappCodeError["code"], number> = {
  NOT_AVAILABLE: 503, BAD_NUMBER: 400, BLOCKED_NUMBER: 400, TOO_MANY: 429, SEND_FAILED: 502, NO_FACTOR: 409, ALREADY_ENROLLED: 409, BAD_CODE: 401,
};

function event(ctx: AdminAuthContext, req: Parameters<typeof recordSecurityEvent>[2], res: Response, input: SecurityEventInput): Promise<void> {
  return recordSecurityEvent(ctx.prisma, ctx.jwtSecret, req, { ...input, correlationId: correlationIdOf(res) || undefined });
}

// -------------------------------------------------------------------------------------------------- POST /login

export function createLoginHandler(ctx: AdminAuthContext): RequestHandler {
  return asyncHandler(async (req, res) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
      return;
    }
    const email = parsed.data.email.toLowerCase();
    // Two limits: per attempted email (stops guessing one account) and per caller address (stops one caller trying many accounts).
    const byEmail = await ctx.limiters.loginEmail.consume(email);
    const ipHash = callerHashes(req, ctx.jwtSecret).ipHash;
    const byIp = ipHash ? await ctx.limiters.loginIp.consume(`ip:${ipHash}`) : { allowed: true, retryAfterSeconds: 0 };
    if (!byEmail.allowed || !byIp.allowed) {
      await event(ctx, req, res, { type: "LOGIN_RATE_LIMITED", result: "DENIED", subject: email });
      tooMany(res, Math.max(byEmail.retryAfterSeconds, byIp.retryAfterSeconds));
      return;
    }

    const admin = await findAdminUserByEmail(ctx.prisma, email);
    const passwordValid = admin ? await verifyAdminPassword(parsed.data.password, admin.passwordHash) : false;
    // Identical answer whether the email is unknown, the password is wrong or the account is disabled: no way to enumerate staff.
    if (!admin || !passwordValid || admin.disabledAt) {
      await event(ctx, req, res, {
        type: "LOGIN_FAILED", result: "FAILURE", subject: email, adminUserId: admin?.id ?? null,
        metadata: { reason: !admin ? "unknown_account" : admin.disabledAt ? "disabled" : "bad_password" },
      });
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }
    await ctx.limiters.loginEmail.reset(email);

    const mfaApplies = ctx.enforceMfa || admin.mfaRequiredAt !== null;
    const now = ctx.now();
    const session = await createAdminSession(ctx.prisma, { adminUserId: admin.id, policy: ctx.policy, mfaVerified: !mfaApplies, req, jwtSecret: ctx.jwtSecret, now });
    await ctx.prisma.adminUser.update({ where: { id: admin.id }, data: { lastSignInAt: now } });
    const mfa = await mfaStateFor(ctx, admin.id, mfaApplies, false);
    await event(ctx, req, res, { type: "LOGIN_SUCCESS", result: "SUCCESS", adminUserId: admin.id, metadata: { sessionId: session.id, mfa } });

    // The token lives as long as the session can; a half-open session's own deadline is enforced server-side.
    const token = issueAdminJwt(
      { adminUserId: admin.id, email: admin.email, role: admin.role },
      ctx.jwtSecret,
      { jwtid: session.id, expiresInSeconds: Math.max(60, Math.floor(ctx.policy.absoluteMs / 1000)) },
    );
    res.json({
      token,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
      mfa: { state: mfa, completeWithinSeconds: mfa === "NOT_REQUIRED" ? null : Math.floor(ctx.policy.preMfaMs / 1000), methods: await methodsFor(ctx, admin.id) },
      session: { absoluteExpiresAt: session.absoluteExpiresAt.toISOString(), idleTimeoutSeconds: Math.floor(ctx.policy.idleMs / 1000) },
    });
  });
}

// ------------------------------------------------------------------------ authenticated, reachable before the factor

export function createSessionRouter(ctx: AdminAuthContext): Router {
  const router = Router();

  function who(req: AuthenticatedAdminRequest): { id: string; email: string; role: string; jti: string } | null {
    const a = req.adminUser;
    return a ? { id: a.adminUserId, email: a.email, role: a.role, jti: a.jti } : null;
  }
  /** The server-side session a WhatsApp code is bound to (its id is the token's `jti`). */
  const sessionIdOf = (req: AuthenticatedAdminRequest, admin: { jti: string }): string => req.adminSession?.id ?? admin.jti;

  router.get(
    "/session",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      const s = req.adminSession;
      const mfa = await mfaStateFor(ctx, admin.id, req.adminMfaApplies ?? false, s?.mfaVerifiedAt != null);
      res.json({
        admin: { id: admin.id, email: admin.email, role: admin.role },
        mfa: { state: mfa, methods: await methodsFor(ctx, admin.id) },
        reauthFresh: s ? reauthIsFresh(s, ctx.policy, ctx.now()) : true,
        session: s ? { absoluteExpiresAt: s.absoluteExpiresAt.toISOString(), idleTimeoutSeconds: Math.floor(ctx.policy.idleMs / 1000) } : null,
        permissions: mfa === "ENROLMENT_REQUIRED" || mfa === "CHALLENGE_REQUIRED" ? [] : platformPermissionsFor(admin.role as never),
      });
    }),
  );

  router.post(
    "/mfa/enroll/start",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      const limit = await ctx.limiters.mfa.consume(`mfa:${admin.id}`);
      if (!limit.allowed) return tooMany(res, limit.retryAfterSeconds);
      // Already has an authenticator: the 409 below answers. Has only a WhatsApp number: adding the app is a sensitive change.
      if (!(await hasConfirmedTotp(ctx.prisma, admin.id)) && (await blockedFromAddingMethod(ctx, req, res, admin.id))) return;
      try {
        const out = await startEnrolment(ctx.prisma, ctx.mfaKey, { id: admin.id, email: admin.email });
        await event(ctx, req, res, { type: "MFA_ENROL_STARTED", result: "SUCCESS", adminUserId: admin.id });
        res.json(out);
      } catch (error) {
        if (error instanceof MfaError) {
          const status = error.code === "ALREADY_ENROLLED" ? 409 : error.code === "NO_KEY" ? 503 : 400;
          return void res.status(status).json({ error: error.message, code: error.code });
        }
        throw error;
      }
    }),
  );

  router.post(
    "/mfa/enroll/confirm",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      const parsed = codeBody.safeParse(req.body);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
      const limit = await ctx.limiters.mfa.consume(`mfa:${admin.id}`);
      if (!limit.allowed) {
        await event(ctx, req, res, { type: "MFA_RATE_LIMITED", result: "DENIED", adminUserId: admin.id });
        return tooMany(res, limit.retryAfterSeconds);
      }
      if ((await hasConfirmedFactor(ctx.prisma, admin.id)) && !req.adminSession?.mfaVerifiedAt) return void res.status(403).json({ error: "Finish signing in first.", code: "MFA_REQUIRED" });
      try {
        const out = await confirmEnrolment(ctx.prisma, ctx.mfaKey, admin.id, parsed.data.code, ctx.now());
        if (req.adminSession) await markSessionMfaVerified(ctx.prisma, req.adminSession.id, ctx.now());
        await ctx.limiters.mfa.reset(`mfa:${admin.id}`);
        await event(ctx, req, res, { type: "MFA_ENROLLED", result: "SUCCESS", adminUserId: admin.id });
        res.json({ enrolled: true, recoveryCodes: out.recoveryCodes, message: "Save these recovery codes now. They are shown only once and each works once." });
      } catch (error) {
        if (error instanceof MfaError) {
          await event(ctx, req, res, { type: "MFA_FAILED", result: "FAILURE", adminUserId: admin.id, metadata: { stage: "enrol" } });
          const status = error.code === "NO_KEY" ? 503 : 400;
          return void res.status(status).json({ error: error.message, code: error.code === "BAD_CODE" ? "BAD_CODE" : error.code });
        }
        throw error;
      }
    }),
  );

  router.post(
    "/mfa/challenge",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      const parsed = codeBody.safeParse(req.body);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
      const limit = await ctx.limiters.mfa.consume(`mfa:${admin.id}`);
      if (!limit.allowed) {
        await event(ctx, req, res, { type: "MFA_RATE_LIMITED", result: "DENIED", adminUserId: admin.id });
        return tooMany(res, limit.retryAfterSeconds);
      }
      try {
        await verifyTotp(ctx.prisma, ctx.mfaKey, admin.id, parsed.data.code, ctx.now());
      } catch (error) {
        if (error instanceof MfaError) {
          await event(ctx, req, res, { type: "MFA_FAILED", result: "FAILURE", adminUserId: admin.id, metadata: { stage: "challenge", replay: error.code === "REPLAY" } });
          return void res.status(error.code === "NO_KEY" ? 503 : 401).json({ error: error.code === "NO_FACTOR" ? error.message : "That code is not right.", code: error.code === "NO_FACTOR" ? "NO_FACTOR" : "BAD_CODE" });
        }
        throw error;
      }
      if (req.adminSession) await markSessionMfaVerified(ctx.prisma, req.adminSession.id, ctx.now());
      await ctx.limiters.mfa.reset(`mfa:${admin.id}`);
      await event(ctx, req, res, { type: "MFA_CHALLENGE_PASSED", result: "SUCCESS", adminUserId: admin.id });
      res.json({ verified: true });
    }),
  );

  router.post(
    "/mfa/recovery",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      const parsed = codeBody.safeParse(req.body);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
      const limit = await ctx.limiters.mfa.consume(`mfa:${admin.id}`);
      if (!limit.allowed) {
        await event(ctx, req, res, { type: "MFA_RATE_LIMITED", result: "DENIED", adminUserId: admin.id });
        return tooMany(res, limit.retryAfterSeconds);
      }
      try {
        const { remaining } = await useRecoveryCode(ctx.prisma, admin.id, parsed.data.code, ctx.now());
        if (req.adminSession) await markSessionMfaVerified(ctx.prisma, req.adminSession.id, ctx.now());
        await ctx.limiters.mfa.reset(`mfa:${admin.id}`);
        await event(ctx, req, res, { type: "RECOVERY_CODE_USED", result: "SUCCESS", adminUserId: admin.id, metadata: { remaining } });
        res.json({ verified: true, recoveryCodesRemaining: remaining, message: remaining <= 2 ? "You are running low on recovery codes. Make new ones after you sign in." : undefined });
      } catch (error) {
        if (error instanceof MfaError) {
          await event(ctx, req, res, { type: "RECOVERY_CODE_FAILED", result: "FAILURE", adminUserId: admin.id });
          return void res.status(401).json({ error: "That code is not right.", code: "BAD_CODE" });
        }
        throw error;
      }
    }),
  );

  // ------------------------------------------------------------------------------- WhatsApp codes (second factor)

  const phoneBody = z.object({ phone: z.string().min(5).max(40) }).strict();
  const failWhatsapp = (res: Response, error: WhatsappCodeError) => res.status(whatsappErrorStatus[error.code]).json({ error: error.message, code: error.code });

  router.post(
    "/mfa/whatsapp/enroll/start",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      const parsed = phoneBody.safeParse(req.body);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
      if (await hasConfirmedWhatsapp(ctx.prisma, admin.id)) return void res.status(409).json({ error: "A WhatsApp number is already set up. Remove it first to use a different one.", code: "ALREADY_ENROLLED" });
      if (await blockedFromAddingMethod(ctx, req, res, admin.id)) return;
      try {
        const out = await startWhatsappEnrolment(whatsappDeps(ctx), { id: admin.id }, sessionIdOf(req, admin), parsed.data.phone);
        await event(ctx, req, res, { type: "WHATSAPP_ENROLL_STARTED", result: "SUCCESS", adminUserId: admin.id, metadata: { last4: out.last4 } });
        res.json({ sent: true, last4: out.last4, expiresInSeconds: out.expiresInSeconds });
      } catch (error) {
        if (!(error instanceof WhatsappCodeError)) throw error;
        await event(ctx, req, res, { type: "WHATSAPP_CODE_FAILED", result: "FAILURE", adminUserId: admin.id, metadata: { stage: "enrol-start", reason: error.code } });
        failWhatsapp(res, error);
      }
    }),
  );

  router.post(
    "/mfa/whatsapp/enroll/confirm",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      const parsed = codeBody.safeParse(req.body);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
      const limit = await ctx.limiters.mfa.consume(`mfa:${admin.id}`);
      if (!limit.allowed) {
        await event(ctx, req, res, { type: "MFA_RATE_LIMITED", result: "DENIED", adminUserId: admin.id });
        return tooMany(res, limit.retryAfterSeconds);
      }
      try {
        const out = await confirmWhatsappEnrolment(whatsappDeps(ctx), admin.id, sessionIdOf(req, admin), parsed.data.code);
        if (req.adminSession && !req.adminSession.mfaVerifiedAt) await markSessionMfaVerified(ctx.prisma, req.adminSession.id, ctx.now());
        await ctx.limiters.mfa.reset(`mfa:${admin.id}`);
        await event(ctx, req, res, { type: "WHATSAPP_ENROLLED", result: "SUCCESS", adminUserId: admin.id });
        res.json({
          enrolled: true,
          ...(out.recoveryCodes ? { recoveryCodes: out.recoveryCodes, message: "Save these recovery codes now. They are shown only once and each works once." } : {}),
        });
      } catch (error) {
        if (!(error instanceof WhatsappCodeError)) throw error;
        await event(ctx, req, res, { type: "MFA_FAILED", result: "FAILURE", adminUserId: admin.id, metadata: { stage: "whatsapp-enrol" } });
        failWhatsapp(res, error);
      }
    }),
  );

  // Sends a sign-in code (half-open session) or a re-authentication code (signed-in session) to the confirmed number.
  router.post(
    "/mfa/whatsapp/send",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      const purpose = req.adminSession?.mfaVerifiedAt ? "REAUTH" : "SIGNIN";
      try {
        const out = await sendWhatsappCode(whatsappDeps(ctx), { id: admin.id }, sessionIdOf(req, admin), purpose);
        await event(ctx, req, res, { type: "WHATSAPP_CODE_SENT", result: "SUCCESS", adminUserId: admin.id, metadata: { purpose, last4: out.last4 } });
        res.json({ sent: true, last4: out.last4, expiresInSeconds: out.expiresInSeconds });
      } catch (error) {
        if (!(error instanceof WhatsappCodeError)) throw error;
        await event(ctx, req, res, { type: "WHATSAPP_CODE_FAILED", result: "FAILURE", adminUserId: admin.id, metadata: { stage: "send", reason: error.code } });
        failWhatsapp(res, error);
      }
    }),
  );

  router.post(
    "/mfa/whatsapp/verify",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      const parsed = codeBody.safeParse(req.body);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
      const limit = await ctx.limiters.mfa.consume(`mfa:${admin.id}`);
      if (!limit.allowed) {
        await event(ctx, req, res, { type: "MFA_RATE_LIMITED", result: "DENIED", adminUserId: admin.id });
        return tooMany(res, limit.retryAfterSeconds);
      }
      try {
        await verifyWhatsappCode(whatsappDeps(ctx), admin.id, sessionIdOf(req, admin), ["SIGNIN"], parsed.data.code);
      } catch (error) {
        if (!(error instanceof WhatsappCodeError)) throw error;
        await event(ctx, req, res, { type: "MFA_FAILED", result: "FAILURE", adminUserId: admin.id, metadata: { stage: "challenge", method: "whatsapp" } });
        return void res.status(401).json({ error: error.code === "NO_FACTOR" ? error.message : "That code is not right.", code: error.code === "NO_FACTOR" ? "NO_FACTOR" : "BAD_CODE" });
      }
      if (req.adminSession) await markSessionMfaVerified(ctx.prisma, req.adminSession.id, ctx.now());
      await ctx.limiters.mfa.reset(`mfa:${admin.id}`);
      await event(ctx, req, res, { type: "MFA_CHALLENGE_PASSED", result: "SUCCESS", adminUserId: admin.id, metadata: { method: "whatsapp" } });
      res.json({ verified: true });
    }),
  );

  // Removing the number needs a signed-in session with a fresh confirmation, and an authenticator app to fall back on (else the person would be locked out).
  router.post(
    "/mfa/whatsapp/remove",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!req.adminSession?.mfaVerifiedAt) return void res.status(403).json({ error: "Finish signing in first.", code: "MFA_REQUIRED" });
      if (!reauthIsFresh(req.adminSession, ctx.policy, ctx.now())) return void res.status(403).json({ error: "Please confirm your password and code to continue.", code: "REAUTH_REQUIRED" });
      if (!(await hasConfirmedTotp(ctx.prisma, admin.id))) return void res.status(409).json({ error: "Set up an authenticator app first, so you are not locked out.", code: "LAST_METHOD" });
      await removeWhatsappFactor(ctx.prisma, admin.id);
      await event(ctx, req, res, { type: "WHATSAPP_REMOVED", result: "SUCCESS", adminUserId: admin.id });
      res.json({ removed: true });
    }),
  );

  // A fresh confirmation (password, and the authenticator code when a second factor applies) for sensitive actions.
  router.post(
    "/session/reauth",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      const parsed = reauthBody.safeParse(req.body);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (!parsed.success) return void res.status(400).json({ error: "Invalid request body." });
      if (req.adminMfaApplies && !req.adminSession?.mfaVerifiedAt) return void res.status(403).json({ error: "Finish signing in first.", code: "MFA_REQUIRED" });
      const limit = await ctx.limiters.reauth.consume(`reauth:${admin.id}`);
      if (!limit.allowed) return tooMany(res, limit.retryAfterSeconds);
      const row = await ctx.prisma.adminUser.findUnique({ where: { id: admin.id }, select: { passwordHash: true, disabledAt: true } });
      const passwordOk = row && !row.disabledAt ? await verifyAdminPassword(parsed.data.password, row.passwordHash) : false;
      let codeOk = true;
      if (req.adminMfaApplies) {
        codeOk = false;
        if (parsed.data.code) {
          try { await verifyTotp(ctx.prisma, ctx.mfaKey, admin.id, parsed.data.code, ctx.now()); codeOk = true; } catch (error) { if (!(error instanceof MfaError)) throw error; }
          // Not an authenticator code: it may be the WhatsApp code this session asked for.
          const wa = whatsappDeps(ctx);
          const sessionId = req.adminSession?.id ?? admin.jti;
          if (!codeOk && (await hasLiveWhatsappCode(wa, admin.id, sessionId))) {
            try { await verifyWhatsappCode(wa, admin.id, sessionId, ["REAUTH"], parsed.data.code); codeOk = true; } catch (error) { if (!(error instanceof WhatsappCodeError)) throw error; }
          }
        }
      }
      if (!passwordOk || !codeOk) {
        await event(ctx, req, res, { type: "REAUTH_FAILED", result: "FAILURE", adminUserId: admin.id });
        return void res.status(401).json({ error: "That did not match. Check your password and code.", code: "REAUTH_FAILED" });
      }
      if (req.adminSession) await markSessionReauth(ctx.prisma, req.adminSession.id, ctx.now());
      await ctx.limiters.reauth.reset(`reauth:${admin.id}`);
      await event(ctx, req, res, { type: "REAUTH_SUCCESS", result: "SUCCESS", adminUserId: admin.id });
      res.json({ reauthenticated: true, validForSeconds: Math.floor(ctx.policy.reauthMs / 1000) });
    }),
  );

  router.post(
    "/mfa/recovery-codes/regenerate",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = who(req);
      if (!admin) return void res.status(401).json({ error: "Not authenticated." });
      if (req.adminMfaApplies && !req.adminSession?.mfaVerifiedAt) return void res.status(403).json({ error: "Finish signing in first.", code: "MFA_REQUIRED" });
      if (req.adminSession && !reauthIsFresh(req.adminSession, ctx.policy, ctx.now())) return void res.status(403).json({ error: "Please confirm your password and authenticator code to continue.", code: "REAUTH_REQUIRED" });
      if (!(await hasConfirmedFactor(ctx.prisma, admin.id))) return void res.status(409).json({ error: "Set up your authenticator app first.", code: "NO_FACTOR" });
      const out = await regenerateRecoveryCodes(ctx.prisma, admin.id);
      await event(ctx, req, res, { type: "RECOVERY_CODES_REGENERATED", result: "SUCCESS", adminUserId: admin.id });
      res.json({ recoveryCodes: out.recoveryCodes, message: "Save these now. The old codes no longer work." });
    }),
  );

  router.post(
    "/logout",
    asyncHandler(async (req: AuthenticatedAdminRequest, res) => {
      const admin = req.adminUser;
      if (admin) {
        await revokeAdminToken(ctx.prisma, admin.jti, admin.exp);
        if (req.adminSession) await revokeAdminSession(ctx.prisma, req.adminSession.id, "signed out", ctx.now());
        await event(ctx, req, res, { type: "LOGOUT", result: "SUCCESS", adminUserId: admin.adminUserId });
      }
      res.json({ message: "Logged out." });
    }),
  );

  return router;
}

/** Records a denied admin request (401/403) as a security event. Cheap, and never allowed to fail the request. */
export function denialRecorder(ctx: AdminAuthContext): RequestHandler {
  return (req, res, next) => {
    res.on("finish", () => {
      if ((res.statusCode === 401 || res.statusCode === 403) && !req.path.startsWith("/login")) {
        const admin = (req as AuthenticatedAdminRequest).adminUser;
        void recordSecurityEvent(ctx.prisma, ctx.jwtSecret, req, {
          type: "ACCESS_DENIED", result: "DENIED", adminUserId: admin?.adminUserId ?? null,
          correlationId: correlationIdOf(res) || undefined,
          metadata: { status: res.statusCode, method: req.method, path: req.path.slice(0, 120) } as Prisma.InputJsonValue,
        });
      }
    });
    next();
  };
}
