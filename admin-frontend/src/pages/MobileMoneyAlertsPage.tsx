import { useEffect, useState } from "react";
import { Pager } from "../components/Pager";
import { apiFetch, buildQuery } from "../lib/apiClient";
import type { MobileMoneyAlert, MobileMoneyAlertStatus, PaginationMeta } from "../lib/types";

const TAKE = 20;
const STATUSES: Array<MobileMoneyAlertStatus | "ALL"> = ["ALL", "UNMATCHED", "SUGGESTED", "CONFIRMED"];

/** amountMinor arrives as a string (bigint serialized over the wire — see adminRoutes.ts). Display-only, so plain division is fine; never re-parse this as a number for anything that feeds back into a write. */
function formatMinor(amountMinor: string): string {
  const value = BigInt(amountMinor);
  const major = value / 100n;
  const minor = value % 100n;
  return `${major}.${minor.toString().padStart(2, "0")}`;
}

export function MobileMoneyAlertsPage() {
  const [status, setStatus] = useState<MobileMoneyAlertStatus | "ALL">("ALL");
  const [businessId, setBusinessId] = useState("");
  const [appliedBusinessId, setAppliedBusinessId] = useState("");
  const [skip, setSkip] = useState(0);
  const [rows, setRows] = useState<MobileMoneyAlert[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ take: TAKE, skip: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ mobileMoneyAlerts: MobileMoneyAlert[]; pagination: PaginationMeta }>(
      `/admin/mobile-money-alerts${buildQuery({
        status: status === "ALL" ? undefined : status,
        businessId: appliedBusinessId || undefined,
        take: TAKE,
        skip,
      })}`,
    )
      .then((result) => {
        if (cancelled) return;
        setRows(result.mobileMoneyAlerts);
        setPagination(result.pagination);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load mobile money alerts.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, appliedBusinessId, skip]);

  return (
    <div className="page">
      <h1>Mobile money alerts</h1>
      <form
        className="filter-row"
        onSubmit={(e) => {
          e.preventDefault();
          setSkip(0);
          setAppliedBusinessId(businessId.trim());
        }}
      >
        <label className="filter-label">
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as MobileMoneyAlertStatus | "ALL");
              setSkip(0);
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-label">
          Business ID
          <input value={businessId} onChange={(e) => setBusinessId(e.target.value)} placeholder="optional filter" />
        </label>
        <button type="submit">Filter</button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Amount</th>
              <th>Sender</th>
              <th>Provider txn ID</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.provider}</td>
                <td>{formatMinor(row.amountMinor)}</td>
                <td>{row.senderMasked ?? "—"}</td>
                <td>{row.providerTransactionId ?? "—"}</td>
                <td>{row.matchStatus}</td>
                <td>{new Date(row.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>No mobile money alerts found.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
      <Pager
        pagination={pagination}
        onPrev={() => setSkip((s) => Math.max(0, s - TAKE))}
        onNext={() => setSkip((s) => s + TAKE)}
      />
    </div>
  );
}
