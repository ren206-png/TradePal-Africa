import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { ApiError, apiFetch } from "../lib/apiClient";
import type { ReorderOverview } from "../lib/types";
import { ReorderPage } from "./ReorderPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const summary = { scoredPredictions: 4, countedPredictions: 4, excludedStockouts: 0, scoredWeeks: 4, modelMapeBps: 3000, baselineMapeBps: 8000, modelWapeBps: 3000, baselineWapeBps: 8000, improvementBps: 6250 };
const overview = (over: Partial<ReorderOverview> = {}): ReorderOverview => ({
  thresholds: { minScoredWeeks: null, minImprovementBps: null, updatedAt: "2026-10-20T00:00:00Z" },
  method: "ses-v1",
  merchants: [{ businessId: "b1", name: "Forecast Merchant", country: "SL", rules: 2, suggestions: { issued: 5, proposed: 1, accepted: 3, dismissed: 1, superseded: 0, tier2Issued: 0 }, flags: { tier1: true, shadow: true, live: false }, forecast: summary, eligible: false }],
  ...over,
});

function login(role: string) {
  localStorage.setItem("tradepal_admin_token", "tok");
  localStorage.setItem("tradepal_admin_user", JSON.stringify({ id: "a1", email: "a@x.test", name: "A", role }));
}
const renderPage = () => render(<AuthProvider><ReorderPage /></AuthProvider>);

describe("ReorderPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => localStorage.clear());

  it("shows scores per merchant, warns that thresholds are unset, and offers no controls to an operator", async () => {
    login("OPERATOR");
    vi.mocked(apiFetch).mockResolvedValue(overview());
    renderPage();
    expect(await screen.findByText("Forecast Merchant")).toBeTruthy();
    expect(screen.getByText(/no defaults/)).toBeTruthy();
    expect(screen.getByText("62.5%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open gate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save thresholds" })).toBeNull();
    expect(screen.getByText("Only the owner can change these.")).toBeTruthy();
  });

  it("lets the owner save thresholds", async () => {
    login("SUPER_ADMIN");
    vi.mocked(apiFetch).mockImplementation(async (_p: string, o?: { method?: string }) => (o?.method === "PUT" ? { minScoredWeeks: 3, minImprovementBps: 2000 } : overview()));
    renderPage();
    await userEvent.type(await screen.findByLabelText("Minimum scored weeks"), "3");
    await userEvent.type(screen.getByLabelText(/Minimum improvement/), "2000");
    await userEvent.click(screen.getByRole("button", { name: "Save thresholds" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Thresholds saved."));
    const put = vi.mocked(apiFetch).mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === "PUT")!;
    expect(put[0]).toBe("/admin/forecast-gate-config");
    expect((put[1] as { body: object }).body).toEqual({ minScoredWeeks: 3, minImprovementBps: 2000 });
  });

  it("shows the server's reason when a promotion is refused, and requires a reason of 10+ characters", async () => {
    login("SUPER_ADMIN");
    vi.mocked(apiFetch).mockImplementation(async (_p: string, o?: { method?: string }) => {
      if (o?.method === "POST") throw new ApiError("Only 4 scored week(s); the threshold is 8.", 409, "BELOW_THRESHOLD");
      return overview();
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Open gate/ }));
    const submit = screen.getByRole("button", { name: "Open gate" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), "Early look at this merchant");
    await userEvent.click(submit);
    expect((await screen.findByRole("alert")).textContent).toContain("Only 4 scored week(s); the threshold is 8.");
    expect(screen.getByRole("dialog")).toBeTruthy(); // stays open so the owner can read it
  });

  it("closing an open gate is offered for an open merchant", async () => {
    login("SUPER_ADMIN");
    const open = overview();
    open.merchants[0]!.flags.live = true;
    vi.mocked(apiFetch).mockResolvedValue(open);
    renderPage();
    expect(await screen.findByRole("button", { name: /Close gate/ })).toBeTruthy();
    expect(screen.getByText("OPEN")).toBeTruthy();
  });
});
