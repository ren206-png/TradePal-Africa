import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { apiFetch, clearStepUpToken, setGuardHandlers, storeStepUpToken } from "../lib/apiClient";

type Prompt = { kind: "step-up" } | { kind: "support-access"; businessId: string };

/**
 * Renders the password / reason prompts that apiFetch asks for when the server requires step-up auth or a
 * support-access reason (expansion Phase 1). Mount once, inside the authenticated app.
 */
export function GuardPrompts() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const open = useCallback((next: Prompt) => {
    setValue("");
    setError(null);
    setPrompt(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setPrompt(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  useEffect(() => {
    setGuardHandlers({
      requestStepUp: () => open({ kind: "step-up" }),
      requestSupportAccess: (businessId) => open({ kind: "support-access", businessId }),
    });
    return () => {
      setGuardHandlers(null);
      clearStepUpToken();
    };
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt) return;
    setBusy(true);
    setError(null);
    try {
      if (prompt.kind === "step-up") {
        const result = await apiFetch<{ stepUpToken: string; expiresInSeconds: number }>("/admin/step-up", {
          method: "POST",
          body: { password: value },
        });
        storeStepUpToken(result.stepUpToken, result.expiresInSeconds);
      } else {
        await apiFetch(`/admin/businesses/${encodeURIComponent(prompt.businessId)}/support-access`, {
          method: "POST",
          body: { reason: value.trim() },
        });
      }
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  if (!prompt) return null;
  const isStepUp = prompt.kind === "step-up";
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={isStepUp ? "Confirm your password" : "Reason for access"}>
      <form className="modal" onSubmit={submit}>
        <h2>{isStepUp ? "Confirm your password" : "Why do you need this merchant's data?"}</h2>
        <p>
          {isStepUp
            ? "This action needs a fresh confirmation. Lasts 5 minutes."
            : "Your reason is recorded and shown in the audit log. Access lasts 30 minutes."}
        </p>
        {isStepUp ? (
          <input type="password" autoFocus autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Password" />
        ) : (
          <textarea autoFocus rows={3} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Reason" placeholder="e.g. Merchant reported a missing payment, ticket 123" />
        )}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={() => close(false)} disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || value.trim().length === 0}>{busy ? "Working…" : "Continue"}</button>
        </div>
      </form>
    </div>
  );
}
