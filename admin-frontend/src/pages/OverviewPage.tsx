import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiClient";

interface Overview {
  businesses: { total: number; active: number; suspended: number; newLast7Days: number };
  merchants: { active: number };
  activity: { transactionsLast24h: number; transactionsLast7d: number };
  subscriptions: Record<string, number>;
  queues: {
    pendingDeletionRequests: number;
    unmatchedMobileMoneyAlerts: number;
    openSupportCases?: number;
    openPaymentExceptions?: number;
    pendingRefundRequests?: number;
    openProviderExceptions?: number;
    unresolvedPaymentAttempts?: number;
    openReports?: number;
    openAppeals?: number;
    openBillingExceptions?: number;
    subscriptionsInGrace?: number;
    outbox: { pending: number; dead: number; oldestPendingAgeSeconds: number | null };
    inbox: { received: number; dead: number; oldestReceivedAgeSeconds?: number | null };
  };
  generatedAt: string;
}

function Stat({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={warn ? "stat-card stat-warn" : "stat-card"}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Overview>("/admin/overview")
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load the overview."));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="page"><h1>Overview</h1><p className="form-error" role="alert">{error}</p></div>;
  if (!data) return <div className="page"><h1>Overview</h1><p>Loading…</p></div>;

  const q = data.queues;
  return (
    <div className="page">
      <h1>Overview</h1>
      <h2>Businesses</h2>
      <div className="stat-grid">
        <Stat label="Total" value={data.businesses.total} />
        <Stat label="Active" value={data.businesses.active} />
        <Stat label="Suspended" value={data.businesses.suspended} warn={data.businesses.suspended > 0} />
        <Stat label="New, last 7 days" value={data.businesses.newLast7Days} />
        <Stat label="Active merchants" value={data.merchants.active} />
      </div>
      <h2>Activity</h2>
      <div className="stat-grid">
        <Stat label="Entries, last 24 h" value={data.activity.transactionsLast24h} />
        <Stat label="Entries, last 7 days" value={data.activity.transactionsLast7d} />
      </div>
      <h2>Subscriptions</h2>
      <div className="stat-grid">
        {Object.entries(data.subscriptions).length === 0 ? <p>None yet.</p> : null}
        {Object.entries(data.subscriptions).map(([status, count]) => (
          <Stat key={status} label={status} value={count} />
        ))}
      </div>
      <h2>Needs attention</h2>
      <div className="stat-grid">
        <Stat label="Deletion requests pending" value={q.pendingDeletionRequests} warn={q.pendingDeletionRequests > 0} />
        <Stat label="Unmatched mobile-money alerts" value={q.unmatchedMobileMoneyAlerts} warn={q.unmatchedMobileMoneyAlerts > 0} />
        <Stat label="Open support cases" value={q.openSupportCases ?? 0} warn={(q.openSupportCases ?? 0) > 0} />
        <Stat label="Payments needing a decision" value={q.openPaymentExceptions ?? 0} warn={(q.openPaymentExceptions ?? 0) > 0} />
        <Stat label="Refund requests in progress" value={q.pendingRefundRequests ?? 0} />
        <Stat label="Provider payment exceptions" value={q.openProviderExceptions ?? 0} warn={(q.openProviderExceptions ?? 0) > 0} />
        <Stat label="Payments waiting on a provider" value={q.unresolvedPaymentAttempts ?? 0} />
        <Stat label="Marketplace reports open" value={q.openReports ?? 0} warn={(q.openReports ?? 0) > 0} />
        <Stat label="Moderation appeals open" value={q.openAppeals ?? 0} warn={(q.openAppeals ?? 0) > 0} />
        <Stat label="Subscription billing exceptions" value={q.openBillingExceptions ?? 0} warn={(q.openBillingExceptions ?? 0) > 0} />
        <Stat label="Subscriptions in grace" value={q.subscriptionsInGrace ?? 0} />
        <Stat label="Outbox dead-lettered" value={q.outbox.dead} warn={q.outbox.dead > 0} />
        <Stat label="Callbacks dead-lettered" value={q.inbox.dead} warn={q.inbox.dead > 0} />
      </div>
      <p className="muted">Counts only; no merchant money or contact details are shown here. Generated {new Date(data.generatedAt).toLocaleString()}.</p>
    </div>
  );
}
