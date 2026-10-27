import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { generateSecret, generateURI, verify } from "otplib";

/**
 * Second factor for staff (admin-console Phase 2): TOTP (RFC 6238) through the maintained `otplib` library, with the secret encrypted at
 * rest (AES-256-GCM from node:crypto, the standard library: no home-made primitive), a replay guard (a code is good once), and eight
 * single-use recovery codes stored only as bcrypt hashes.
 *
 * Secrets, codes and recovery codes are never logged and never returned again after the response that first shows them.
 */
export const TOTP_ISSUER = "TradePal Admin";
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const CODE_RE = /^\d{6}$/;
/** One 30-second step either side of now, for clock drift between the server and a phone. */
const EPOCH_TOLERANCE_SECONDS = 30;

export class MfaError extends Error {
  readonly code: "NO_KEY" | "NO_FACTOR" | "ALREADY_ENROLLED" | "BAD_CODE" | "REPLAY";
  constructor(code: MfaError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------- secret at rest

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptSecret(key: Buffer, stored: string): string {
  if (!stored.startsWith("v1:")) throw new Error("Unknown secret format.");
  const raw = Buffer.from(stored.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** A valid TOTP result carries the time step the code belongs to (the HOTP shape of the library's union has none). */
function timeStepOf(result: { valid: boolean }): number {
  const step = (result as { timeStep?: unknown }).timeStep;
  if (typeof step !== "number") throw new MfaError("BAD_CODE", "That code is not right.");
  return step;
}

const epochOf = (d: Date): number => Math.floor(d.getTime() / 1000);

export function normaliseCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

// ------------------------------------------------------------------------------------------------- enrolment

/** An authenticator app is set up and confirmed. */
export async function hasConfirmedTotp(prisma: PrismaClient, adminUserId: string): Promise<boolean> {
  const f = await prisma.adminMfaFactor.findFirst({ where: { adminUserId, disabledAt: null, confirmedAt: { not: null } }, select: { id: true } });
  return f !== null;
}

/** Any second factor is set up and confirmed: an authenticator app, or a WhatsApp number (see whatsappCodes.ts). */
export async function hasConfirmedFactor(prisma: PrismaClient, adminUserId: string): Promise<boolean> {
  if (await hasConfirmedTotp(prisma, adminUserId)) return true;
  const w = await prisma.adminWhatsappFactor.findFirst({ where: { adminUserId, disabledAt: null, confirmedAt: { not: null } }, select: { id: true } });
  return w !== null;
}

/** Starts (or restarts) enrolment: an unconfirmed factor with a fresh secret. Refuses when a confirmed factor already exists. */
export async function startEnrolment(prisma: PrismaClient, key: Buffer | undefined, admin: { id: string; email: string }): Promise<{ secret: string; otpauthUri: string }> {
  if (!key) throw new MfaError("NO_KEY", "Second-factor enrolment is not configured on this server.");
  if (await hasConfirmedTotp(prisma, admin.id)) throw new MfaError("ALREADY_ENROLLED", "A second factor is already set up for this account.");
  const secret = generateSecret();
  await prisma.$transaction(async (tx) => {
    await tx.adminMfaFactor.updateMany({ where: { adminUserId: admin.id, disabledAt: null, confirmedAt: null }, data: { disabledAt: new Date() } });
    await tx.adminMfaFactor.create({ data: { adminUserId: admin.id, secretCiphertext: encryptSecret(key, secret) } });
  });
  return { secret, otpauthUri: generateURI({ issuer: TOTP_ISSUER, label: admin.email, secret }) };
}

/** Confirms enrolment with a first valid code, and issues the recovery codes (shown once, only hashes kept). */
export async function confirmEnrolment(prisma: PrismaClient, key: Buffer | undefined, adminUserId: string, code: string, now: Date = new Date()): Promise<{ recoveryCodes: string[] }> {
  if (!key) throw new MfaError("NO_KEY", "Second-factor enrolment is not configured on this server.");
  const factor = await prisma.adminMfaFactor.findFirst({ where: { adminUserId, disabledAt: null, confirmedAt: null }, orderBy: { createdAt: "desc" } });
  if (!factor) throw new MfaError("NO_FACTOR", "Start enrolment first.");
  const cleaned = normaliseCode(code);
  if (!CODE_RE.test(cleaned)) throw new MfaError("BAD_CODE", "That code is not right.");
  const result = await verify({ secret: decryptSecret(key, factor.secretCiphertext), token: cleaned, epoch: epochOf(now), epochTolerance: EPOCH_TOLERANCE_SECONDS });
  if (!result.valid) throw new MfaError("BAD_CODE", "That code is not right.");
  const recoveryCodes = newRecoveryCodes();
  const batchId = randomBytes(8).toString("hex");
  const hashes = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(normaliseCode(c), 10)));
  await prisma.$transaction(async (tx) => {
    const confirmed = await tx.adminMfaFactor.updateMany({
      where: { id: factor.id, confirmedAt: null, disabledAt: null },
      data: { confirmedAt: now, lastUsedCounter: BigInt(timeStepOf(result)) },
    });
    if (confirmed.count !== 1) throw new MfaError("NO_FACTOR", "Start enrolment first.");
    await tx.adminRecoveryCode.deleteMany({ where: { adminUserId } });
    await tx.adminRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ adminUserId, batchId, codeHash })) });
  });
  return { recoveryCodes };
}

