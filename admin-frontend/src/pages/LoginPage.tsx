import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/apiClient";

// The console areas listed on the art panel — mirrors the routes in App.tsx.
const AREAS = [
  ["Businesses", "01"],
  ["Deletion requests", "02"],
  ["Audit logs", "03"],
  ["Mobile money alerts", "04"],
  ["Plans", "05"],
  ["Feature flags", "06"],
] as const;

function LogoMark() {
  return (
    <svg viewBox="0 0 36 36" role="img" aria-label="TradePal" xmlns="http://www.w3.org/2000/svg">
      <rect width="36" height="36" rx="10" fill="#f7f1e5" />
      <path
        d="M9.5 7.5h17a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H18l-6 4.5V24.5H9.5A3.5 3.5 0 0 1 6 21V11a3.5 3.5 0 0 1 3.5-3.5Z"
        fill="#0f2a22"
      />
      <rect x="11.5" y="11.6" width="12" height="2.8" rx="1" fill="#f7f1e5" />
      <rect x="16" y="11.6" width="2.8" height="9.8" rx="1" fill="#f7f1e5" />
      <circle cx="24.2" cy="20.6" r="2.2" fill="#e9a21b" />
    </svg>
  );
}

export function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) return <Navigate to="/businesses" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/businesses", { replace: true });
    } catch (err) {
      // The backend deliberately returns the same message for "unknown email"
      // and "wrong password" (see adminRoutes.ts) so this can't be used to
      // enumerate admin accounts — shown here as-is, unchanged.
      setError(err instanceof ApiError ? err.message : "Login failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <aside className="login-art">
        <div className="login-weave top" aria-hidden="true" />

        <div className="login-brand">
          <LogoMark />
          <span className="login-brand-name">
            TradePal<small>Admin</small>
          </span>
        </div>

        <div className="login-tagline">
          <h2>
            The books, <em>behind the chat.</em>
          </h2>
          <p>
            Every shop, plan and payment running through TradePal on WhatsApp, kept in one place for the team that
            looks after them.
          </p>
        </div>

        <ul className="login-areas" aria-label="What's inside the console">
          {AREAS.map(([name, n]) => (
            <li key={name}>
              <span>{name}</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>

        <div className="login-weave bottom" aria-hidden="true" />
      </aside>

      <main className="login-panel">
        <form className="login-form" onSubmit={handleSubmit}>
          <p className="login-eyebrow">Admin console</p>
          <h1>
            Welcome <em>back.</em>
          </h1>
          <p className="login-lede">Sign in with your admin account to manage businesses, plans and requests.</p>

          <label>
            Email
            <span className="login-field">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                autoFocus
              />
            </span>
          </label>

          <label>
            Password
            <span className="login-field">
              <input
                type={showPassword ? "text" : "password"}
                className="has-toggle"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="login-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </span>
          </label>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="login-submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
            {submitting ? null : (
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            )}
          </button>

          <p className="login-foot">Authorised TradePal staff only.</p>
        </form>
      </main>
    </div>
  );
}
