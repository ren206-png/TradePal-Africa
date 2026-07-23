import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Pager } from "../components/Pager";
import { apiFetch, buildQuery } from "../lib/apiClient";
import type { Business, PaginationMeta } from "../lib/types";

const TAKE = 20;

export function BusinessesPage() {
  const [skip, setSkip] = useState(0);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ take: TAKE, skip: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ businesses: Business[]; pagination: PaginationMeta }>(
      `/admin/businesses${buildQuery({ take: TAKE, skip })}`,
    )
      .then((result) => {
        if (cancelled) return;
        setBusinesses(result.businesses);
        setPagination(result.pagination);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load businesses.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skip]);

  return (
    <div className="page">
      <h1>Businesses</h1>
      {error ? <p className="form-error">{error}</p> : null}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Country</th>
              <th>Currency</th>
              <th>Timezone</th>
              <th>Merchants</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {businesses.map((business) => (
              <tr key={business.id}>
                <td>
                  <Link to={`/businesses/${business.id}`}>{business.name}</Link>
                </td>
                <td>{business.countryCode}</td>
                <td>{business.currencyCode}</td>
                <td>{business.timezone}</td>
                <td>{business._count?.merchants ?? "—"}</td>
                <td>{new Date(business.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {businesses.length === 0 ? (
              <tr>
                <td colSpan={6}>No businesses found.</td>
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
