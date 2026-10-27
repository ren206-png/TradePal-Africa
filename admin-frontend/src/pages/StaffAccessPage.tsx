import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "../lib/apiClient";
import { useAuth } from "../auth/AuthContext";
import type { AdminRole } from "../lib/types";

interface StaffRow { id: string; email: string; name: string; role: AdminRole; status: "ACTIVE" | "DISABLED"; mfa: "ENROLLED" | "REQUIRED" | "NOT_ENROLLED"; lastSignInAt: string | null; liveSessions: number }
interface InvitationRow { id: string; email: string; role: AdminRole; status: "OPEN" | "ACCEPTED" | "REVOKED" | "EXPIRED"; expiresAt: string }
interface EventRow { id: string; eventType: string; result: string; createdAt: string; adminUserId: string | null }
interface TransferRow { id: string; fromAdminId: string; toAdminId: string; status: string; expiresAt: string }

const ROLES: AdminRole[] = ["SUPER_ADMIN", "OPERATOR", "SUPPORT", "ANALYST", "FINANCE_ADMIN", "MODERATOR"];
const LABEL: Record<AdminRole, string> = {
  SUPER_ADMIN: "Platform owner", OPERATOR: "Operations", SUPPORT: "Support", ANALYST: "Auditor (read-only)", FINANCE_ADMIN: "Finance", MODERATOR: "Moderator",
};

/**
 * Staff access (admin-console Phase 3): who has access, invitations, role and account changes, ownership transfer and the security trail.
 * Every change needs a reason; the server also asks for a fresh password and authenticator code, which the app prompts for when needed.
 * An invitation link is shown ONCE, here, to the owner who made it: copy it and send it yourself.
 */
