import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/apiClient";
import { MessagingPage } from "./MessagingPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const channel = { lastDeliveredAt: null, lastFailedAt: "2026-10-30T00:00:00Z", lastChannelCheckAt: null, lastChannelCheckStatus: null, failedLast7Days: 2, recentFailures: [{ at: "2026-10-30T00:00:00Z", title: "AI provider billing failure (DeepSeek)", error: "denied", httpStatus: 403 }], needsAttention: true };
const overview = {
  consumerMessaging: { platformSwitchOn: false, globalDefault: false }, templatesByStatus: { APPROVED: 1 }, consents: [{ purpose: "ORDER_UPDATES", status: "OPTED_IN", count: 3 }], blockedNumbers: 1,
  outbound30d: { SENT: 4, SUPPRESSED: 2 }, suppressionReasons30d: [], volumes: { inbound24h: 10, inbound7d: 50, outbound24h: 9, outbound7d: 40 },
  aiParse7d: { total: 20, validationPassed: 18, validationFailed: 2, successRate: 90 }, stuckInbound: 1, alertChannel: channel,
  localization: [{ code: "en", name: "English", status: "SOURCE", keysServed: 40, keysTotal: 40, caveat: "Key count only. Comprehension and quality are not measured." }, { code: "kri", name: "Krio", status: "MISSING", keysServed: 0, keysTotal: 40, caveat: "x" }],
};
const templates = [
  { messageClass: "CONSUMER_ORDER_CONFIRMED", audience: "CONSUMER", category: "UTILITY", pipeline: "ENFORCED", trigger: "The seller confirms an order.", consentBasis: "ORDER_UPDATES_OPT_IN", windowRule: "TEMPLATE_REQUIRED", body: "{seller}: confirmed", needsTemplate: true, status: "NOT_SUBMITTED", providerTemplateName: null, approvalReference: null, disabledReason: null },
  { messageClass: "CONSUMER_ORDER_READY", audience: "CONSUMER", category: "UTILITY", pipeline: "ENFORCED", trigger: "ready", consentBasis: "ORDER_UPDATES_OPT_IN", windowRule: "TEMPLATE_REQUIRED", body: "{seller}: ready", needsTemplate: true, status: "APPROVED", providerTemplateName: "order_ready_v1", approvalReference: "meta:1", disabledReason: null },
  { messageClass: "MERCHANT_WEEKLY_DIGEST", audience: "MERCHANT", category: "UTILITY", pipeline: "LEGACY", trigger: "weekly", consentBasis: "MERCHANT_RELATIONSHIP", windowRule: "TEMPLATE_OUTSIDE_WINDOW", body: null, needsTemplate: false, status: "LEGACY", providerTemplateName: null, approvalReference: null, disabledReason: null },
];

function mockApi() {
  vi.mocked(apiFetch).mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]);
    if (path.endsWith("/overview")) return overview;
    if (path.endsWith("/templates")) return { templates };
    if (path.includes("/consents")) return { consents: [{ id: "c1", phone: "••••4567", business: "Ade Foods", purpose: "ORDER_UPDATES", status: "OPTED_IN", basis: "ORDER_CHECKOUT", textVersion: "order-updates-v1", updatedAt: "2026-10-30T00:00:00Z" }] };
    if (path.endsWith("/blocks")) return { blocks: [{ id: "b1", phone: "••••7777", source: "ADMIN", reason: "abuse", active: true, createdAt: "2026-10-30T00:00:00Z", liftedAt: null, liftReason: null }, { id: "b2", phone: "••••1111", source: "STOP_KEYWORD", reason: null, active: true, createdAt: "2026-10-30T00:00:00Z", liftedAt: null, liftReason: null }] };
    if (path.endsWith("/inbound/stuck")) return { events: [{ id: "e1", waMessageId: "w1", receivedAt: "2026-10-30T00:00:00Z", from: "••••2222", messageType: "text", replayable: true, tooOld: false }] };
    return {};
  });
}

describe("MessagingPage", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it("shows masked numbers, the register state, the alert channel warning and that only English exists", async () => {
    mockApi();
    render(<MessagingPage />);
    expect(await screen.findByText(/platform switch off/)).toBeTruthy();
    expect(screen.getByText("needs attention")).toBeTruthy();
    expect(screen.getByText(/AI provider billing failure \(DeepSeek\)/)).toBeTruthy();
    expect(screen.getByText("••••4567")).toBeTruthy();
    expect(screen.getByText("not submitted")).toBeTruthy();
    expect(screen.getByText(/order ready \(order_ready_v1\)|approved \(order_ready_v1\)/)).toBeTruthy();
    expect(screen.getByText(/Only English exists/)).toBeTruthy();
    expect(screen.queryByText(/2348031234567/)).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("will not approve without a provider name and reference, nor act without a real reason, and sends them", async () => {
    mockApi();
    render(<MessagingPage />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Record state…" }))[0]!);
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    await userEvent.type(screen.getByLabelText("Reason"), "Approved in WhatsApp Business Manager today");
    expect(confirm.disabled).toBe(true); // approved, but no provider name or reference yet
    await userEvent.type(screen.getByLabelText("Provider template name"), "order_confirmed_v1");
    await userEvent.type(screen.getByLabelText("Where the approval can be checked"), "meta:tpl:123");
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/messaging/templates/CONSUMER_ORDER_CONFIRMED", { method: "PUT", body: { status: "APPROVED", providerTemplateName: "order_confirmed_v1", approvalReference: "meta:tpl:123", reason: "Approved in WhatsApp Business Manager today" } }));
  });

  it("offers Unblock only for an operator block, never for a person's own STOP", async () => {
    mockApi();
    render(<MessagingPage />);
    await screen.findByText("••••7777");
    expect(screen.getAllByRole("button", { name: "Unblock…" })).toHaveLength(1);
    expect(screen.getByText("the person (STOP)")).toBeTruthy();
  });

  it("replays a stuck message with a reason", async () => {
    mockApi();
    render(<MessagingPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Replay…" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Redis was down during the incident");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/admin/messaging/inbound/e1/replay", { method: "POST", body: { reason: "Redis was down during the incident" } }));
  });
});
