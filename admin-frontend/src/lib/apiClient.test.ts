import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  clearStoredToken,
  getStoredToken,
  setUnauthorizedHandler,
  storeToken,
} from "./apiClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it("returns the parsed JSON body on a successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ hello: "world" }));

    const result = await apiFetch<{ hello: string }>("/admin/ping");

    expect(result).toEqual({ hello: "world" });
  });

  it("attaches an Authorization header from the stored token when authenticated", async () => {
    storeToken("test-token-123");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetch("/admin/ping");

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-123");
  });

  it("throws ApiError with the server's error message on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Business not found." }, 404));

    await expect(apiFetch("/admin/businesses/does-not-exist")).rejects.toMatchObject({
      message: "Business not found.",
      status: 404,
    });
  });

  it("throws an ApiError instance specifically (not just any Error)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Nope" }, 400));

    await expect(apiFetch("/admin/whatever")).rejects.toBeInstanceOf(ApiError);
  });

  it("invokes the registered unauthorized handler on a 401 for an authenticated request", async () => {
    storeToken("stale-token");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Invalid or expired token." }, 401));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(apiFetch("/admin/businesses")).rejects.toThrow();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke the unauthorized handler for a 401 on an unauthenticated request (e.g. bad login)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Invalid credentials." }, 401));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(
      apiFetch("/admin/login", { method: "POST", body: { email: "a@b.com", password: "wrong" }, authenticated: false }),
    ).rejects.toThrow();

    expect(handler).not.toHaveBeenCalled();
  });

  it("getStoredToken/clearStoredToken round-trip through localStorage", () => {
    expect(getStoredToken()).toBeNull();
    storeToken("abc");
    expect(getStoredToken()).toBe("abc");
    clearStoredToken();
    expect(getStoredToken()).toBeNull();
  });
});
