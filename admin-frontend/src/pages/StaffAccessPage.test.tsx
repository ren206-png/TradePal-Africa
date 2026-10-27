import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { Layout } from "../components/Layout";
import { apiFetch } from "../lib/apiClient";
import { StaffAccessPage } from "./StaffAccessPage";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return { ...actual, apiFetch: vi.fn() };
});

const STAFF = [
  { id: "me", email: "boss@example.com", name: "Boss", role: "SUPER_ADMIN", status: "ACTIVE", mfa: "ENROLLED", lastSignInAt: null, liveSessions: 1 },
  { id: "p2", email: "ops@example.com", name: "Ops", role: "OPERATOR", status: "ACTIVE", mfa: "REQUIRED", lastSignInAt: null, liveSessions: 2 },
];

function signedIn(role: string) {
  localStorage.setItem("tradepal_admin_token", "t");
  localStorage.setItem("tradepal_admin_user", JSON.stringify({ id: "me", email: "boss@example.com", name: "Boss", role }));
  localStorage.setItem("tradepal_admin_mfa", "VERIFIED");
}

function route(handlers: Record<string, unknown> = {}) {
  vi.mocked(apiFetch).mockImplementation((async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in handlers) {
      const h = handlers[key];
      return typeof h === "function" ? (h as (b: unknown) => unknown)(options?.body) : h;
    }
    if (path === "/admin/staff") return { staff: STAFF };
    if (path === "/admin/staff/invitations" && !options?.method) return { invitations: [] };
    if (path === "/admin/staff/ownership-transfers" && !options?.method) return { transfers: [] };
    if (path.startsWith("/admin/security-events")) return { events: [{ id: "e1", eventType: "LOGIN_FAILED", result: "FAILURE", createdAt: new Date().toISOString(), adminUserId: null }] };
    if (path === "/admin/me/permissions") return { role: "SUPER_ADMIN", permissions: ["admin:view_staff", "admin:view_overview", "admin:view_orgs"] };
    return {};
  }) as never);
}