// -------------------------------------------------------------------------------------------------- verifying

/** Checks a sign-in code against the confirmed factor. A code that was already used (same or earlier time step) is refused (replay). */
export async function verifyTotp(prisma: PrismaClient, key: Buffer | undefined, adminUserId: string, code: string, now: Date = new Date()): Promise<void> {
  if (!key) throw new MfaError("NO_KEY", "Second-factor sign-in is not configured on this server.");
  const factor = await prisma.adminMfaFactor.findFirst({ where: { adminUserId, disabledAt: null, confirmedAt: { not: null } } });
  if (!factor) throw new MfaError("NO_FACTOR", "No second factor is set up for this account.");
  const cleaned = normaliseCode(code);
  if (!CODE_RE.test(cleaned)) throw new MfaError("BAD_CODE", "That code is not right.");
  const secret = decryptSecret(key, factor.secretCiphertext);
  const last = factor.lastUsedCounter === null ? undefined : Number(factor.lastUsedCounter);
  const result = await verify({ secret, token: cleaned, epoch: epochOf(now), epochTolerance: EPOCH_TOLERANCE_SECONDS, ...(last !== undefined ? { afterTimeStep: last } : {}) });
  if (!result.valid) {
    // Distinguish "right code, already used" from "wrong code" only inside the server (for the event record), never to the caller.
    const replay = await verify({ secret, token: cleaned, epoch: epochOf(now), epochTolerance: EPOCH_TOLERANCE_SECONDS });
    throw new MfaError(replay.valid ? "REPLAY" : "BAD_CODE", "That code is not right.");
  }
  // Move the replay guard forward atomically: if two requests carry the same code at once, only one wins.
  const step = BigInt(timeStepOf(result));
  const moved = await prisma.adminMfaFactor.updateMany({
    where: { id: factor.id, OR: [{ lastUsedCounter: null }, { lastUsedCounter: { lt: step } }] },
    data: { lastUsedCounter: step },
  });
  if (moved.count !== 1) throw new MfaError("REPLAY", "That code is not right.");
}

// ---------------------------------------------------------------------------------------------- recovery codes

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const pick = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${pick()}-${pick()}`;
  });
}

/** Uses one recovery code. Returns how many unused codes remain. The code is single-use: the winner of a race marks it used. */
export async function useRecoveryCode(prisma: PrismaClient, adminUserId: string, code: string, now: Date = new Date()): Promise<{ remaining: number }> {
  const cleaned = normaliseCode(code).toUpperCase();
  const unused = await prisma.adminRecoveryCode.findMany({ where: { adminUserId, usedAt: null } });
  for (const row of unused) {
    if (cleaned.length === 10 && (await bcrypt.compare(cleaned, row.codeHash))) {
      const claimed = await prisma.adminRecoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count !== 1) break; // someone else used it a moment ago
      return { remaining: unused.length - 1 };
    }
  }
  throw new MfaError("BAD_CODE", "That code is not right.");
}

export async function regenerateRecoveryCodes(prisma: PrismaClient, adminUserId: string): Promise<{ recoveryCodes: string[] }> {
  const recoveryCodes = newRecoveryCodes();
  const batchId = randomBytes(8).toString("hex");
  const hashes = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(normaliseCode(c), 10)));
  await prisma.$transaction(async (tx) => {
    await tx.adminRecoveryCode.deleteMany({ where: { adminUserId } });
    await tx.adminRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ adminUserId, batchId, codeHash })) });
  });
  return { recoveryCodes };
}

/** Removes the second factor and recovery codes for one admin (the lockout-recovery command). The person must enrol again at next sign-in. */
export async function resetMfaFor(prisma: PrismaClient, adminUserId: string, now: Date = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.adminMfaFactor.updateMany({ where: { adminUserId, disabledAt: null }, data: { disabledAt: now } });
    await tx.adminWhatsappChallenge.deleteMany({ where: { adminUserId } });
    await tx.adminWhatsappFactor.deleteMany({ where: { adminUserId } });
    await tx.adminRecoveryCode.deleteMany({ where: { adminUserId } });
    await tx.adminUser.update({ where: { id: adminUserId }, data: { mfaRequiredAt: now } });
  });
}
