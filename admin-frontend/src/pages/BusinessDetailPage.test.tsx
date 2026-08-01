import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { apiFetch } from "../lib/apiClient";
import type { BusinessDetail, EffectivePlan, FeatureFlagState, Invoice, PaymentRequest } from "../lib/types";
import { BusinessDetailPage } from "./BusinessDetailPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const BUSINESS: BusinessDetail = {
  id: "biz-1",
  name: "Mama Kemi's Store",
  countryCode: "NG",
  currencyCode: "NGN",
  languageCode: "en",
  timezone: "Africa/Lagos",
  status: "ACTIVE",
  suspendedAt: null,
  suspensionReason: null,
  createdAt: new Date().toISOString(),
  merchants: [],
  subscriptions: [],
};

const CURRENT_PLAN: EffectivePlan = { code: "FREE", entryCapPerMonth: 50, voiceEnabled: false };
const FEATURE_FLAGS: FeatureFlagState[] = [];

function loginAs(role: "SUPER_ADMIN" | "ANALYST") {
  localStorage.setItem("tradepal_admin_token", "test-token");
  localStorage.setItem(
    "tradepal_admin_user",
    JSON.stringify({ id: "admin-1", email: "owner@example.com", name: "Owner", role }),
  );
}

function renderPage() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/businesses/biz-1"]}>
        <Routes>
          <Route path="/businesses/:id" element={<BusinessDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/**
 * Every render loads the business detail and its feature flags before anything else can happen,
 * then (once `business` is set) InvoicesSection and PaymentRequestsSection mount and issue their
 * own fetches. Order matches the four fetches BusinessDetailPage.tsx actually issues: load(),
 * loadFeatureFlags(), InvoicesSection's own effect, PaymentRequestsSection's own effect.
 */
function mockInitialLoad(invoices: Invoice[] = [], paymentRequests: PaymentRequest[] = []) {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ business: BUSINESS, currentPlan: CURRENT_PLAN })
    .mockResolvedValueOnce({ featureFlags: FEATURE_FLAGS })
    .mockResolvedValueOnce({ invoices, pagination: { take: 20, skip: 0, hasMore: false } })
    .mockResolvedValueOnce({ paymentRequests, pagination: { take: 20, skip: 0, hasMore: false } });
}

describe("BusinessDetailPage — inventory backfill section (Phase 17 gap closure)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a 'Backfill inventory links' button for a privileged role", async () => {
    loginAs("SUPER_ADMIN");
    mockInitialLoad();

    renderPage();

    await waitFor(() => expect(screen.getByText("Mama Kemi's Store")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Backfill inventory links" })).toBeInTheDocument();
  });

  it("hides the button and shows a role-required message for a read-only ANALYST", async () => {
    loginAs("ANALYST");
    mockInitialLoad();

    renderPage();

    await waitFor(() => expect(screen.getByText("Mama Kemi's Store")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Backfill inventory links" })).not.toBeInTheDocument();
    expect(screen.getByText("Requires SUPER_ADMIN or SUPPORT to run.")).toBeInTheDocument();
  });

  it("clicking the button calls the backfill endpoint and reports the linked count", async () => {
    const user = userEvent.setup();
    loginAs("SUPER_ADMIN");
    mockInitialLoad();
    vi.mocked(apiFetch).mockResolvedValueOnce({ transactionItemsLinked: 3 });

    renderPage();
    await waitFor(() => expect(screen.getByText("Mama Kemi's Store")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Backfill inventory links" }));

    expect(apiFetch).toHaveBeenCalledWith(
      "/admin/businesses/biz-1/inventory/backfill",
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Linked 3 transaction item(s) to inventory and applied matching stock movements."),
      ).toBeInTheDocument(),
    );
  });

  it("reports a zero-result run distinctly from an error", async () => {
    const user = userEvent.setup();
    loginAs("SUPER_ADMIN");
    mockInitialLoad();
    vi.mocked(apiFetch).mockResolvedValueOnce({ transactionItemsLinked: 0 });

    renderPage();
    await waitFor(() => expect(screen.getByText("Mama Kemi's Store")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Backfill inventory links" }));

    await waitFor(() =>
      expect(
        screen.getByText("No un-linked sale/purchase line items found — nothing to backfill."),
      ).toBeInTheDocument(),
    );
  });
});

describe("BusinessDetailPage — invoices section (Phase 23 gap closure)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the invoice list with a formatted amount, status, and provider", async () => {
    loginAs("SUPER_ADMIN");
    const invoice: Invoice = {
      id: "inv-1",
      subscriptionId: "sub-1",
      amountMinor: "500000",
      currencyCode: "NGN",
      status: "PAID",
      dueDate: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      providerCode: "FLUTTERWAVE",
      providerReference: "tx-ref-1",
      subscription: { planCode: "STARTER" },
    };
    mockInitialLoad([invoice]);

    renderPage();

    await waitFor(() => expect(screen.getByText("STARTER")).toBeInTheDocument());
    expect(screen.getByText("5000.00")).toBeInTheDocument();
    expect(screen.getByText("PAID")).toBeInTheDocument();
    expect(screen.getByText("FLUTTERWAVE")).toBeInTheDocument();
  });

  it("shows an empty-state message when the business has no invoices", async () => {
    loginAs("ANALYST");
    mockInitialLoad([]);

    renderPage();

    await waitFor(() => expect(screen.getByText("Mama Kemi's Store")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No invoices for this business yet.")).toBeInTheDocument());
  });
});

describe("BusinessDetailPage — payment requests section (Phase 24)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the payment request list with a formatted amount, customer, and status", async () => {
    loginAs("SUPER_ADMIN");
    const paymentRequest: PaymentRequest = {
      id: "pr-1",
      businessId: "biz-1",
      customerId: "cust-1",
      description: "Payment from Amina",
      amountMinor: "75000",
      currencyCode: "NGN",
      status: "PAID",
      providerCode: "FLUTTERWAVE",
      providerReference: "tpr_test-1",
      checkoutUrl: null,
      transactionId: "txn-1",
      createdAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      customer: { name: "Amina" },
    };
    mockInitialLoad([], [paymentRequest]);

    renderPage();

    await waitFor(() => expect(screen.getByText("Payment from Amina")).toBeInTheDocument());
    expect(screen.getByText("750.00")).toBeInTheDocument();
    expect(screen.getByText("Amina")).toBeInTheDocument();
    expect(screen.getByText("PAID")).toBeInTheDocument();
    expect(screen.getByText("FLUTTERWAVE")).toBeInTheDocument();
  });

  it("shows an empty-state message when the business has no payment requests", async () => {
    loginAs("ANALYST");
    mockInitialLoad([], []);

    renderPage();

    await waitFor(() => expect(screen.getByText("Mama Kemi's Store")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No payment requests for this business yet.")).toBeInTheDocument());
  });
});
