import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { ApiError, apiFetch } from "../lib/apiClient";

/**
 * Where an invitation link lands (admin-console Phase 2): `/accept-invite#token=...`. The token lives in the URL fragment, which the
 * browser never sends to a server or a proxy log. The person chooses their name and password; the account then needs the authenticator
 * step at first sign-in.
 */
function tokenFromFragment(hash: string): string {
  const m = /(?:^#|&)token=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]!) : "";
}

export function AcceptInvitePage() {
  const token = useMemo(() => tokenFromFragment(window.location.hash), []);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/admin/invitations/accept", { method: "POST", body: { token, name: name.trim(), password }, authenticated: false });
      history.replaceState(null, "", window.location.pathname); // the link has done its job: take the token out of the address bar
      setDone("Your account is ready. Sign in, then set up your authenticator app.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell>
        <div className="login-form">
          <p className="login-eyebrow">Welcome</p>
          <h1>You are <em>in.</em></h1>
          <p className="login-lede">{done}</p>
          <Link className="login-submit" to="/login">Go to sign in</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form className="login-form" onSubmit={submit}>
        <p className="login-eyebrow">Invitation</p>
        <h1>Create your <em>account.</em></h1>
        {!token ? <p className="form-error" role="alert">This link is missing its invitation code. Ask for a new link.</p> : null}
        <label>Your name<span className="login-field"><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></span></label>
        <label>Password (at least 12 characters)<span className="login-field"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required /></span></label>
        <label>Repeat password<span className="login-field"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={12} required /></span></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button type="submit" className="login-submit" disabled={busy || !token}>{busy ? "Creating…" : "Create account"}</button>
      </form>
    </AuthShell>
  );
}
