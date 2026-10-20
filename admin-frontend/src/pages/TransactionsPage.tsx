import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Pager } from "../components/Pager";
import { apiFetch, buildQuery } from "../lib/apiClient";
import type { AdminJournal, AdminStockMovement, AdminTransaction, PaginationMeta } from "../lib/types";

const TAKE = 20;
/** Mirrors requirePlatformPermission("admin:reverse_transaction") on the server. The server is the real gate. */
const REVERSE_ROLES = new Set(["SUPER_ADMIN", "OPERATOR"]);

type Tab = "transactions" | "stock" | "journals";

function formatMinor(amountMinor: string): string {
  const value = BigInt(amountMinor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function TransactionsPage() {
  const { id } = useParams<{ id: string }>();
  const { admin } = useAuth();
  const canReverse = admin ? REVERSE_ROLES.has(admin.role) : false;

  const [tab, setTab] = useState<Tab>("transactions");
  const [skip, setSkip] = useState(0);
  const [type, setType] = useState("");
  const [log, setLog] = useState<"v2" | "legacy">("v2");
  const [transactions, setTransactions] = useState<AdminTransaction[]>([]);
  const [movements, setMovements] = useState<AdminStockMovement[]>([]);
  const [journals, setJournals] = useState<AdminJournal[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ take: TAKE, skip: 0, hasMore: false });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const [reversing, setReversing] = useState<AdminTransaction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const base = `/admin/businesses/${id}`;
    const run = async () => {
      if (tab === "transactions") {
        const r = await apiFetch<{ transactions: AdminTransaction[]; pagination: PaginationMeta }>(`${base}/transactions${buildQuery({ take: TAKE, skip, type: type || undefined })}`);
        if (!cancelled) { setTransactions(r.transactions); setPagination(r.pagination); }
      } else if (tab === "stock") {
        const r = await apiFetch<{ movements: AdminStockMovement[]; pagination: PaginationMeta }>(`${base}/stock-movements${buildQuery({ take: TAKE, skip, log: log === "legacy" ? "legacy" : undefined })}`);
        if (!cancelled) { setMovements(r.movements); setPagination(r.pagination); }
      } else {
        const r = await apiFetch<{ journals: AdminJournal[]; pagination: PaginationMeta }>(`${base}/journals${buildQuery({ take: TAKE, skip })}`);
        if (!cancelled) { setJournals(r.journals); setPagination(r.pagination); }
      }
    };
    run()
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, tab, skip, type, log, reloadKey]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setSkip(0);
    setNotice(null);
  };

  const submitReverse = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!reversing) return;
      setBusy(true);
      setError(null);
      try {
        await apiFetch(`/admin/businesses/${id}/transactions/${reversing.id}/reverse`, { method: "POST", body: { reason: reason.trim() } });
        setNotice(`Reversed ${reversing.type.toLowerCase().replace("_", " ")} of ${formatMinor(reversing.amountMinor)} ${reversing.currencyCode}. The original stays on record.`);
        setReversing(null);
        setReason("");
        setReloadKey((k) => k + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not reverse that transaction.");
      } finally {
        setBusy(false);
      }
    },
    [id, reason, reversing],
  );

  async function exportCsv() {
    setError(null);
    try {
      const text = await apiFetch<string>(`/admin/businesses/${id}/transactions.csv`, { responseType: "text" });
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `transactions-${(id ?? "").slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  return (
    <div className="page">
      <p><Link to={`/businesses/${id}`}>&larr; Back to business</Link></p>
      <h1>Transactions, stock and journals</h1>
      <p className="muted">Nothing here can be deleted. Voiding creates a reversal and keeps the original.</p>

      <div className="tab-row" role="tablist">
        {(["transactions", "stock", "journals"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => switchTab(t)}>
            {t === "transactions" ? "Transactions" : t === "stock" ? "Stock movements" : "Journals"}
          </button>
        ))}
      </div>

      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {tab === "transactions" ? (
        <div className="filter-row">
          <label className="filter-label">
            Type
            <select value={type} onChange={(e) => { setType(e.target.value); setSkip(0); }}>
              <option value="">All</option>
              {["SALE", "PURCHASE", "PAYMENT_RECEIVED", "EXPENSE", "DEBT_NOTE"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <button type="button" onClick={exportCsv}>Export CSV</button>
        </div>
      ) : null}
      {tab === "stock" ? (
        <div className="filter-row">
          <label className="filter-label">
            Log
            <select value={log} onChange={(e) => { setLog(e.target.value as "v2" | "legacy"); setSkip(0); }}>
              <option value="v2">Stock log (new)</option>
              <option value="legacy">Earlier inventory log</option>
            </select>
          </label>
        </div>
      ) : null}

      {loading ? <p>Loading…</p> : null}

      {!loading && tab === "transactions" ? (
        <table className="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Paid</th><th>Who</th><th>Note</th><th>Status</th><th>Source</th><th /></tr></thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
                <td>{t.type}</td>
                <td>{formatMinor(t.amountMinor)} {t.currencyCode}</td>
                <td>{t.paymentStatus}</td>
                <td>{t.counterparty ?? "-"}</td>
                <td>{t.description ?? "-"}</td>
                <td>{t.status}</td>
                <td title={t.provenance.reference ?? ""}>{t.provenance.channel === "WHATSAPP" ? "WhatsApp" : "Other"}</td>
                <td>
                  {canReverse && t.status === "POSTED" ? (
                    <button type="button" onClick={() => { setReversing(t); setReason(""); setNotice(null); }}>Void…</button>
                  ) : null}
                </td>
              </tr>
            ))}
            {transactions.length === 0 ? <tr><td colSpan={9}>No transactions.</td></tr> : null}
          </tbody>
        </table>
      ) : null}

      {!loading && tab === "stock" ? (
        <table className="data-table">
          <thead><tr><th>When</th><th>Item</th><th>Kind</th><th>Change</th><th>Cost</th><th>Source</th></tr></thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.createdAt).toLocaleString()}</td>
                <td>{m.product ? `${m.product} (${m.sku})` : m.item}</td>
                <td>{m.kind ?? m.source}</td>
                <td>{m.onHandDelta ?? m.quantityDelta}{m.damagedDelta ? ` / damaged ${m.damagedDelta}` : ""}{m.inTransitDelta ? ` / in transit ${m.inTransitDelta}` : ""}</td>
                <td>{m.costMinor ? formatMinor(m.costMinor) : "-"}{m.costIncomplete ? " (incomplete)" : ""}</td>
                <td>{m.source ?? "-"}</td>
              </tr>
            ))}
            {movements.length === 0 ? <tr><td colSpan={6}>No stock movements.</td></tr> : null}
          </tbody>
        </table>
      ) : null}

      {!loading && tab === "journals" ? (
        <div>
          {journals.map((j) => (
            <table className="data-table" key={j.id}>
              <caption>{new Date(j.occurredAt).toLocaleString()} · {j.kind} · {j.status} · {j.provenance}{j.memo ? ` · ${j.memo}` : ""}</caption>
              <thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
              <tbody>
                {j.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.account}</td>
                    <td>{BigInt(l.debitMinor) > 0n ? formatMinor(l.debitMinor) : ""}</td>
                    <td>{BigInt(l.creditMinor) > 0n ? formatMinor(l.creditMinor) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          {journals.length === 0 ? <p>No journal entries (accounting is off for this business, or nothing has been posted).</p> : null}
        </div>
      ) : null}

      <Pager pagination={pagination} onPrev={() => setSkip(Math.max(0, skip - TAKE))} onNext={() => setSkip(skip + TAKE)} />

      {reversing ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Void transaction">
          <form className="modal" onSubmit={submitReverse}>
            <h2>Void this transaction?</h2>
            <p>
              {reversing.type} of {formatMinor(reversing.amountMinor)} {reversing.currencyCode}. This adds a reversal; the original is kept. Stock and balances are put back.
            </p>
            <textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" placeholder="Why? At least 10 characters. Shown in the merchant's audit history." />
            <div className="modal-actions">
              <button type="button" onClick={() => setReversing(null)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy || reason.trim().length < 10}>{busy ? "Working…" : "Void transaction"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
