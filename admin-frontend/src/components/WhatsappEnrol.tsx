import { useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "../lib/apiClient";

interface Sent { sent: boolean; last4: string; expiresInSeconds: number }
interface Confirmed { enrolled: boolean; recoveryCodes?: string[] }

/**
 * Adds a WhatsApp number as a second step: the person types the number (with its country code), we send a code to it, and entering the code
 * proves the number is theirs. Used on the first-time setup screen and in Account security. The server decides what is allowed (a person
 * who already has a second step must have signed in fully and confirmed recently; that prompt appears by itself).
 */
export function WhatsappEnrol({ onEnrolled }: { onEnrolled: (recoveryCodes: string[] | undefined) => void }) {
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const out = await apiFetch<Sent>("/admin/mfa/whatsapp/enroll/start", { method: "POST", body: { phone: phone.trim() } });
      setSentTo(out.last4);
      setCode("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const out = await apiFetch<Confirmed>("/admin/mfa/whatsapp/enroll/confirm", { method: "POST", body: { code: code.trim() } });
      onEnrolled(out.recoveryCodes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo === null) {
    return (
      <form className="whatsapp-enrol" onSubmit={send}>
        <p className="login-lede">Enter your WhatsApp number with its country code. We will send a 6-digit code to it.</p>
        <label>
          WhatsApp number
          <span className="login-field">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="+1 403 555 0100" required maxLength={40} />
          </span>
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button type="submit" className="login-submit" disabled={busy || phone.trim().length < 6}>{busy ? "Sending…" : "Send me a code"}</button>
      </form>
    );
  }
  return (
    <form className="whatsapp-enrol" onSubmit={confirm}>
      <p className="login-lede">We sent a code to your WhatsApp number ending {sentTo}. It lasts 5 minutes.</p>
      <label>
        6-digit code
        <span className="login-field">
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={8} />
        </span>
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button type="submit" className="login-submit" disabled={busy || code.trim().length < 6}>{busy ? "Checking…" : "Confirm and finish"}</button>
      <p className="login-foot">
        <button type="button" className="link-button" disabled={busy} onClick={() => void send()}>Send a new code</button>
        {" · "}
        <button type="button" className="link-button" onClick={() => { setSentTo(null); setError(null); }}>Use a different number</button>
      </p>
    </form>
  );
}