describe("staff access page", () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(apiFetch).mockReset(); });
  afterEach(() => vi.clearAllMocks());

  it("lists people with role, status and authenticator state, and shows the security events", async () => {
    signedIn("SUPER_ADMIN");
    route();
    render(<AuthProvider><StaffAccessPage /></AuthProvider>);
    expect(await screen.findByText("ops@example.com")).toBeInTheDocument();
    expect(screen.getByText("Required, not yet set up")).toBeInTheDocument();
    expect(await screen.findByText("LOGIN_FAILED")).toBeInTheDocument();
    // your own row has no destructive actions
    const mine = screen.getByText("boss@example.com").closest("tr")!;
    expect(within(mine).getByText("You")).toBeInTheDocument();
  });

  it("will not change a role or disable anyone until a reason is typed, then sends it with the change", async () => {
    signedIn("SUPER_ADMIN");
    const sent: unknown[] = [];
    route({ "POST /admin/staff/p2/disable": (b: unknown) => { sent.push(b); return { status: "DISABLED" }; } });
    const user = userEvent.setup();
    render(<AuthProvider><StaffAccessPage /></AuthProvider>);
    const row = (await screen.findByText("ops@example.com")).closest("tr")!;
    const disable = within(row).getByRole("button", { name: "Disable" });
    expect(disable).toBeDisabled();
    await user.type(screen.getByLabelText("Reason for the next change"), "left the company");
    expect(disable).toBeEnabled();
    await user.click(disable);
    await waitFor(() => expect(sent).toEqual([{ reason: "left the company" }]));
  });

  it("shows an invitation link once, right after it is made", async () => {
    signedIn("SUPER_ADMIN");
    route({ "POST /admin/staff/invitations": { link: "https://admin.example.test/accept-invite#token=abc" } });
    const user = userEvent.setup();
    render(<AuthProvider><StaffAccessPage /></AuthProvider>);
    await user.type(await screen.findByLabelText("Invitation email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByLabelText("Invitation link")).toHaveValue("https://admin.example.test/accept-invite#token=abc");
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
  });

  it("shows the server's message when a change is refused", async () => {
    signedIn("SUPER_ADMIN");
    const { ApiError } = await import("../lib/apiClient");
    route({ "POST /admin/staff/p2/disable": () => { throw new ApiError("That would leave the platform without an active owner.", 409, "LAST_OWNER"); } });
    const user = userEvent.setup();
    render(<AuthProvider><StaffAccessPage /></AuthProvider>);
    const row = (await screen.findByText("ops@example.com")).closest("tr")!;
    await user.type(screen.getByLabelText("Reason for the next change"), "testing it");
    await user.click(within(row).getByRole("button", { name: "Disable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/without an active owner/);
  });
});

describe("navigation", () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(apiFetch).mockReset(); });

  it("shows a newer role only what its permissions allow, and the Staff access link only to those who may use it", async () => {
    signedIn("MODERATOR");
    vi.mocked(apiFetch).mockResolvedValue({ permissions: ["admin:view_overview", "admin:view_orgs", "admin:view_moderation", "admin:moderate_listings"] });
    render(<AuthProvider><MemoryRouter><Layout><p>x</p></Layout></MemoryRouter></AuthProvider>);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Payments" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Moderation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Businesses" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit logs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Staff access" })).not.toBeInTheDocument();
  });

  it("keeps every familiar item for the original roles and adds Staff access for an owner", async () => {
    signedIn("SUPER_ADMIN");
    vi.mocked(apiFetch).mockResolvedValue({ permissions: ["admin:view_staff"] });
    render(<AuthProvider><MemoryRouter><Layout><p>x</p></Layout></MemoryRouter></AuthProvider>);
    expect(await screen.findByRole("link", { name: "Staff access" })).toBeInTheDocument();
    for (const name of ["Payments", "Audit logs", "Feature flags", "Moderation"]) expect(screen.getByRole("link", { name })).toBeInTheDocument();
  });

  it("groups the sidebar by task and drops a group the person has nothing in", async () => {
    signedIn("MODERATOR");
    vi.mocked(apiFetch).mockResolvedValue({ permissions: ["admin:view_overview", "admin:view_orgs", "admin:view_moderation"] });
    render(<AuthProvider><MemoryRouter><Layout><p>x</p></Layout></MemoryRouter></AuthProvider>);
    const nav = screen.getByRole("navigation", { name: "Main" });
    await waitFor(() => expect(within(nav).queryByRole("link", { name: "Payments" })).not.toBeInTheDocument());
    expect(within(nav).getByText("Businesses", { selector: "p" })).toBeInTheDocument();
    expect(within(nav).getByText("Conversations", { selector: "p" })).toBeInTheDocument();
    expect(within(nav).queryByText("Money", { selector: "p" })).not.toBeInTheDocument();
  });

  it("marks the page you are on and opens and closes the menu on a phone", async () => {
    signedIn("SUPER_ADMIN");
    vi.mocked(apiFetch).mockResolvedValue({ permissions: [] });
    render(<AuthProvider><MemoryRouter initialEntries={["/payments"]}><Layout><p>x</p></Layout></MemoryRouter></AuthProvider>);
    expect(screen.getByRole("link", { name: "Payments" })).toHaveClass("active");
    expect(screen.getByRole("link", { name: "Plans" })).not.toHaveClass("active");
    const sidebar = document.getElementById("app-sidebar") as HTMLElement;
    expect(sidebar).not.toHaveClass("open");
    await userEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    expect(sidebar).toHaveClass("open");
    await userEvent.click(screen.getByTestId("sidebar-scrim"));
    expect(sidebar).not.toHaveClass("open");
    await userEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    await userEvent.click(screen.getByRole("link", { name: "Plans" }));
    expect(sidebar).not.toHaveClass("open");
  });
});
