import { useEffect, useState } from 'react';
import { isAbortError } from '../api/client';
import { isLogsResponse } from '../api/guards';
import { useAuth } from '../auth/AuthProvider';

export function LogsPage() {
  const { api } = useAuth();
  const [source, setSource] = useState<'sync-server' | 'backup'>('sync-server');
  const [entries, setEntries] = useState<import('../api/types').LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get(`/api/v1/admin/logs?source=${source}&limit=100`, isLogsResponse, controller.signal)
      .then((response) => setEntries(response.entries))
      .catch((loadError: unknown) => {
        if (!isAbortError(loadError)) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load logs.');
        }
      });
    return () => controller.abort();
  }, [api, source]);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Evidence</p>
          <h1>Recent logs</h1>
          <p>Bounded, redacted records from Ariadne operations.</p>
        </div>
        <label className="source-select">
          <span>Source</span>
          <select value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
            <option value="sync-server">Operations</option>
            <option value="backup">Backups</option>
          </select>
        </label>
      </header>
      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
      <section className="panel log-panel">
        <div className="log-header">
          <span>Time</span><span>Source</span><span>Message</span>
        </div>
        {entries.length === 0 && !error ? <p className="pane-message">No recent records.</p> : null}
        {entries.map((entry) => (
          <article className="log-row" key={entry.sequence}>
            <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>
            <span className={`severity severity--${entry.severity}`}>
              {source === 'sync-server' ? 'operations' : source}
            </span>
            <pre>{entry.message}</pre>
          </article>
        ))}
      </section>
    </div>
  );
}
