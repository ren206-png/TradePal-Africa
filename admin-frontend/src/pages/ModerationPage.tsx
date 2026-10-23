import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/apiClient";
import type { AppealRow, ReportRow, SellerModerationRow } from "../lib/types";

type Action =
  | { kind: "unpublish"; listingId: string; reportId: string; title: string }
  | { kind: "suspend"; businessId: string; reportId: string; title: string }
  | { kind: "dismiss"; reportId: string; title: string }
  | { kind: "reinstateSeller"; businessId: string; title: string }
  | { kind: "appeal"; appealId: string; outcome: "UPHELD" | "OVERTURNED"; title: string };

export function ModerationPage() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [appeals, setAppeals] = useState<AppealRow[]>([]);
  const [sellers, setSellers] = useState<SellerModerationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [q, a, s] = await Promise.all([
          apiFetch<{ reports: ReportRow[] }>("/admin/moderation/queue"),
          apiFetch<{ appeals: AppealRow[] }>("/admin/moderation/appeals"),
          apiFetch<{ sellers: SellerModerationRow[] }>("/admin/moderation/sellers"),
        ]);
        if (cancelled) return;
        setReports(q.reports);
        setAppeals(a.appeals);
        setSellers(s.sellers);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!action) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const reason = text.trim();
    try {
      if (action.kind === "unpublish") await apiFetch(`/admin/moderation/listings/${action.listingId}/unpublish`, { method: "POST", body: { reason, reportId: action.reportId } });
      else if (action.kind === "suspend") await apiFetch(`/admin/moderation/sellers/${action.businessId}/suspend`, { method: "POST", body: { reason, reportId: action.reportId } });
      else if (action.kind === "dismiss") await apiFetch(`/admin/moderation/reports/${action.reportId}/dismiss`, { method: "POST", body: { reason } });
      else if (action.kind === "reinstateSeller") await apiFetch(`/admin/moderation/sellers/${action.businessId}/reinstate`, { method: "POST", body: { reason } });
      else await apiFetch(`/admin/moderation/appeals/${action.appealId}/decide`, { method: "POST", body: { outcome: action.outcome, reason } });
      setNotice("Recorded.");
      setAction(null);
      setText("");
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }, [action, text]);

  if (error && !loaded) return <div className="page"><h1>Listings and moderation</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!loaded) return <div className="page"><h1>Listings and moderation</h1><p>Loading…</p></div>;

  const suspended = sellers.filter((s) => s.marketplaceStatus === "SUSPENDED");
  return (
    <div className="page">
      <h1>Listings and moderation</h1>
      <p className="muted">
        A report proposes; you decide. Nothing is taken down automatically. Unpublishing a listing or suspending a seller hides it everywhere public but never blocks the
        seller from servicing orders already placed. Every decision is recorded with your name and reason and can be appealed.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <h2>Open reports</h2>
      <table className="data-table">
        <thead><tr><th>Reported</th><th>Seller</th><th>Item</th><th>Reason</th><th>What was said</th><th>Open reports on seller</th><th /></tr></thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.createdAt).toLocaleDateString()}</td>
              <td>{r.seller?.name ?? "unknown"} ({r.seller?.marketplaceStatus.toLowerCase()})</td>
              <td>{r.listing ? `${r.listing.item} (${r.listing.sku})${r.listing.moderation === "UNPUBLISHED" ? " - unpublished" : ""}` : "whole shop"}</td>
              <td>{r.reason.toLowerCase().replace(/_/g, " ")}</td>
              <td>{r.details}</td>
              <td>{r.openReportsAboutSeller}</td>
              <td>
                {r.listing && r.listing.moderation === "VISIBLE" ? <button type="button" onClick={() => { setAction({ kind: "unpublish", listingId: r.listing!.id, reportId: r.id, title: `Unpublish ${r.listing!.item}` }); setText(""); }}>Unpublish…</button> : null}{" "}
                {r.seller && r.seller.marketplaceStatus !== "SUSPENDED" ? <button type="button" onClick={() => { setAction({ kind: "suspend", businessId: r.seller!.id, reportId: r.id, title: `Suspend ${r.seller!.name}` }); setText(""); }}>Suspend seller…</button> : null}{" "}
                <button type="button" onClick={() => { setAction({ kind: "dismiss", reportId: r.id, title: "Dismiss this report" }); setText(""); }}>Dismiss…</button>
              </td>
            </tr>
          ))}
          {reports.length === 0 ? <tr><td colSpan={7}>No open reports.</td></tr> : null}
        </tbody>
      </table>

      <h2>Appeals</h2>
      <table className="data-table">
        <thead><tr><th>Seller</th><th>Decision appealed</th><th>Their reason</th><th /></tr></thead>
        <tbody>
          {appeals.map((a) => (
            <tr key={a.id}>
              <td>{a.seller}</td><td>{a.action.type.toLowerCase().replace(/_/g, " ")}: {a.action.reason}</td><td>{a.text}</td>
              <td>
                <button type="button" onClick={() => { setAction({ kind: "appeal", appealId: a.id, outcome: "OVERTURNED", title: "Overturn this decision" }); setText(""); }}>Overturn…</button>{" "}
                <button type="button" onClick={() => { setAction({ kind: "appeal", appealId: a.id, outcome: "UPHELD", title: "Uphold this decision" }); setText(""); }}>Uphold…</button>
              </td>
            </tr>
          ))}
          {appeals.length === 0 ? <tr><td colSpan={4}>No open appeals.</td></tr> : null}
        </tbody>
      </table>

      <h2>Suspended sellers</h2>
      <table className="data-table">
        <thead><tr><th>Seller</th><th>Reason</th><th /></tr></thead>
        <tbody>
          {suspended.map((s) => (
            <tr key={s.businessId}><td>{s.name}</td><td>{s.note}</td><td><button type="button" onClick={() => { setAction({ kind: "reinstateSeller", businessId: s.businessId, title: `Reinstate ${s.name}` }); setText(""); }}>Reinstate…</button></td></tr>
          ))}
          {suspended.length === 0 ? <tr><td colSpan={3}>No suspended sellers.</td></tr> : null}
        </tbody>
      </table>

      {action ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={action.title}>
          <form className="modal" onSubmit={submit}>
            <h2>{action.title}</h2>
            <textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="Reason" placeholder="Why? At least 10 characters. Recorded with your name; the seller will see it." />
            <div className="modal-actions">
              <button type="button" onClick={() => setAction(null)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy || text.trim().length < (action.kind === "dismiss" ? 5 : 10)}>{busy ? "Working…" : "Confirm"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
