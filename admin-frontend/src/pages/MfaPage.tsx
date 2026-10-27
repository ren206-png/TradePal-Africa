import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AuthShell } from "../components/AuthShell";
import { QrCode } from "../components/QrCode";
import { WhatsappEnrol } from "../components/WhatsappEnrol";
import { ApiError, apiFetch } from "../lib/apiClient";

interface EnrolStart { secret: string; otpauthUri: string }
interface EnrolConfirm { recoveryCodes: string[] }
interface Sent { sent: boolean; last4: string }

type EnrolMethod = "app" | "whatsapp";
type ChallengeMode = "app" | "whatsapp" | "recovery";

/**
 * The second step of sign-in (admin-console Phase 2). Two situations, chosen by what the server said at sign-in:
 *   - ENROLMENT_REQUIRED: set up an authenticator app (setup key, first code) or, where the server offers it, a WhatsApp number
 *     (a code is sent to it); then show the recovery codes ONCE;
 *   - CHALLENGE_REQUIRED: take the 6-digit code from the authenticator app or from WhatsApp, or switch to a recovery code;
 * Nothing else in the console opens until this is done (the server enforces it; this screen only follows).
 */
export function MfaPage() {
  const { isAuthenticated, mfaState, mfaPending, mfaMethods, completeMfa, logout } = useAuth();
  const navigate = useNavigate();
  const [setup, setSetup] = useState<EnrolStart | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState("");
  const whatsappOffered = mfaMethods?.whatsapp.available === true;
  const whatsappEnrolled = mfaMethods?.whatsapp.enrolled === true;
  const hasApp = mfaMethods ? mfaMethods.totp : true; // an older server says nothing: it only had the app
  const [enrolMethod, setEnrolMethod] = useState<EnrolMethod>("app");
  const [mode, setMode] = useState<ChallengeMode>(!hasApp && whatsappEnrolled ? "whatsapp" : "app");
  const [codeSent, setCodeSent] = useState<string | null>(null);
  const useRecovery = mode === "recovery";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enrolling = mfaState === "ENROLMENT_REQUIRED";

  useEffect(() => {
    if (!isAuthenticated || !enrolling || enrolMethod !== "app" || setup || codes) return;
    let cancelled = false;
    apiFetch<EnrolStart>("/admin/mfa/enroll/start", { method: "POST", body: {} })
      .then((s) => { if (!cancelled) setSetup(s); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not start setup. Please try again."); });
    return () => { cancelled = true; };
  }, [isAuthenticated, enrolling, enrolMethod, setup, codes]);

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
        const route = mode === "recovery" ? "/admin/mfa/recovery" : mode === "whatsapp" ? "/admin/mfa/whatsapp/verify" : "/admin/mfa/challenge";
        await apiFetch(route, { method: "POST", body: { code: code.trim() } });
        completeMfa();
        navigate("/businesses", { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendWhatsappCode() {
    setError(null);
    setBusy(true);
    try {
      const out = await apiFetch<Sent>("/admin/mfa/whatsapp/send", { method: "POST", body: {} });
      setCodeSent(out.last4);
      setCode("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: ChallengeMode) {
    setMode(next);
    setCode("");
    setError(null);
    setCodeSent(null);
  }

  function finish() {
    completeMfa();
    navigate("/businesses", { replace: true });
  }

  if (codes) {
    return (
      <AuthShell>
        <div className="login-form">
          <p className="login-eyebrow">Your second step is set up</p>
          <h1>Save your <em>recovery codes.</em></h1>
          <p className="login-lede">If you lose your phone or cannot get a code, each of these signs you in once. They are shown only now. Store them somewhere safe, such as a password manager.</p>
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

  // WhatsApp set-up has its own two small forms (number, then code).
  if (enrolling && enrolMethod === "whatsapp") {
    return (
      <AuthShell>
        <div className="login-form">
          <p className="login-eyebrow">Set up WhatsApp codes</p>
          <h1>Protect your <em>account.</em></h1>
          <WhatsappEnrol
            onEnrolled={(recoveryCodes) => {
              if (recoveryCodes && recoveryCodes.length > 0) setCodes(recoveryCodes);
              else finish();
            }}
          />
          <p className="login-foot"><button type="button" className="link-button" onClick={() => setEnrolMethod("app")}>Use an authenticator app instead</button></p>
          <p className="login-foot"><button type="button" className="link-button" onClick={logout}>Sign out</button></p>
        </div>
      </AuthShell>
    );
  }

  const whatsappMode = !enrolling && mode === "whatsapp";
  const needsSend = whatsappMode && codeSent === null;
  return (
    <AuthShell>
      <form className="login-form" onSubmit={needsSend ? (e) => { e.preventDefault(); void sendWhatsappCode(); } : submit}>
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
          <p className="login-lede">
            {mode === "recovery"
              ? "Enter one of your recovery codes. Each works once."
              : mode === "whatsapp"
                ? codeSent === null
                  ? `We will send a 6-digit code to your WhatsApp number ending ${mfaMethods?.whatsapp.last4 ?? "····"}.`
                  : `We sent a code to your WhatsApp number ending ${codeSent}. It lasts 5 minutes.`
                : "Enter the 6-digit code from your authenticator app."}
          </p>
        )}

        {needsSend ? null : (
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
        )}

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        {needsSend ? (
          <button type="submit" className="login-submit" disabled={busy}>{busy ? "Sending…" : "Send me a code"}</button>
        ) : (
          <button type="submit" className="login-submit" disabled={busy || (enrolling && !setup) || code.trim().length < 6}>
            {busy ? "Checking…" : enrolling ? "Confirm and finish" : "Continue"}
          </button>
        )}
        {enrolling && whatsappOffered ? (
          <p className="login-foot">
            <button type="button" className="link-button" onClick={() => setEnrolMethod("whatsapp")}>Get codes by WhatsApp instead</button>
          </p>
        ) : null}
        {!enrolling ? (
          <p className="login-foot">
            {mode === "whatsapp" && codeSent !== null ? (
              <><button type="button" className="link-button" disabled={busy} onClick={() => void sendWhatsappCode()}>Send a new code</button>{" · "}</>
            ) : null}
            {mode !== "app" && hasApp ? (
              <button type="button" className="link-button" onClick={() => switchMode("app")}>Use my authenticator app instead</button>
            ) : null}
            {mode !== "whatsapp" && whatsappEnrolled ? (
              <>{mode !== "app" && hasApp ? " · " : ""}<button type="button" className="link-button" onClick={() => switchMode("whatsapp")}>Send a code to my WhatsApp instead</button></>
            ) : null}
          </p>
        ) : null}
        {!enrolling && mode !== "recovery" ? (
          <p className="login-foot">
            <button type="button" className="link-button" onClick={() => switchMode("recovery")}>I lost my phone: use a recovery code</button>
          </p>
        ) : null}
        <p className="login-foot"><button type="button" className="link-button" onClick={logout}>Sign out</button></p>
      </form>
    </AuthShell>
  );
}
