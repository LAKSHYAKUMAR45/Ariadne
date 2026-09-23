import { useCallback, useRef, useState, type MouseEvent } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { LoginPage } from './auth/LoginPage';
import { MembersPage } from './members/MembersPage';
import { AuditPage } from './operations/AuditPage';
import { BackupsPage } from './operations/BackupsPage';
import { DeploymentsPage } from './operations/DeploymentsPage';
import { LogsPage } from './operations/LogsPage';
import { OverviewPage } from './overview/OverviewPage';
import { ServicesPage } from './operations/ServicesPage';
import { TasksPage } from './tasks/TasksPage';

type Section =
  | 'overview'
  | 'members'
  | 'tasks'
  | 'backups'
  | 'services'
  | 'deployments'
  | 'logs'
  | 'audit';

const sections: ReadonlyArray<{ id: Section; label: string; glyph: string }> = [
  { id: 'overview', label: 'Overview', glyph: 'OV' },
  { id: 'members', label: 'Members', glyph: 'MB' },
  { id: 'tasks', label: 'Tasks', glyph: 'TK' },
  { id: 'backups', label: 'Backups', glyph: 'BK' },
  { id: 'services', label: 'Services', glyph: 'SV' },
  { id: 'deployments', label: 'Deployments', glyph: 'DP' },
  { id: 'logs', label: 'Logs', glyph: 'LG' },
  { id: 'audit', label: 'Audit', glyph: 'AT' },
];

function ConsoleShell() {
  const { error, logout, session } = useAuth();
  const [section, setSection] = useState<Section>('overview');
  const mainRef = useRef<HTMLElement | null>(null);

  if (!session) {
    return null;
  }

  const activeSection = sections.find((item) => item.id === section);

  const skipToContent = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.history.replaceState(null, '', '#main-content');
    mainRef.current?.focus();
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={skipToContent}>Skip to content</a>
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
              id={`nav-${item.id}`}
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
          <button className="logout-action" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <main
        ref={mainRef}
        id="main-content"
        className="main-content"
        tabIndex={-1}
        aria-label={`${activeSection?.label ?? 'Operations console'} section`}
      >
        {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
        {section === 'overview' ? <OverviewPage /> : null}
        {section === 'members' ? <MembersPage /> : null}
        {section === 'tasks' ? <TasksPage /> : null}
        {section === 'backups' ? <BackupsPage /> : null}
        {section === 'services' ? <ServicesPage /> : null}
        {section === 'deployments' ? <DeploymentsPage /> : null}
        {section === 'logs' ? <LogsPage /> : null}
        {section === 'audit' ? <AuditPage /> : null}
      </main>
    </div>
  );
}

function AuthenticatedApp() {
  const { ready, session } = useAuth();

  if (!ready) {
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

  return session ? <ConsoleShell /> : <LoginPage />;
}

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
