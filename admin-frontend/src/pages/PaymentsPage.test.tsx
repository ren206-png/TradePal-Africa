import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/apiClient";
import { PaymentsPage } from "./PaymentsPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const overview = {
  intents: { OPEN: 2 }, attempts: { PENDING: 1, SUCCEEDED: 3 }, openProviderExceptions: { CURRENCY_MISMATCH: 1 }, openStorePaymentExceptions: {}, refunds: { FAILED: 1 },
  collectedNotSettled: [{ currencyCode: "NGN", amountMinor: "40000" }], callbacks: { received: 0, processing: 0, processed: 9, dead: 2 }, providers: ["simulator"],
  connections: [{ id: "c1", business: "Ade Foods", provider: "simulator", status: "ACTIVE", consecutiveFailures: 3, circuitOpen: true }],
};
const exceptions = [{ id: "e1", source: "PROVIDER", type: "CURRENCY_MISMATCH", status: "OPEN", business: "Ade Foods", reference: null, amountMinor: "20000", currencyCode: "USD", createdAt: "2026-10-20T08:00:00Z" },
  { id: "e2", source: "STORE_ORDER", type: "LATE_SUCCESS", status: "OPEN", business: "Ade Foods", reference: "ORD-000003", amountMinor: "10000", currencyCode: null, createdAt: "2026-10-20T09:00:00Z" }];
const attempts = [{ id: "a1", business: "Ade Foods", provider: "simulator", reference: "ORD-000004", status: "UNKNOWN", amountMinor: "10000", capturedMinor: "0", currencyCode: "NGN", pollCount: 2, createdAt: "2026-10-20T08:30:00Z" }];
const refunds = [{ id: "r1", business: "Ade Foods", reference: "ORD-000002", amountMinor: "5000", status: "FAILED", failureReason: "The simulated provider could not send the refund." }];

function mockApi() {
  vi.mocked(apiFetch).mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]);
    if (path.includes("/overview")) return overview;
    if (path.includes("/attempts?")) return { attempts };
    if (path.includes("/exceptions") && !path.includes("resolve")) return { exceptions };
    if (path.includes("/refunds") && !path.includes("retry")) return { refunds };
    if (path.includes("/settlements")) return { settlements: [] };
    return {};
  });
}

describe("PaymentsPage", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it("shows exceptions, unresolved attempts and failed refunds, warns about a paused provider, and only offers resolution for provider exceptions", async () => {
    mockApi();
    render(<PaymentsPage />);
    expect(await screen.findByText("currency mismatch")).toBeTruthy();
    expect(screen.getByText("late success")).toBeTruthy();
    expect(screen.getByText(/new payments are paused/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Resolve…" })).toHaveLength(1); // the shop-order exception is the seller's to resolve
    expect(screen.getByText(/the seller resolves/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /mark paid/i })).toBeNull();
  });

  it("will not resolve without a real note, and posts the outcome and note", async () => {
    mockApi();
    render(<PaymentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Resolve…" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Note"), "Called the provider and the seller");
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/payments/exceptions/e1/resolve", { method: "POST", body: { outcome: "CONTACTED_PARTIES", note: "Called the provider and the seller" } }));
  });

  it("asks the provider before closing an attempt and can retry a failed refund", async () => {
    mockApi();
    render(<PaymentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Check with provider" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/payments/attempts/a1/refresh", { method: "POST", body: {} }));
    await userEvent.click(screen.getByRole("button", { name: "Close…" }));
    expect(screen.getByText(/closed only if the provider confirms/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/payments/refunds/r1/retry", { method: "POST", body: {} }));
  });
});
