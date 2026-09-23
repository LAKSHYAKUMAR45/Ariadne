import { useEffect, useState } from 'react';
import { getJson } from '../api/client';

interface LogEntry {
  id: string;
  source: string;
  severity: string;
  message: string;
  createdAt: string;
}

interface LogsResponse {
  entries: LogEntry[];
}

export function LogsPage() {
  const [source, setSource] = useState<'operations' | 'backup'>('operations');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getJson<LogsResponse>(`/api/v1/admin/logs?source=${source}&limit=100`, controller.signal)
      .then((response) => setEntries(response.entries))
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load logs.');
        }
      });
    return () => controller.abort();
  }, [source]);

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
            <option value="operations">Operations</option>
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
          <article className="log-row" key={entry.id}>
            <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
            <span className={`severity severity--${entry.severity}`}>{entry.source}</span>
            <pre>{entry.message}</pre>
          </article>
        ))}
      </section>
    </div>
  );
}
