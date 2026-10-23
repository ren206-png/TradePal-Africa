import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, constants } from "node:crypto";

/**
 * Verification of pawaPay's SIGNED CALLBACKS: HTTP Message Signatures (RFC 9421) with a Content-Digest (RFC 9530), as pawaPay
 * documents at https://docs.pawapay.io/v2/docs/signatures (fetched 2026-10-20). This is NOT a generic HMAC header scheme.
 *
 * What a callback carries (per that page): `Signature: sig-pp=:<base64>:`, `Signature-Input` naming the covered components and the
 * parameters `alg`, `keyid`, `created`, `expires`, `Signature-Date`, `Content-Type`, and `Content-Digest` (sha-256 or sha-512).
 *
 * What is verified here, failing CLOSED on every doubt:
 *  1. the body matches the Content-Digest (every digest we understand must match; at least one must be understood);
 *  2. the signature input names the components we require (`@method`, `@authority`, `@path`, `content-digest`) and only components we
 *     know how to rebuild;
 *  3. `created` and `expires` are present and the message is inside its window (small clock skew allowed), with a sane lifetime;
 *  4. the signature base is rebuilt from OUR configured authority and path (never from the Host header an attacker could set) and
 *     verified with the public key named by `keyid`, using one of the four algorithms the page lists.
 * Key lookup and rotation are the caller's job (`resolveKey`): an unknown key id returns `UNKNOWN_KEY` so the caller can refresh its
 * keys once and retry.
 *
 * NOT VERIFIED against a real pawaPay callback: no sandbox account exists yet. The page gives no verification pseudocode, no key
 * rotation rules and no replay rules; the choices above (required components, window checks, skew) are ours and are recorded in
 * docs/expansion/pawapay-audit.md.
 */
export type SignatureFailure =
  | "MISSING_HEADERS" | "BAD_SIGNATURE_INPUT" | "UNSUPPORTED_COMPONENT" | "MISSING_REQUIRED_COMPONENT" | "UNSUPPORTED_ALGORITHM" | "MISSING_TIMES"
  | "NOT_YET_VALID" | "EXPIRED" | "LIFETIME_TOO_LONG" | "DIGEST_MISSING" | "DIGEST_MISMATCH" | "UNKNOWN_KEY" | "BAD_SIGNATURE";

export type VerifyResult = { ok: true; keyId: string; alg: string; created: number; expires: number } | { ok: false; reason: SignatureFailure };

export interface VerifyInput {
  method: string;
  /** Our own configured public authority (host[:port]) and path for this callback URL, exactly as pawaPay was told. */
  authority: string;
  path: string;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  /** Seconds since the epoch. */
  now: number;
  skewSeconds?: number;
  maxLifetimeSeconds?: number;
  /** Returns the PEM public key for a key id, or null. */
  resolveKey: (keyId: string) => Promise<string | null>;
}

const LABEL = "sig-pp";
const REQUIRED = ["@method", "@authority", "@path", "content-digest"];
const DERIVED = new Set(["@method", "@authority", "@path", "@scheme", "@target-uri", "@query"]);

interface Parsed {
  components: string[];
  paramsText: string; // the raw `(...);alg=...` text after `label=`, used verbatim in the signature base
  alg?: string;
  keyid?: string;
  created?: number;
  expires?: number;
}

/** Splits a structured-field dictionary on top-level commas (not inside quotes or parentheses). */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSignatureInput(header: string): Parsed | null {
  const member = splitTop(header).find((m) => m.startsWith(`${LABEL}=`));
  if (!member) return null;
  const paramsText = member.slice(LABEL.length + 1);
  const m = /^\(([^)]*)\)(.*)$/.exec(paramsText);
  if (!m) return null;
  const components: string[] = [];
  for (const c of m[1]!.trim().split(/\s+/).filter(Boolean)) {
    const q = /^"([^"]+)"$/.exec(c);
    if (!q) return null; // parameters on a component identifier (for example ;sf, ;key) are not supported: fail closed
    components.push(q[1]!);
  }
  const parsed: Parsed = { components, paramsText };
  for (const part of m[2]!.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const k = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    const str = /^"(.*)"$/.exec(raw);
    if (k === "alg") parsed.alg = str ? str[1]! : raw;
    else if (k === "keyid") parsed.keyid = str ? str[1]! : raw;
    else if (k === "created" || k === "expires") {
      if (!/^\d{1,12}$/.test(raw)) return null;
      parsed[k] = Number(raw);
    }
  }
  return parsed;
}

function parseSignature(header: string): Buffer | null {
  const member = splitTop(header).find((m) => m.startsWith(`${LABEL}=`));
  const m = member ? /^[^=]+=:([A-Za-z0-9+/=]+):$/.exec(member) : null;
  return m ? Buffer.from(m[1]!, "base64") : null;
}

