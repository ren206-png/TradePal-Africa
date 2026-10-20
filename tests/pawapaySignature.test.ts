import { describe, expect, it } from "vitest";
import { constants, createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyPawaPayCallback, type VerifyInput } from "../src/pawapay/signature.js";

/**
 * These vectors are produced by an independent, minimal RFC 9421 signer written in this file. They prove the verifier agrees with the
 * RFC's construction (signature base, derived components, structured-field parameters); they are NOT captured from a real pawaPay
 * callback (no sandbox account exists), so compatibility with pawaPay's actual messages remains to be verified in the sandbox.
 */
const AUTHORITY = "api.tradepal.example";
const PATH = "/webhooks/pawapay/billing";
const NOW = 1_714_657_560;
const BODY = Buffer.from(JSON.stringify({ depositId: "11111111-1111-4111-8111-111111111111", status: "COMPLETED" }));

type Alg = "ecdsa-p256-sha256" | "ecdsa-p384-sha384" | "rsa-pss-sha512" | "rsa-v1_5-sha256";
const keys = {
  ec256: generateKeyPairSync("ec", { namedCurve: "P-256" }),
  ec384: generateKeyPairSync("ec", { namedCurve: "P-384" }),
  rsa: generateKeyPairSync("rsa", { modulusLength: 2048 }),
};
const pem = (k: { publicKey: import("node:crypto").KeyObject }) => k.publicKey.export({ type: "spki", format: "pem" }).toString();

function signed(opts: { alg?: Alg; keyId?: string; created?: number; expires?: number; components?: string[]; body?: Buffer; digestAlg?: "sha-256" | "sha-512"; authority?: string; path?: string; omit?: string[] } = {}) {
  const alg = opts.alg ?? "ecdsa-p256-sha256";
  const body = opts.body ?? BODY;
  const created = opts.created ?? NOW - 5;
  const expires = opts.expires ?? NOW + 55;
  const components = opts.components ?? ["@method", "@authority", "@path", "signature-date", "content-digest", "content-type"];
  const digestAlg = opts.digestAlg ?? "sha-256";
  const headers: Record<string, string> = {
    "content-type": "application/json", "signature-date": new Date(created * 1000).toUTCString(),
    "content-digest": `${digestAlg}=:${createHash(digestAlg === "sha-256" ? "sha256" : "sha512").update(body).digest("base64")}:`,
  };
  const params = `(${components.map((c) => `"${c}"`).join(" ")});alg="${alg}";keyid="${opts.keyId ?? "TEST_KEY"}";created=${created};expires=${expires}`;
  const value = (c: string) => (c === "@method" ? "POST" : c === "@authority" ? (opts.authority ?? AUTHORITY) : c === "@path" ? (opts.path ?? PATH) : headers[c]!);
  const base = [...components.map((c) => `"${c}": ${value(c)}`), `"@signature-params": ${params}`].join("\n");
  const data = Buffer.from(base);
  const sig =
    alg === "ecdsa-p256-sha256" ? cryptoSign("sha256", data, { key: keys.ec256.privateKey, dsaEncoding: "ieee-p1363" })
    : alg === "ecdsa-p384-sha384" ? cryptoSign("sha384", data, { key: keys.ec384.privateKey, dsaEncoding: "ieee-p1363" })
    : alg === "rsa-pss-sha512" ? cryptoSign("sha512", data, { key: keys.rsa.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 })
    : cryptoSign("sha256", data, { key: keys.rsa.privateKey, padding: constants.RSA_PKCS1_PADDING });
  headers["signature-input"] = `sig-pp=${params}`;
  headers["signature"] = `sig-pp=:${sig.toString("base64")}:`;
  for (const o of opts.omit ?? []) delete headers[o];
  return { headers, body };
}

const keyFor = (alg: Alg) => (alg === "ecdsa-p256-sha256" ? pem(keys.ec256) : alg === "ecdsa-p384-sha384" ? pem(keys.ec384) : pem(keys.rsa));
const verify = (m: { headers: Record<string, string>; body: Buffer }, over: Partial<VerifyInput> = {}, alg: Alg = "ecdsa-p256-sha256") =>
  verifyPawaPayCallback({ method: "POST", authority: AUTHORITY, path: PATH, headers: m.headers, rawBody: m.body, now: NOW, resolveKey: async (id) => (id === "TEST_KEY" ? keyFor(alg) : null), ...over });

