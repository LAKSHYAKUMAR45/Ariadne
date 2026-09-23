import { FormEvent, useEffect, useState } from 'react';
import { BackupsPage } from './operations/BackupsPage';
import { LogsPage } from './operations/LogsPage';
import { OverviewPage } from './operations/OverviewPage';
import { ServicesPage } from './operations/ServicesPage';
import { TasksPage } from './tasks/TasksPage';

type Section = 'overview' | 'tasks' | 'backups' | 'services' | 'logs';

interface AdminSession {
  userId: string;
  username: string;
  reauthenticatedUntil: string | null;
  csrfToken?: string;
}

const sections: ReadonlyArray<{ id: Section; label: string; glyph: string }> = [
  { id: 'overview', label: 'Overview', glyph: 'OV' },
  { id: 'tasks', label: 'Tasks', glyph: 'TK' },
  { id: 'backups', label: 'Backups', glyph: 'BK' },
  { id: 'services', label: 'Services', glyph: 'SV' },
  { id: 'logs', label: 'Logs', glyph: 'LG' },
];

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('application/json') ? response.json() : null;
}

function isSession(value: unknown): value is AdminSession {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.userId === 'string' && typeof candidate.username === 'string';
}

function LoginPage({ onAuthenticated }: { onAuthenticated: (session: AdminSession) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch('/api/v1/admin/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: String(form.get('username') ?? ''),
          password: String(form.get('password') ?? ''),
        }),
      });
      const body = await readJson(response);
      if (!response.ok || !isSession(body)) {
        throw new Error('The username or password was not accepted.');
      }
      onAuthenticated(body);
    } catch (loginError: unknown) {
      setError(loginError instanceof Error ? loginError.message : 'Unable to reach Ariadne.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-story" aria-labelledby="login-title">
        <div className="brand-lockup brand-lockup--large">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>ARIADNE</span>
        </div>
        <p className="eyebrow">Operations console</p>
        <h1 id="login-title">Command your Ariadne cloud</h1>
        <p className="login-copy">
          Inspect synced work, captured files, backups, and the health of nodem2 from one focused
          control surface.
        </p>
        <div className="login-signal" aria-label="Connection details">
          <span className="signal-dot" aria-hidden="true" />
          <span>Private tunnel</span>
          <strong>127.0.0.1:14300</strong>
        </div>
      </section>

      <section className="login-panel" aria-label="Administrator login">
        <p className="eyebrow">Restricted access</p>
        <h2>Sign in as administrator</h2>
        <p className="muted">Use the credentials registered for this Ariadne server.</p>
        <form onSubmit={submit}>
          <label htmlFor="username">Username</label>
          <input id="username" name="username" autoComplete="username" required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? 'Signing in...' : 'Open console'}
          </button>
        </form>
        <p className="login-footnote">Available only through the configured SSH tunnel.</p>
      </section>
    </main>
  );
}

function ConsoleShell({
  session,
  onLogout,
}: {
  session: AdminSession;
  onLogout: () => Promise<void>;
}) {
  const [section, setSection] = useState<Section>('overview');

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>ARIADNE</span>
        </div>
        <div className="environment">
          <span className="status-dot status-dot--good" aria-hidden="true" />
          <div>
            <strong>nodem2 / production</strong>
            <span>Private cloud</span>
          </div>
        </div>
        <nav aria-label="Primary">
          {sections.map((item) => (
            <button
              className={item.id === section ? 'nav-item nav-item--active' : 'nav-item'}
              key={item.id}
              type="button"
              aria-current={item.id === section ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="avatar" aria-hidden="true">{session.username.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{session.username}</strong>
            <span>Administrator</span>
          </div>
          <button className="logout-action" type="button" onClick={() => void onLogout()}>
            Sign out
          </button>
        </div>
      </aside>
      <main id="main-content" className="main-content">
        {section === 'overview' ? <OverviewPage /> : null}
        {section === 'tasks' ? <TasksPage /> : null}
        {section === 'backups' ? <BackupsPage csrfToken={session.csrfToken} /> : null}
        {section === 'services' ? <ServicesPage csrfToken={session.csrfToken} /> : null}
        {section === 'logs' ? <LogsPage /> : null}
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function restoreSession(): Promise<void> {
      try {
        const response = await fetch('/api/v1/admin/session', {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const body = await readJson(response);
        if (response.ok && isSession(body)) {
          setSession(body);
        }
      } catch (error: unknown) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setSession(null);
        }
      } finally {
        setCheckingSession(false);
      }
    }

    void restoreSession();
    return () => controller.abort();
  }, []);

  async function logout(): Promise<void> {
    if (!session?.csrfToken) {
      setSession(null);
      return;
    }
    const response = await fetch('/api/v1/admin/session', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        'X-CSRF-Token': session.csrfToken,
      },
    });
    if (response.ok || response.status === 401) {
      setSession(null);
    }
  }

  if (checkingSession) {
    return (
      <main className="boot-screen">
        <div className="brand-lockup brand-lockup--large">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>ARIADNE</span>
        </div>
        <p>Opening operations console...</p>
      </main>
    );
  }

  return session ? (
    <ConsoleShell session={session} onLogout={logout} />
  ) : (
    <LoginPage onAuthenticated={setSession} />
  );
}
