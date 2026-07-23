import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, clearStoredToken, getStoredToken, setUnauthorizedHandler, storeToken } from "../lib/apiClient";
import type { AdminUser } from "../lib/types";

const ADMIN_STORAGE_KEY = "tradepal_admin_user";

interface LoginResponse {
  token: string;
  admin: AdminUser;
}

interface AuthContextValue {
  admin: AdminUser | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredAdmin(): AdminUser | null {
  const raw = localStorage.getItem(ADMIN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminUser;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminUser | null>(() => (getStoredToken() ? readStoredAdmin() : null));

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<LoginResponse>("/admin/login", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
    storeToken(result.token);
    localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(result.admin));
    setAdmin(result.admin);
  }, []);

  // Shared by an explicit logout and an auto-logout triggered by a 401 —
  // both cases end with the same local state being wiped.
  const clearLocalSession = useCallback(() => {
    clearStoredToken();
    localStorage.removeItem(ADMIN_STORAGE_KEY);
    setAdmin(null);
  }, []);

  const logout = useCallback(() => {
    // Best-effort: tell the server to revoke the token so it can't be reused
    // (see POST /admin/logout), but don't block clearing local state on it —
    // an admin should always be able to log out client-side even if the
    // network call fails.
    void apiFetch("/admin/logout", { method: "POST" }).catch(() => {
      /* ignore - local logout still proceeds */
    });
    clearLocalSession();
  }, [clearLocalSession]);

  // Register a global 401 handler with apiClient: if the backend ever
  // rejects the stored token (expired, revoked, or otherwise invalid), log
  // the admin out immediately rather than letting every page independently
  // render an inline "Invalid or expired token" error. There is no server
  // call here — the token is already known-bad, so revoking it again would
  // be pointless.
  useEffect(() => {
    setUnauthorizedHandler(clearLocalSession);
    return () => setUnauthorizedHandler(null);
  }, [clearLocalSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ admin, isAuthenticated: admin !== null, login, logout }),
    [admin, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
