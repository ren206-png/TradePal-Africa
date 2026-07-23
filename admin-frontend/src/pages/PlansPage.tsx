import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch, ApiError } from "../lib/apiClient";
import type { Plan } from "../lib/types";

/** Only SUPER_ADMIN may call POST /admin/plans (see requireAdminRole in adminRoutes.ts) — plan/pricing
 * changes are global, not scoped to one business, so this is stricter than the phone-number-change precedent. */
const PLAN_WRITE_ROLES = new Set(["SUPER_ADMIN"]);

export function PlansPage() {
  const { admin } = useAuth();
  const canWrite = admin ? PLAN_WRITE_ROLES.has(admin.role) : false;

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    apiFetch<{ plans: Plan[] }>("/admin/plans")
      .then((result) => setPlans(result.plans))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load plans."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="page">
      <h1>Plans</h1>
      {canWrite ? <ExpireSubscriptionsButton /> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Price (minor units)</th>
              <th>Currency</th>
              <th>Entry cap / month</th>
              <th>Voice enabled</th>
              <th>Staff cap</th>
              {canWrite ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.code}>
                <td>{plan.code}</td>
                <td>{plan.name}</td>
                <td>{plan.priceMinor}</td>
                <td>{plan.currencyCode}</td>
                <td>{plan.entryCapPerMonth ?? "Uncapped"}</td>
                <td>{plan.voiceEnabled ? "Yes" : "No"}</td>
                <td>{plan.staffCapCount ?? "Uncapped"}</td>
                {canWrite ? (
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(plan);
                        setShowForm(true);
                      }}
                    >
                      Edit
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
            {plans.length === 0 ? (
              <tr>
                <td colSpan={canWrite ? 8 : 7}>No plans defined yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}

      {canWrite ? (
        <>
          <button
            type="button"
            onClick={() => {
              const isAddingNew = showForm && editing === null;
              if (isAddingNew) {
                setShowForm(false);
              } else {
                setEditing(null);
                setShowForm(true);
              }
            }}
          >
            {showForm && editing === null ? "Cancel" : "New plan"}
          </button>
          {showForm ? (
            <PlanForm
              key={editing?.code ?? "new"}
              initial={editing}
              onSaved={() => {
                setShowForm(false);
                setEditing(null);
                load();
              }}
              onCancel={() => {
                setShowForm(false);
                setEditing(null);
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Phase 6: manually triggers the same lapsed-subscription sweep the hourly
 * subscriptionExpiryWorker runs (POST /admin/maintenance/expire-subscriptions),
 * so an operator doesn't have to wait up to an hour for a just-lapsed
 * subscription's stored status to catch up. Global/cross-business action —
 * lives here (not on a single business's detail page) and is SUPER_ADMIN-only,
 * mirroring the backend's own requireAdminRole check.
 */
function ExpireSubscriptionsButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiFetch<{ expiredCount: number }>("/admin/maintenance/expire-subscriptions", {
        method: "POST",
      });
      setResult(
        response.expiredCount === 0
          ? "No lapsed subscriptions found."
          : `Expired ${response.expiredCount} lapsed subscription(s).`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to run the expiry sweep.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ marginBottom: "1rem" }}>
      <button type="button" onClick={handleClick} disabled={running}>
        {running ? "Running…" : "Run subscription-expiry sweep now"}
      </button>
      {result ? <p>{result}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function PlanForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Plan | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [priceMinor, setPriceMinor] = useState(initial?.priceMinor ?? "0");
  const [currencyCode, setCurrencyCode] = useState(initial?.currencyCode ?? "");
  const [entryCapPerMonth, setEntryCapPerMonth] = useState(
    initial?.entryCapPerMonth !== null && initial?.entryCapPerMonth !== undefined
      ? String(initial.entryCapPerMonth)
      : "",
  );
  const [voiceEnabled, setVoiceEnabled] = useState(initial?.voiceEnabled ?? false);
  const [staffCapCount, setStaffCapCount] = useState(
    initial?.staffCapCount !== null && initial?.staffCapCount !== undefined ? String(initial.staffCapCount) : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = initial !== null;

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch("/admin/plans", {
        method: "POST",
        body: {
          code,
          name,
          priceMinor,
          currencyCode,
          entryCapPerMonth: entryCapPerMonth.trim() === "" ? null : Number(entryCapPerMonth),
          voiceEnabled,
          staffCapCount: staffCapCount.trim() === "" ? null : Number(staffCapCount),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save plan.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="inline-form" style={{ flexWrap: "wrap", marginTop: "1rem" }}>
      <label>
        Code
        <input value={code} onChange={(e) => setCode(e.target.value)} disabled={isEdit} />
      </label>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Price (minor units)
        <input value={priceMinor} onChange={(e) => setPriceMinor(e.target.value)} placeholder="e.g. 250000" />
      </label>
      <label>
        Currency code
        <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} placeholder="e.g. NGN" />
      </label>
      <label>
        Entry cap / month (blank = uncapped)
        <input value={entryCapPerMonth} onChange={(e) => setEntryCapPerMonth(e.target.value)} />
      </label>
      <label>
        Voice enabled
        <input type="checkbox" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} />
      </label>
      <label>
        Staff cap (blank = uncapped)
        <input value={staffCapCount} onChange={(e) => setStaffCapCount(e.target.value)} />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button type="button" disabled={submitting || !code || !name || !currencyCode} onClick={handleSubmit}>
        {submitting ? "Saving…" : isEdit ? "Save changes" : "Create plan"}
      </button>
      <button type="button" onClick={onCancel} disabled={submitting}>
        Cancel
      </button>
    </div>
  );
}
