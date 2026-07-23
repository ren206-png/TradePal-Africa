import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch, ApiError } from "../lib/apiClient";
import type { FeatureFlag } from "../lib/types";

/** Only SUPER_ADMIN may call POST /admin/feature-flags/:key (see requireAdminRole in adminRoutes.ts) —
 * flipping a flag's global default is a bulk rollout affecting every business that has never set its
 * own per-business override, a materially bigger blast radius than a single-business override. */
const GLOBAL_ROLLOUT_WRITE_ROLES = new Set(["SUPER_ADMIN"]);

export function FeatureFlagsPage() {
  const { admin } = useAuth();
  const canWrite = admin ? GLOBAL_ROLLOUT_WRITE_ROLES.has(admin.role) : false;

  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    apiFetch<{ featureFlags: FeatureFlag[] }>("/admin/feature-flags")
      .then((result) => setFlags(result.featureFlags))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load feature flags."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="page">
      <h1>Feature flags</h1>
      <p>
        Each flag defaults to off. Flipping "Enabled by default" here rolls the feature out (or back)
        globally — any business that has never set its own override for a flag picks up this change
        immediately, while a business with its own override keeps its choice regardless. Per-business
        overrides are managed from that business's detail page.
      </p>
      {error ? <p className="form-error">{error}</p> : null}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Description</th>
              <th>Enabled by default</th>
              {canWrite ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {flags.map((flag) => (
              <FeatureFlagRow key={flag.key} flag={flag} canWrite={canWrite} onChanged={load} />
            ))}
            {flags.length === 0 ? (
              <tr>
                <td colSpan={canWrite ? 4 : 3}>No feature flags defined yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FeatureFlagRow({
  flag,
  canWrite,
  onChanged,
}: {
  flag: FeatureFlag;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    const action = flag.enabledByDefault ? "roll back (disable by default)" : "roll out (enable by default)";
    const impact = flag.enabledByDefault
      ? "Any business that has never set its own override for this flag will immediately lose access to it."
      : "Any business that has never set its own override for this flag will immediately gain access to it.";
    const confirmed = window.confirm(
      `Are you sure you want to ${action} "${flag.key}" globally?\n\n${impact} ` +
        "Businesses with their own override are unaffected.",
    );
    if (!confirmed) return;

    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/admin/feature-flags/${flag.key}`, {
        method: "POST",
        body: { enabledByDefault: !flag.enabledByDefault },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update the flag.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <tr>
      <td>{flag.key}</td>
      <td>{flag.description}</td>
      <td>{flag.enabledByDefault ? "Yes" : "No"}</td>
      {canWrite ? (
        <td>
          <button type="button" onClick={handleToggle} disabled={submitting}>
            {submitting ? "Saving…" : flag.enabledByDefault ? "Roll back (disable by default)" : "Roll out (enable by default)"}
          </button>
          {error ? <p className="form-error">{error}</p> : null}
        </td>
      ) : null}
    </tr>
  );
}
