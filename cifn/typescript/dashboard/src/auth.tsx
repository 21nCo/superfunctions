import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const STORAGE_KEY = 'cifn_dashboard_token';

/** Env token (Vite: VITE_CIFN_API_KEY); only used to seed initial state if no stored token. */
function getEnvToken(): string | null {
  try {
    const v = import.meta.env?.VITE_CIFN_API_KEY;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

type GetToken = () => string | null;

interface AuthContextValue {
  getToken: GetToken;
  token: string | null;
  setToken: (t: string | null) => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getStoredToken() || getEnvToken());
  const setToken = useCallback((t: string | null) => {
    setTokenState(t);
    setStoredToken(t);
  }, []);
  const getToken = useCallback<GetToken>(() => token ?? getStoredToken(), [token]);
  const isAuthenticated = !!token || !!getStoredToken();
  const value = useMemo(
    () => ({ getToken, token: token ?? getStoredToken(), setToken, isAuthenticated }),
    [getToken, token, setToken, isAuthenticated]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
