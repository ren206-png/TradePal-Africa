import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { isValidWebhookSignature } from "../src/whatsapp/signature.js";

const APP_SECRET = "test-app-secret";

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("isValidWebhookSignature", () => {
  it("accepts a signature computed with the correct app secret", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = sign(body.toString(), APP_SECRET);
    expect(isValidWebhookSignature(body, signature, APP_SECRET)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = sign(body.toString(), "wrong-secret");
    expect(isValidWebhookSignature(body, signature, APP_SECRET)).toBe(false);
  });

  it("rejects a signature that doesn't match the body (tampered payload)", () => {
    const originalBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = sign(originalBody.toString(), APP_SECRET);
    const tamperedBody = Buffer.from(JSON.stringify({ hello: "tampered" }));
    expect(isValidWebhookSignature(tamperedBody, signature, APP_SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(isValidWebhookSignature(body, undefined, APP_SECRET)).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(isValidWebhookSignature(body, "not-a-real-signature", APP_SECRET)).toBe(false);
  });
});
