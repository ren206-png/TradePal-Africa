// Thin fetch wrapper for the /admin/* JSON API (src/admin/adminRoutes.ts).
// Deliberately dumb: no retries, no caching — this is an internal admin tool,
// not a customer-facing app, so simplicity beats cleverness here.

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

const TOKEN_STORAGE_KEY = "tradepal_admin_token";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Set false for the login call, which has no token yet. */
  authenticated?: boolean;
}

/**
 * Every admin route (except POST /login) requires `Authorization: Bearer
 * <jwt>` — see requireAdminAuth on the backend. A 401 here always means the
 * stored token is missing/expired/revoked, so callers should treat it as
 * "log the admin out", not retry.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, authenticated = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authenticated) {
    const token = getStoredToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : null;

  if (!response.ok) {
    const message = (data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : `Request failed with status ${response.status}`);
    // A 401 on an authenticated request means the stored token is
    // missing/expired/revoked. Notify the registered handler (AuthContext)
    // so the app logs the admin out and redirects to /login globally,
    // instead of every page independently rendering an inline error.
    if (response.status === 401 && authenticated) {
      onUnauthorized?.();
    }
    throw new ApiError(message, response.status);
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
