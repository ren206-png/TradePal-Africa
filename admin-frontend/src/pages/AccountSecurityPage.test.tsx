import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../lib/apiClient";
import { AccountSecurityPage } from "./AccountSecurityPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const session = (methods: object) => ({ mfa: { state: "VERIFIED", methods } });
const renderPage = () => render(<MemoryRouter><AccountSecurityPage /></MemoryRouter>);

describe("account security", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it("says WhatsApp codes are unavailable when the server does not offer them", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(session({ totp: true, whatsapp: { available: false, enrolled: false, last4: null } }));
    renderPage();
    expect(await screen.findByText("Not available on this server right now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add my WhatsApp number" })).not.toBeInTheDocument();
  });

  it("adds a WhatsApp number: number, code, done (no new recovery codes when there already are some)", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(session({ totp: true, whatsapp: { available: true, enrolled: false, last4: null } }))
      .mockResolvedValueOnce({ sent: true, last4: "0100", expiresInSeconds: 300 })
      .mockResolvedValueOnce({ enrolled: true })
      .mockResolvedValueOnce(session({ totp: true, whatsapp: { available: true, enrolled: true, last4: "0100" } }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add my WhatsApp number" }));
    await user.type(screen.getByLabelText("WhatsApp number"), "+14035550100");
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await user.type(await screen.findByLabelText("6-digit code"), "482913");
    await user.click(screen.getByRole("button", { name: "Confirm and finish" }));
    expect(await screen.findByText(/Codes go to your WhatsApp number ending 0100/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off WhatsApp codes" })).toBeInTheDocument();
  });

  it("turns WhatsApp codes off, and shows the server's reason when it refuses", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(session({ totp: false, whatsapp: { available: true, enrolled: true, last4: "0100" } }))
      .mockRejectedValueOnce(new ApiError("Set up an authenticator app first, so you are not locked out.", 409, "LAST_METHOD"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Turn off WhatsApp codes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not locked out");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/mfa/whatsapp/remove", { method: "POST", body: {} }));
  });
});
