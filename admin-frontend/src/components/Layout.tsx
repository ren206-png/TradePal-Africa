import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/apiClient";

/** The four roles that existed before the permission matrix keep every item they always saw (their pages answer for themselves); newer roles see only what they may use. */
const ORIGINAL_ROLES = new Set(["SUPER_ADMIN", "OPERATOR", "SUPPORT", "ANALYST"]);

interface NavItem { to: string; label: string; needs: string; /** New in the permission era: shown only to a role that holds the permission. */ strict?: boolean }
interface NavGroup { title: string | null; items: NavItem[] }

/** The sidebar: items grouped by what people come here to do. A group with nothing the person may use is not shown at all. */
const navGroups: NavGroup[] = [
  { title: null, items: [{ to: "/overview", label: "Overview", needs: "admin:view_overview" }] },
  {
    title: "Money",
    items: [
      { to: "/payments", label: "Payments", needs: "admin:view_payments" },
      { to: "/subscriptions", label: "Subscriptions", needs: "admin:view_subscriptions" },
      { to: "/plans", label: "Plans", needs: "admin:view_subscriptions" },
      { to: "/mobile-money-alerts", label: "Mobile money alerts", needs: "admin:view_payments" },
      { to: "/refund-requests", label: "Refund requests", needs: "admin:request_refund", strict: true },
    ],
  },
  {
    title: "Businesses",
    items: [
      { to: "/businesses", label: "Businesses", needs: "admin:view_orgs" },
      { to: "/support-cases", label: "Support cases", needs: "admin:view_support_cases" },
      { to: "/deletion-requests", label: "Deletion requests", needs: "admin:view_support_cases" },
      { to: "/reorder", label: "Reorder", needs: "admin:view_reorder" },
    ],
  },
  {
    title: "Conversations",
    items: [
      { to: "/messaging", label: "Messaging", needs: "admin:view_messaging" },
      { to: "/moderation", label: "Moderation", needs: "admin:view_moderation" },
    ],
  },
  {
    title: "Platform",
    items: [
      { to: "/system-health", label: "System health", needs: "admin:view_system_health" },
      { to: "/audit-logs", label: "Audit logs", needs: "admin:view_audit_log" },
      { to: "/feature-flags", label: "Feature flags", needs: "admin:view_orgs" },
      { to: "/staff", label: "Staff access", needs: "admin:view_staff", strict: true },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { admin, logout } = useAuth();
  // Hide what this person cannot use (the server enforces it either way). While the list loads, or if it cannot be read, nothing is hidden.
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ permissions: string[]; environment?: string }>("/admin/me/permissions")
      .then((r) => { if (!cancelled) { setPermissions(r.permissions); setEnvironment(r.environment ?? null); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [admin?.id]);
  const allowed = (item: NavItem): boolean => {
    if (permissions === null) return !item.strict;
    if (item.strict) return permissions.includes(item.needs);
    return admin && ORIGINAL_ROLES.has(admin.role) ? true : permissions.includes(item.needs);
  };
  const groups = navGroups.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length > 0);

  // On a phone the sidebar is a drawer: a button opens it, and choosing a page (or tapping outside it) closes it.
  const [open, setOpen] = useState(false);
  const badge = environment ? (
    <span className={`env-badge ${environment === "production" ? "env-production" : "env-other"}`} aria-label="Environment">
      {environment === "production" ? "PRODUCTION" : environment.toUpperCase()}
    </span>
  ) : null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-topbar">
        <button type="button" className="menu-button" aria-label="Open the menu" aria-expanded={open} aria-controls="app-sidebar" onClick={() => setOpen(true)}>
          <span aria-hidden="true">&#9776;</span> Menu
        </button>
        <span className="app-title">TradePal Admin</span>
        {badge}
      </header>
      {open ? <div className="sidebar-scrim" data-testid="sidebar-scrim" onClick={() => setOpen(false)} /> : null}
      <aside id="app-sidebar" className={open ? "app-sidebar open" : "app-sidebar"}>
        <div className="sidebar-brand">
          <span className="app-title">TradePal Admin</span>
          {badge}
          <button type="button" className="sidebar-close" aria-label="Close the menu" onClick={() => setOpen(false)}>&times;</button>
        </div>
        <nav aria-label="Main" className="sidebar-nav">
          {groups.map((group) => (
            <div className="nav-group" key={group.title ?? "top"}>
              {group.title ? <p className="nav-group-title">{group.title}</p> : null}
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} onClick={() => setOpen(false)} className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          {admin ? (
            <>
              <span className="sidebar-user-name">{admin.name}</span>
              <span className="role-badge">{admin.role}</span>
              <button type="button" onClick={logout}>Log out</button>
            </>
          ) : null}
        </div>
      </aside>
      <main id="main-content" className="app-content">{children}</main>
    </div>
  );
}
