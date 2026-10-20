import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiClient";

interface Health {
  heartbeats: { enabled: boolean; services: { service: string; lastSeenAt: string | null; ageSeconds: number | null; stale: boolean }[] };
  webhooks: { stuckPendingOver5Min: number };
  outbox: { pending: number; processing: number; dead: number; oldestPendingAgeSeconds: number | null };
  inbox: { received: number; processing: number; dead: number };
  ai: { lastSuccessfulCallAt: string | null; lastSuccessfulProvider: string | null };
  configured: { alertEmail: boolean; deepseek: boolean; outboxSweep: boolean };
  adminControls: Record<string, boolean>;
  generatedAt: string;
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

export function SystemHealthPage() {
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Health>("/admin/system-health")
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load system health."));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="page"><h1>System health</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!data) return <div className="page"><h1>System health</h1><p>Loading…</p></div>;

  return (
    <div className="page">
      <h1>System health</h1>

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
