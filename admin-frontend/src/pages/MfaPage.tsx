import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AuthShell } from "../components/AuthShell";
import { QrCode } from "../components/QrCode";
import { ApiError, apiFetch } from "../lib/apiClient";

interface EnrolStart { secret: string; otpauthUri: string }
interface EnrolConfirm { recoveryCodes: string[] }

/**
 * The authenticator step (admin-console Phase 2). Three situations, chosen by what the server said at sign-in:
 *   - ENROLMENT_REQUIRED: show the setup key, take a first code, then show the recovery codes ONCE;
 *   - CHALLENGE_REQUIRED: take the 6-digit code, or switch to a recovery code;
 * Nothing else in the console opens until this is done (the server enforces it; this screen only follows).
 */
export function MfaPage() {
  const { isAuthenticated, mfaState, mfaPending, completeMfa, logout } = useAuth();
  const navigate = useNavigate();
  const [setup, setSetup] = useState<EnrolStart | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enrolling = mfaState === "ENROLMENT_REQUIRED";

  useEffect(() => {
    if (!isAuthenticated || !enrolling || setup || codes) return;
    let cancelled = false;
    apiFetch<EnrolStart>("/admin/mfa/enroll/start", { method: "POST", body: {} })
      .then((s) => { if (!cancelled) setSetup(s); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not start setup. Please try again."); });
    return () => { cancelled = true; };
  }, [isAuthenticated, enrolling, setup, codes]);

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!mfaPending && !codes) return <Navigate to="/businesses" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (enrolling) {
        const out = await apiFetch<EnrolConfirm>("/admin/mfa/enroll/confirm", { method: "POST", body: { code: code.trim() } });
        setCodes(out.recoveryCodes);
      } else {
        await apiFetch(useRecovery ? "/admin/mfa/recovery" : "/admin/mfa/challenge", { method: "POST", body: { code: code.trim() } });
        completeMfa();
        navigate("/businesses", { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    completeMfa();
    navigate("/businesses", { replace: true });
  }

  if (codes) {
    return (
      <AuthShell>
        <div className="login-form">
          <p className="login-eyebrow">Authenticator is set up</p>
          <h1>Save your <em>recovery codes.</em></h1>
          <p className="login-lede">If you lose your phone, each of these signs you in once. They are shown only now. Store them somewhere safe, such as a password manager.</p>
          <ul aria-label="Recovery codes" style={{ columns: 2, listStyle: "none", padding: 0, fontFamily: "ui-monospace, monospace" }}>
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved these codes
          </label>
          <button type="button" className="login-submit" disabled={!saved} onClick={finish}>Continue to the console</button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form className="login-form" onSubmit={submit}>
        <p className="login-eyebrow">{enrolling ? "Set up your authenticator" : "Second step"}</p>
        <h1>{enrolling ? <>Protect your <em>account.</em></> : <>Enter your <em>code.</em></>}</h1>

        {enrolling ? (
          <>
            <p className="login-lede">Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password) on your phone and scan this code, then enter the 6-digit code it shows.</p>
            {setup ? (
              <>
                <QrCode value={setup.otpauthUri} label="QR code to scan with your authenticator app" />
                <p className="login-lede">Cannot scan it? In the app choose &ldquo;Enter a setup key&rdquo; and type this key (account name TradePal Admin, time based):</p>
                <p aria-label="Setup key" style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{setup.secret}</p>
                <p><a href={setup.otpauthUri}>Open in my authenticator app</a> (only if you are on your phone)</p>
              </>
            ) : (
              <p>Preparing your setup key…</p>
            )}
          </>
        ) : (
          <p className="login-lede">{useRecovery ? "Enter one of your recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app."}</p>
        )}

        <label>
          {useRecovery ? "Recovery code" : "6-digit code"}
          <span className="login-field">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={useRecovery ? 12 : 8}
            />
          </span>
        </label>

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <button type="submit" className="login-submit" disabled={busy || (enrolling && !setup) || code.trim().length < 6}>
          {busy ? "Checking…" : enrolling ? "Confirm and finish" : "Continue"}
        </button>
        {!enrolling ? (
          <p className="login-foot">
            <button type="button" className="link-button" onClick={() => { setUseRecovery((v) => !v); setCode(""); setError(null); }}>
              {useRecovery ? "Use my authenticator app instead" : "I lost my phone: use a recovery code"}
            </button>
          </p>
        ) : null}
        <p className="login-foot"><button type="button" className="link-button" onClick={logout}>Sign out</button></p>
      </form>
    </AuthShell>
  );
}
