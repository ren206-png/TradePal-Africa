import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "./OverviewPage";

const overview = {
  businesses: { total: 4, active: 3, suspended: 1, newLast7Days: 2 },
  merchants: { active: 5 },
  activity: { transactionsLast24h: 7, transactionsLast7d: 30 },
  subscriptions: { ACTIVE: 1 },
  queues: {
    pendingDeletionRequests: 2,
    unmatchedMobileMoneyAlerts: 0,
    outbox: { pending: 0, dead: 3, oldestPendingAgeSeconds: null },
    inbox: { received: 0, dead: 0 },
  },
  generatedAt: "2026-10-20T10:00:00.000Z",
};

describe("OverviewPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows counts and highlights dead-lettered work", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(overview), { status: 200, headers: { "content-type": "application/json" } }),
    );
    render(<OverviewPage />);
    expect(await screen.findByText("Outbox dead-lettered")).toBeTruthy();
    expect(screen.getByText("Entries, last 24 h")).toBeTruthy();
    expect(screen.getByText("Outbox dead-lettered").closest(".stat-card")?.className).toContain("stat-warn");
  });

  it("shows the server's message when the admin lacks permission", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "You do not have permission to perform this action." }), { status: 403, headers: { "content-type": "application/json" } }),
    );
    render(<OverviewPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("permission");
  });
});