/** Content-Digest dictionary: `sha-256=:base64:, sha-512=:base64:`. Every algorithm we understand must match the body. */
function digestOk(header: string, body: Buffer): "OK" | "MISMATCH" | "NONE" {
  let understood = 0;
  for (const member of splitTop(header)) {
    const m = /^(sha-256|sha-512)=:([A-Za-z0-9+/=]+):$/.exec(member);
    if (!m) continue;
    understood++;
    const expected = createHash(m[1] === "sha-256" ? "sha256" : "sha512").update(body).digest();
    const given = Buffer.from(m[2]!, "base64");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "MISMATCH";
  }
  return understood > 0 ? "OK" : "NONE";
}

function componentValue(name: string, input: VerifyInput): string | null {
  switch (name) {
    case "@method": return input.method.toUpperCase();
    case "@authority": return input.authority.toLowerCase();
    case "@path": return input.path;
    case "@scheme": return "https";
    case "@target-uri": return `https://${input.authority.toLowerCase()}${input.path}`;
    case "@query": return "?"; // we never accept a callback URL with a query string
    default: {
      const v = input.headers[name];
      return v === undefined ? null : v.trim().replace(/\s+/g, " ");
    }
  }
}

function verifyWithAlg(alg: string, key: ReturnType<typeof createPublicKey>, data: Buffer, sig: Buffer): boolean {
  switch (alg) {
    case "ecdsa-p256-sha256": return key.asymmetricKeyType === "ec" && sig.length === 64 && cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    case "ecdsa-p384-sha384": return key.asymmetricKeyType === "ec" && sig.length === 96 && cryptoVerify("sha384", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    case "rsa-pss-sha512": return key.asymmetricKeyType === "rsa-pss" || key.asymmetricKeyType === "rsa" ? cryptoVerify("sha512", data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }, sig) : false;
    case "rsa-v1_5-sha256": return key.asymmetricKeyType === "rsa" && cryptoVerify("sha256", data, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
    default: return false;
  }
}
const SUPPORTED_ALGS = new Set(["ecdsa-p256-sha256", "ecdsa-p384-sha384", "rsa-pss-sha512", "rsa-v1_5-sha256"]);

export async function verifyPawaPayCallback(input: VerifyInput): Promise<VerifyResult> {
  const h = (n: string) => input.headers[n];
  const sigInput = h("signature-input");
  const sigHeader = h("signature");
  const digestHeader = h("content-digest");
  if (!sigInput || !sigHeader) return { ok: false, reason: "MISSING_HEADERS" };
  if (!digestHeader) return { ok: false, reason: "DIGEST_MISSING" };

  const parsed = parseSignatureInput(sigInput);
  const signature = parseSignature(sigHeader);
  if (!parsed || !signature) return { ok: false, reason: "BAD_SIGNATURE_INPUT" };
  for (const c of parsed.components) if (!DERIVED.has(c) && !/^[a-z0-9-]+$/.test(c)) return { ok: false, reason: "UNSUPPORTED_COMPONENT" };
  for (const r of REQUIRED) if (!parsed.components.includes(r)) return { ok: false, reason: "MISSING_REQUIRED_COMPONENT" };
  if (!parsed.alg || !SUPPORTED_ALGS.has(parsed.alg)) return { ok: false, reason: "UNSUPPORTED_ALGORITHM" };
  if (!parsed.keyid) return { ok: false, reason: "BAD_SIGNATURE_INPUT" };
  if (parsed.created === undefined || parsed.expires === undefined) return { ok: false, reason: "MISSING_TIMES" };

  const skew = input.skewSeconds ?? 60;
  if (parsed.created > input.now + skew) return { ok: false, reason: "NOT_YET_VALID" };
  if (parsed.expires < input.now - skew) return { ok: false, reason: "EXPIRED" };
  if (parsed.expires - parsed.created > (input.maxLifetimeSeconds ?? 600) || parsed.expires <= parsed.created) return { ok: false, reason: "LIFETIME_TOO_LONG" };

  const d = digestOk(digestHeader, input.rawBody);
  if (d === "NONE") return { ok: false, reason: "DIGEST_MISSING" };
  if (d === "MISMATCH") return { ok: false, reason: "DIGEST_MISMATCH" };

  const lines: string[] = [];
  for (const c of parsed.components) {
    const v = componentValue(c, input);
    if (v === null) return { ok: false, reason: "MISSING_REQUIRED_COMPONENT" };
    lines.push(`"${c}": ${v}`);
  }
  lines.push(`"@signature-params": ${parsed.paramsText}`);
  const base = Buffer.from(lines.join("\n"), "utf8");

  const pem = await input.resolveKey(parsed.keyid);
  if (!pem) return { ok: false, reason: "UNKNOWN_KEY" };
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    return { ok: false, reason: "UNKNOWN_KEY" };
  }
  let good = false;
  try {
    good = verifyWithAlg(parsed.alg, key, base, signature);
  } catch {
    good = false;
  }
  return good ? { ok: true, keyId: parsed.keyid, alg: parsed.alg, created: parsed.created, expires: parsed.expires } : { ok: false, reason: "BAD_SIGNATURE" };
}
