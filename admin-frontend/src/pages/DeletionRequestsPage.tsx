import { useEffect, useState } from "react";
import { Pager } from "../components/Pager";
import { useAuth } from "../auth/AuthContext";
import { apiFetch, ApiError, buildQuery } from "../lib/apiClient";
import type { DeletionRequest, DeletionRequestStatus, PaginationMeta } from "../lib/types";

const TAKE = 20;
const STATUSES: DeletionRequestStatus[] = ["PENDING", "COMPLETED", "REJECTED"];

/** Only these roles may call POST /deletion-requests/:id/complete|reject (see requireAdminRole
 * in adminRoutes.ts) — this resolves a customer's NDPA/DPA/Act 843 deletion request (Phase 16),
 * a business-scoped-but-sensitive write, mirroring the phone-number-change RBAC precedent. */
const DELETION_RESOLUTION_WRITE_ROLES = new Set(["SUPER_ADMIN", "SUPPORT"]);

export function DeletionRequestsPage() {
  const { admin } = useAuth();
  const canResolve = admin ? DELETION_RESOLUTION_WRITE_ROLES.has(admin.role) : false;

  const [status, setStatus] = useState<DeletionRequestStatus>("PENDING");
  const [skip, setSkip] = useState(0);
  const [rows, setRows] = useState<DeletionRequest[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ take: TAKE, skip: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ deletionRequests: DeletionRequest[]; pagination: PaginationMeta }>(
      `/admin/deletion-requests${buildQuery({ status, take: TAKE, skip })}`,
    )
      .then((result) => {
        if (cancelled) return;
        setRows(result.deletionRequests);
        setPagination(result.pagination);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load deletion requests.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  };

  useEffect(load, [status, skip]);

  const columnCount = canResolve ? 5 : 4;

  return (
    <div className="page">
      <h1>Deletion requests</h1>
      <label className="filter-label">
        Status
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as DeletionRequestStatus);
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
      {error ? <p className="form-error">{error}</p> : null}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Business ID</th>
              <th>Requestor</th>
              <th>Description</th>
              <th>Created</th>
              {canResolve ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <DeletionRequestRow key={row.id} request={row} canResolve={canResolve} onChanged={load} />
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount}>No deletion requests with this status.</td>
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

function DeletionRequestRow({
  request,
  canResolve,
  onChanged,
}: {
  request: DeletionRequest;
  canResolve: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [resolutionNote, setResolutionNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPending = request.status === "PENDING";

  async function handleComplete() {
    if (
      !window.confirm(
        "Completing this request anonymizes the customer's name permanently. This cannot be undone. Continue?",
      )
    ) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/admin/deletion-requests/${request.id}/complete`, {
        method: "POST",
        body: { businessId: request.businessId, ...(resolutionNote ? { resolutionNote } : {}) },
      });
      setEditing(false);
      setResolutionNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to complete the deletion request.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    if (!resolutionNote) {
      setError("A resolution note is required to reject a request.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/admin/deletion-requests/${request.id}/reject`, {
        method: "POST",
        body: { businessId: request.businessId, resolutionNote },
      });
      setEditing(false);
      setResolutionNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reject the deletion request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <tr>
        <td>{request.businessId}</td>
        <td>{request.requestorType}</td>
        <td>{request.description}</td>
        <td>{new Date(request.createdAt).toLocaleString()}</td>
        {canResolve ? (
          <td>
            {isPending ? (
              <button type="button" onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel" : "Resolve"}
              </button>
            ) : (
              <span>{request.resolutionNote ?? "—"}</span>
            )}
          </td>
        ) : null}
      </tr>
      {editing ? (
        <tr>
          <td colSpan={canResolve ? 5 : 4}>
            <div className="inline-form">
              <label>
                Resolution note (required to reject, optional to complete)
                <input value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
              </label>
              <button type="button" disabled={submitting} onClick={handleComplete}>
                {submitting ? "Saving…" : "Complete (anonymize)"}
              </button>
              <button type="button" disabled={submitting || !resolutionNote} onClick={handleReject}>
                {submitting ? "Saving…" : "Reject"}
              </button>
              {error ? <p className="form-error">{error}</p> : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
