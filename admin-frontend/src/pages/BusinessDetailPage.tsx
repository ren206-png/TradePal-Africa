import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiFetch, ApiError, buildQuery } from "../lib/apiClient";
import { Pager } from "../components/Pager";
import type {
  BusinessDetail,
  EffectivePlan,
  FeatureFlagState,
  Invoice,
  Merchant,
  PaginationMeta,
  PaymentRequest,
  Plan,
} from "../lib/types";

const INVOICES_TAKE = 20;
const PAYMENT_REQUESTS_TAKE = 20;

/** amountMinor arrives as a string (bigint serialized over the wire — see adminRoutes.ts). Display-only, mirrors MobileMoneyAlertsPage.tsx's formatMinor. */
function formatMinor(amountMinor: string): string {
  const value = BigInt(amountMinor);
  const major = value / 100n;
  const minor = value % 100n;
  return `${major}.${minor.toString().padStart(2, "0")}`;
}

/** Only these roles may call POST /merchants/:id/phone-number (see requireAdminRole in adminRoutes.ts). */
const PHONE_CHANGE_ROLES = new Set(["SUPER_ADMIN", "SUPPORT"]);
/** Same roles that may assign/cancel a Subscription (see requireAdminRole in adminRoutes.ts) — mirrors
 * the existing phone-number-change precedent, since these are operational (not pricing-global) changes. */
const SUBSCRIPTION_WRITE_ROLES = new Set(["SUPER_ADMIN", "SUPPORT"]);
/** Same roles that may set/reset a business's own feature-flag override (see requireAdminRole in
 * adminRoutes.ts) — a single-business override is operational, unlike the global default flip on
 * FeatureFlagsPage, which is SUPER_ADMIN-only. */
const FEATURE_FLAG_WRITE_ROLES = new Set(["SUPER_ADMIN", "SUPPORT"]);
/** Same roles that may trigger POST /businesses/:id/inventory/backfill (see requireAdminRole in
 * adminRoutes.ts) — a business-scoped, idempotent, operator-triggered maintenance action, mirroring
 * the phone-number-change and feature-flag-override precedents rather than PlansPage's SUPER_ADMIN-only
 * global expiry sweep, since this action's blast radius is a single business. */
const INVENTORY_BACKFILL_WRITE_ROLES = new Set(["SUPER_ADMIN", "SUPPORT"]);

