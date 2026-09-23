import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AdminApiError, createAdminApiClient, isAbortError } from '../api/client';
import { isAdminSession, isReauthenticationResponse } from '../api/guards';
import type { AdminApiClient, AdminSession, ReauthenticationResponse } from '../api/types';

interface AuthContextValue {
  ready: boolean;
  session: AdminSession | null;
  api: AdminApiClient;
  error: string | null;
  clearError: () => void;
  login: (username: string, password: string, signal?: AbortSignal) => Promise<void>;
  logout: (signal?: AbortSignal) => Promise<void>;
  reauthenticate: (password: string, signal?: AbortSignal) => Promise<ReauthenticationResponse>;
}

interface AuthProviderProps {
  children: ReactNode;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.toLowerCase().includes('application/json');
}

async function readJson(response: Response): Promise<unknown | null> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  if (!isJsonResponse(response)) {
    throw new AdminApiError(response.status, 'invalid_response', 'The server returned an invalid response.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminApiError(response.status, 'invalid_response', 'The server returned an invalid response.');
  }
}

function parseError(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return 'The request could not be completed.';
  }

  const payload = value as { error?: { message?: unknown }; message?: unknown };
  if (typeof payload.error?.message === 'string') {
    return payload.error.message;
  }
  if (typeof payload.message === 'string') {
    return payload.message;
  }
  return 'The request could not be completed.';
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expiredRef = useRef(false);

  const expireSession = useCallback(() => {
    if (expiredRef.current) {
      return;
    }
    expiredRef.current = true;
    setSession(null);
    setError('Session expired. Sign in again.');
  }, []);

  const api = useMemo(
    () =>
      createAdminApiClient({
        getCsrfToken: () => session?.csrfToken ?? null,
        onUnauthorized: expireSession,
      }),
    [expireSession, session?.csrfToken],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const applySession = useCallback((nextSession: AdminSession) => {
    expiredRef.current = false;
    setSession(nextSession);
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function restoreSession(): Promise<void> {
      try {
        const response = await fetch('/api/v1/admin/session', {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const payload = await readJson(response);
        if (response.status === 401) {
          expiredRef.current = false;
          setSession(null);
          return;
        }
        if (!response.ok) {
          throw new Error(parseError(payload));
        }
        if (!isAdminSession(payload)) {
          throw new AdminApiError(200, 'invalid_response', 'The server returned an invalid response.');
        }
        applySession(payload);
      } catch (restoreError: unknown) {
        if (!isAbortError(restoreError)) {
          setSession(null);
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : 'Unable to restore your administrator session.',
          );
        }
      } finally {
        setReady(true);
      }
    }

    void restoreSession();
    return () => controller.abort();
  }, [applySession]);

  const login = useCallback(
    async (username: string, password: string, signal?: AbortSignal): Promise<void> => {
      setError(null);
      const response = await fetch('/api/v1/admin/session', {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const message = parseError(payload);
        setError(message);
        throw new Error(message);
      }
      if (!isAdminSession(payload)) {
        const invalid = new AdminApiError(200, 'invalid_response', 'The server returned an invalid response.');
        setError(invalid.message);
        throw invalid;
      }
      applySession(payload);
    },
    [applySession],
  );

  const logout = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!session?.csrfToken) {
        expiredRef.current = false;
        setSession(null);
        return;
      }

      const response = await fetch('/api/v1/admin/session', {
        method: 'DELETE',
        credentials: 'same-origin',
        signal,
        headers: {
          'X-CSRF-Token': session.csrfToken,
        },
      });

      if (response.ok || response.status === 401) {
        expiredRef.current = false;
        setSession(null);
        setError(null);
      }
    },
    [session?.csrfToken],
  );

  const reauthenticate = useCallback(
    async (password: string, signal?: AbortSignal): Promise<ReauthenticationResponse> => {
      const response = await api.mutate(
        'POST',
        '/api/v1/admin/session/reauthenticate',
        { password },
        isReauthenticationResponse,
        signal,
      );

      setSession((current) =>
        current
          ? {
              ...current,
              reauthenticatedUntil: response.reauthenticatedUntil,
            }
          : current,
      );

      return response;
    },
    [api],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      session,
      api,
      error,
      clearError,
      login,
      logout,
      reauthenticate,
    }),
    [api, clearError, error, login, logout, ready, reauthenticate, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
