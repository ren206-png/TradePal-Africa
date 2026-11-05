import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AdminWhatsappCodeConfig } from "./adminConfig.js";
import { keyedHash } from "./adminConfig.js";
import { decryptSecret, encryptSecret, regenerateRecoveryCodes } from "./mfa.js";
import { isBlocked } from "../messaging/consent.js";
import type { MessageTransport } from "../messaging/send.js";

/**
 * WhatsApp codes as a second factor for staff (the alternative to an authenticator app).
 *
 * A code is six digits, valid 5 minutes, usable once, bound to the sign-in session that asked for it, and allowed 5 wrong guesses. Only a
 * keyed hash of it is stored. The number a code goes to is stored encrypted (same key as authenticator secrets) and is shown back only as its
 * last four digits. The first code to a new number proves the person controls it; until then the number is not a factor.
 *
 * Sending is capped per account and per number so this can never be used to message a stranger repeatedly, and a number on the platform's
 * block list (someone who replied STOP) is never messaged. The message class is `STAFF_SIGNIN_CODE` in `src/messaging/registry.ts`.
 *
 * Codes and full numbers are never logged and never returned.
 */
export const WHATSAPP_CODE_TTL_MS = 5 * 60_000;
export const WHATSAPP_MAX_GUESSES = 5;
const SENDS_PER_ACCOUNT_10_MIN = 3;
const SENDS_PER_ACCOUNT_DAY = 10;
const SENDS_PER_NUMBER_HOUR = 3;
/** "Message" mode: how long a person has to send "ADMIN CODE" after asking. */
const MESSAGE_WAIT_MS = 10 * 60_000;

export type WhatsappPurpose = "ENROL" | "SIGNIN" | "REAUTH";

