import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/apiClient";
import { SubscriptionsPage } from "./SubscriptionsPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const overview = {
  states: { ACTIVE: 3, GRACE: 1 }, invoices: { PAID: 3, PENDING: 1 }, attempts: {}, openExceptions: { AMOUNT_MISMATCH: 1 }, refunds: {}, callbackAuthFailuresLast24h: 2,
  switches: [{ id: "s1", provider: "pawapay", countryCode: "SL", purpose: "PLATFORM_SUBSCRIPTION", newAttemptsEnabled: true, reason: null }],
  configuration: { configured: true, environment: "SANDBOX", requireSignedCallbacks: true, productionActivated: false },
};
const subs = [{ id: "sub1", business: "Ade Foods", country: "SL", securitySuspended: false, planCode: "STARTER", planVersion: 1, status: "ACTIVE", state: "GRACE", currentPeriodEnd: "2026-11-30T00:00:00Z", cancelAtPeriodEnd: false }];
const detail = { ...subs[0], invoices: [{ id: "inv1", reference: "INV-ABCD2345", status: "PAID", amountMinor: "500000", paidMinor: "500000", refundedMinor: "0", currencyCode: "SLE" }], history: [{ id: "h1", kind: "GRANTED", from: "FREE", to: "STARTER", source: "payment", reason: null, at: "2026-10-30T00:00:00Z" }] };
const versions = [
  { id: "v1", planCode: "STARTER", version: 1, status: "PUBLISHED", graceDays: 3, billingPeriodDays: 30, features: ["trade"], subscribers: 4, prices: [{ countryCode: "SL", currencyCode: "SLE", priceMinor: "500000" }] },
  { id: "v2", planCode: "PRO", version: 1, status: "DRAFT", graceDays: 3, billingPeriodDays: 30, features: [], subscribers: 0, prices: [] },
];

function mockApi() {
  vi.mocked(apiFetch).mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]);
    if (path.includes("/overview")) return overview;
    if (path.startsWith("/admin/subscriptions/exceptions") && !path.includes("resolve")) return { exceptions: [{ id: "e1", attemptId: "att1", type: "AMOUNT_MISMATCH", business: "Ade Foods", amountMinor: "100", createdAt: "2026-10-30T00:00:00Z" }] };
    if (path === "/admin/subscriptions/sub1") return detail;
    if (path.startsWith("/admin/subscriptions")) return { subscriptions: subs };
    if (path.startsWith("/admin/plan-versions")) return { versions, knownFeatures: ["trade", "marketplace"] };
    return {};
  });
}

describe("SubscriptionsPage", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it("shows configuration, switches, states, exceptions and frozen versions; a draft without a price cannot be published", async () => {
    mockApi();
    render(<SubscriptionsPage />);
    expect(await screen.findByText(/pawaPay: sandbox/)).toBeTruthy();
    expect(screen.getByText(/Signed callbacks required/)).toBeTruthy();
    expect(screen.getByText(/NEW charges only/)).toBeTruthy();
    expect(screen.getByText("grace")).toBeTruthy(); // the subscription row is in its grace period
    expect(screen.getByText("frozen")).toBeTruthy(); // the published version
    expect((screen.getByRole("button", { name: "Publish…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /mark paid|delete/i })).toBeNull();
  });

  it("will not switch charges off or resolve an exception without a real reason, and sends the reason", async () => {
    mockApi();
    render(<SubscriptionsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn off…" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), "Provider incident under investigation");
    await userEvent.click(confirm);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/billing-switches", { method: "PUT", body: { provider: "pawapay", countryCode: "SL", newAttemptsEnabled: false, reason: "Provider incident under investigation" } }));
    await userEvent.click(await screen.findByRole("button", { name: "Resolve…" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Returned the short payment");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/subscriptions/exceptions/e1/resolve", { method: "POST", body: { outcome: "CONTACTED_MERCHANT", note: "Returned the short payment" } }));
  });

  it("offers to give back a collected-but-unapplied payment from its exception", async () => {
    mockApi();
    render(<SubscriptionsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Refund the payment…" }));
    expect(screen.getByText(/never applied to an invoice/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Reason"), "Duplicate payment, returning it");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/subscriptions/attempts/att1/refund", { method: "POST", body: { reason: "Duplicate payment, returning it" } }));
  });

  it("opens a subscription, shows its invoices and history, and refunds a paid invoice with a reason", async () => {
    mockApi();
    render(<SubscriptionsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByText("INV-ABCD2345")).toBeTruthy();
    expect(screen.getByText(/granted/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Refund…" }));
    expect(screen.getByText(/does not end the subscription/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Reason"), "Charged by mistake, returning it");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/invoices/inv1/refund", { method: "POST", body: { reason: "Charged by mistake, returning it" } }));
  });
});