export function BusinessDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { admin } = useAuth();
  const [business, setBusiness] = useState<BusinessDetail | null>(null);
  const [currentPlan, setCurrentPlan] = useState<EffectivePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [featureFlags, setFeatureFlags] = useState<FeatureFlagState[]>([]);
  const [featureFlagsError, setFeatureFlagsError] = useState<string | null>(null);

  const canChangePhoneNumber = admin ? PHONE_CHANGE_ROLES.has(admin.role) : false;
  const canManageSubscription = admin ? SUBSCRIPTION_WRITE_ROLES.has(admin.role) : false;
  const canManageFeatureFlags = admin ? FEATURE_FLAG_WRITE_ROLES.has(admin.role) : false;
  const canBackfillInventory = admin ? INVENTORY_BACKFILL_WRITE_ROLES.has(admin.role) : false;

  const load = () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    apiFetch<{ business: BusinessDetail; currentPlan: EffectivePlan | null }>(`/admin/businesses/${id}`)
      .then((result) => {
        setBusiness(result.business);
        setCurrentPlan(result.currentPlan);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load business."))
      .finally(() => setLoading(false));
  };

  const loadFeatureFlags = () => {
    if (!id) return;
    setFeatureFlagsError(null);
    apiFetch<{ featureFlags: FeatureFlagState[] }>(`/admin/businesses/${id}/feature-flags`)
      .then((result) => setFeatureFlags(result.featureFlags))
      .catch((err) => setFeatureFlagsError(err instanceof Error ? err.message : "Failed to load feature flags."));
  };

  useEffect(load, [id]);
  useEffect(loadFeatureFlags, [id]);

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!business) return <p>Business not found.</p>;

  return (
    <div className="page">
      <p>
        <Link to="/businesses">&larr; Back to businesses</Link>
      </p>
      <h1>{business.name}</h1>
      <dl className="detail-grid">
        <dt>Country</dt>
        <dd>{business.countryCode}</dd>
        <dt>Currency</dt>
        <dd>{business.currencyCode}</dd>
        <dt>Language</dt>
        <dd>{business.languageCode}</dd>
        <dt>Timezone</dt>
        <dd>{business.timezone}</dd>
        <dt>Created</dt>
        <dd>{new Date(business.createdAt).toLocaleString()}</dd>
      </dl>

      <h2>Subscription</h2>
      <SubscriptionSection
        businessId={business.id}
        subscriptions={business.subscriptions}
        currentPlan={currentPlan}
        canManage={canManageSubscription}
        onChanged={load}
      />

      <h2>Invoices</h2>
      <InvoicesSection businessId={business.id} />

      <h2>Payment requests</h2>
      <PaymentRequestsSection businessId={business.id} />

      <h2>Merchants</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Phone number</th>
            <th>Display name</th>
            <th>Created</th>
            {canChangePhoneNumber ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {business.merchants.map((merchant) => (
            <MerchantRow
              key={merchant.id}
              merchant={merchant}
              businessId={business.id}
              canChangePhoneNumber={canChangePhoneNumber}
              onChanged={load}
            />
          ))}
          {business.merchants.length === 0 ? (
            <tr>
              <td colSpan={canChangePhoneNumber ? 4 : 3}>No merchants on this business yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h2>Feature flags</h2>
      {featureFlagsError ? <p className="form-error">{featureFlagsError}</p> : null}
      <FeatureFlagsSection
        businessId={business.id}
        flags={featureFlags}
        canManage={canManageFeatureFlags}
        onChanged={loadFeatureFlags}
      />

      <h2>Inventory</h2>
      <InventoryBackfillSection businessId={business.id} canRun={canBackfillInventory} />
    </div>
  );
}

/**
 * Phase 23 gap closure: Phase 22 (Flutterwave payment collection) added the
 * Invoice model but never surfaced it anywhere in the admin dashboard — this
 * is that missing view. Read-only (see GET /admin/businesses/:id/invoices's
 * doc comment in adminRoutes.ts for why there's deliberately no write path),
 * paginated like MobileMoneyAlertsPage.tsx rather than loaded all-at-once
 * like SubscriptionSection above it, since an Invoice history can in
 * principle grow without bound the same way mobile money alerts can.
 */
function InvoicesSection({ businessId }: { businessId: string }) {
  const [skip, setSkip] = useState(0);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ take: INVOICES_TAKE, skip: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ invoices: Invoice[]; pagination: PaginationMeta }>(
      `/admin/businesses/${businessId}/invoices${buildQuery({ take: INVOICES_TAKE, skip })}`,
    )
      .then((result) => {
        if (cancelled) return;
        setInvoices(result.invoices);
        setPagination(result.pagination);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load invoices.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, skip]);

  if (loading) return <p>Loading invoices…</p>;
  if (error) return <p className="form-error">{error}</p>;

  return (
    <div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Plan</th>
            <th>Amount</th>
            <th>Currency</th>
            <th>Status</th>
            <th>Provider</th>
            <th>Due</th>
            <th>Paid</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <td>{invoice.subscription.planCode}</td>
              <td>{formatMinor(invoice.amountMinor)}</td>
              <td>{invoice.currencyCode}</td>
              <td>{invoice.status}</td>
              <td>{invoice.providerCode ?? "—"}</td>
              <td>{new Date(invoice.dueDate).toLocaleString()}</td>
              <td>{invoice.paidAt ? new Date(invoice.paidAt).toLocaleString() : "—"}</td>
            </tr>
          ))}
          {invoices.length === 0 ? (
            <tr>
              <td colSpan={7}>No invoices for this business yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <Pager
        pagination={pagination}
        onPrev={() => setSkip((s) => Math.max(0, s - INVOICES_TAKE))}
        onNext={() => setSkip((s) => s + INVOICES_TAKE)}
      />
    </div>
  );
}

