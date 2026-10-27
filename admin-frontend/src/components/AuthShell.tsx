import type { ReactNode } from "react";

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

/** The signed-out layout (art panel + a form panel) shared by the authenticator and invitation screens. */
export function AuthShell({ children }: { children: ReactNode }) {
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
            Two steps, <em>every time.</em>
          </h2>
          <p>Your password proves who you are. The code from your authenticator app proves it is really you.</p>
        </div>
        <div className="login-weave bottom" aria-hidden="true" />
      </aside>
      <main className="login-panel">{children}</main>
    </div>
  );
}
