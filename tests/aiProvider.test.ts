import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { isAiProviderConfigurationError } from "../src/ai/provider.js";

/**
 * Regression coverage for the 2026-08-04–2026-08-09 production outage: a $0
 * credit balance made every AI-parse call fail with the same generic incident
 * title as an ordinary transient blip, so the outage never stood out from
 * routine noise. isAiProviderConfigurationError is what now distinguishes
 * "will recover on its own" from "needs a human" — see its doc comment in
 * src/ai/provider.ts for the full rationale.
 */
function apiError(status: number, error: object | undefined, message = "error"): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(status, error, message, new Headers());
}

describe("isAiProviderConfigurationError", () => {
  it("returns true for a 400 invalid_request_error with a credit-balance message (the actual production shape)", () => {
    const error = apiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    });

    expect(isAiProviderConfigurationError(error)).toBe(true);
  });

  it("returns true for a 401 authentication error (revoked/rotated/mistyped API key)", () => {
    const error = apiError(401, {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });

    expect(isAiProviderConfigurationError(error)).toBe(true);
  });

  it("returns false for a 400 invalid_request_error unrelated to billing", () => {
    const error = apiError(400, {
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens must be greater than 0" },
    });

    expect(isAiProviderConfigurationError(error)).toBe(false);
  });

  it("returns false for a 400 with no parseable error body", () => {
    const error = apiError(400, undefined);

    expect(isAiProviderConfigurationError(error)).toBe(false);
  });

  it("returns false for a 429 rate-limit error (ordinary transient failure)", () => {
    const error = apiError(429, {
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limited" },
    });

    expect(isAiProviderConfigurationError(error)).toBe(false);
  });

  it("returns false for a 500 internal server error (ordinary transient failure)", () => {
    const error = apiError(500, {
      type: "error",
      error: { type: "api_error", message: "Internal server error" },
    });

    expect(isAiProviderConfigurationError(error)).toBe(false);
  });

  it("returns false for a plain non-APIError Error (e.g. a network failure)", () => {
    expect(isAiProviderConfigurationError(new Error("fetch failed"))).toBe(false);
  });

  it("returns false for a non-Error thrown value", () => {
    expect(isAiProviderConfigurationError("some string")).toBe(false);
    expect(isAiProviderConfigurationError(undefined)).toBe(false);
  });
});
