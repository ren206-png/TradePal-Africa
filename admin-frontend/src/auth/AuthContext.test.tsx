import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Minimal consumer exercising every AuthContext value, so tests can drive it via the DOM. */
function Consumer() {
  const { admin, isAuthenticated, login, logout } = useAuth();
  return (
    <div>
      <p data-testid="status">{isAuthenticated ? `logged-in:${admin?.email}` : "logged-out"}</p>
      <button onClick={() => void login("owner@example.com", "password123")}>Login</button>
      <button onClick={logout}>Logout</button>
    </div>
  );
}

describe("AuthContext", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts logged out when there is no stored token", () => {
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("logged-out");
  });

  it("logs in on a successful POST /admin/login, storing the token and admin profile", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        token: "jwt-abc",
        admin: { id: "admin-1", email: "owner@example.com", name: "Owner", role: "SUPER_ADMIN" },
      }),
    );

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await user.click(screen.getByText("Login"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("logged-in:owner@example.com"));
    expect(localStorage.getItem("tradepal_admin_token")).toBe("jwt-abc");
  });

  it("logs out and clears the stored token/session", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        token: "jwt-abc",
        admin: { id: "admin-1", email: "owner@example.com", name: "Owner", role: "SUPER_ADMIN" },
      }),
    );
    // logout() fires a best-effort POST /admin/logout in the background.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await user.click(screen.getByText("Login"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("logged-in:owner@example.com"));

    await user.click(screen.getByText("Logout"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("logged-out"));
    expect(localStorage.getItem("tradepal_admin_token")).toBeNull();
  });

  it("auto-logs-out when apiFetch reports a 401 from anywhere in the app", async () => {
    localStorage.setItem("tradepal_admin_token", "stale-token");
    localStorage.setItem(
      "tradepal_admin_user",
      JSON.stringify({ id: "admin-1", email: "owner@example.com", name: "Owner", role: "SUPER_ADMIN" }),
    );

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("logged-in:owner@example.com");

    // Simulate some other part of the app making an authenticated call that comes back 401.
    const { apiFetch } = await import("../lib/apiClient");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Invalid or expired token." }, 401));

    await act(async () => {
      await expect(apiFetch("/admin/businesses")).rejects.toThrow();
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("logged-out"));
  });
});
