import { useEffect, useState } from "react";
import { Pager } from "../components/Pager";
import { apiFetch, buildQuery } from "../lib/apiClient";
import type { AuditLog, PaginationMeta } from "../lib/types";

const TAKE = 20;

export function AuditLogsPage() {
  const [businessId, setBusinessId] = useState("");
  const [appliedBusinessId, setAppliedBusinessId] = useState("");
  const [skip, setSkip] = useState(0);
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ take: TAKE, skip: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ auditLogs: AuditLog[]; pagination: PaginationMeta }>(
      `/admin/audit-logs${buildQuery({ businessId: appliedBusinessId || undefined, take: TAKE, skip })}`,
    )
      .then((result) => {
        if (cancelled) return;
        setRows(result.auditLogs);
        setPagination(result.pagination);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load audit logs.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appliedBusinessId, skip]);

  return (
    <div className="page">
      <h1>Audit logs</h1>
      <form
        className="filter-row"
        onSubmit={(e) => {
          e.preventDefault();
          setSkip(0);
          setAppliedBusinessId(businessId.trim());
        }}
      >
        <label className="filter-label">
          Business ID
          <input
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
            placeholder="optional filter"
          />
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
              <th>Action</th>
              <th>Business ID</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.action}</td>
                <td>{row.businessId ?? "—"}</td>
                <td>{new Date(row.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3}>No audit log entries found.</td>
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
