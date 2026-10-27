import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/apiClient";

/** The four roles that existed before the permission matrix keep every item they always saw (their pages answer for themselves); newer roles see only what they may use. */
const ORIGINAL_ROLES = new Set(["SUPER_ADMIN", "OPERATOR", "SUPPORT", "ANALYST"]);

interface NavItem { to: string; label: string; needs: string; /** New in the permission era: shown only to a role that holds the permission. */ strict?: boolean }
const navItems: NavItem[] = [
  { to: "/overview", label: "Overview", needs: "admin:view_overview" },
  { to: "/system-health", label: "System health", needs: "admin:view_system_health" },
  { to: "/reorder", label: "Reorder", needs: "admin:view_reorder" },
  { to: "/support-cases", label: "Support cases", needs: "admin:view_support_cases" },
  { to: "/payments", label: "Payments", needs: "admin:view_payments" },
  { to: "/subscriptions", label: "Subscriptions", needs: "admin:view_subscriptions" },
  { to: "/messaging", label: "Messaging", needs: "admin:view_messaging" },
  { to: "/moderation", label: "Moderation", needs: "admin:view_moderation" },
  { to: "/businesses", label: "Businesses", needs: "admin:view_orgs" },
  { to: "/deletion-requests", label: "Deletion requests", needs: "admin:view_support_cases" },
  { to: "/audit-logs", label: "Audit logs", needs: "admin:view_audit_log" },
  { to: "/mobile-money-alerts", label: "Mobile money alerts", needs: "admin:view_payments" },
  { to: "/plans", label: "Plans", needs: "admin:view_subscriptions" },
  { to: "/feature-flags", label: "Feature flags", needs: "admin:view_orgs" },
  { to: "/refund-requests", label: "Refund requests", needs: "admin:request_refund", strict: true },
  { to: "/staff", label: "Staff access", needs: "admin:view_staff", strict: true },
];

export function Layout({ children }: { children: ReactNode }) {
  const { admin, logout } = useAuth();
  // Hide what this person cannot use (the server enforces it either way). While the list loads, or if it cannot be read, nothing is hidden.
  const [permissions, setPermissions] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ permissions: string[] }>("/admin/me/permissions")
      .then((r) => { if (!cancelled) setPermissions(r.permissions); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [admin?.id]);
  const visible = navItems.filter((item) => {
    if (permissions === null) return !item.strict;
    if (item.strict) return permissions.includes(item.needs);
    return admin && ORIGINAL_ROLES.has(admin.role) ? true : permissions.includes(item.needs);
  });

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">TradePal Admin</span>
        <nav>
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="app-user">
          {admin ? (
            <>
              <span>
                {admin.name} <span className="role-badge">{admin.role}</span>
              </span>
              <button type="button" onClick={logout}>
                Log out
              </button>
            </>
          ) : null}
        </div>
      </header>
      <main className="app-content">{children}</main>
    </div>
  );
}
