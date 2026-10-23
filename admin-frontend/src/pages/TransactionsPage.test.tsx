import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { apiFetch } from "../lib/apiClient";
import type { AdminTransaction } from "../lib/types";
import { TransactionsPage } from "./TransactionsPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const POSTED: AdminTransaction = {
  id: "t-1", type: "SALE", amountMinor: "20000", currencyCode: "NGN", paymentStatus: "PAID", description: "2 bags rice", counterparty: "Mama Put",
  createdAt: "2026-10-20T10:00:00Z", itemCount: 1, status: "POSTED", reversalOfTransactionId: null, reversedByTransactionId: null,
  provenance: { label: "MERCHANT_ENTERED", channel: "WHATSAPP", reference: "wamid.1" }, journalEntryId: "j-1",
};
const REVERSED: AdminTransaction = { ...POSTED, id: "t-2", status: "REVERSED", reversedByTransactionId: "t-3", description: "old sale" };

function login(role: string) {
  localStorage.setItem("tradepal_admin_token", "tok");
  localStorage.setItem("tradepal_admin_user", JSON.stringify({ id: "a1", email: "a@x.test", name: "A", role }));
}
function renderPage() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/businesses/biz-1/transactions"]}>
        <Routes><Route path="/businesses/:id/transactions" element={<TransactionsPage />} /></Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("TransactionsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => localStorage.clear());

  it("lists transactions and offers Void only on live ones, only to roles that may reverse", async () => {
    login("OPERATOR");
    vi.mocked(apiFetch).mockResolvedValue({ transactions: [POSTED, REVERSED], pagination: { take: 20, skip: 0, hasMore: false } });
    renderPage();
    expect(await screen.findByText("2 bags rice")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Void/ })).toHaveLength(1);
    expect(screen.getByText("REVERSED")).toBeTruthy();
    expect(screen.getAllByText("200.00 NGN")).toHaveLength(2);
  });

  it("shows no Void button to a support agent", async () => {
    login("SUPPORT");
    vi.mocked(apiFetch).mockResolvedValue({ transactions: [POSTED], pagination: { take: 20, skip: 0, hasMore: false } });
    renderPage();
    await screen.findByText("2 bags rice");
    expect(screen.queryByRole("button", { name: /Void/ })).toBeNull();
  });

  it("voids with a reason of at least 10 characters, then reloads and explains the original is kept", async () => {
    login("SUPER_ADMIN");
    vi.mocked(apiFetch).mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === "POST") return { reversal: { id: "t-9" } };
      return { transactions: [POSTED], pagination: { take: 20, skip: 0, hasMore: false } };
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Void/ }));
    const submit = screen.getByRole("button", { name: "Void transaction" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), "too short");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), " now long enough");
    await userEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("original stays on record"));
    const post = vi.mocked(apiFetch).mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === "POST");
    expect(post?.[0]).toBe("/admin/businesses/biz-1/transactions/t-1/reverse");
    expect((post?.[1] as { body: { reason: string } }).body.reason).toBe("too short now long enough");
  });

  it("shows the server's message when the load is refused", async () => {
    login("SUPPORT");
    vi.mocked(apiFetch).mockRejectedValue(new Error("Open a support-access session with a reason before viewing this merchant's financial data."));
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("support-access");
  });
});
