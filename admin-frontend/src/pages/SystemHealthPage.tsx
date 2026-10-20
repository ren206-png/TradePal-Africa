import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/apiClient";

interface Health {
  heartbeats: { enabled: boolean; services: { service: string; lastSeenAt: string | null; ageSeconds: number | null; stale: boolean }[] };
  webhooks: { stuckPendingOver5Min: number };
  outbox: { pending: number; processing: number; dead: number; oldestPendingAgeSeconds: number | null };
  inbox: { received: number; processing: number; dead: number };
  ai: { lastSuccessfulCallAt: string | null; lastSuccessfulProvider: string | null };
  configured: { alertEmail: boolean; deepseek: boolean; outboxSweep: boolean };
  adminControls: Record<string, boolean>;
  alertChannel?: { lastDeliveredAt: string | null; lastFailedAt: string | null; failedLast7Days: number; needsAttention: boolean };
  generatedAt: string;
}
interface Job { id: string; label: string; paused: boolean; reason: string | null; changedBy: string | null; changedAt: string | null }
type Action = { kind: "pause" | "resume"; job: Job } | { kind: "incident" };

const yesNo = (v: boolean) => (v ? "Yes" : "No");

export function SystemHealthPage() {
  const [data, setData] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await apiFetch<Health>("/admin/system-health");
        const j = await apiFetch<{ jobs: Job[] }>("/admin/system/jobs");
        if (cancelled) return;
        setData(h);
        setJobs(j.jobs);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load system health.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action.kind === "incident") {
        const r = await apiFetch<{ note: string }>("/admin/system/synthetic-incident", { method: "POST", body: { reason: reason.trim() } });
        setNotice(r.note);
      } else {
        await apiFetch(`/admin/system/jobs/${action.job.id}/${action.kind}`, { method: "POST", body: { reason: reason.trim() } });
        setNotice(action.kind === "pause" ? "Paused. Scheduled runs will skip it until you resume it." : "Resumed.");
      }
      setAction(null);
      setReason("");
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <div className="page"><h1>System health</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!data) return <div className="page"><h1>System health</h1><p>Loading…</p></div>;

  return (
    <div className="page">
      <h1>System health</h1>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      <h2>Heartbeats</h2>
      {!data.heartbeats.enabled ? <p className="muted">Heartbeat writing is off on this API (HEARTBEAT_ENABLED is not true), so these will show as stale.</p> : null}
      <table className="data-table">
        <thead><tr><th>Service</th><th>Last seen</th><th>Age</th><th>Status</th></tr></thead>
        <tbody>
          {data.heartbeats.services.map((s) => (
            <tr key={s.service}>
              <td>{s.service}</td>
              <td>{s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : "never"}</td>
              <td>{s.ageSeconds === null ? "-" : `${s.ageSeconds}s`}</td>
              <td>{s.stale ? "STALE" : "OK"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Queues</h2>
      <table className="data-table">
        <tbody>
          <tr><th>Inbound messages stuck pending &gt; 5 min</th><td>{data.webhooks.stuckPendingOver5Min}</td></tr>
          <tr><th>Outbox pending / dead</th><td>{data.outbox.pending} / {data.outbox.dead}</td></tr>
          <tr><th>Outbox oldest pending</th><td>{data.outbox.oldestPendingAgeSeconds === null ? "-" : `${data.outbox.oldestPendingAgeSeconds}s`}</td></tr>
          <tr><th>Callbacks received / dead</th><td>{data.inbox.received} / {data.inbox.dead}</td></tr>
        </tbody>
      </table>

      <h2>Alert channel</h2>
      {data.alertChannel ? (
        <p className={data.alertChannel.needsAttention ? "form-error" : "muted"}>
          {data.alertChannel.needsAttention ? "Needs attention: no alert delivery has been proven in the last 7 days, or the latest attempt failed. " : "An alert delivery was accepted recently. "}
          Last accepted: {data.alertChannel.lastDeliveredAt ? new Date(data.alertChannel.lastDeliveredAt).toLocaleString() : "never"}. Failures in 7 days: {data.alertChannel.failedLast7Days}.
        </p>
      ) : null}
      <p><button type="button" onClick={() => { setAction({ kind: "incident" }); setReason(""); }}>Send a synthetic incident…</button></p>

      <h2>Background jobs</h2>
      <table className="data-table">
        <thead><tr><th>Job</th><th>State</th><th /></tr></thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.label}</td>
              <td>{j.paused ? `PAUSED${j.reason ? `: ${j.reason}` : ""}` : "running"}</td>
              <td><button type="button" onClick={() => { setAction({ kind: j.paused ? "resume" : "pause", job: j }); setReason(""); }}>{j.paused ? "Resume…" : "Pause…"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Pausing skips scheduled runs only. Inbound WhatsApp messages and payment callbacks are never paused.</p>
      {action ? (
        <form onSubmit={submit} className="card" aria-label="Confirm">
          <h3>{action.kind === "incident" ? "Send a synthetic incident" : `${action.kind === "pause" ? "Pause" : "Resume"}: ${action.job.label}`}</h3>
          <label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} /></label>
          <button type="submit" disabled={busy || reason.trim().length < 10}>Confirm</button>
          <button type="button" onClick={() => setAction(null)}>Cancel</button>
        </form>
      ) : null}

      <h2>AI</h2>
      <p>
        Last successful call:{" "}
        {data.ai.lastSuccessfulCallAt ? `${new Date(data.ai.lastSuccessfulCallAt).toLocaleString()} (${data.ai.lastSuccessfulProvider})` : "none recorded"}
      </p>

      <h2>Configuration (set / not set, never the values)</h2>
      <table className="data-table">
        <tbody>
          <tr><th>Alert email configured</th><td>{yesNo(data.configured.alertEmail)}</td></tr>
          <tr><th>DeepSeek key configured</th><td>{yesNo(data.configured.deepseek)}</td></tr>
          <tr><th>Outbox/inbox sweep enabled</th><td>{yesNo(data.configured.outboxSweep)}</td></tr>
          {Object.entries(data.adminControls).map(([key, on]) => (
            <tr key={key}><th>{key}</th><td>{on ? "On" : "Off"}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Generated {new Date(data.generatedAt).toLocaleString()}.</p>
    </div>
  );
}
