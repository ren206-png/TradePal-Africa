import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/apiClient";
import type { BillingExceptionRow, PlanVersionRow, SubscriptionDetail, SubscriptionRow, SubscriptionsOverview } from "../lib/types";

const count = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")} ${v}`).join(", ") || "none";
const RESOLUTIONS = ["NO_ACTION_NEEDED", "REFUNDED", "SETTLED_OFFLINE", "CONTACTED_MERCHANT", "ESCALATED_TO_PROVIDER"] as const;

type Action =
  | { kind: "switch"; countryCode: string; enable: boolean; title: string }
  | { kind: "resolve"; id: string; title: string }
  | { kind: "refund"; invoiceId: string; title: string }
  | { kind: "refundHeld"; attemptId: string; title: string }
  | { kind: "adjust"; subscriptionId: string; title: string }
  | { kind: "newVersion"; title: string }
  | { kind: "price"; versionId: string; title: string }
  | { kind: "publish"; versionId: string; title: string };

export function SubscriptionsPage() {
  const [overview, setOverview] = useState<SubscriptionsOverview | null>(null);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [exceptions, setExceptions] = useState<BillingExceptionRow[]>([]);
  const [versions, setVersions] = useState<PlanVersionRow[]>([]);
  const [features, setFeatures] = useState<string[]>([]);
  const [stateFilter, setStateFilter] = useState("");
  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<(typeof RESOLUTIONS)[number]>("CONTACTED_MERCHANT");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [planCode, setPlanCode] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [grace, setGrace] = useState("3");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [o, l, e, v] = await Promise.all([
          apiFetch<SubscriptionsOverview>("/admin/subscriptions/overview"),
          apiFetch<{ subscriptions: SubscriptionRow[] }>(`/admin/subscriptions${stateFilter ? `?state=${stateFilter}` : ""}`),
          apiFetch<{ exceptions: BillingExceptionRow[] }>("/admin/subscriptions/exceptions"),
          apiFetch<{ versions: PlanVersionRow[]; knownFeatures: string[] }>("/admin/plan-versions"),
        ]);
        if (cancelled) return;
        setOverview(o);
        setSubs(l.subscriptions);
        setExceptions(e.exceptions);
        setVersions(v.versions);
        setFeatures(v.knownFeatures);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload, stateFilter]);

  const open = useCallback(async (id: string) => {
    try {
      setDetail(await apiFetch<SubscriptionDetail>(`/admin/subscriptions/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the subscription.");
    }
  }, []);

  function begin(a: Action) {
    setAction(a);
    setReason("");
    setAmount("");
    setDate("");
    setCountry("");
    setPlanCode("");
    setChosen([]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = reason.trim();
    try {
      if (action.kind === "switch") await apiFetch("/admin/billing-switches", { method: "PUT", body: { provider: "pawapay", countryCode: action.countryCode, newAttemptsEnabled: action.enable, reason: r } });
      else if (action.kind === "resolve") await apiFetch(`/admin/subscriptions/exceptions/${action.id}/resolve`, { method: "POST", body: { outcome, note: r } });
      else if (action.kind === "refund") await apiFetch(`/admin/invoices/${action.invoiceId}/refund`, { method: "POST", body: { ...(amount.trim() ? { amountMinor: amount.trim() } : {}), reason: r } });
      else if (action.kind === "refundHeld") await apiFetch(`/admin/subscriptions/attempts/${action.attemptId}/refund`, { method: "POST", body: { ...(amount.trim() ? { amountMinor: amount.trim() } : {}), reason: r } });
      else if (action.kind === "adjust") await apiFetch(`/admin/subscriptions/${action.subscriptionId}/adjust`, { method: "POST", body: { periodEnd: new Date(date).toISOString(), reason: r } });
      else if (action.kind === "newVersion") await apiFetch(`/admin/plan-versions/${planCode.trim().toUpperCase()}`, { method: "POST", body: { features: chosen, graceDays: Number(grace), reason: r } });
      else if (action.kind === "price") await apiFetch(`/admin/plan-versions/${action.versionId}/prices`, { method: "PUT", body: { countryCode: country.trim().toUpperCase(), priceMinor: amount.trim(), reason: r } });
      else await apiFetch(`/admin/plan-versions/${action.versionId}/publish`, { method: "POST", body: { reason: r } });
      setNotice("Recorded.");
      setAction(null);
      setReload((n) => n + 1);
      if (detail) void open(detail.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !loaded) return <div className="page"><h1>Subscriptions</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!loaded || !overview) return <div className="page"><h1>Subscriptions</h1><p>Loading…</p></div>;
  const cfg = overview.configuration;

  return (
    <div className="page">
      <h1>Subscriptions</h1>
      <p className="muted">
        TradePal's own billing through pawaPay. Each renewal is authorised by the payer's PIN: nothing is charged automatically. A plan version is frozen once published, a
        subscription becomes paid only when pawaPay confirms it, and nothing here deletes anything or marks anything paid.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {cfg.configured ? (
        <p className="muted">pawaPay: {cfg.environment.toLowerCase()}. Signed callbacks {cfg.requireSignedCallbacks ? "required" : "NOT required"}. {cfg.environment === "PRODUCTION" ? (cfg.productionActivated ? "Production ACTIVATED." : "Production not activated: no new charges.") : ""}</p>
      ) : <p className="form-error">pawaPay is not usable here: {cfg.reason}. No new charges can start.</p>}

      <div className="stat-grid">
        <div className="stat-card"><div className="stat-value">{count(overview.states)}</div><div className="stat-label">Subscriptions</div></div>
        <div className="stat-card"><div className="stat-value">{count(overview.invoices)}</div><div className="stat-label">Invoices</div></div>
        <div className={Object.keys(overview.openExceptions).length ? "stat-card stat-warn" : "stat-card"}><div className="stat-value">{count(overview.openExceptions)}</div><div className="stat-label">Open exceptions</div></div>
        <div className={overview.callbackAuthFailuresLast24h > 0 ? "stat-card stat-warn" : "stat-card"}><div className="stat-value">{overview.callbackAuthFailuresLast24h}</div><div className="stat-label">Callback auth failures (24h)</div></div>
      </div>

      <h2>New charges by country</h2>
      <table className="data-table">
        <thead><tr><th>Provider</th><th>Country</th><th>Purpose</th><th>New charges</th><th /></tr></thead>
        <tbody>
          {overview.switches.map((s) => (
            <tr key={s.id}>
              <td>{s.provider}</td><td>{s.countryCode}</td><td>{s.purpose.toLowerCase().replace(/_/g, " ")}</td><td>{s.newAttemptsEnabled ? "allowed" : "OFF"}</td>
              <td><button type="button" onClick={() => begin({ kind: "switch", countryCode: s.countryCode, enable: !s.newAttemptsEnabled, title: `${s.newAttemptsEnabled ? "Stop" : "Allow"} new charges in ${s.countryCode}` })}>{s.newAttemptsEnabled ? "Turn off…" : "Turn on…"}</button></td>
            </tr>
          ))}
          {overview.switches.length === 0 ? <tr><td colSpan={5}>No country has new charges switched on (the default).</td></tr> : null}
        </tbody>
      </table>
      <p className="muted">Switching off stops NEW charges only. Callbacks, status checks, reconciliation and refunds for existing charges keep working.</p>

      <h2>Subscriptions</h2>
      <div className="filter-row">
        <label className="filter-label">State
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">Any</option><option value="ACTIVE">Active</option><option value="GRACE">In grace</option><option value="EXPIRED">Expired</option><option value="PENDING">Pending</option><option value="CANCELLED">Cancelled</option>
          </select>
        </label>
      </div>
      <table className="data-table">
        <thead><tr><th>Business</th><th>Plan</th><th>State</th><th>Paid until</th><th /></tr></thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.id}>
              <td>{s.business} ({s.country}){s.securitySuspended ? " - SECURITY SUSPENDED" : ""}</td><td>{s.planCode}{s.planVersion ? ` v${s.planVersion}` : ""}</td><td>{s.state.toLowerCase()}{s.cancelAtPeriodEnd ? " (not renewing)" : ""}</td>
              <td>{new Date(s.currentPeriodEnd).toLocaleDateString()}</td><td><button type="button" onClick={() => void open(s.id)}>Details</button></td>
            </tr>
          ))}
          {subs.length === 0 ? <tr><td colSpan={5}>No subscriptions match.</td></tr> : null}
        </tbody>
      </table>

      {detail ? (
        <div>
          <h2>{detail.business}: {detail.planCode}</h2>
          <p><button type="button" onClick={() => begin({ kind: "adjust", subscriptionId: detail.id, title: "Adjust the paid-until date" })}>Adjust entitlement…</button></p>
          <table className="data-table">
            <thead><tr><th>Invoice</th><th>Status</th><th>Amount (minor)</th><th>Paid</th><th>Refunded</th><th /></tr></thead>
            <tbody>
              {detail.invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.reference ?? "-"}</td><td>{i.status.toLowerCase().replace(/_/g, " ")}</td><td>{i.amountMinor} {i.currencyCode}</td><td>{i.paidMinor}</td><td>{i.refundedMinor}</td>
                  <td>{i.status === "PAID" || i.status === "PARTIALLY_REFUNDED" ? <button type="button" onClick={() => begin({ kind: "refund", invoiceId: i.id, title: `Refund ${i.reference}` })}>Refund…</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Entitlement history</h3>
          <ul>{detail.history.map((h) => <li key={h.id}><span className="muted">{new Date(h.at).toLocaleString()} · {h.source.toLowerCase()}:</span> {h.kind.toLowerCase().replace(/_/g, " ")}{h.to ? ` (${h.from ?? "-"} to ${h.to})` : ""}{h.reason ? ` - ${h.reason}` : ""}</li>)}</ul>
        </div>
      ) : null}

      <h2>Billing exceptions</h2>
      <table className="data-table">
        <thead><tr><th>When</th><th>Business</th><th>Type</th><th>Amount (minor)</th><th /></tr></thead>
        <tbody>
          {exceptions.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString()}</td><td>{e.business ?? "unknown"}</td><td>{e.type.toLowerCase().replace(/_/g, " ")}</td><td>{e.amountMinor ?? "-"}</td>
              <td>
                {e.attemptId && ["DUPLICATE_PAYMENT", "AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "PAYMENT_AFTER_CANCELLATION"].includes(e.type) ? <><button type="button" onClick={() => begin({ kind: "refundHeld", attemptId: e.attemptId!, title: "Give the payment back" })}>Refund the payment…</button>{" "}</> : null}
                <button type="button" onClick={() => begin({ kind: "resolve", id: e.id, title: `Resolve: ${e.type.toLowerCase().replace(/_/g, " ")}` })}>Resolve…</button>
              </td>
            </tr>
          ))}
          {exceptions.length === 0 ? <tr><td colSpan={5}>No open exceptions.</td></tr> : null}
        </tbody>
      </table>

      <h2>Plan versions</h2>
      <p><button type="button" onClick={() => begin({ kind: "newVersion", title: "New plan version (draft)" })}>New version…</button> <span className="muted">There are no default prices: nothing can be sold until a version has a price and is published.</span></p>
      <table className="data-table">
        <thead><tr><th>Plan</th><th>Version</th><th>Status</th><th>Includes</th><th>Grace</th><th>Prices</th><th>Subscribers</th><th /></tr></thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id}>
              <td>{v.planCode}</td><td>{v.version}</td><td>{v.status.toLowerCase()}</td><td>{v.features.join(", ") || "-"}</td><td>{v.graceDays} d</td>
              <td>{v.prices.map((p) => `${p.countryCode} ${p.priceMinor} ${p.currencyCode}`).join("; ") || "none"}</td><td>{v.subscribers}</td>
              <td>
                {v.status === "DRAFT" ? <><button type="button" onClick={() => begin({ kind: "price", versionId: v.id, title: `Set a price on ${v.planCode} v${v.version}` })}>Set price…</button>{" "}
                  <button type="button" disabled={v.prices.length === 0} onClick={() => begin({ kind: "publish", versionId: v.id, title: `Publish ${v.planCode} v${v.version}` })}>Publish…</button></> : <span className="muted">frozen</span>}
              </td>
            </tr>
          ))}
          {versions.length === 0 ? <tr><td colSpan={8}>No plan versions yet.</td></tr> : null}
        </tbody>
      </table>

      {action ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={action.title}>
          <form className="modal" onSubmit={(e) => void submit(e)}>
            <h2>{action.title}</h2>
            {action.kind === "resolve" ? (
              <label className="filter-label">Outcome<select value={outcome} onChange={(e) => setOutcome(e.target.value as (typeof RESOLUTIONS)[number])}>{RESOLUTIONS.map((o) => <option key={o} value={o}>{o.toLowerCase().replace(/_/g, " ")}</option>)}</select></label>
            ) : null}
            {action.kind === "refund" || action.kind === "refundHeld" ? <label className="filter-label">Amount in minor units (empty = everything refundable)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" /></label> : null}
            {action.kind === "adjust" ? <label className="filter-label">New paid-until date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label> : null}
            {action.kind === "price" ? (
              <>
                <label className="filter-label">Country (two letters)<input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} /></label>
                <label className="filter-label">Price in minor units<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" /></label>
              </>
            ) : null}
            {action.kind === "newVersion" ? (
              <>
                <label className="filter-label">Plan code<input value={planCode} onChange={(e) => setPlanCode(e.target.value)} /></label>
                <label className="filter-label">Grace days<input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" /></label>
                <fieldset><legend>Includes</legend>{features.map((f) => <label key={f}><input type="checkbox" checked={chosen.includes(f)} onChange={(e) => setChosen(e.target.checked ? [...chosen, f] : chosen.filter((x) => x !== f))} /> {f}</label>)}</fieldset>
              </>
            ) : null}
            {action.kind === "refund" ? <p>This refunds a SUBSCRIPTION charge to the payer through pawaPay. It does not end the subscription.</p> : null}
            {action.kind === "refundHeld" ? <p>This gives back money pawaPay collected that was never applied to an invoice. The invoice is not touched.</p> : null}
            <textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" placeholder="Why? At least 10 characters. Recorded in the audit log." />
            <div className="modal-actions">
              <button type="button" onClick={() => setAction(null)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy || reason.trim().length < 10}>{busy ? "Working…" : "Confirm"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
