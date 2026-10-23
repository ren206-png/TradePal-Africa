import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/apiClient";
import type { SupportCaseDetail, SupportCaseList } from "../lib/types";
import { SupportCasesPage } from "./SupportCasesPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const row = { id: "c1", business: "Ade Foods", orderReference: "ORD-000007", type: "DELIVERY", handledBy: "SELLER" as const, status: "OPEN" as const, openedBy: "CONSUMER", summary: "The delivery never arrived", contactPhone: "*******4567", createdAt: "2026-10-20T08:00:00Z" };
const list: SupportCaseList = { cases: [row], counts: { byStatus: { OPEN: 1 }, openByParty: { SELLER: 1 } }, pagination: { take: 20, skip: 0, hasMore: false } };
const detail = (over: Partial<SupportCaseDetail> = {}): SupportCaseDetail => ({
  ...row, contactName: "Amaka", resolution: null, order: { reference: "ORD-000007", status: "PLACED", fulfilment: "DELIVERY", paymentMethod: "PAY_ON_COLLECTION", totalMinor: "70000", paidMinor: "0", refundedMinor: "0", currencyCode: "NGN" },
  notes: [{ id: "n1", authorType: "CONSUMER", body: "The delivery never arrived", createdAt: "2026-10-20T08:00:00Z" }], ...over,
});

describe("SupportCasesPage", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it("lists cases with who is responsible, opens one, and posts a note", async () => {
    vi.mocked(apiFetch).mockImplementation(async (...a: unknown[]) => { const path = String(a[0]); return (path.startsWith("/admin/support-cases/c1") ? detail() : path.includes("notes") ? {} : list); });
    render(<SupportCasesPage />);
    expect(await screen.findByText("Ade Foods")).toBeTruthy();
    expect(screen.getAllByText("Seller").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "The delivery never arrived" }));
    expect(await screen.findByText(/Case: Delivery at Ade Foods/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Add a note"), "Phoned the seller");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/support-cases/c1/notes", { method: "POST", body: { body: "Phoned the seller" } }));
  });

  it("will not close without a real resolution, and offers no actions on a closed case", async () => {
    vi.mocked(apiFetch).mockImplementation(async (...a: unknown[]) => { const path = String(a[0]); return (path.startsWith("/admin/support-cases/c1") ? detail() : list); });
    render(<SupportCasesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "The delivery never arrived" }));
    await userEvent.click(await screen.findByRole("button", { name: "Close…" }));
    const submit = screen.getByRole("button", { name: "Close case" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Resolution"), "Seller redelivered on Tuesday");
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a closed case read-only", async () => {
    vi.mocked(apiFetch).mockImplementation(async (...a: unknown[]) => { const path = String(a[0]); return (path.startsWith("/admin/support-cases/c1") ? detail({ status: "CLOSED", resolution: "Done" }) : list); });
    render(<SupportCasesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "The delivery never arrived" }));
    expect(await screen.findByText(/A new problem is a new case/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
  });
});
