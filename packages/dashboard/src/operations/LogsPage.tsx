import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError } from '../api/client';
import { isLogsResponse } from '../api/guards';
import type { LogEntry, LogSeverity } from '../api/types';
import { useAuth } from '../auth/AuthProvider';

const POLL_INTERVAL_MS = 30_000;

type LogSource = 'sync-server' | 'operator' | 'deployment' | 'backup';
type TimeWindow = '24h' | '7d' | 'all';

function buildSince(value: TimeWindow): string | undefined {
  if (value === 'all') {
    return undefined;
  }

  const offsetMs = value === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - offsetMs).toISOString();
}

function buildLogsPath(
  source: LogSource,
  severity: LogSeverity | '',
  timeWindow: TimeWindow,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  params.set('source', source);
  params.set('limit', '50');
  if (severity) {
    params.set('severity', severity);
  }
  const since = buildSince(timeWindow);
  if (since) {
    params.set('since', since);
  }
  if (cursor) {
    params.set('cursor', cursor);
  }
  return `/api/v1/admin/logs?${params.toString()}`;
}

export function LogsPage() {
  const { api } = useAuth();
  const [source, setSource] = useState<LogSource>('sync-server');
  const [severity, setSeverity] = useState<LogSeverity | ''>('');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');
  const [textFilter, setTextFilter] = useState('');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const loadLogs = useCallback(async (cursor?: string): Promise<void> => {
    if (!cursor) {
      controllerRef.current?.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;

    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await api.get(
        buildLogsPath(source, severity, timeWindow, cursor),
        isLogsResponse,
        controller.signal,
      );
      if (controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      setEntries((current) => {
        if (!cursor) {
          return response.entries;
        }
        const bySequence = new Map<number, LogEntry>();
        for (const entry of [...current, ...response.entries]) {
          bySequence.set(entry.sequence, entry);
        }
        return [...bySequence.values()].sort((left, right) => right.sequence - left.sequence);
      });
      setNextCursor(response.nextCursor);
      setError(null);
    } catch (loadLogsError: unknown) {
      if (isAbortError(loadLogsError)) {
        return;
      }
      setError(loadLogsError instanceof Error ? loadLogsError.message : 'Unable to load logs.');
      if (!cursor) {
        setEntries([]);
        setNextCursor(null);
      }
    } finally {
      if (cursor) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, [api, severity, source, timeWindow]);

  useEffect(() => {
    void loadLogs();
    return () => controllerRef.current?.abort();
  }, [loadLogs]);

  useEffect(() => {
    if (paused) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void loadLogs();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadLogs, paused]);

  const visibleEntries = useMemo(() => {
    if (!textFilter.trim()) {
      return entries;
    }
    const lowered = textFilter.trim().toLowerCase();
    return entries.filter((entry) => entry.message.toLowerCase().includes(lowered));
  }, [entries, textFilter]);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Evidence</p>
          <h1>Recent logs</h1>
          <p>Bounded, redacted records from Ariadne operations.</p>
        </div>
      </header>
      <section className="operations-filter-bar" role="group" aria-label="Log filters">
        <label className="source-select">
          <span>Source</span>
          <select aria-label="Source" value={source} onChange={(event) => setSource(event.target.value as LogSource)}>
            <option value="sync-server">sync-server</option>
            <option value="operator">operator</option>
            <option value="deployment">deployment</option>
            <option value="backup">backup</option>
          </select>
        </label>
        <label className="source-select">
          <span>Severity</span>
          <select aria-label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value as LogSeverity | '')}>
            <option value="">all</option>
            <option value="error">error</option>
            <option value="warning">warning</option>
            <option value="info">info</option>
          </select>
        </label>
        <label className="source-select">
          <span>Time window</span>
          <select aria-label="Time window" value={timeWindow} onChange={(event) => setTimeWindow(event.target.value as TimeWindow)}>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
            <option value="all">all</option>
          </select>
        </label>
        <label className="source-select source-select--wide">
          <span>Filter loaded lines</span>
          <input
            aria-label="Filter loaded lines"
            type="search"
            value={textFilter}
            onChange={(event) => setTextFilter(event.target.value)}
          />
        </label>
        <button
          className="quiet-action row-action"
          type="button"
          onClick={() => {
            const nextPaused = !paused;
            setPaused(nextPaused);
            if (!nextPaused) {
              void loadLogs();
            }
          }}
        >
          {paused ? 'Resume live refresh' : 'Pause live refresh'}
        </button>
      </section>
      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
      <section className="panel log-panel">
        <div className="log-header">
          <span>Time</span><span>Severity</span><span>Message</span>
        </div>
        {loading && entries.length === 0 ? <p className="pane-message">Loading logs…</p> : null}
        {visibleEntries.length === 0 && !loading && !error ? <p className="pane-message">No recent records.</p> : null}
        {visibleEntries.map((entry) => (
          <article className="log-row" key={entry.sequence}>
            <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>
            <span className={`severity severity--${entry.severity}`}>{entry.severity}</span>
            <div className="log-message-stack">
              <pre>{entry.message}</pre>
              {entry.redacted ? <span className="status-pill status-pill--warning">Redacted</span> : null}
            </div>
          </article>
        ))}
      </section>
      {nextCursor ? (
        <button
          className="quiet-action row-action load-more-action"
          type="button"
          disabled={loadingMore}
          onClick={() => void loadLogs(nextCursor)}
        >
          {loadingMore ? 'Loading…' : 'Load older lines'}
        </button>
      ) : null}
    </div>
  );
}
