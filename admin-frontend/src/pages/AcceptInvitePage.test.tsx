import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../lib/apiClient";
import { AcceptInvitePage } from "./AcceptInvitePage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

function renderPage(hash: string) {
  window.location.hash = hash;
  return render(<MemoryRouter><AcceptInvitePage /></MemoryRouter>);
}

describe("accepting an invitation", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());
  afterEach(() => { window.location.hash = ""; });

  it("says so when the link has no invitation code, and offers no way to submit", () => {
    renderPage("");
    expect(screen.getByRole("alert")).toHaveTextContent(/missing its invitation code/);
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
  });

  it("refuses two different passwords without calling the server", async () => {
    const user = userEvent.setup();
    renderPage("#token=abc123");
    await user.type(screen.getByLabelText(/Your name/), "Ama Mensah");
    await user.type(screen.getByLabelText(/^Password/), "a-long-password-1");
    await user.type(screen.getByLabelText(/Repeat password/), "a-long-password-2");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("posts the token from the link fragment without a sign-in, then points to sign-in", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ created: true });
    const user = userEvent.setup();
    renderPage("#token=tok-xyz");
    await user.type(screen.getByLabelText(/Your name/), "Ama Mensah");
    await user.type(screen.getByLabelText(/^Password/), "a-long-password-1");
    await user.type(screen.getByLabelText(/Repeat password/), "a-long-password-1");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(screen.getByText(/Your account is ready/)).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledWith("/admin/invitations/accept", { method: "POST", body: { token: "tok-xyz", name: "Ama Mensah", password: "a-long-password-1" }, authenticated: false });
    expect(window.location.hash).toBe(""); // the token is taken out of the address bar
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  });

  it("shows the server's reason when the invitation is not valid", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError("This invitation is not valid. Ask for a new one.", 400, "INVITATION_INVALID"));
    const user = userEvent.setup();
    renderPage("#token=old");
    await user.type(screen.getByLabelText(/Your name/), "Ama");
    await user.type(screen.getByLabelText(/^Password/), "a-long-password-1");
    await user.type(screen.getByLabelText(/Repeat password/), "a-long-password-1");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid/);
  });
});
