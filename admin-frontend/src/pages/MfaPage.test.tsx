import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { ProtectedRoute } from "../auth/ProtectedRoute";
import { ApiError, apiFetch } from "../lib/apiClient";
import { MfaPage } from "./MfaPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

function signedIn(mfa: string) {
  localStorage.setItem("tradepal_admin_token", "t");
  localStorage.setItem("tradepal_admin_user", JSON.stringify({ id: "a1", email: "owner@example.com", name: "Owner", role: "SUPER_ADMIN" }));
  localStorage.setItem("tradepal_admin_mfa", mfa);
}

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<p>login page</p>} />
          <Route path="/mfa" element={<MfaPage />} />
          <Route path="/businesses" element={<ProtectedRoute><p>the console</p></ProtectedRoute>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("authenticator step", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("sends someone who is not signed in back to the sign-in page", () => {
    renderAt("/mfa");
    expect(screen.getByText("login page")).toBeInTheDocument();
  });

  it("holds the console back until the authenticator step is done", () => {
    signedIn("CHALLENGE_REQUIRED");
    renderAt("/businesses");
    expect(screen.queryByText("the console")).not.toBeInTheDocument();
    expect(screen.getByText(/Enter your/)).toBeInTheDocument();
  });

  it("takes the 6-digit code and then opens the console", async () => {
    signedIn("CHALLENGE_REQUIRED");
    vi.mocked(apiFetch).mockResolvedValueOnce({ verified: true });
    const user = userEvent.setup();
    renderAt("/mfa");
    await user.type(screen.getByLabelText(/6-digit code/), "123456");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("the console")).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledWith("/admin/mfa/challenge", { method: "POST", body: { code: "123456" } });
    expect(localStorage.getItem("tradepal_admin_mfa")).toBe("VERIFIED");
  });

  it("shows the server's message for a wrong code and stays on the page", async () => {
    signedIn("CHALLENGE_REQUIRED");
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError("That code is not right.", 401, "BAD_CODE"));
    const user = userEvent.setup();
    renderAt("/mfa");
    await user.type(screen.getByLabelText(/6-digit code/), "000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not right.");
    expect(screen.queryByText("the console")).not.toBeInTheDocument();
  });

  it("switches to a recovery code and posts it to the recovery route", async () => {
    signedIn("CHALLENGE_REQUIRED");
    vi.mocked(apiFetch).mockResolvedValueOnce({ verified: true, recoveryCodesRemaining: 7 });
    const user = userEvent.setup();
    renderAt("/mfa");
    await user.click(screen.getByRole("button", { name: /lost my phone/ }));
    await user.type(screen.getByLabelText(/Recovery code/), "ABCDE-FGHJK");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/mfa/recovery", { method: "POST", body: { code: "ABCDE-FGHJK" } }));
  });

  it("walks through first-time setup: setup key, first code, recovery codes shown once, then the console", async () => {
    signedIn("ENROLMENT_REQUIRED");
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/TradePal%20Admin:owner%40example.com?secret=JBSWY3DPEHPK3PXP" })
      .mockResolvedValueOnce({ enrolled: true, recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] });
    const user = userEvent.setup();
    renderAt("/mfa");
    expect(await screen.findByLabelText("Setup key")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    // the QR code is drawn in the browser from the setup address (an inline picture, never an outside image address)
    const qr = await screen.findByRole("img", { name: "QR code to scan with your authenticator app" });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(decodeURIComponent(qr.getAttribute("src")!)).toContain("<svg");
    await user.type(screen.getByLabelText(/6-digit code/), "654321");
    await user.click(screen.getByRole("button", { name: "Confirm and finish" }));
    expect(await screen.findByRole("list", { name: "Recovery codes" })).toHaveTextContent("AAAAA-BBBBB");
    const go = screen.getByRole("button", { name: "Continue to the console" });
    expect(go).toBeDisabled(); // cannot move on until the codes are acknowledged
    await user.click(screen.getByLabelText(/I have saved these codes/));
    await user.click(go);
    await waitFor(() => expect(screen.getByText("the console")).toBeInTheDocument());
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/admin/mfa/enroll/confirm", { method: "POST", body: { code: "654321" } });
  });

  it("offers WhatsApp codes at first-time setup only when the server does, without starting the authenticator setup", async () => {
    signedIn("ENROLMENT_REQUIRED");
    setMethods({ totp: false, whatsapp: { available: true, enrolled: false, last4: null } });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" })
      .mockResolvedValueOnce({ sent: true, last4: "0100", expiresInSeconds: 300 })
      .mockResolvedValueOnce({ enrolled: true, recoveryCodes: ["AAAAA-BBBBB"] });
    const user = userEvent.setup();
    renderAt("/mfa");
    await user.click(await screen.findByRole("button", { name: "Get codes by WhatsApp instead" }));
    await user.type(screen.getByLabelText("WhatsApp number"), "+1 403 555 0100");
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(await screen.findByText(/ending 0100/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/admin/mfa/whatsapp/enroll/start", { method: "POST", body: { phone: "+1 403 555 0100" } });
    await user.type(screen.getByLabelText("6-digit code"), "482913");
    await user.click(screen.getByRole("button", { name: "Confirm and finish" }));
    expect(await screen.findByRole("list", { name: "Recovery codes" })).toHaveTextContent("AAAAA-BBBBB");
    expect(apiFetch).toHaveBeenCalledWith("/admin/mfa/whatsapp/enroll/confirm", { method: "POST", body: { code: "482913" } });
  });

  it("does not offer WhatsApp when the server does not", async () => {
    signedIn("ENROLMENT_REQUIRED");
    setMethods({ totp: false, whatsapp: { available: false, enrolled: false, last4: null } });
    vi.mocked(apiFetch).mockResolvedValueOnce({ secret: "S", otpauthUri: "otpauth://totp/x?secret=S" });
    renderAt("/mfa");
    await screen.findByLabelText("Setup key");
    expect(screen.queryByRole("button", { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it("signs in with a WhatsApp code: asks to send it, then verifies it", async () => {
    signedIn("CHALLENGE_REQUIRED");
    setMethods({ totp: false, whatsapp: { available: true, enrolled: true, last4: "0100" } });
    vi.mocked(apiFetch).mockResolvedValueOnce({ sent: true, last4: "0100", expiresInSeconds: 300 }).mockResolvedValueOnce({ verified: true });
    const user = userEvent.setup();
    renderAt("/mfa");
    expect(screen.getByText(/ending 0100/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await user.type(await screen.findByLabelText("6-digit code"), "482913");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("the console")).toBeInTheDocument());
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/admin/mfa/whatsapp/send", { method: "POST", body: {} });
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/admin/mfa/whatsapp/verify", { method: "POST", body: { code: "482913" } });
  });

  it("lets someone with both choose either way, and still offers a recovery code", async () => {
    signedIn("CHALLENGE_REQUIRED");
    setMethods({ totp: true, whatsapp: { available: true, enrolled: true, last4: "0100" } });
    const user = userEvent.setup();
    renderAt("/mfa");
    expect(screen.getByText("Enter the 6-digit code from your authenticator app.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send a code to my WhatsApp instead" }));
    expect(screen.getByRole("button", { name: "Send me a code" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use my authenticator app instead" }));
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /lost my phone/ })).toBeInTheDocument();
  });
});

function setMethods(m: object) {
  localStorage.setItem("tradepal_admin_mfa_methods", JSON.stringify(m));
}
