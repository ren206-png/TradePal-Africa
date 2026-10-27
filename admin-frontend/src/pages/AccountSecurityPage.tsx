import { useCallback, useEffect, useState } from "react";
import { WhatsappEnrol } from "../components/WhatsappEnrol";
import { ApiError, apiFetch } from "../lib/apiClient";
import type { MfaMethods } from "../lib/types";

interface SessionInfo { mfa?: { methods?: MfaMethods } }

/**
 * Account security: the ways you can finish signing in, and adding or removing the WhatsApp one. Adding or removing a way to sign in is a
 * sensitive change: the server asks for your password and a current code, and the app prompts for them when it does.
 */
export function AccountSecurityPage() {
  const [methods, setMethods] = useState<MfaMethods | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiFetch<SessionInfo>("/admin/session");
      setMethods(s.mfa?.methods ?? null);
      setLoadError(s.mfa?.methods ? null : "This server did not report your sign-in options.");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load your sign-in options.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function remove() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch("/admin/mfa/whatsapp/remove", { method: "POST", body: {} });
      setNotice("WhatsApp codes are turned off for your account.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Account security</h1>
      <p>These are the ways you can finish signing in after your password. Recovery codes always work as a last resort.</p>
      {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {methods ? (
        <>
          <section aria-labelledby="sec-app">
            <h2 id="sec-app">Authenticator app</h2>
            <p>{methods.totp ? "Set up. Use the 6-digit code from your app." : "Not set up."}</p>
          </section>

          <section aria-labelledby="sec-wa">
            <h2 id="sec-wa">Codes by WhatsApp</h2>
            {!methods.whatsapp.available ? (
              <p>Not available on this server right now.</p>
            ) : methods.whatsapp.enrolled ? (
              <>
                <p>On. Codes go to your WhatsApp number ending {methods.whatsapp.last4}.</p>
                <button type="button" onClick={() => void remove()} disabled={busy}>{busy ? "Working…" : "Turn off WhatsApp codes"}</button>
                {!methods.totp ? <p>To turn this off you first need an authenticator app, so you are never locked out.</p> : null}
              </>
            ) : newCodes ? (
              <>
                <p>WhatsApp codes are on. Save your recovery codes now; they are shown only once.</p>
                <ul aria-label="Recovery codes" style={{ columns: 2, listStyle: "none", padding: 0, fontFamily: "ui-monospace, monospace" }}>
                  {newCodes.map((c) => <li key={c}>{c}</li>)}
                </ul>
                <button type="button" onClick={() => { setNewCodes(null); setAdding(false); void load(); }}>I have saved them</button>
              </>
            ) : adding ? (
              <WhatsappEnrol
                onEnrolled={(codes) => {
                  setNotice("WhatsApp codes are on.");
                  if (codes && codes.length > 0) setNewCodes(codes);
                  else { setAdding(false); void load(); }
                }}
              />
            ) : (
              <>
                <p>Get your sign-in code in a WhatsApp message instead of using an app.</p>
                <button type="button" onClick={() => { setAdding(true); setNotice(null); }}>Add my WhatsApp number</button>
              </>
            )}
          </section>
        </>
      ) : loadError ? null : <p>Loading…</p>}
    </div>
  );
}
