import crypto from "node:crypto";

/**
 * Verifies Meta's `X-Hub-Signature-256` header against the raw request body.
 * Must run against the raw (unparsed) bytes — re-serializing a parsed JSON
 * body can produce different bytes than what Meta signed, which is why the
 * caller must capture the raw body before express.json() parses it.
 */
export function isValidWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;

  const [algo, providedDigestHex] = signatureHeader.split("=");
  if (algo !== "sha256" || !providedDigestHex) return false;

  const expectedDigest = crypto.createHmac("sha256", appSecret).update(rawBody).digest();

  let providedDigest: Buffer;
  try {
    providedDigest = Buffer.from(providedDigestHex, "hex");
  } catch {
    return false;
  }

  if (providedDigest.length !== expectedDigest.length) return false;
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}
