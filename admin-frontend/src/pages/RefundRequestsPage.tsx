import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "../lib/apiClient";
import { useAuth } from "../auth/AuthContext";

interface RefundRequest {
  id: string; action: string; status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "EXPIRED" | "CANCELLED"; reason: string;
  payload: { targetId: string; amountMinor: string | null; currency: string; revokeEntitlement: boolean }; payloadHash: string;
  requestedById: string; approvedById: string | null; expiresAt: string;
}

/**
 * Refunds of TradePal subscription charges under the two-person rule (admin-console Phase 3): one person asks, a different person approves
 * exactly what they see here (the code below the request is its fingerprint), and a third step runs it, only where execution is switched on.
 */
export function RefundRequestsPage() {
  const { admin } = useAuth();
  const [requests, setRequests] = useState<RefundRequest[]>([]);
  const [executionEnabled, setExecutionEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState("SUBSCRIPTION_CHARGE_REFUND");
  const [targetId, setTargetId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    apiFetch<{ requests: RefundRequest[]; executionEnabled: boolean }>("/admin/refund-requests")
      .then((r) => { setRequests(r.requests); setExecutionEnabled(r.executionEnabled); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load refund requests."));
  }, []);
  useEffect(load, [load]);

  async function call(label: string, path: string, body: unknown) {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(path, { method: "POST", body });
      setNotice(`${label}: done.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `${label} did not work.`);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await call("Refund request", "/admin/refund-requests", { action, targetId: targetId.trim(), ...(amount.trim() ? { amountMinor: amount.trim() } : {}), reason: reason.trim() });
    setTargetId(""); setAmount(""); setReason("");
  }

  return (
    <div className="page">
      <h1>Refund requests</h1>
      <p>Refunds of subscription charges need two people: one makes the request, a different person approves exactly what is shown, then it is run.{" "}
        {executionEnabled ? "Running refunds is switched on." : <strong>Running refunds is switched off in this environment: approved requests wait and nothing is sent to the payment provider.</strong>}
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      <h2>New request</h2>
      <form onSubmit={submit}>
        <label>What <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="What to refund">
          <option value="SUBSCRIPTION_CHARGE_REFUND">A paid subscription invoice</option>
          <option value="HELD_PAYMENT_REFUND">A collected payment never applied to an invoice</option>
        </select></label>{" "}
        <label>Invoice or payment id <input value={targetId} onChange={(e) => setTargetId(e.target.value)} required aria-label="Invoice or payment id" /></label>{" "}
        <label>Amount (minor units; empty = everything refundable) <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" aria-label="Amount in minor units" /></label>{" "}
        <label>Reason (10+ characters) <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required aria-label="Reason" /></label>{" "}
        <button type="submit">Make request</button>
      </form>

      <h2>Requests</h2>
      <table className="data-table">
        <thead><tr><th>Request</th><th>Status</th><th>Fingerprint</th><th>Actions</th></tr></thead>
        <tbody>
          {requests.map((r) => {
            const mine = r.requestedById === admin?.id;
            return (
              <tr key={r.id}>
                <td>{r.action === "SUBSCRIPTION_CHARGE_REFUND" ? "Invoice" : "Payment"} {r.payload.targetId}<br />
                  {r.payload.amountMinor ?? "all refundable"} {r.payload.currency}{r.payload.revokeEntitlement ? ", ends the paid period" : ""}<br /><small>{r.reason}</small></td>
                <td>{r.status}</td>
                <td><code title="Approving binds your approval to exactly this request">{r.payloadHash.slice(0, 12)}…</code></td>
                <td>
                  {r.status === "PENDING" && !mine ? (
                    <>
                      <button type="button" onClick={() => void call("Approve", `/admin/refund-requests/${r.id}/approve`, { payloadHash: r.payloadHash })}>Approve exactly this</button>{" "}
                      <button type="button" onClick={() => void call("Reject", `/admin/refund-requests/${r.id}/reject`, { reason: "Rejected on review" })}>Reject</button>
                    </>
                  ) : null}
                  {r.status === "PENDING" && mine ? <em>Waiting for someone else to approve</em> : null}
                  {(r.status === "PENDING" || r.status === "APPROVED") && mine ? <>{" "}<button type="button" onClick={() => void call("Cancel", `/admin/refund-requests/${r.id}/cancel`, {})}>Cancel</button></> : null}
                  {r.status === "APPROVED" ? (
                    <button type="button" disabled={!executionEnabled} title={executionEnabled ? "" : "Switched off in this environment"} onClick={() => void call("Run refund", `/admin/refund-requests/${r.id}/execute`, {})}>Run refund</button>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {requests.length === 0 ? <tr><td colSpan={4}>No refund requests.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
