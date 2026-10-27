import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, clearStoredToken, getStoredToken, setMfaRequiredHandler, setUnauthorizedHandler, storeToken } from "../lib/apiClient";
import type { AdminUser, MfaMethods, MfaState } from "../lib/types";

const ADMIN_STORAGE_KEY = "tradepal_admin_user";
const MFA_STORAGE_KEY = "tradepal_admin_mfa";
const MFA_METHODS_STORAGE_KEY = "tradepal_admin_mfa_methods";

interface LoginResponse {
  token: string;
  admin: AdminUser;
  /** Absent from an older server: treated as "no second factor". */
  mfa?: { state: MfaState; methods?: MfaMethods };
}

interface AuthContextValue {
  admin: AdminUser | null;
  isAuthenticated: boolean;
  /** Resolves with where the sign-in stands, so the caller can go to the authenticator screen when one is needed. */
  login: (email: string, password: string) => Promise<MfaState>;
  logout: () => void;
  /** NOT_REQUIRED / VERIFIED means fully signed in; the other two mean the authenticator step is still to do. */
  mfaState: MfaState;
  mfaPending: boolean;
  /** The second-factor options reported at sign-in (null when the server did not say: treat as an authenticator app only). */
  mfaMethods: MfaMethods | null;
  /** Called by the authenticator screen once the second factor has been passed. */
  completeMfa: () => void;
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

function readStoredMfa(): MfaState {
  const raw = localStorage.getItem(MFA_STORAGE_KEY);
  return raw === "ENROLMENT_REQUIRED" || raw === "CHALLENGE_REQUIRED" || raw === "VERIFIED" ? raw : "NOT_REQUIRED";
}

function readStoredMethods(): MfaMethods | null {
  const raw = localStorage.getItem(MFA_METHODS_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MfaMethods;
    return parsed && typeof parsed.totp === "boolean" && parsed.whatsapp ? parsed : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminUser | null>(() => (getStoredToken() ? readStoredAdmin() : null));
  const [mfaState, setMfaState] = useState<MfaState>(() => (getStoredToken() ? readStoredMfa() : "NOT_REQUIRED"));

  const [mfaMethods, setMfaMethods] = useState<MfaMethods | null>(() => (getStoredToken() ? readStoredMethods() : null));

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<LoginResponse>("/admin/login", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
    const state = result.mfa?.state ?? "NOT_REQUIRED";
    storeToken(result.token);
    localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(result.admin));
    localStorage.setItem(MFA_STORAGE_KEY, state);
    const methods = result.mfa?.methods ?? null;
    if (methods) localStorage.setItem(MFA_METHODS_STORAGE_KEY, JSON.stringify(methods));
    else localStorage.removeItem(MFA_METHODS_STORAGE_KEY);
    setMfaMethods(methods);
    setMfaState(state);
    setAdmin(result.admin);
    return state;
  }, []);

  const completeMfa = useCallback(() => {
    localStorage.setItem(MFA_STORAGE_KEY, "VERIFIED");
    setMfaState("VERIFIED");
  }, []);

  // Shared by an explicit logout and an auto-logout triggered by a 401 —
  // both cases end with the same local state being wiped.
  const clearLocalSession = useCallback(() => {
    clearStoredToken();
    localStorage.removeItem(ADMIN_STORAGE_KEY);
    localStorage.removeItem(MFA_STORAGE_KEY);
    localStorage.removeItem(MFA_METHODS_STORAGE_KEY);
    setMfaMethods(null);
    setMfaState("NOT_REQUIRED");
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

  // The server tells us when a sign-in still owes its second factor (403 MFA_*): move to the authenticator screen.
  useEffect(() => {
    setMfaRequiredHandler((state) => {
      localStorage.setItem(MFA_STORAGE_KEY, state);
      setMfaState(state);
    });
    return () => setMfaRequiredHandler(null);
  }, []);

  const mfaPending = mfaState === "ENROLMENT_REQUIRED" || mfaState === "CHALLENGE_REQUIRED";
  const value = useMemo<AuthContextValue>(
    () => ({ admin, isAuthenticated: admin !== null, login, logout, mfaState, mfaPending, mfaMethods, completeMfa }),
    [admin, login, logout, mfaState, mfaPending, mfaMethods, completeMfa],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
