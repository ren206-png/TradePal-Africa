import { describe, expect, it } from "vitest";
import { isValidFlutterwaveWebhookSignature } from "../src/flutterwave/signature.js";

const SECRET_HASH = "test-webhook-secret-hash";

describe("isValidFlutterwaveWebhookSignature", () => {
  it("accepts a header matching the configured secret hash", () => {
    expect(isValidFlutterwaveWebhookSignature(SECRET_HASH, SECRET_HASH)).toBe(true);
  });

  it("rejects a header that doesn't match the configured secret hash", () => {
    expect(isValidFlutterwaveWebhookSignature("wrong-hash", SECRET_HASH)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isValidFlutterwaveWebhookSignature(undefined, SECRET_HASH)).toBe(false);
  });

  it("rejects a header of a different length than the secret hash", () => {
    expect(isValidFlutterwaveWebhookSignature("short", SECRET_HASH)).toBe(false);
  });
});
