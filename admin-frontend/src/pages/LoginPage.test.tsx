import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { LoginPage } from "./LoginPage";

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}{loc.search}</p>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderLogin(initial: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/mfa" element={<Where />} />
          <Route path="/businesses" element={<Where />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("sign-in destination", () => {
  beforeEach(() => { localStorage.clear(); vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => vi.unstubAllGlobals());

  it("ignores any `next` address in the link: sign-in always lands on the console, never on an outside address", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ token: "t", admin: { id: "a", email: "o@example.com", name: "O", role: "SUPER_ADMIN" }, mfa: { state: "NOT_REQUIRED" } }));
    const user = userEvent.setup();
    renderLogin("/login?next=//evil.example/steal&redirect=https://evil.example");
    await user.type(screen.getByLabelText(/Email/), "o@example.com");
    await user.type(screen.getByLabelText(/^Password/), "a-long-password-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/businesses"));
    expect(screen.getByTestId("where").textContent).not.toMatch(/evil/);
  });

  it("goes to the authenticator step when the server says the second factor is still to do", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ token: "t", admin: { id: "a", email: "o@example.com", name: "O", role: "SUPER_ADMIN" }, mfa: { state: "CHALLENGE_REQUIRED" } }));
    const user = userEvent.setup();
    renderLogin("/login");
    await user.type(screen.getByLabelText(/Email/), "o@example.com");
    await user.type(screen.getByLabelText(/^Password/), "a-long-password-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/mfa"));
  });
});
