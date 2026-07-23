import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { apiFetch } from "../lib/apiClient";
import type { DeletionRequest } from "../lib/types";
import { DeletionRequestsPage } from "./DeletionRequestsPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const PENDING_REQUEST: DeletionRequest = {
  id: "req-1",
  businessId: "biz-1",
  customerId: "cust-1",
  requestorType: "CUSTOMER_VIA_MERCHANT",
  description: "Customer asked to have their data removed.",
  status: "PENDING",
  resolutionNote: null,
  createdAt: new Date().toISOString(),
  resolvedAt: null,
};

function loginAsSuperAdmin() {
  localStorage.setItem("tradepal_admin_token", "test-token");
  localStorage.setItem(
    "tradepal_admin_user",
    JSON.stringify({ id: "admin-1", email: "owner@example.com", name: "Owner", role: "SUPER_ADMIN" }),
  );
}

function renderPage() {
  return render(
    <AuthProvider>
      <DeletionRequestsPage />
    </AuthProvider>,
  );
}

describe("DeletionRequestsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the list and, for a privileged role, shows a Resolve action per PENDING row", async () => {
    loginAsSuperAdmin();
    vi.mocked(apiFetch).mockResolvedValueOnce({
      deletionRequests: [PENDING_REQUEST],
      pagination: { take: 20, skip: 0, hasMore: false },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("biz-1")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
  });

  it("does not show a Resolve action for a read-only ANALYST role", async () => {
    localStorage.setItem("tradepal_admin_token", "test-token");
    localStorage.setItem(
      "tradepal_admin_user",
      JSON.stringify({ id: "admin-2", email: "analyst@example.com", name: "Analyst", role: "ANALYST" }),
    );
    vi.mocked(apiFetch).mockResolvedValueOnce({
      deletionRequests: [PENDING_REQUEST],
      pagination: { take: 20, skip: 0, hasMore: false },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("biz-1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
  });

  it("completing a request confirms, calls the complete endpoint with the businessId, and reloads", async () => {
    const user = userEvent.setup();
    loginAsSuperAdmin();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ deletionRequests: [PENDING_REQUEST], pagination: { take: 20, skip: 0, hasMore: false } })
      .mockResolvedValueOnce({ deletionRequest: { ...PENDING_REQUEST, status: "COMPLETED" } })
      .mockResolvedValueOnce({ deletionRequests: [], pagination: { take: 20, skip: 0, hasMore: false } });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPage();
    await waitFor(() => expect(screen.getByText("biz-1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await user.click(screen.getByRole("button", { name: "Complete (anonymize)" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/admin/deletion-requests/req-1/complete",
        expect.objectContaining({ method: "POST", body: { businessId: "biz-1" } }),
      ),
    );
    // The reload (3rd call) fires after resolution.
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("rejecting requires a non-empty resolution note before the button is enabled", async () => {
    const user = userEvent.setup();
    loginAsSuperAdmin();
    vi.mocked(apiFetch).mockResolvedValueOnce({
      deletionRequests: [PENDING_REQUEST],
      pagination: { take: 20, skip: 0, hasMore: false },
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("biz-1")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Resolve" }));

    const rejectButton = screen.getByRole("button", { name: "Reject" });
    expect(rejectButton).toBeDisabled();

    const noteInput = screen.getByLabelText(/Resolution note/i);
    await user.type(noteInput, "Could not verify identity.");
    expect(rejectButton).toBeEnabled();

    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ deletionRequest: { ...PENDING_REQUEST, status: "REJECTED" } })
      .mockResolvedValueOnce({ deletionRequests: [], pagination: { take: 20, skip: 0, hasMore: false } });

    await user.click(rejectButton);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/admin/deletion-requests/req-1/reject",
        expect.objectContaining({
          method: "POST",
          body: { businessId: "biz-1", resolutionNote: "Could not verify identity." },
        }),
      ),
    );
  });
});