/**
 * Phase 24: same admin-visibility precedent as InvoicesSection above, for the
 * new customer-facing /paylink feature. Read-only for the same reason —
 * status is only ever set by confirmPaymentRequestPayment reacting to a
 * verified Flutterwave webhook, never by an admin action.
 */
function PaymentRequestsSection({ businessId }: { businessId: string }) {
  const [skip, setSkip] = useState(0);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({
    take: PAYMENT_REQUESTS_TAKE,
    skip: 0,
    hasMore: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ paymentRequests: PaymentRequest[]; pagination: PaginationMeta }>(
      `/admin/businesses/${businessId}/payment-requests${buildQuery({ take: PAYMENT_REQUESTS_TAKE, skip })}`,
    )
      .then((result) => {
        if (cancelled) return;
        setPaymentRequests(result.paymentRequests);
        setPagination(result.pagination);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load payment requests.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, skip]);

  if (loading) return <p>Loading payment requests…</p>;
  if (error) return <p className="form-error">{error}</p>;

  return (
    <div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Currency</th>
            <th>Status</th>
            <th>Provider</th>
            <th>Created</th>
            <th>Paid</th>
          </tr>
        </thead>
        <tbody>
          {paymentRequests.map((paymentRequest) => (
            <tr key={paymentRequest.id}>
              <td>{paymentRequest.customer?.name ?? "—"}</td>
              <td>{paymentRequest.description}</td>
              <td>{formatMinor(paymentRequest.amountMinor)}</td>
              <td>{paymentRequest.currencyCode}</td>
              <td>{paymentRequest.status}</td>
              <td>{paymentRequest.providerCode ?? "—"}</td>
              <td>{new Date(paymentRequest.createdAt).toLocaleString()}</td>
              <td>{paymentRequest.paidAt ? new Date(paymentRequest.paidAt).toLocaleString() : "—"}</td>
            </tr>
          ))}
          {paymentRequests.length === 0 ? (
            <tr>
              <td colSpan={8}>No payment requests for this business yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <Pager
        pagination={pagination}
        onPrev={() => setSkip((s) => Math.max(0, s - PAYMENT_REQUESTS_TAKE))}
        onNext={() => setSkip((s) => s + PAYMENT_REQUESTS_TAKE)}
      />
    </div>
  );
}

/**
 * Phase 17 gap closure: `POST /admin/businesses/:id/inventory/backfill` (added alongside
 * `backfillInventoryLinksForBusiness` in src/domain/inventory.ts) previously had no admin-frontend
 * UI at all — an operator had to call it directly via curl/Postman. This mirrors
 * `ExpireSubscriptionsButton` (PlansPage.tsx)'s no-body-POST / plain-inline-result shape, but is
 * scoped to a single business (like SubscriptionSection/FeatureFlagsSection above) rather than
 * being a global sweep, since the backfill only ever touches one business's own data.
 */
function InventoryBackfillSection({ businessId, canRun }: { businessId: string; canRun: boolean }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiFetch<{ transactionItemsLinked: number }>(
        `/admin/businesses/${businessId}/inventory/backfill`,
        { method: "POST" },
      );
      setResult(
        response.transactionItemsLinked === 0
          ? "No un-linked sale/purchase line items found — nothing to backfill."
          : `Linked ${response.transactionItemsLinked} transaction item(s) to inventory and applied matching stock movements.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to run the inventory backfill.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ marginBottom: "1rem" }}>
      <p>
        Retroactively links this business&rsquo;s pre-existing SALE/PURCHASE transaction items to inventory items
        and applies matching stock movements, for history logged before stock tracking was enabled. Safe to run
        more than once &mdash; already-linked items are skipped, so re-running is a no-op.
      </p>
      {canRun ? (
        <button type="button" onClick={handleClick} disabled={running}>
          {running ? "Running…" : "Backfill inventory links"}
        </button>
      ) : (
        <p>Requires SUPER_ADMIN or SUPPORT to run.</p>
      )}
      {result ? <p>{result}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function FeatureFlagsSection({
  businessId,
  flags,
  canManage,
  onChanged,
}: {
  businessId: string;
  flags: FeatureFlagState[];
  canManage: boolean;
  onChanged: () => void;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Description</th>
          <th>Global default</th>
          <th>Override</th>
          <th>Effective</th>
          {canManage ? <th>Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {flags.map((flag) => (
          <FeatureFlagRow key={flag.key} businessId={businessId} flag={flag} canManage={canManage} onChanged={onChanged} />
        ))}
        {flags.length === 0 ? (
          <tr>
            <td colSpan={canManage ? 6 : 5}>No feature flags defined yet.</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function FeatureFlagRow({
  businessId,
  flag,
  canManage,
  onChanged,
}: {
  businessId: string;
  flag: FeatureFlagState;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSetOverride(enabled: boolean) {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/admin/businesses/${businessId}/feature-flags/${flag.key}`, {
        method: "POST",
        body: { enabled, ...(reason ? { reason } : {}) },
      });
      setEditing(false);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to set the override.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReset() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/admin/businesses/${businessId}/feature-flags/${flag.key}/reset`, {
        method: "POST",
        body: { ...(reason ? { reason } : {}) },
      });
      setEditing(false);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reset the override.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <tr>
        <td>{flag.key}</td>
        <td>{flag.description}</td>
        <td>{flag.enabledByDefault ? "Yes" : "No"}</td>
        <td>{flag.override === null ? "— (follows default)" : flag.override ? "Enabled" : "Disabled"}</td>
        <td>{flag.effective ? "Yes" : "No"}</td>
        {canManage ? (
          <td>
            <button type="button" onClick={() => setEditing((v) => !v)}>
              {editing ? "Cancel" : "Change override"}
            </button>
          </td>
        ) : null}
      </tr>
      {editing ? (
        <tr>
          <td colSpan={6}>
            <div className="inline-form">
              <label>
                Reason (optional, recorded in the audit log)
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button type="button" disabled={submitting} onClick={() => handleSetOverride(true)}>
                {submitting ? "Saving…" : "Force enabled"}
              </button>
              <button type="button" disabled={submitting} onClick={() => handleSetOverride(false)}>
                {submitting ? "Saving…" : "Force disabled"}
              </button>
              {flag.override !== null ? (
                <button type="button" disabled={submitting} onClick={handleReset}>
                  {submitting ? "Saving…" : "Reset to global default"}
                </button>
              ) : null}
              {error ? <p className="form-error">{error}</p> : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SubscriptionSection({
  businessId,
  subscriptions,
  currentPlan,
  canManage,
  onChanged,
}: {
  businessId: string;
  subscriptions: BusinessDetail["subscriptions"];
  currentPlan: EffectivePlan | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [planCode, setPlanCode] = useState("");
  const [periodDays, setPeriodDays] = useState("30");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasActiveSubscription = subscriptions.some((s) => s.status === "ACTIVE");

  function openAssignForm() {
    setError(null);
    setAssigning(true);
    if (plans === null) {
      apiFetch<{ plans: Plan[] }>("/admin/plans")
        .then((result) => {
          setPlans(result.plans);
          setPlanCode((prev) => prev || result.plans[0]?.code || "");
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load plans."));
    }
  }

  async function handleAssign() {
    setError(null);
    const days = Number(periodDays);
    if (!Number.isFinite(days) || days <= 0) {
      setError("Period (days) must be a positive number.");
      return;
    }
    setSubmitting(true);
    try {
      const now = new Date();
      const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      await apiFetch(`/admin/businesses/${businessId}/subscription`, {
        method: "POST",
        body: {
          planCode,
          currentPeriodStart: now.toISOString(),
          currentPeriodEnd: end.toISOString(),
          ...(reason ? { reason } : {}),
        },
      });
      setAssigning(false);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to assign subscription.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/admin/businesses/${businessId}/subscription/cancel`, {
        method: "POST",
        body: { ...(reason ? { reason } : {}) },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to cancel subscription.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <dl className="detail-grid">
        <dt>Effective plan</dt>
        <dd>
          {currentPlan
            ? `${currentPlan.code} (entry cap: ${currentPlan.entryCapPerMonth ?? "uncapped"}, voice: ${
                currentPlan.voiceEnabled ? "yes" : "no"
              })`
            : "Unknown"}
        </dd>
      </dl>

      {canManage ? (
        <div style={{ marginBottom: "1rem" }}>
          {!assigning ? (
            <button type="button" onClick={openAssignForm}>
              Assign a plan
            </button>
          ) : null}
          {hasActiveSubscription ? (
            <button type="button" onClick={handleCancel} disabled={submitting} style={{ marginLeft: "0.5rem" }}>
              {submitting ? "Canceling…" : "Cancel active subscription"}
            </button>
          ) : null}
        </div>
      ) : null}

      {assigning ? (
        <div className="inline-form" style={{ flexWrap: "wrap", marginBottom: "1rem" }}>
          <label>
            Plan
            {plans === null ? (
              <span>Loading plans…</span>
            ) : (
              <select value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label>
            Period length (days)
            <input value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} />
          </label>
          <label>
            Reason (optional, recorded in the audit log)
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button type="button" disabled={submitting || !planCode} onClick={handleAssign}>
            {submitting ? "Saving…" : "Assign"}
          </button>
          <button type="button" onClick={() => setAssigning(false)} disabled={submitting}>
            Cancel
          </button>
        </div>
      ) : error ? (
        <p className="form-error">{error}</p>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th>Plan</th>
            <th>Status</th>
            <th>Period start</th>
            <th>Period end</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {subscriptions.map((subscription) => (
            <tr key={subscription.id}>
              <td>{subscription.planCode}</td>
              <td>{subscription.status}</td>
              <td>{new Date(subscription.currentPeriodStart).toLocaleString()}</td>
              <td>{new Date(subscription.currentPeriodEnd).toLocaleString()}</td>
              <td>{new Date(subscription.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {subscriptions.length === 0 ? (
            <tr>
              <td colSpan={5}>No subscription history — this business is on the implicit default plan.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function MerchantRow({
  merchant,
  businessId,
  canChangePhoneNumber,
  onChanged,
}: {
  merchant: Merchant;
  businessId: string;
  canChangePhoneNumber: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/admin/merchants/${merchant.id}/phone-number`, {
        method: "POST",
        body: { businessId, newPhoneNumber, reason },
      });
      setEditing(false);
      setNewPhoneNumber("");
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to change phone number.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <tr>
        <td>{merchant.phoneNumber}</td>
        <td>{merchant.displayName ?? "—"}</td>
        <td>{new Date(merchant.createdAt).toLocaleString()}</td>
        {canChangePhoneNumber ? (
          <td>
            <button type="button" onClick={() => setEditing((v) => !v)}>
              {editing ? "Cancel" : "Change number"}
            </button>
          </td>
        ) : null}
      </tr>
      {editing ? (
        <tr>
          <td colSpan={4}>
            <div className="inline-form">
              <label>
                New phone number
                <input value={newPhoneNumber} onChange={(e) => setNewPhoneNumber(e.target.value)} />
              </label>
              <label>
                Reason (required, recorded in the audit log)
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              {error ? <p className="form-error">{error}</p> : null}
              <button
                type="button"
                disabled={submitting || !newPhoneNumber || !reason}
                onClick={handleSubmit}
              >
                {submitting ? "Saving…" : "Save"}
              </button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
