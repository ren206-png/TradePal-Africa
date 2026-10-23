import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch, ApiError } from "../lib/apiClient";
import type { ForecastPredictionRow, ReorderMerchantRow, ReorderOverview } from "../lib/types";

/** Mirrors requirePlatformPermission("admin:flip_forecast_gate" / "admin:set_forecast_thresholds"). The server is the real gate. */
const OWNER_ROLES = new Set(["SUPER_ADMIN"]);

const pct = (bps: number | null) => (bps === null ? "-" : `${(bps / 100).toFixed(1)}%`);

interface GateDialog {
  merchant: ReorderMerchantRow;
  enabled: boolean;
}

export function ReorderPage() {
  const { admin } = useAuth();
  const isOwner = admin ? OWNER_ROLES.has(admin.role) : false;
  const [data, setData] = useState<ReorderOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [weeks, setWeeks] = useState("");
  const [improvement, setImprovement] = useState("");

  const [dialog, setDialog] = useState<GateDialog | null>(null);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ForecastPredictionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ReorderOverview>("/admin/reorder/overview")
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setWeeks(r.thresholds.minScoredWeeks?.toString() ?? "");
        setImprovement(r.thresholds.minImprovementBps?.toString() ?? "");
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load."));
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    if (!openId) return;
    let cancelled = false;
    setDetail(null);
    apiFetch<{ predictions: ForecastPredictionRow[] }>(`/admin/businesses/${openId}/forecasts`)
      .then((r) => !cancelled && setDetail(r.predictions))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load forecasts."));
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const saveThresholds = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setError(null);
      setNotice(null);
      try {
        await apiFetch("/admin/forecast-gate-config", {
          method: "PUT",
          body: { ...(weeks.trim() ? { minScoredWeeks: Number(weeks) } : {}), ...(improvement.trim() ? { minImprovementBps: Number(improvement) } : {}) },
        });
        setNotice("Thresholds saved.");
        setReload((n) => n + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    },
    [weeks, improvement],
  );

  async function submitGate(event: FormEvent) {
    event.preventDefault();
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      await apiFetch(`/admin/businesses/${dialog.merchant.businessId}/forecast-gate`, { method: "POST", body: { enabled: dialog.enabled, reason: reason.trim() } });
      setNotice(`${dialog.enabled ? "Opened" : "Closed"} the forecast gate for ${dialog.merchant.name}.`);
      setDialog(null);
      setReason("");
      setReload((n) => n + 1);
    } catch (err) {
      // a rejected promotion is recorded by the server; show why
      setDialogError(err instanceof ApiError || err instanceof Error ? err.message : "Could not change the gate.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <div className="page"><h1>Reorder and forecasting</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!data) return <div className="page"><h1>Reorder and forecasting</h1><p>Loading…</p></div>;

  const thresholdsSet = data.thresholds.minScoredWeeks !== null && data.thresholds.minImprovementBps !== null;
  return (
    <div className="page">
      <h1>Reorder and forecasting</h1>
      <p className="muted">
        Forecasts run in shadow mode and are never shown to merchants. A merchant gets forecast-based suggestions only after you open their gate, which needs the thresholds
        below to be met on that merchant's own scored data. Method: {data.method}.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <h2>Promotion thresholds</h2>
      {!thresholdsSet ? <p className="form-error">Not set yet. Until you set both, no merchant can be promoted (there are no defaults).</p> : null}
      <form className="filter-row" onSubmit={saveThresholds}>
        <label className="filter-label">
          Minimum scored weeks
          <input value={weeks} onChange={(e) => setWeeks(e.target.value)} inputMode="numeric" disabled={!isOwner} />
        </label>
        <label className="filter-label">
          Minimum improvement over the simple rule (basis points)
          <input value={improvement} onChange={(e) => setImprovement(e.target.value)} inputMode="numeric" disabled={!isOwner} />
        </label>
        {isOwner ? <button type="submit">Save thresholds</button> : <span className="muted">Only the owner can change these.</span>}
      </form>

      <h2>Merchants</h2>
      <table className="data-table">
        <thead>
          <tr><th>Merchant</th><th>Rules</th><th>Suggestions (issued / accepted / dismissed)</th><th>Scored weeks</th><th>Forecast error</th><th>Simple-rule error</th><th>Improvement</th><th>Gate</th><th /></tr>
        </thead>
        <tbody>
          {data.merchants.map((m) => (
            <tr key={m.businessId}>
              <td><button type="button" className="link-button" onClick={() => setOpenId(openId === m.businessId ? null : m.businessId)}>{m.name}</button></td>
              <td>{m.rules}</td>
              <td>{m.suggestions.issued} / {m.suggestions.accepted} / {m.suggestions.dismissed}</td>
              <td>{m.forecast.scoredWeeks}</td>
              <td>{pct(m.forecast.modelMapeBps)}</td>
              <td>{pct(m.forecast.baselineMapeBps)}</td>
              <td>{pct(m.forecast.improvementBps)}</td>
              <td>{m.flags.live ? "OPEN" : m.eligible ? "eligible" : "closed"}{m.flags.shadow ? "" : " (shadow off)"}</td>
              <td>
                {isOwner ? (
                  m.flags.live ? (
                    <button type="button" onClick={() => { setDialog({ merchant: m, enabled: false }); setReason(""); setDialogError(null); }}>Close gate…</button>
                  ) : (
                    <button type="button" onClick={() => { setDialog({ merchant: m, enabled: true }); setReason(""); setDialogError(null); }}>Open gate…</button>
                  )
                ) : null}
              </td>
            </tr>
          ))}
          {data.merchants.length === 0 ? <tr><td colSpan={9}>No merchant has reorder rules yet.</td></tr> : null}
        </tbody>
      </table>

      {openId ? (
        <div>
          <h2>Forecasts and scores</h2>
          {!detail ? <p>Loading…</p> : (
            <table className="data-table">
              <thead><tr><th>Item</th><th>Period</th><th>Forecast units</th><th>Simple-rule units</th><th>Actual</th><th>Forecast error</th><th>Simple-rule error</th><th>Stock-out</th></tr></thead>
              <tbody>
                {detail.map((p) => (
                  <tr key={p.id}>
                    <td>{p.sku}</td>
                    <td>{new Date(p.periodStart).toLocaleDateString()} to {new Date(p.periodEnd).toLocaleDateString()}</td>
                    <td>{p.predictedUnits}</td>
                    <td>{p.tier1Units}</td>
                    <td>{p.score ? p.score.actualUnits : "not scored yet"}</td>
                    <td>{pct(p.score?.modelApeBps ?? null)}</td>
                    <td>{pct(p.score?.tier1ApeBps ?? null)}</td>
                    <td>{p.score ? (p.score.stockout ? "yes (excluded)" : "no") : "-"}</td>
                  </tr>
                ))}
                {detail.length === 0 ? <tr><td colSpan={8}>No forecasts yet.</td></tr> : null}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {dialog ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Forecast gate">
          <form className="modal" onSubmit={submitGate}>
            <h2>{dialog.enabled ? "Open" : "Close"} the forecast gate for {dialog.merchant.name}?</h2>
            <p>
              {dialog.enabled
                ? "Forecast-based quantities will replace the simple rule in this merchant's reorder suggestions. This only works if their data meets the thresholds; a refused attempt is recorded too."
                : "This merchant goes back to the simple rule. Always allowed."}
            </p>
            <textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" placeholder="Why? At least 10 characters. Recorded in the audit log." />
            {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
            <div className="modal-actions">
              <button type="button" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy || reason.trim().length < 10}>{busy ? "Working…" : dialog.enabled ? "Open gate" : "Close gate"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
