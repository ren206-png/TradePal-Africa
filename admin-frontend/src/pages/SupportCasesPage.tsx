import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Pager } from "../components/Pager";
import { apiFetch } from "../lib/apiClient";
import type { SupportCaseDetail, SupportCaseList, SupportParty } from "../lib/types";

const PARTY_LABEL: Record<SupportParty, string> = { SELLER: "Seller", PLATFORM: "TradePal", PROVIDER: "Payment provider" };
const TYPE_LABEL: Record<string, string> = { DELIVERY: "Delivery", PRODUCT_COMPLAINT: "Goods", PAYMENT_DISPUTE: "Payment", REFUND: "Refund", OTHER: "Other" };
type Action = "reassign" | "close" | null;

export function SupportCasesPage() {
  const [status, setStatus] = useState("active");
  const [party, setParty] = useState("");
  const [type, setType] = useState("");
  const [skip, setSkip] = useState(0);
  const [list, setList] = useState<SupportCaseList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportCaseDetail | null>(null);
  const [note, setNote] = useState("");
  const [action, setAction] = useState<Action>(null);
  const [text, setText] = useState("");
  const [newParty, setNewParty] = useState<SupportParty>("PLATFORM");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ status, take: "20", skip: String(skip) });
    if (party) qs.set("party", party);
    if (type) qs.set("type", type);
    apiFetch<SupportCaseList>(`/admin/support-cases?${qs.toString()}`)
      .then((r) => !cancelled && setList(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load."));
    return () => {
      cancelled = true;
    };
  }, [status, party, type, skip, reload]);

  useEffect(() => {
    if (!openId) return;
    let cancelled = false;
    apiFetch<SupportCaseDetail>(`/admin/support-cases/${openId}`)
      .then((r) => !cancelled && setDetail(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load the case."));
    return () => {
      cancelled = true;
    };
  }, [openId, reload]);

  const run = useCallback(async (path: string, body: object, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/admin/support-cases/${openId}/${path}`, { method: "POST", body });
      setNotice(done);
      setNote("");
      setText("");
      setAction(null);
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }, [openId]);

  function submitAction(event: FormEvent) {
    event.preventDefault();
    if (action === "reassign") void run("reassign", { party: newParty, reason: text.trim() }, "Responsibility moved.");
    if (action === "close") void run("close", { resolution: text.trim() }, "Case closed.");
  }

  if (error && !list) return <div className="page"><h1>Support cases</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!list) return <div className="page"><h1>Support cases</h1><p>Loading…</p></div>;

  const closed = detail?.status === "CLOSED";
  return (
    <div className="page">
      <h1>Support cases</h1>
      <p className="muted">
        Every case names who is responsible. Sellers answer for goods and delivery; the payment provider for money it handled; TradePal for the rest. You can reassign a case with a reason.
        Notes cannot be edited, and a closed case stays closed.
      </p>
      <p className="muted">Open now: {Object.entries(list.counts.openByParty).map(([p, n]) => `${PARTY_LABEL[p as SupportParty] ?? p} ${n}`).join(", ") || "none"}.</p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="filter-row">
        <label className="filter-label">Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setSkip(0); }}>
            <option value="active">Not closed</option><option value="OPEN">Open</option><option value="ASSIGNED">Assigned</option><option value="CLOSED">Closed</option>
          </select>
        </label>
        <label className="filter-label">Responsible
          <select value={party} onChange={(e) => { setParty(e.target.value); setSkip(0); }}>
            <option value="">Anyone</option><option value="SELLER">Seller</option><option value="PLATFORM">TradePal</option><option value="PROVIDER">Payment provider</option>
          </select>
        </label>
        <label className="filter-label">Type
          <select value={type} onChange={(e) => { setType(e.target.value); setSkip(0); }}>
            <option value="">Any</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>

      <table className="data-table">
        <thead><tr><th>Opened</th><th>Shop</th><th>Order</th><th>Type</th><th>Responsible</th><th>Status</th><th>Summary</th></tr></thead>
        <tbody>
          {list.cases.map((c) => (
            <tr key={c.id}>
              <td>{new Date(c.createdAt).toLocaleDateString()}</td>
              <td>{c.business}</td>
              <td>{c.orderReference ?? "-"}</td>
              <td>{TYPE_LABEL[c.type] ?? c.type}</td>
              <td>{PARTY_LABEL[c.handledBy]}</td>
              <td>{c.status.toLowerCase()}</td>
              <td><button type="button" className="link-button" onClick={() => { setOpenId(c.id); setDetail(null); setAction(null); }}>{c.summary}</button></td>
            </tr>
          ))}
          {list.cases.length === 0 ? <tr><td colSpan={7}>No cases match.</td></tr> : null}
        </tbody>
      </table>
      <Pager pagination={list.pagination} onPrev={() => setSkip(Math.max(0, skip - list.pagination.take))} onNext={() => setSkip(skip + list.pagination.take)} />

      {openId && detail ? (
        <div>
          <h2>Case: {TYPE_LABEL[detail.type] ?? detail.type} at {detail.business}</h2>
          <p>
            Responsible: <strong>{PARTY_LABEL[detail.handledBy]}</strong> · Status: {detail.status.toLowerCase()} · Opened by the {detail.openedBy.toLowerCase()}
            {detail.contactName ? ` · Contact: ${detail.contactName}${detail.contactPhone ? ` ${detail.contactPhone}` : ""}` : ""}
          </p>
          {detail.order ? <p className="muted">Order {detail.order.reference}: {detail.order.status.toLowerCase().replace(/_/g, " ")}, {detail.order.fulfilment.toLowerCase()}, paid {detail.order.paidMinor} of {detail.order.totalMinor} (minor units, {detail.order.currencyCode}), refunded {detail.order.refundedMinor}.</p> : null}
          {detail.resolution ? <p>Resolution: {detail.resolution}</p> : null}
          <ul>
            {detail.notes.map((n) => <li key={n.id}><span className="muted">{new Date(n.createdAt).toLocaleString()} · {n.authorType.toLowerCase()}:</span> {n.body}</li>)}
          </ul>
          {!closed ? (
            <>
              <form className="filter-row" onSubmit={(e) => { e.preventDefault(); void run("notes", { body: note.trim() }, "Note added."); }}>
                <label className="filter-label">Add a note<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
                <button type="submit" disabled={busy || note.trim().length < 3}>Add note</button>
              </form>
              <div className="filter-row">
                {detail.status === "OPEN" ? <button type="button" disabled={busy} onClick={() => void run("assign", {}, "Assigned to you.")}>Assign to me</button> : null}
                <button type="button" onClick={() => { setAction("reassign"); setText(""); }}>Reassign…</button>
                <button type="button" onClick={() => { setAction("close"); setText(""); }}>Close…</button>
              </div>
            </>
          ) : <p className="muted">This case is closed. A new problem is a new case.</p>}
        </div>
      ) : null}

      {action ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={action === "close" ? "Close case" : "Reassign case"}>
          <form className="modal" onSubmit={submitAction}>
            <h2>{action === "close" ? "Close this case?" : "Who should handle this case?"}</h2>
            {action === "reassign" ? (
              <label className="filter-label">New responsible party
                <select value={newParty} onChange={(e) => setNewParty(e.target.value as SupportParty)}>
                  <option value="SELLER">Seller</option><option value="PLATFORM">TradePal</option><option value="PROVIDER">Payment provider</option>
                </select>
              </label>
            ) : null}
            <textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label={action === "close" ? "Resolution" : "Reason"} placeholder={action === "close" ? "How was it resolved? At least 10 characters." : "Why? At least 10 characters. Recorded in the case and the audit log."} />
            <div className="modal-actions">
              <button type="button" onClick={() => setAction(null)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy || text.trim().length < 10}>{busy ? "Working…" : action === "close" ? "Close case" : "Reassign"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
