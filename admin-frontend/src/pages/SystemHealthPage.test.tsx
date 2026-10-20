import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/apiClient";
import { SystemHealthPage } from "./SystemHealthPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const health = {
  heartbeats: { enabled: true, services: [{ service: "api", lastSeenAt: "2026-10-30T00:00:00Z", ageSeconds: 4, stale: false }] },
  webhooks: { stuckPendingOver5Min: 0 }, outbox: { pending: 0, processing: 0, dead: 0, oldestPendingAgeSeconds: null }, inbox: { received: 0, processing: 0, dead: 0 },
  ai: { lastSuccessfulCallAt: null, lastSuccessfulProvider: null }, configured: { alertEmail: true, deepseek: true, outboxSweep: true }, adminControls: {},
  alertChannel: { lastDeliveredAt: null, lastFailedAt: "2026-10-30T00:00:00Z", failedLast7Days: 3, needsAttention: true }, generatedAt: "2026-10-30T00:00:00Z",
};
const jobs = [{ id: "outbox-sweep", label: "Outbox and callback inbox processing", paused: false, reason: null, changedBy: null, changedAt: null }, { id: "business-digest", label: "Weekly business digest", paused: true, reason: "Template under review", changedBy: "a", changedAt: "2026-10-29T00:00:00Z" }];

describe("SystemHealthPage controls", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (...args: unknown[]) => {
      const path = String(args[0]);
      if (path === "/admin/system-health") return health;
      if (path === "/admin/system/jobs") return { jobs };
      if (path === "/admin/system/integrity") return { ranAt: "2026-10-30T00:00:00Z", businessesChecked: 3, truncated: false, findings: [{ check: "STOCK_BALANCE_MISMATCH", businessId: "abcdef12-0000", count: 2, detail: "2 stock balance(s) differ from the sum of their movements." }] };
      return { note: "The email service accepted the incident." };
    });
  });

  it("shows the alert-channel warning and which jobs are paused", async () => {
    render(<SystemHealthPage />);
    expect(await screen.findByText(/Needs attention: no alert delivery/)).toBeTruthy();
    expect(screen.getByText(/PAUSED: Template under review/)).toBeTruthy();
    expect(screen.getByText(/never paused/)).toBeTruthy();
    expect(screen.getByText(/1 finding\(s\)\./)).toBeTruthy();
    expect(screen.getByText(/stock balance mismatch \(abcdef12\)/)).toBeTruthy();
  });

  it("pauses only with a real reason, and says what the synthetic incident did", async () => {
    render(<SystemHealthPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Pause…" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), "Outbox is looping on a bad row");
    await userEvent.click(confirm);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/system/jobs/outbox-sweep/pause", { method: "POST", body: { reason: "Outbox is looping on a bad row" } }));
    await userEvent.click(await screen.findByRole("button", { name: "Send a synthetic incident…" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Quarterly alert test run");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/email service accepted the incident/)).toBeTruthy();
  });
});
