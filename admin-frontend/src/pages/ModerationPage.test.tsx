import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/apiClient";
import { ModerationPage } from "./ModerationPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const reports = [{ id: "rep1", reason: "SCAM", details: "<b>They took my money</b>", status: "OPEN", createdAt: "2026-10-20T08:00:00Z", openReportsAboutSeller: 3,
  seller: { id: "b1", name: "Ade Foods", country: "NG", marketplaceStatus: "ACTIVE" }, listing: { id: "l1", item: "Cola", sku: "COLA", moderation: "VISIBLE" } }];
const appeals = [{ id: "ap1", seller: "Bola Drinks", text: "The reports came from a rival", status: "OPEN", action: { type: "SUSPEND_SELLER", reason: "Scam reports confirmed" } }];
const sellers = [{ businessId: "b2", name: "Bola Drinks", marketplaceStatus: "SUSPENDED", note: "Scam reports confirmed" }];

function mockApi() {
  vi.mocked(apiFetch).mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]);
    if (path.includes("/queue")) return { reports };
    if (path.includes("/appeals") && !path.includes("decide")) return { appeals };
    if (path.includes("/sellers") && !path.includes("suspend") && !path.includes("reinstate")) return { sellers };
    return {};
  });
}

describe("ModerationPage", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it("shows reports with how many open reports the seller has, and renders report text as plain text", async () => {
    mockApi();
    render(<ModerationPage />);
    expect(await screen.findByText("<b>They took my money</b>")).toBeTruthy(); // not interpreted as HTML
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText(/nothing is taken down automatically/i)).toBeTruthy();
    expect(screen.getAllByText(/Bola Drinks/, { selector: "td" }).length).toBeGreaterThanOrEqual(2); // in appeals and in suspended sellers
  });

  it("needs a reason before unpublishing, and posts it with the report", async () => {
    mockApi();
    render(<ModerationPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Unpublish…" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), "Counterfeit goods confirmed");
    await userEvent.click(confirm);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/moderation/listings/l1/unpublish", { method: "POST", body: { reason: "Counterfeit goods confirmed", reportId: "rep1" } }));
  });

  it("can overturn an appeal and reinstate a suspended seller", async () => {
    mockApi();
    render(<ModerationPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Overturn…" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Evidence shows the reports were retaliatory");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/moderation/appeals/ap1/decide", { method: "POST", body: { outcome: "OVERTURNED", reason: "Evidence shows the reports were retaliatory" } }));
    await userEvent.click(await screen.findByRole("button", { name: "Reinstate…" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Appeal reviewed and accepted");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/moderation/sellers/b2/reinstate", { method: "POST", body: { reason: "Appeal reviewed and accepted" } }));
  });
});
