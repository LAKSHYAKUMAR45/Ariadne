import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '../api/client';
import { isAuditResponse } from '../api/guards';
import type { AuditEvent } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { AsyncState } from '../components/AsyncState';
import { OperationProgress } from '../components/OperationProgress';
import { shortenSha } from './helpers';

function buildAuditPath(action: string, outcome: string, cursor?: string): string {
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (action.trim()) {
    params.set('action', action.trim());
  }
  if (outcome.trim()) {
    params.set('outcome', outcome.trim());
  }
  if (cursor) {
    params.set('cursor', cursor);
  }
  return `/api/v1/admin/audit?${params.toString()}`;
}

function targetSummary(event: AuditEvent): string {
  const metadata = event.metadata as Record<string, unknown>;
  if (typeof metadata.revision === 'string') {
    return `revision ${shortenSha(metadata.revision)}`;
  }
  if (typeof metadata.username === 'string') {
    return metadata.username;
  }
  if (typeof metadata.backupName === 'string') {
    return metadata.backupName;
  }
  if (typeof metadata.service === 'string') {
    return metadata.service;
  }
  if (typeof metadata.captureId === 'string') {
    return metadata.captureId;
  }
  return '—';
}

export function AuditPage() {
  const { api } = useAuth();
  const [draftAction, setDraftAction] = useState('');
  const [draftOutcome, setDraftOutcome] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const loadAudit = useCallback(async (cursor?: string): Promise<void> => {
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
        buildAuditPath(actionFilter, outcomeFilter, cursor),
        isAuditResponse,
        controller.signal,
      );
      if (controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      setEvents((current) => (cursor ? [...current, ...response.events] : response.events));
      setNextCursor(response.nextCursor);
      setError(null);
    } catch (loadAuditError: unknown) {
      if (isAbortError(loadAuditError)) {
        return;
      }
      setError(loadAuditError instanceof Error ? loadAuditError.message : 'Unable to load audit history.');
      if (!cursor) {
        setEvents([]);
        setNextCursor(null);
      }
    } finally {
      if (cursor) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, [actionFilter, api, outcomeFilter]);

  useEffect(() => {
    void loadAudit();
    return () => controllerRef.current?.abort();
  }, [loadAudit]);

  useEffect(() => {
    if (!selectedOperationId) {
      return;
    }

    const nextHash = `#operation-${selectedOperationId}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash);
    }
  }, [selectedOperationId]);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Forensics</p>
          <h1>Audit</h1>
          <p>Immutable administrator activity with bounded filters and operation references.</p>
        </div>
      </header>
      <section className="operations-filter-bar" role="group" aria-label="Audit filters">
        <label className="source-select">
          <span>Action</span>
          <input aria-label="Action" value={draftAction} onChange={(event) => setDraftAction(event.target.value)} />
        </label>
        <label className="source-select">
          <span>Outcome</span>
          <input aria-label="Outcome" value={draftOutcome} onChange={(event) => setDraftOutcome(event.target.value)} />
        </label>
        <button
          className="quiet-action row-action"
          type="button"
          onClick={() => {
            setActionFilter(draftAction);
            setOutcomeFilter(draftOutcome);
          }}
        >
          Apply filters
        </button>
      </section>
      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
      {selectedOperationId ? (
        <OperationProgress
          api={api}
          operationId={selectedOperationId}
          autoFocus
        />
      ) : null}
      <section className="panel data-panel">
        <div className="table-heading">
          <strong>Audit history</strong>
          <span>{events.length} loaded</span>
        </div>
        <AsyncState
          loading={loading}
          empty={events.length === 0}
          error={error}
          loadingLabel="Loading audit events"
          emptyTitle="No audit events"
          emptyMessage="Administrator activity will appear here as immutable structured records."
        >
          <div className="audit-list">
            {events.map((event) => {
              const metadata = event.metadata as Record<string, unknown>;
              const operationId = typeof metadata.operationId === 'string' ? metadata.operationId : null;

              return (
                <article className="audit-row" key={event.id}>
                  <div className="audit-row__time">
                    <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
                  </div>
                  <div className="audit-row__main">
                    <strong>{event.action}</strong>
                    <span>{event.actorUserId ?? 'system'}</span>
                    <span>{targetSummary(event)}</span>
                  </div>
                  <span>{event.outcome}</span>
                  {operationId ? (
                    <a
                      href={`#operation-${operationId}`}
                      onClick={(clickEvent) => {
                        clickEvent.preventDefault();
                        setSelectedOperationId(operationId);
                      }}
                    >
                      {`Operation ${operationId}`}
                    </a>
                  ) : (
                    <span className="member-static">No operation</span>
                  )}
                </article>
              );
            })}
          </div>
        </AsyncState>
      </section>
      {nextCursor ? (
        <button
          className="quiet-action row-action load-more-action"
          type="button"
          disabled={loadingMore}
          onClick={() => void loadAudit(nextCursor)}
        >
          {loadingMore ? 'Loading…' : 'Load older events'}
        </button>
      ) : null}
    </div>
  );
}
