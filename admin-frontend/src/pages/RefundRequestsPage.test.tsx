import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { apiFetch } from "../lib/apiClient";
import { RefundRequestsPage } from "./RefundRequestsPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const HASH = "a".repeat(64);
const mk = (over: Record<string, unknown>) => ({
  id: "r1", action: "SUBSCRIPTION_CHARGE_REFUND", status: "PENDING", reason: "customer was charged twice", payloadHash: HASH,
  payload: { targetId: "inv-1", amountMinor: "50000", currency: "SLE", revokeEntitlement: false }, requestedById: "someone-else", approvedById: null, expiresAt: new Date().toISOString(), ...over,
});

function setup(requests: unknown[], executionEnabled = false) {
  localStorage.setItem("tradepal_admin_token", "t");
  localStorage.setItem("tradepal_admin_user", JSON.stringify({ id: "me", email: "fin@example.com", name: "Fin", role: "FINANCE_ADMIN" }));
  localStorage.setItem("tradepal_admin_mfa", "VERIFIED");
  vi.mocked(apiFetch).mockImplementation((async (path: string) => (path === "/admin/refund-requests" ? { requests, executionEnabled } : {})) as never);
  return render(<AuthProvider><RefundRequestsPage /></AuthProvider>);
}

describe("refund requests page", () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(apiFetch).mockReset(); });
  afterEach(() => vi.clearAllMocks());

  it("tells people plainly when running refunds is switched off, and disables the run button", async () => {
    setup([mk({ status: "APPROVED" })], false);
    expect(await screen.findByText(/Running refunds is switched off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run refund" })).toBeDisabled();
  });

  it("lets a different person approve exactly the fingerprint shown, but not the requester", async () => {
    const user = userEvent.setup();
    setup([mk({}), mk({ id: "r2", requestedById: "me", payload: { targetId: "inv-2", amountMinor: null, currency: "SLE", revokeEntitlement: false } })]);
    const others = (await screen.findByText(/inv-1/)).closest("tr")!;
    await user.click(within(others).getByRole("button", { name: "Approve exactly this" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/refund-requests/r1/approve", { method: "POST", body: { payloadHash: HASH } }));
    const mine = screen.getByText(/inv-2/).closest("tr")!;
    expect(within(mine).queryByRole("button", { name: "Approve exactly this" })).not.toBeInTheDocument();
    expect(within(mine).getByText("Waiting for someone else to approve")).toBeInTheDocument();
    expect(within(mine).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("enables the run step only when execution is on", async () => {
    setup([mk({ status: "APPROVED" })], true);
    expect(await screen.findByRole("button", { name: "Run refund" })).toBeEnabled();
  });
});
