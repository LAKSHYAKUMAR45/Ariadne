import { useEffect, useState } from 'react';
import { getJson } from '../api/client';

interface Overview {
  generatedAt: string;
  database: { healthy: boolean; latencyMs: number };
  tasks: { total: number; active: number; updatedLast24h: number };
  backup: { latestAt: string | null; latestVerifiedAt: string | null; status: string };
  operations: { running: number; failedLast24h: number };
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'No backup recorded';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function OverviewPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getJson<Overview>('/api/v1/admin/overview', controller.signal)
      .then(setOverview)
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load system status.');
        }
      });
    return () => controller.abort();
  }, [refreshKey]);

  const healthy = overview?.database.healthy === true && overview.operations.failedLast24h === 0;

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Live system</p>
          <h1>System overview</h1>
          <p>What needs attention across the Ariadne cloud right now.</p>
        </div>
        <button className="quiet-action" type="button" onClick={() => setRefreshKey((key) => key + 1)}>
          Refresh status
        </button>
      </header>

      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}

      <section className="priority-strip" aria-label="System summary">
        <div>
          <span className={`status-dot ${healthy ? 'status-dot--good' : 'status-dot--warning'}`} />
          Platform <strong>{overview ? (healthy ? 'Operational' : 'Attention needed') : 'Checking...'}</strong>
        </div>
        <div>Database <strong>{overview ? `${overview.database.latencyMs} ms` : 'Checking...'}</strong></div>
        <div>Latest backup <strong>{overview ? formatTimestamp(overview.backup.latestAt) : 'Checking...'}</strong></div>
      </section>

      <div className="overview-grid">
        <section className="panel panel--span">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Attention queue</p>
              <h2>Operational status</h2>
            </div>
            <span className={`status-pill ${healthy ? 'status-pill--good' : 'status-pill--neutral'}`}>
              {overview ? (healthy ? 'Operational' : 'Review') : 'Connecting'}
            </span>
          </div>
          {overview ? (
            <div className="status-list">
              <div>
                <span className={`status-dot ${overview.database.healthy ? 'status-dot--good' : 'status-dot--bad'}`} />
                <div><strong>PostgreSQL</strong><span>{overview.database.healthy ? 'Connection healthy' : 'Unavailable'}</span></div>
                <small>{overview.database.latencyMs} ms</small>
              </div>
              <div>
                <span className={`status-dot ${overview.backup.status === 'verified' ? 'status-dot--good' : 'status-dot--warning'}`} />
                <div><strong>Backup protection</strong><span>{formatTimestamp(overview.backup.latestVerifiedAt)}</span></div>
                <small>{overview.backup.status === 'verified' ? 'Verified' : overview.backup.status}</small>
              </div>
              <div>
                <span className={`status-dot ${overview.operations.failedLast24h ? 'status-dot--bad' : 'status-dot--good'}`} />
                <div><strong>Admin operations</strong><span>{overview.operations.failedLast24h} failures in the last 24 hours</span></div>
                <small>{overview.operations.running} running</small>
              </div>
            </div>
          ) : (
            <div className="empty-inline">
              <span className="activity-pulse" aria-hidden="true" />
              <div>
                <strong>Loading live status from nodem2</strong>
                <p>Database, backup freshness, and recent operations will appear here.</p>
              </div>
            </div>
          )}
        </section>

        <section className="panel metric-panel">
          <p className="eyebrow">Workspace</p>
          <strong className="metric-value">{overview?.tasks.total ?? '—'}</strong>
          <span>{overview ? `${overview.tasks.active} active · ${overview.tasks.updatedLast24h} updated today` : 'tracked tasks'}</span>
        </section>
        <section className="panel metric-panel">
          <p className="eyebrow">Operations</p>
          <strong className="metric-value">{overview?.operations.running ?? '—'}</strong>
          <span>{overview ? `${overview.operations.running} running` : 'running now'}</span>
        </section>
      </div>
    </div>
  );
}
