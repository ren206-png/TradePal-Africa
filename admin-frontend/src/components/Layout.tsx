import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const navItems = [
  { to: "/businesses", label: "Businesses" },
  { to: "/deletion-requests", label: "Deletion requests" },
  { to: "/audit-logs", label: "Audit logs" },
  { to: "/mobile-money-alerts", label: "Mobile money alerts" },
  { to: "/plans", label: "Plans" },
  { to: "/feature-flags", label: "Feature flags" },
];

export function Layout({ children }: { children: ReactNode }) {
  const { admin, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">TradePal Admin</span>
        <nav>
          {navItems.map((item) => (
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
