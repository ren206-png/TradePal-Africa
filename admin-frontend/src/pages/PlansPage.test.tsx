import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { apiFetch } from "../lib/apiClient";
import type { Plan } from "../lib/types";
import { PlansPage } from "./PlansPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const CAPPED_PLAN: Plan = {
  code: "STARTER",
  name: "Starter",
  priceMinor: "250000",
  currencyCode: "NGN",
  entryCapPerMonth: 200,
  voiceEnabled: false,
  staffCapCount: 3,
};

const UNCAPPED_PLAN: Plan = {
  code: "PRO",
  name: "Pro",
  priceMinor: "500000",
  currencyCode: "NGN",
  entryCapPerMonth: null,
  voiceEnabled: true,
  staffCapCount: null,
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
      <PlansPage />
    </AuthProvider>,
  );
}

/**
 * Phase 18 gap closure: `Plan.staffCapCount` (Phase 14) was never surfaced on
 * this page — the table only showed entryCapPerMonth/voiceEnabled, and the
 * create/edit form couldn't set it at all, even though the backend route
 * (`POST /admin/plans`) has accepted it as an optional field since Phase 14.
 */
describe("PlansPage — staffCapCount column and form field (Phase 18 gap closure)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a Staff cap column showing the numeric cap or 'Uncapped'", async () => {
    loginAsSuperAdmin();
    vi.mocked(apiFetch).mockResolvedValueOnce({ plans: [CAPPED_PLAN, UNCAPPED_PLAN] });

    renderPage();

    await waitFor(() => expect(screen.getByText("Starter")).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "Staff cap" })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("Uncapped").length).toBeGreaterThan(0);
  });

  it("editing a plan pre-fills the staff cap field and submits an updated value", async () => {
    const user = userEvent.setup();
    loginAsSuperAdmin();
    vi.mocked(apiFetch).mockResolvedValueOnce({ plans: [CAPPED_PLAN] });

    renderPage();
    await waitFor(() => expect(screen.getByText("Starter")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));

    const staffCapInput = screen.getByLabelText(/Staff cap/i);
    expect(staffCapInput).toHaveValue("3");

    await user.clear(staffCapInput);
    await user.type(staffCapInput, "5");

    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ plan: { ...CAPPED_PLAN, staffCapCount: 5 } })
      .mockResolvedValueOnce({ plans: [{ ...CAPPED_PLAN, staffCapCount: 5 }] });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/admin/plans",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ staffCapCount: 5 }),
        }),
      ),
    );
  });

  it("leaving the staff cap field blank submits null (uncapped)", async () => {
    const user = userEvent.setup();
    loginAsSuperAdmin();
    vi.mocked(apiFetch).mockResolvedValueOnce({ plans: [CAPPED_PLAN] });

    renderPage();
    await waitFor(() => expect(screen.getByText("Starter")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const staffCapInput = screen.getByLabelText(/Staff cap/i);
    await user.clear(staffCapInput);

    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ plan: { ...CAPPED_PLAN, staffCapCount: null } })
      .mockResolvedValueOnce({ plans: [{ ...CAPPED_PLAN, staffCapCount: null }] });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/admin/plans",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ staffCapCount: null }),
        }),
      ),
    );
  });
});
