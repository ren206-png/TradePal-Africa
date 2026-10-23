// Thin fetch wrapper for the /admin/* JSON API (src/admin/adminRoutes.ts).
// Deliberately dumb: no retries, no caching — this is an internal admin tool,
// not a customer-facing app, so simplicity beats cleverness here.

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

const TOKEN_STORAGE_KEY = "tradepal_admin_token";

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable reason from the server (e.g. STEP_UP_REQUIRED), when it sent one. */
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * Registered by AuthContext so apiFetch can notify it when the server has
 * rejected the stored token. A simple settable callback (rather than an
 * event bus) since there is only ever one auth consumer in this app.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * Expansion Phase 1: step-up and support access. When the server answers 403 STEP_UP_REQUIRED or
 * SUPPORT_ACCESS_REQUIRED, apiFetch asks the registered prompts (a modal, see GuardPrompts) to collect the
 * password / reason, then retries the request once. With the server flags off (default) none of this triggers.
 */
export interface GuardHandlers {
  /** Prompt for the password; must call confirmStepUp() on success and resolve true, or resolve false if cancelled. */
  requestStepUp: () => Promise<boolean>;
  /** Prompt for a reason and open the support-access session for `businessId`; resolve false if cancelled. */
  requestSupportAccess: (businessId: string) => Promise<boolean>;
}

let guardHandlers: GuardHandlers | null = null;
export function setGuardHandlers(handlers: GuardHandlers | null): void {
  guardHandlers = handlers;
}

let stepUp: { token: string; expiresAt: number } | null = null;
export function storeStepUpToken(token: string, expiresInSeconds: number): void {
  // Drop it a few seconds early so a request never races the server-side expiry.
  stepUp = { token, expiresAt: Date.now() + Math.max(0, expiresInSeconds - 10) * 1000 };
}
export function clearStepUpToken(): void {
  stepUp = null;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Set false for the login call, which has no token yet. */
  authenticated?: boolean;
  /** "text" for non-JSON bodies (CSV export). Error responses are still parsed as JSON. */
  responseType?: "json" | "text";
}

/**
 * Every admin route (except POST /login) requires `Authorization: Bearer
 * <jwt>` — see requireAdminAuth on the backend. A 401 here always means the
 * stored token is missing/expired/revoked, so callers should treat it as
 * "log the admin out", not retry.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, authenticated = true, responseType = "json" } = options;

  const attempt = async (): Promise<{ response: Response; data: unknown }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated) {
      const token = getStoredToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      if (stepUp && stepUp.expiresAt > Date.now()) headers["x-admin-step-up"] = stepUp.token;
    }
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? await response.json() : responseType === "text" ? await response.text() : null;
    return { response, data };
  };

  const codeOf = (data: unknown): string | undefined =>
    data && typeof data === "object" && "code" in data && typeof (data as { code: unknown }).code === "string"
      ? (data as { code: string }).code
      : undefined;

  let { response, data } = await attempt();

  if (response.status === 403 && authenticated && guardHandlers) {
    const code = codeOf(data);
    let proceed = false;
    if (code === "STEP_UP_REQUIRED") {
      proceed = await guardHandlers.requestStepUp();
    } else if (code === "SUPPORT_ACCESS_REQUIRED") {
      const businessId = /^\/admin\/businesses\/([^/?]+)/.exec(path)?.[1];
      proceed = businessId ? await guardHandlers.requestSupportAccess(businessId) : false;
    }
    if (proceed) ({ response, data } = await attempt());
  }

  if (!response.ok) {
    const message = (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
      ? (data as { error: string }).error
      : `Request failed with status ${response.status}`);
    // A 401 on an authenticated request means the stored token is
    // missing/expired/revoked. Notify the registered handler (AuthContext)
    // so the app logs the admin out and redirects to /login globally,
    // instead of every page independently rendering an inline error.
    if (response.status === 401 && authenticated) {
      onUnauthorized?.();
    }
    throw new ApiError(message, response.status, codeOf(data));
  }

  return data as T;
}

export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}