describe("pawaPay signed-callback verification (RFC 9421 + Content-Digest)", () => {
  it.each<Alg>(["ecdsa-p256-sha256", "ecdsa-p384-sha384", "rsa-pss-sha512", "rsa-v1_5-sha256"])("accepts a valid message signed with %s", async (alg) => {
    expect(await verify(signed({ alg }), {}, alg)).toMatchObject({ ok: true, keyId: "TEST_KEY", alg });
  });

  it("accepts sha-512 digests and rejects a body that was changed after signing", async () => {
    expect(await verify(signed({ digestAlg: "sha-512" }))).toMatchObject({ ok: true });
    const m = signed();
    expect(await verify({ ...m, body: Buffer.from(m.body.toString().replace("COMPLETED", "FAILED_")) })).toEqual({ ok: false, reason: "DIGEST_MISMATCH" });
    const both = signed();
    both.headers["content-digest"] += `, sha-512=:${createHash("sha512").update("something else").digest("base64")}:`;
    expect(await verify(both)).toEqual({ ok: false, reason: "DIGEST_MISMATCH" }); // every digest we understand must match
  });

  it("rejects a forged signature, a different key, a different authority or path, and a re-signed body with a stale digest", async () => {
    const m = signed();
    const flipped = { ...m, headers: { ...m.headers, signature: m.headers["signature"]!.replace(/^(sig-pp=:.{10})(.)/, (_x, a: string, c: string) => a + (c === "A" ? "B" : "A")) } };
    expect((await verify(flipped)).ok).toBe(false);
    expect(await verify(m, { resolveKey: async () => pem(generateKeyPairSync("ec", { namedCurve: "P-256" })) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(await verify(m, { authority: "evil.example" })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(await verify(m, { path: "/other" })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(await verify(m, { method: "GET" })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    const lyingHost = { ...m, headers: { ...m.headers, host: "evil.example" } };
    expect(await verify(lyingHost)).toMatchObject({ ok: true }); // the Host header is ignored: only OUR configured authority is used
    const wrongAlgKey = await verify(m, { resolveKey: async () => pem(keys.rsa) });
    expect(wrongAlgKey).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("enforces the validity window, requires created and expires, and rejects absurd lifetimes", async () => {
    expect(await verify(signed({ created: NOW - 600, expires: NOW - 300 }))).toEqual({ ok: false, reason: "EXPIRED" });
    expect(await verify(signed({ created: NOW + 600, expires: NOW + 660 }))).toEqual({ ok: false, reason: "NOT_YET_VALID" });
    expect(await verify(signed({ created: NOW - 5, expires: NOW + 100_000 }))).toEqual({ ok: false, reason: "LIFETIME_TOO_LONG" });
    expect(await verify(signed({ created: NOW - 5, expires: NOW - 6 }))).toEqual({ ok: false, reason: "LIFETIME_TOO_LONG" });
    expect(await verify(signed({ created: NOW - 5, expires: NOW - 1 }))).toMatchObject({ ok: true }); // inside the 60 s skew
    const noTimes = signed();
    noTimes.headers["signature-input"] = noTimes.headers["signature-input"]!.replace(/;created=\d+;expires=\d+/, "");
    expect(await verify(noTimes)).toEqual({ ok: false, reason: "MISSING_TIMES" });
  });

  it("fails closed on missing headers, missing digest coverage, unsupported components and algorithms, and unknown keys", async () => {
    expect(await verify(signed({ omit: ["signature"] }))).toEqual({ ok: false, reason: "MISSING_HEADERS" });
    expect(await verify(signed({ omit: ["signature-input"] }))).toEqual({ ok: false, reason: "MISSING_HEADERS" });
    expect(await verify(signed({ omit: ["content-digest"] }))).toEqual({ ok: false, reason: "DIGEST_MISSING" });
    expect(await verify(signed({ components: ["@method", "@authority", "@path", "content-type"] }))).toEqual({ ok: false, reason: "MISSING_REQUIRED_COMPONENT" });
    expect(await verify(signed({ components: ["@method", "@authority", "content-digest"] }))).toEqual({ ok: false, reason: "MISSING_REQUIRED_COMPONENT" });
    const odd = signed();
    odd.headers["signature-input"] = odd.headers["signature-input"]!.replace(/alg="[^"]+"/, 'alg="hmac-sha256"');
    expect(await verify(odd)).toEqual({ ok: false, reason: "UNSUPPORTED_ALGORITHM" });
    expect(await verify(signed({ keyId: "ROTATED_KEY" }))).toEqual({ ok: false, reason: "UNKNOWN_KEY" });
    const paramComponent = signed();
    paramComponent.headers["signature-input"] = paramComponent.headers["signature-input"]!.replace('"content-type"', '"content-type";sf');
    expect(await verify(paramComponent)).toEqual({ ok: false, reason: "BAD_SIGNATURE_INPUT" });
    const wrongLabel = signed();
    wrongLabel.headers["signature-input"] = wrongLabel.headers["signature-input"]!.replace("sig-pp=", "sig1=");
    expect(await verify(wrongLabel)).toEqual({ ok: false, reason: "BAD_SIGNATURE_INPUT" });
    const garbage = signed();
    garbage.headers["signature"] = "sig-pp=:not base64 !!:";
    expect(await verify(garbage)).toEqual({ ok: false, reason: "BAD_SIGNATURE_INPUT" });
  });
});