export function StaffAccessPage() {
  const { admin } = useAuth();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AdminRole>("SUPPORT");
  const [failuresOnly, setFailuresOnly] = useState(false);

  const load = useCallback(() => {
    setError(null);
    apiFetch<{ staff: StaffRow[] }>("/admin/staff").then((r) => setStaff(r.staff)).catch((e) => setError(e instanceof Error ? e.message : "Could not load staff."));
    apiFetch<{ invitations: InvitationRow[] }>("/admin/staff/invitations").then((r) => setInvitations(r.invitations)).catch(() => undefined);
    apiFetch<{ transfers: TransferRow[] }>("/admin/staff/ownership-transfers").then((r) => setTransfers(r.transfers)).catch(() => undefined);
    apiFetch<{ events: EventRow[] }>(`/admin/security-events${failuresOnly ? "?result=FAILURE" : ""}`).then((r) => setEvents(r.events)).catch(() => undefined);
  }, [failuresOnly]);
  useEffect(load, [load]);

  async function run(label: string, path: string, method: "POST" | "PUT", body: unknown) {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(path, { method, body });
      setNotice(`${label}: done.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `${label} did not work.`);
    }
  }
  const reasonOk = reason.trim().length >= 3;

  async function invite(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLink(null);
    try {
      const r = await apiFetch<{ link: string }>("/admin/staff/invitations", { method: "POST", body: { email: inviteEmail.trim(), role: inviteRole } });
      setLink(r.link);
      setInviteEmail("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the invitation.");
    }
  }

  return (
    <div className="page">
      <h1>Staff access</h1>
      <p>Who can sign in to this console and what they can do. Every change is recorded with your reason and needs a fresh confirmation.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      <label>
        Reason for the next change
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. moved to the finance team" aria-label="Reason for the next change" />
      </label>

      <h2>People</h2>
      <table className="data-table">
        <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Authenticator</th><th>Last sign-in</th><th>Sessions</th><th>Actions</th></tr></thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.id}>
              <td>{s.name}<br /><small>{s.email}</small></td>
              <td>
                <select aria-label={`Role for ${s.email}`} value={s.role} disabled={s.id === admin?.id || !reasonOk} onChange={(e) => void run(`Role for ${s.email}`, `/admin/staff/${s.id}/role`, "PUT", { role: e.target.value, reason: reason.trim() })}>
                  {ROLES.map((r) => <option key={r} value={r}>{LABEL[r]}</option>)}
                </select>
              </td>
              <td>{s.status === "ACTIVE" ? "Active" : "Disabled"}</td>
              <td>{s.mfa === "ENROLLED" ? "Set up" : s.mfa === "REQUIRED" ? "Required, not yet set up" : "Not set up"}</td>
              <td>{s.lastSignInAt ? new Date(s.lastSignInAt).toLocaleString() : "Never"}</td>
              <td>{s.liveSessions}</td>
              <td>
                {s.id === admin?.id ? <em>You</em> : (
                  <>
                    <button type="button" disabled={!reasonOk} onClick={() => void run(s.status === "ACTIVE" ? `Disable ${s.email}` : `Enable ${s.email}`, `/admin/staff/${s.id}/${s.status === "ACTIVE" ? "disable" : "enable"}`, "POST", { reason: reason.trim() })}>
                      {s.status === "ACTIVE" ? "Disable" : "Enable"}
                    </button>{" "}
                    <button type="button" disabled={!reasonOk || s.liveSessions === 0} onClick={() => void run(`End sessions for ${s.email}`, `/admin/staff/${s.id}/revoke-sessions`, "POST", { reason: reason.trim() })}>End sessions</button>{" "}
                    {admin?.role === "SUPER_ADMIN" && s.status === "ACTIVE" && s.role !== "SUPER_ADMIN" ? (
                      <button type="button" onClick={() => void run(`Offer ownership to ${s.email}`, "/admin/staff/ownership-transfers", "POST", { toAdminId: s.id })}>Hand over ownership…</button>
                    ) : null}
                  </>
                )}
              </td>
            </tr>
          ))}
          {staff.length === 0 ? <tr><td colSpan={7}>No staff to show.</td></tr> : null}
        </tbody>
      </table>

      {transfers.filter((t) => t.status === "INITIATED").length > 0 ? (
        <>
          <h2>Open ownership transfers</h2>
          <ul>
            {transfers.filter((t) => t.status === "INITIATED").map((t) => (
              <li key={t.id}>
                Offered until {new Date(t.expiresAt).toLocaleString()}{" "}
                {t.toAdminId === admin?.id ? <button type="button" onClick={() => void run("Accept ownership", `/admin/staff/ownership-transfers/${t.id}/accept`, "POST", {})}>Accept ownership</button> : null}{" "}
                {t.toAdminId === admin?.id || t.fromAdminId === admin?.id ? <button type="button" onClick={() => void run("Cancel the transfer", `/admin/staff/ownership-transfers/${t.id}/cancel`, "POST", {})}>Cancel</button> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2>Invite someone</h2>
      <form onSubmit={invite}>
        <label>Email <input type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} aria-label="Invitation email" /></label>{" "}
        <label>Role <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as AdminRole)} aria-label="Invitation role">{ROLES.map((r) => <option key={r} value={r}>{LABEL[r]}</option>)}</select></label>{" "}
        <button type="submit">Create invitation</button>
      </form>
      {link ? (
        <div role="status" className="callout">
          <p><strong>Copy this link now and send it to the person yourself.</strong> It is shown only once, works once, and expires in 72 hours.</p>
          <input readOnly value={link} aria-label="Invitation link" style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : null}
      <table className="data-table">
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th></th></tr></thead>
        <tbody>
          {invitations.map((i) => (
            <tr key={i.id}>
              <td>{i.email}</td><td>{LABEL[i.role]}</td><td>{i.status}</td><td>{new Date(i.expiresAt).toLocaleString()}</td>
              <td>{i.status === "OPEN" ? <button type="button" onClick={() => void run(`Revoke invitation for ${i.email}`, `/admin/staff/invitations/${i.id}/revoke`, "POST", {})}>Revoke</button> : null}</td>
            </tr>
          ))}
          {invitations.length === 0 ? <tr><td colSpan={5}>No invitations yet.</td></tr> : null}
        </tbody>
      </table>

      <h2>Sign-in and security events</h2>
      <label><input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} /> Failures only</label>
      <table className="data-table">
        <thead><tr><th>When</th><th>Event</th><th>Result</th></tr></thead>
        <tbody>
          {events.map((e) => <tr key={e.id}><td>{new Date(e.createdAt).toLocaleString()}</td><td>{e.eventType}</td><td>{e.result}</td></tr>)}
          {events.length === 0 ? <tr><td colSpan={3}>No events.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
