import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/apiClient";
import type { PaymentAttemptRow, PaymentExceptionRow, PaymentsOverview, RefundRow, SettlementRow } from "../lib/types";

const OUTCOMES = ["NO_ACTION_NEEDED", "CORRECTED_BY_PROVIDER", "SETTLED_OFFLINE", "REFUNDED_OFFLINE", "CONTACTED_PARTIES", "ESCALATED_TO_PROVIDER"] as const;
const count = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(", ") || "none";

interface Dialog {
  kind: "resolve" | "close";
  id: string;
  title: string;
}

export function PaymentsPage() {
  const [overview, setOverview] = useState<PaymentsOverview | null>(null);
  const [attempts, setAttempts] = useState<PaymentAttemptRow[]>([]);
  const [exceptions, setExceptions] = useState<PaymentExceptionRow[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [settlements, setSettlements] = useState<SettlementRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>("CONTACTED_PARTIES");
  const [closeAs, setCloseAs] = useState<"FAILED" | "CANCELLED">("FAILED");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [o, a, e, r, s] = await Promise.all([
          apiFetch<PaymentsOverview>("/admin/payments/overview"),
          apiFetch<{ attempts: PaymentAttemptRow[] }>("/admin/payments/attempts?status=unresolved"),
          apiFetch<{ exceptions: PaymentExceptionRow[] }>("/admin/payments/exceptions"),
          apiFetch<{ refunds: RefundRow[] }>("/admin/payments/refunds"),
          apiFetch<{ settlements: SettlementRow[] }>("/admin/payments/settlements"),
        ]);
        if (cancelled) return;
        setOverview(o);
        setAttempts(a.attempts);
        setExceptions(e.exceptions);
        setRefunds(r.refunds);
        setSettlements(s.settlements);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const post = useCallback(async (path: string, body: object, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(path, { method: "POST", body });
      setNotice(done);
      setDialog(null);
      setText("");
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dialog) return;
    if (dialog.kind === "resolve") void post(`/admin/payments/exceptions/${dialog.id}/resolve`, { outcome, note: text.trim() }, "Exception resolved.");
    else void post(`/admin/payments/attempts/${dialog.id}/close`, { as: closeAs, reason: text.trim() }, "Attempt closed after the provider confirmed it did not collect.");
  }

  if (error && !overview) return <div className="page"><h1>Payments</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!overview) return <div className="page"><h1>Payments</h1><p>Loading…</p></div>;

  return (
    <div className="page">
      <h1>Payments and exceptions</h1>
      <p className="muted">
        Merchant sales payments through providers. A payment is applied only when the provider confirms it. Nothing here can mark a payment paid or move money: you check
        with the provider, close what is dead, and record how an exception was settled.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="stat-grid">
        <div className="stat-card"><div className="stat-value">{count(overview.attempts)}</div><div className="stat-label">Attempts</div></div>
        <div className={Object.keys(overview.openProviderExceptions).length ? "stat-card stat-warn" : "stat-card"}><div className="stat-value">{count(overview.openProviderExceptions)}</div><div className="stat-label">Open provider exceptions</div></div>
        <div className="stat-card"><div className="stat-value">{count(overview.refunds)}</div><div className="stat-label">Refunds</div></div>
        <div className={overview.callbacks.dead > 0 ? "stat-card stat-warn" : "stat-card"}><div className="stat-value">{overview.callbacks.dead}</div><div className="stat-label">Callbacks dead-lettered</div></div>
      </div>
      <p className="muted">
        Providers in this environment: {overview.providers.length ? overview.providers.join(", ") : "none (live online payment is unavailable)"}. Collected but not yet settled:{" "}
        {overview.collectedNotSettled.map((c) => `${c.amountMinor} ${c.currencyCode} (minor units)`).join(", ") || "nothing"}.
      </p>
      {overview.connections.filter((c) => c.circuitOpen).map((c) => <p key={c.id} className="form-error">Provider unavailable for {c.business} ({c.provider}): new payments are paused; reconciliation continues.</p>)}

      <h2>Exceptions</h2>
      <table className="data-table">
        <thead><tr><th>When</th><th>Shop</th><th>Order</th><th>Type</th><th>Amount (minor)</th><th>Source</th><th /></tr></thead>
        <tbody>
          {exceptions.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString()}</td><td>{e.business ?? "unknown"}</td><td>{e.reference ?? "-"}</td><td>{e.type.toLowerCase().replace(/_/g, " ")}</td>
              <td>{e.amountMinor ?? "-"} {e.currencyCode ?? ""}</td><td>{e.source === "PROVIDER" ? "provider" : "shop order (the seller resolves)"}</td>
              <td>{e.source === "PROVIDER" ? <button type="button" onClick={() => { setDialog({ kind: "resolve", id: e.id, title: `Resolve: ${e.type.toLowerCase().replace(/_/g, " ")}` }); setText(""); }}>Resolve…</button> : null}</td>
            </tr>
          ))}
          {exceptions.length === 0 ? <tr><td colSpan={7}>No open exceptions.</td></tr> : null}
        </tbody>
      </table>

      <h2>Unresolved attempts</h2>
      <table className="data-table">
        <thead><tr><th>Created</th><th>Shop</th><th>Order</th><th>Status</th><th>Amount (minor)</th><th>Checks</th><th /></tr></thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.createdAt).toLocaleString()}</td><td>{a.business}</td><td>{a.reference}</td><td>{a.status.toLowerCase()}</td><td>{a.amountMinor} {a.currencyCode}</td><td>{a.pollCount}</td>
              <td>
                <button type="button" disabled={busy} onClick={() => void post(`/admin/payments/attempts/${a.id}/refresh`, {}, "Checked with the provider.")}>Check with provider</button>{" "}
                <button type="button" onClick={() => { setDialog({ kind: "close", id: a.id, title: "Close this attempt" }); setText(""); }}>Close…</button>
              </td>
            </tr>
          ))}
          {attempts.length === 0 ? <tr><td colSpan={7}>Nothing waiting on a provider.</td></tr> : null}
        </tbody>
      </table>

      <h2>Refunds</h2>
      <table className="data-table">
        <thead><tr><th>Shop</th><th>Order</th><th>Amount (minor)</th><th>Status</th><th /></tr></thead>
        <tbody>
          {refunds.map((r) => (
            <tr key={r.id}>
              <td>{r.business}</td><td>{r.reference}</td><td>{r.amountMinor}</td><td>{r.status.toLowerCase()}{r.failureReason ? ` (${r.failureReason})` : ""}</td>
              <td>{r.status === "FAILED" ? <button type="button" disabled={busy} onClick={() => void post(`/admin/payments/refunds/${r.id}/retry`, {}, "Refund retried through the same provider.")}>Retry</button> : null}</td>
            </tr>
          ))}
          {refunds.length === 0 ? <tr><td colSpan={5}>No provider refunds.</td></tr> : null}
        </tbody>
      </table>

      <h2>Settlements</h2>
      <table className="data-table">
        <thead><tr><th>Shop</th><th>Reference</th><th>Gross</th><th>Fee</th><th>Net</th><th>Payments</th></tr></thead>
        <tbody>
          {settlements.map((s) => <tr key={s.id}><td>{s.business}</td><td>{s.reference}</td><td>{s.grossMinor} {s.currencyCode}</td><td>{s.feeMinor}</td><td>{s.netMinor}</td><td>{s.payments}</td></tr>)}
          {settlements.length === 0 ? <tr><td colSpan={6}>No settlements reported.</td></tr> : null}
        </tbody>
      </table>

      {dialog ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={dialog.title}>
          <form className="modal" onSubmit={submit}>
            <h2>{dialog.title}</h2>
            {dialog.kind === "resolve" ? (
              <label className="filter-label">Outcome
                <select value={outcome} onChange={(e) => setOutcome(e.target.value as (typeof OUTCOMES)[number])}>{OUTCOMES.map((o) => <option key={o} value={o}>{o.toLowerCase().replace(/_/g, " ")}</option>)}</select>
              </label>
            ) : (
              <>
                <p>The attempt is closed only if the provider confirms it did not collect. If it was paid, it is applied instead.</p>
                <label className="filter-label">Close as
                  <select value={closeAs} onChange={(e) => setCloseAs(e.target.value as "FAILED" | "CANCELLED")}><option value="FAILED">failed</option><option value="CANCELLED">cancelled</option></select>
                </label>
              </>
            )}
            <textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="Note" placeholder="What did you check or do? At least 10 characters. Recorded in the audit log." />
            <div className="modal-actions">
              <button type="button" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy || text.trim().length < 10}>{busy ? "Working…" : "Confirm"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
