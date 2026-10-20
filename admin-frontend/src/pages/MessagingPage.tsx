import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../lib/apiClient";
import type { BlockRow, ConsentRow, MessagingOverview, StuckInboundRow, TemplateRow } from "../lib/types";

const words = (s: string) => s.toLowerCase().replace(/_/g, " ");
const count = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${words(k)} ${v}`).join(", ") || "none";
const when = (s: string | null) => (s ? new Date(s).toLocaleString() : "never");

type Action =
  | { kind: "approve"; messageClass: string; title: string }
  | { kind: "disable"; messageClass: string; title: string }
  | { kind: "block"; title: string }
  | { kind: "unblock"; phone: string; title: string }
  | { kind: "replay"; id: string; title: string }
  | { kind: "check"; title: string };

export function MessagingPage() {
  const [overview, setOverview] = useState<MessagingOverview | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [consents, setConsents] = useState<ConsentRow[]>([]);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [stuck, setStuck] = useState<StuckInboundRow[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [phone, setPhone] = useState("");
  const [providerName, setProviderName] = useState("");
  const [reference, setReference] = useState("");
  const [status, setStatus] = useState<"SUBMITTED" | "APPROVED" | "REJECTED" | "DRAFT">("APPROVED");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = search.trim() ? `?phone=${encodeURIComponent(search.trim())}` : "";
        const o = await apiFetch<MessagingOverview>("/admin/messaging/overview");
        const t = await apiFetch<{ templates: TemplateRow[] }>("/admin/messaging/templates");
        const c = await apiFetch<{ consents: ConsentRow[] }>(`/admin/messaging/consents${q}`);
        const b = await apiFetch<{ blocks: BlockRow[] }>("/admin/messaging/blocks");
        const s = await apiFetch<{ events: StuckInboundRow[] }>("/admin/messaging/inbound/stuck");
        if (cancelled) return;
        setOverview(o);
        setTemplates(t.templates);
        setConsents(c.consents);
        setBlocks(b.blocks);
        setStuck(s.events);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload, search]);

  function begin(a: Action) {
    setAction(a);
    setReason("");
    setPhone("");
    setProviderName("");
    setReference("");
    setStatus("APPROVED");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = reason.trim();
    try {
      if (action.kind === "approve") await apiFetch(`/admin/messaging/templates/${action.messageClass}`, { method: "PUT", body: { status, ...(providerName.trim() ? { providerTemplateName: providerName.trim() } : {}), ...(reference.trim() ? { approvalReference: reference.trim() } : {}), reason: r } });
      else if (action.kind === "disable") await apiFetch(`/admin/messaging/templates/${action.messageClass}/disable`, { method: "POST", body: { reason: r } });
      else if (action.kind === "block") await apiFetch("/admin/messaging/blocks", { method: "POST", body: { phone: phone.trim(), reason: r } });
      else if (action.kind === "unblock") await apiFetch("/admin/messaging/blocks/unblock", { method: "POST", body: { phone: phone.trim(), reason: r } });
      else if (action.kind === "replay") await apiFetch(`/admin/messaging/inbound/${action.id}/replay`, { method: "POST", body: { reason: r } });
      else await apiFetch("/admin/messaging/alert-channel/check", { method: "POST", body: {} });
      setNotice(action.kind === "check" ? "Test message accepted by the email service. Check the inbox to be sure it arrived." : "Recorded.");
      setAction(null);
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !loaded) return <div className="page"><h1>Messaging</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!loaded || !overview) return <div className="page"><h1>Messaging</h1><p>Loading…</p></div>;
  const ch = overview.alertChannel;
  const needsReason = action ? action.kind !== "check" : false;
  const reasonOk = !needsReason || reason.trim().length >= 10;
  const phoneOk = action?.kind === "block" || action?.kind === "unblock" ? /^\+?[0-9 ()-]{8,20}$/.test(phone.trim()) : true;
  const approvalOk = action?.kind !== "approve" || status !== "APPROVED" || (providerName.trim().length >= 3 && reference.trim().length >= 3);

  return (
    <div className="page">
      <h1>Messaging and consent</h1>
      <p className="muted">
        What TradePal is allowed to send, to whom, and what people agreed to. Phone numbers are shown by their last four digits only. Nothing here sends a message to a shopper or changes a
        person's consent: only the person can do that (the checkout tick, STOP, START). A class of message that needs a template is NOT sent until a template is recorded as approved below.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <p className={overview.consumerMessaging.platformSwitchOn ? "form-error" : "muted"}>
        Messages to shoppers: platform switch {overview.consumerMessaging.platformSwitchOn ? "ON" : "off"}. Each seller must also have the consumerMessaging flag on, and each shopper must have opted in.
      </p>

      <div className="stat-grid">
        <div className="stat-card"><div className="stat-value">{count(overview.templatesByStatus)}</div><div className="stat-label">Templates</div></div>
        <div className="stat-card"><div className="stat-value">{overview.consents.map((c) => `${words(c.status)} ${c.count}`).join(", ") || "none"}</div><div className="stat-label">Consent records</div></div>
        <div className="stat-card"><div className="stat-value">{overview.blockedNumbers}</div><div className="stat-label">Blocked numbers</div></div>
        <div className="stat-card"><div className="stat-value">{count(overview.outbound30d)}</div><div className="stat-label">Shopper/partner messages, 30 days</div></div>
        <div className="stat-card"><div className="stat-value">{overview.volumes.inbound24h} in / {overview.volumes.outbound24h} out</div><div className="stat-label">WhatsApp, last 24 hours ({overview.volumes.inbound7d} / {overview.volumes.outbound7d} in 7 days)</div></div>
        <div className="stat-card"><div className="stat-value">{overview.aiParse7d.successRate === null ? "no data" : `${overview.aiParse7d.successRate}%`}</div><div className="stat-label">AI replies that passed validation, 7 days ({overview.aiParse7d.total}). Not a measure of being right.</div></div>
        <div className={overview.stuckInbound > 0 ? "stat-card stat-warn" : "stat-card"}><div className="stat-value">{overview.stuckInbound}</div><div className="stat-label">Stuck inbound messages</div></div>
        <div className={ch.needsAttention ? "stat-card stat-warn" : "stat-card"}><div className="stat-value">{ch.needsAttention ? "needs attention" : "proven"}</div><div className="stat-label">Alert channel</div></div>
      </div>

      <h2>Alert channel</h2>
      <p className="muted">
        Last delivery accepted: {when(ch.lastDeliveredAt)}. Last failure: {when(ch.lastFailedAt)}. Last check: {when(ch.lastChannelCheckAt)}{ch.lastChannelCheckStatus ? ` (${words(ch.lastChannelCheckStatus)})` : ""}. Failures in 7 days: {ch.failedLast7Days}.
        "Accepted" means the email service took it; it cannot prove it reached an inbox.
      </p>
      {ch.recentFailures.length > 0 ? <ul>{ch.recentFailures.map((f, i) => <li key={i}><span className="muted">{when(f.at)}:</span> {f.title} {f.httpStatus ? `(HTTP ${f.httpStatus}) ` : ""}{f.error ?? ""}</li>)}</ul> : null}
      <p><button type="button" onClick={() => begin({ kind: "check", title: "Send a test alert" })}>Check the alert channel…</button></p>

      <h2>Template register</h2>
      <table className="data-table">
        <thead><tr><th>Class</th><th>Audience</th><th>When</th><th>Consent</th><th>Window</th><th>State</th><th /></tr></thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.messageClass}>
              <td><code>{t.messageClass}</code>{t.body ? <div className="muted">{t.body}</div> : null}</td>
              <td>{words(t.audience)}</td><td>{t.trigger}</td><td>{words(t.consentBasis)}</td><td>{words(t.windowRule)}</td>
              <td>{words(t.status)}{t.providerTemplateName ? ` (${t.providerTemplateName})` : ""}{t.disabledReason ? `: ${t.disabledReason}` : ""}</td>
              <td>
                {t.needsTemplate && t.pipeline === "ENFORCED" ? <button type="button" onClick={() => begin({ kind: "approve", messageClass: t.messageClass, title: `Record the template state for ${t.messageClass}` })}>Record state…</button> : null}
                {t.status === "APPROVED" ? <button type="button" onClick={() => begin({ kind: "disable", messageClass: t.messageClass, title: `Disable ${t.messageClass}` })}>Disable…</button> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Recording an approval only records what the provider's dashboard shows; nothing here contacts Meta. Legacy classes send through their own modules and are listed for completeness.</p>

      <h2>Consent and opt-out records</h2>
      <div className="filter-row">
        <label className="filter-label">Find by last 4 digits or full number
          <input value={search} onChange={(e) => setSearch(e.target.value)} inputMode="tel" />
        </label>
      </div>
      <table className="data-table">
        <thead><tr><th>Number</th><th>Seller</th><th>Purpose</th><th>Status</th><th>How</th><th>Notice version</th><th>Updated</th></tr></thead>
        <tbody>
          {consents.map((c) => <tr key={c.id}><td>{c.phone}</td><td>{c.business}</td><td>{words(c.purpose)}</td><td>{words(c.status)}</td><td>{words(c.basis)}</td><td>{c.textVersion}</td><td>{when(c.updatedAt)}</td></tr>)}
          {consents.length === 0 ? <tr><td colSpan={7}>No records match.</td></tr> : null}
        </tbody>
      </table>

      <h2>Blocked numbers</h2>
      <p><button type="button" onClick={() => begin({ kind: "block", title: "Block a number" })}>Block a number…</button></p>
      <table className="data-table">
        <thead><tr><th>Number</th><th>By</th><th>Reason</th><th>State</th><th /></tr></thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.id}>
              <td>{b.phone}</td><td>{b.source === "STOP_KEYWORD" ? "the person (STOP)" : "an operator"}</td><td>{b.reason ?? "-"}</td><td>{b.active ? "blocked" : `lifted ${when(b.liftedAt)}`}</td>
              <td>{b.active && b.source === "ADMIN" ? <button type="button" onClick={() => begin({ kind: "unblock", phone: "", title: `Unblock ${b.phone}` })}>Unblock…</button> : null}</td>
            </tr>
          ))}
          {blocks.length === 0 ? <tr><td colSpan={5}>No blocked numbers.</td></tr> : null}
        </tbody>
      </table>
      <p className="muted">A STOP from the person is lifted only by their own START. Unblocking never turns anyone's consent back on.</p>

      <h2>Stuck inbound messages</h2>
      <table className="data-table">
        <thead><tr><th>Received</th><th>From</th><th>Type</th><th /></tr></thead>
        <tbody>
          {stuck.map((e) => (
            <tr key={e.id}>
              <td>{when(e.receivedAt)}</td><td>{e.from ?? "unreadable"}</td><td>{e.messageType ?? "-"}</td>
              <td>{e.replayable ? <button type="button" onClick={() => begin({ kind: "replay", id: e.id, title: "Replay this message" })}>Replay…</button> : e.tooOld ? "too old to answer" : "cannot replay"}</td>
            </tr>
          ))}
          {stuck.length === 0 ? <tr><td colSpan={4}>Nothing is stuck.</td></tr> : null}
        </tbody>
      </table>

      <h2>Languages</h2>
      <table className="data-table">
        <thead><tr><th>Language</th><th>Status</th><th>Messages with reviewed text</th></tr></thead>
        <tbody>{overview.localization.map((l) => <tr key={l.code}><td>{l.name}</td><td>{words(l.status)}</td><td>{l.keysServed} of {l.keysTotal}</td></tr>)}</tbody>
      </table>
      <p className="muted">{overview.localization[0]?.caveat} Only English exists. No other language has any text, and none is machine-translated.</p>

      {action ? (
        <form onSubmit={submit} className="card" aria-label={action.title}>
          <h3>{action.title}</h3>
          {action.kind === "approve" ? (
            <>
              <label>State
                <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  <option value="DRAFT">Draft</option><option value="SUBMITTED">Submitted to the provider</option><option value="APPROVED">Approved by the provider</option><option value="REJECTED">Rejected</option>
                </select>
              </label>
              <label>Provider template name<input value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="order_confirmed_v1" /></label>
              <label>Where the approval can be checked<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Meta template id or ticket" /></label>
            </>
          ) : null}
          {action.kind === "block" || action.kind === "unblock" ? <label>Phone number<input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></label> : null}
          {needsReason ? <label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} /></label> : <p className="muted">This sends one clearly labelled test message to the alert address.</p>}
          <button type="submit" disabled={busy || !reasonOk || !phoneOk || !approvalOk}>Confirm</button>
          <button type="button" onClick={() => setAction(null)}>Cancel</button>
        </form>
      ) : null}
    </div>
  );
}