export class WhatsappCodeError extends Error {
  readonly code: "NOT_AVAILABLE" | "BAD_NUMBER" | "BLOCKED_NUMBER" | "TOO_MANY" | "SEND_FAILED" | "NO_FACTOR" | "ALREADY_ENROLLED" | "BAD_CODE";
  constructor(code: WhatsappCodeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * What actually delivers a code. Two ways, chosen by configuration:
 *  - "template": TradePal sends the code to the person's number when they ask (needs an approved Meta authentication template);
 *  - "message":  TradePal only ever replies to a person who has just written "ADMIN CODE" to its WhatsApp number (no template needed).
 */
export interface WhatsappCodeSender {
  readonly mode: "template" | "message";
  /** Delivers a code to this number now. In "message" mode this is only ever called as the reply to that person's own message. */
  send(toPhoneDigits: string, code: string): Promise<void>;
  /** "message" mode: the number people write to, digits with country code. */
  readonly chatNumber?: string;
}

/** The phrase a person sends to ask for a code in "message" mode. */
export const WHATSAPP_CODE_KEYWORD = "ADMIN CODE";
const KEYWORD_RE = /^\s*admin\s+code\s*$/i;
export const codeReplyText = (code: string): string => `Your TradePal Admin sign-in code is ${code}. It works once and expires in 5 minutes. If you did not ask for it, ignore this message and do not share it.`;

export function createWhatsappCodeSender(transport: MessageTransport, config: AdminWhatsappCodeConfig): WhatsappCodeSender {
  if (config.templateName) {
    const templateName = config.templateName;
    return {
      mode: "template",
      async send(toPhoneDigits, code) {
        await transport.sendTemplate(toPhoneDigits, templateName, config.languageCode, [code], { otpButtonCode: code });
      },
    };
  }
  return {
    mode: "message",
    ...(config.chatNumber ? { chatNumber: config.chatNumber } : {}),
    async send(toPhoneDigits, code) {
      await transport.sendText(toPhoneDigits, codeReplyText(code));
    },
  };
}

/** What the person must do next, shown in the console in "message" mode. */
export interface WhatsappChatInstruction { to: string; text: string; url: string }
export interface WhatsappIssued {
  last4: string;
  expiresInSeconds: number;
  mode: "template" | "message";
  /** Present in "message" mode: the code has NOT been sent; it arrives as a reply once the person sends this message. */
  message?: WhatsappChatInstruction;
}

export interface WhatsappCodeDeps {
  prisma: PrismaClient;
  jwtSecret: string;
  key: Buffer | undefined;
  sender: WhatsappCodeSender | undefined;
  now: () => Date;
}

/** "+1 (403) 555-0100", "00 233 24 555 0100" and "14035550100" all become digits with the country code first. */
export function normalisePhone(input: string): string {
  const trimmed = input.trim();
  // The country code must be explicit (+ or 00): a bare local number could belong to anyone, anywhere.
  const stripped = /^(\+|00)/.test(trimmed) ? trimmed.replace(/[\s().-]/g, "").replace(/^(\+|00)/, "") : "";
  if (!/^[1-9]\d{7,14}$/.test(stripped)) throw new WhatsappCodeError("BAD_NUMBER", "Enter the number with its country code, for example +1 403 555 0100.");
  return stripped;
}

const phoneHashOf = (secret: string, digits: string): string => keyedHash(secret, "admin-wa-phone", digits);
const codeHashOf = (secret: string, challengeId: string, code: string): string => createHmac("sha256", `${secret}::admin-wa-code::${challengeId}`).update(code).digest("hex");
const last4Of = (digits: string): string => digits.slice(-4);

export async function hasConfirmedWhatsapp(prisma: PrismaClient, adminUserId: string): Promise<boolean> {
  const f = await prisma.adminWhatsappFactor.findFirst({ where: { adminUserId, disabledAt: null, confirmedAt: { not: null } }, select: { id: true } });
  return f !== null;
}

export interface WhatsappMethodInfo { available: boolean; enrolled: boolean; last4: string | null; mode: "template" | "message" | null }
export async function whatsappMethodInfo(deps: Pick<WhatsappCodeDeps, "prisma" | "sender" | "key">, adminUserId: string): Promise<WhatsappMethodInfo> {
  const f = await deps.prisma.adminWhatsappFactor.findFirst({ where: { adminUserId, disabledAt: null, confirmedAt: { not: null } }, select: { phoneLast4: true } });
  const available = !!deps.sender && !!deps.key && (deps.sender.mode === "template" || !!deps.sender.chatNumber);
  return { available, enrolled: f !== null, last4: f?.phoneLast4 ?? null, mode: available ? deps.sender!.mode : null };
}

function requireAvailable(deps: WhatsappCodeDeps): { sender: WhatsappCodeSender; key: Buffer } {
  if (!deps.sender || !deps.key) throw new WhatsappCodeError("NOT_AVAILABLE", "Codes by WhatsApp are not available right now.");
  return { sender: deps.sender, key: deps.key };
}

async function issueChallenge(
  deps: WhatsappCodeDeps,
  sender: WhatsappCodeSender,
  input: { adminUserId: string; sessionId: string; purpose: WhatsappPurpose; phoneDigits: string },
): Promise<WhatsappIssued> {
  const { prisma, jwtSecret } = deps;
  const now = deps.now();
  const phoneHash = phoneHashOf(jwtSecret, input.phoneDigits);
  const since = (ms: number) => new Date(now.getTime() - ms);
  const [recent, today, toNumber] = await Promise.all([
    prisma.adminWhatsappChallenge.count({ where: { adminUserId: input.adminUserId, createdAt: { gt: since(10 * 60_000) } } }),
    prisma.adminWhatsappChallenge.count({ where: { adminUserId: input.adminUserId, createdAt: { gt: since(24 * 60 * 60_000) } } }),
    // The per-number cap is for numbers being proved (the way to message a stranger). Sign-in codes go only to a number already confirmed.
    input.purpose === "ENROL" ? prisma.adminWhatsappChallenge.count({ where: { phoneHash, purpose: "ENROL", createdAt: { gt: since(60 * 60_000) } } }) : Promise.resolve(0),
  ]);
  if (recent >= SENDS_PER_ACCOUNT_10_MIN || today >= SENDS_PER_ACCOUNT_DAY || toNumber >= SENDS_PER_NUMBER_HOUR) {
    throw new WhatsappCodeError("TOO_MANY", "Too many codes were requested. Wait a few minutes and try again.");
  }
  if (await isBlocked(prisma, input.phoneDigits)) throw new WhatsappCodeError("BLOCKED_NUMBER", "We cannot send messages to that number.");

  // Only the newest request for this session works: an older one still in someone's chat history is retired.
  await prisma.adminWhatsappChallenge.updateMany({ where: { adminUserId: input.adminUserId, sessionId: input.sessionId, consumedAt: null }, data: { consumedAt: now } });
  const challengeId = randomUUID();

  if (sender.mode === "message") {
    // Nothing is sent. The person writes first; the code is made and sent as the reply (see handleAdminCodeMessage). Ten minutes to do so.
    const chatNumber = sender.chatNumber ?? "";
    await prisma.adminWhatsappChallenge.create({
      data: { id: challengeId, adminUserId: input.adminUserId, sessionId: input.sessionId, purpose: input.purpose, codeHash: "awaiting-message", awaitingMessage: true, phoneHash, expiresAt: new Date(now.getTime() + MESSAGE_WAIT_MS), createdAt: now },
    });
    return {
      last4: last4Of(input.phoneDigits), expiresInSeconds: Math.floor(MESSAGE_WAIT_MS / 1000), mode: "message",
      message: { to: chatNumber, text: WHATSAPP_CODE_KEYWORD, url: `https://wa.me/${chatNumber}?text=${encodeURIComponent(WHATSAPP_CODE_KEYWORD)}` },
    };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.adminWhatsappChallenge.create({
    data: { id: challengeId, adminUserId: input.adminUserId, sessionId: input.sessionId, purpose: input.purpose, codeHash: codeHashOf(jwtSecret, challengeId, code), phoneHash, expiresAt: new Date(now.getTime() + WHATSAPP_CODE_TTL_MS), createdAt: now },
  });
  try {
    await sender.send(input.phoneDigits, code);
  } catch {
    await prisma.adminWhatsappChallenge.update({ where: { id: challengeId }, data: { consumedAt: now } });
    throw new WhatsappCodeError("SEND_FAILED", "We could not send the code. Try again in a minute, or use your authenticator app or a recovery code.");
  }
  return { last4: last4Of(input.phoneDigits), expiresInSeconds: Math.floor(WHATSAPP_CODE_TTL_MS / 1000), mode: "template" };
}

/**
 * "Message" mode: a person has just written "ADMIN CODE" to TradePal's WhatsApp number. If that number belongs to a pending request (made from a
 * password-signed-in session, within ten minutes), make the code and reply with it, which is allowed because they wrote first. Returns true when the
 * message was handled here (the caller then does not treat it as an ordinary message); false for everything else, so any other message, and a
 * "ADMIN CODE" from a number nobody asked about, flows on exactly as before. Never sends to anyone who has not just written.
 */
export async function handleAdminCodeMessage(deps: WhatsappCodeDeps, message: { from: string; text: string }): Promise<boolean> {
  if (deps.sender?.mode !== "message" || !KEYWORD_RE.test(message.text)) return false;
  const digits = message.from.replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) return false;
  const now = deps.now();
  const phoneHash = phoneHashOf(deps.jwtSecret, digits);
  const pending = await deps.prisma.adminWhatsappChallenge.findFirst({
    where: { phoneHash, awaitingMessage: true, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) return false;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const claimed = await deps.prisma.adminWhatsappChallenge.updateMany({
    where: { id: pending.id, awaitingMessage: true, consumedAt: null },
    data: { awaitingMessage: false, codeHash: codeHashOf(deps.jwtSecret, pending.id, code), attempts: 0, expiresAt: new Date(now.getTime() + WHATSAPP_CODE_TTL_MS) },
  });
  if (claimed.count !== 1) return true; // a repeat of the same message a moment later: already answered
  try {
    await deps.sender.send(digits, code);
  } catch {
    await deps.prisma.adminWhatsappChallenge.update({ where: { id: pending.id }, data: { consumedAt: now } });
  }
  return true;
}

/** Starts adding a number: stores it (encrypted, unconfirmed) and sends the proving code. Refuses when a number is already confirmed. */
export async function startWhatsappEnrolment(deps: WhatsappCodeDeps, admin: { id: string }, sessionId: string, phoneInput: string): Promise<WhatsappIssued> {
  const { sender, key } = requireAvailable(deps);
  const digits = normalisePhone(phoneInput);
  if (await hasConfirmedWhatsapp(deps.prisma, admin.id)) throw new WhatsappCodeError("ALREADY_ENROLLED", "A WhatsApp number is already set up. Remove it first to use a different one.");
  const data = { phoneCiphertext: encryptSecret(key, digits), phoneHash: phoneHashOf(deps.jwtSecret, digits), phoneLast4: last4Of(digits), confirmedAt: null, lastUsedAt: null, disabledAt: null, createdAt: deps.now() };
  await deps.prisma.adminWhatsappFactor.upsert({ where: { adminUserId: admin.id }, create: { adminUserId: admin.id, ...data }, update: data });
  return issueChallenge(deps, sender, { adminUserId: admin.id, sessionId, purpose: "ENROL", phoneDigits: digits });
}

/** Sends a sign-in (or re-authentication) code to the confirmed number. */
export async function sendWhatsappCode(deps: WhatsappCodeDeps, admin: { id: string }, sessionId: string, purpose: "SIGNIN" | "REAUTH"): Promise<WhatsappIssued> {
  const { sender, key } = requireAvailable(deps);
  const factor = await deps.prisma.adminWhatsappFactor.findFirst({ where: { adminUserId: admin.id, disabledAt: null, confirmedAt: { not: null } } });
  if (!factor) throw new WhatsappCodeError("NO_FACTOR", "No WhatsApp number is set up for this account.");
  return issueChallenge(deps, sender, { adminUserId: admin.id, sessionId, purpose, phoneDigits: decryptSecret(key, factor.phoneCiphertext) });
}

/**
 * Checks a code against the newest live challenge of this session. Every try counts first (so parallel guesses cannot beat the limit),
 * a wrong code never says why, and a right code is claimed atomically: it works once.
 */
async function verifyChallenge(deps: WhatsappCodeDeps, adminUserId: string, sessionId: string, purposes: WhatsappPurpose[], code: string): Promise<void> {
  const cleaned = code.replace(/[\s-]/g, "");
  const bad = new WhatsappCodeError("BAD_CODE", "That code is not right.");
  if (!/^\d{6}$/.test(cleaned)) throw bad;
  const now = deps.now();
  const challenge = await deps.prisma.adminWhatsappChallenge.findFirst({
    where: { adminUserId, sessionId, purpose: { in: purposes }, consumedAt: null, awaitingMessage: false, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw bad;
  const counted = await deps.prisma.adminWhatsappChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, attempts: { lt: WHATSAPP_MAX_GUESSES } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) throw bad;
  const expected = Buffer.from(challenge.codeHash, "hex");
  const given = Buffer.from(codeHashOf(deps.jwtSecret, challenge.id, cleaned), "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    if (challenge.attempts + 1 >= WHATSAPP_MAX_GUESSES) await deps.prisma.adminWhatsappChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } });
    throw bad;
  }
  const claimed = await deps.prisma.adminWhatsappChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } });
  if (claimed.count !== 1) throw bad;
}

/** Confirms the number with the code sent to it. Returns recovery codes only when this is the person's first second factor. */
export async function confirmWhatsappEnrolment(deps: WhatsappCodeDeps, adminUserId: string, sessionId: string, code: string): Promise<{ recoveryCodes?: string[] }> {
  await verifyChallenge(deps, adminUserId, sessionId, ["ENROL"], code);
  const now = deps.now();
  const confirmed = await deps.prisma.adminWhatsappFactor.updateMany({ where: { adminUserId, confirmedAt: null, disabledAt: null }, data: { confirmedAt: now, lastUsedAt: now } });
  if (confirmed.count !== 1) throw new WhatsappCodeError("NO_FACTOR", "Start by entering your WhatsApp number.");
  const haveCodes = (await deps.prisma.adminRecoveryCode.count({ where: { adminUserId, usedAt: null } })) > 0;
  return haveCodes ? {} : { recoveryCodes: (await regenerateRecoveryCodes(deps.prisma, adminUserId)).recoveryCodes };
}

/** A sign-in or re-authentication code. */
export async function verifyWhatsappCode(deps: WhatsappCodeDeps, adminUserId: string, sessionId: string, purposes: Array<"SIGNIN" | "REAUTH">, code: string): Promise<void> {
  if (!(await hasConfirmedWhatsapp(deps.prisma, adminUserId))) throw new WhatsappCodeError("NO_FACTOR", "No WhatsApp number is set up for this account.");
  await verifyChallenge(deps, adminUserId, sessionId, purposes, code);
  await deps.prisma.adminWhatsappFactor.updateMany({ where: { adminUserId, disabledAt: null }, data: { lastUsedAt: deps.now() } });
}

/** Whether a live (unused, unexpired) code has been sent for this session: tells a re-authentication which kind of code it was given. */
export async function hasLiveWhatsappCode(deps: WhatsappCodeDeps, adminUserId: string, sessionId: string): Promise<boolean> {
  const c = await deps.prisma.adminWhatsappChallenge.findFirst({ where: { adminUserId, sessionId, consumedAt: null, awaitingMessage: false, expiresAt: { gt: deps.now() } }, select: { id: true } });
  return c !== null;
}

/** Removes the number and any codes in flight. */
export async function removeWhatsappFactor(prisma: PrismaClient, adminUserId: string): Promise<void> {
  await prisma.$transaction([
    prisma.adminWhatsappChallenge.deleteMany({ where: { adminUserId } }),
    prisma.adminWhatsappFactor.deleteMany({ where: { adminUserId } }),
  ]);
}
