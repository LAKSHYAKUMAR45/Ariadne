import { useEffect } from 'react';
import { useOperation } from '../hooks/useOperation';
import type { AdminApiClient, AdminOperation } from '../api/types';
import { StatusLabel } from './StatusLabel';

interface OperationProgressProps {
  api: AdminApiClient;
  operationId: string | null;
  initialOperation?: AdminOperation | null;
  onOperationChange?: (operation: AdminOperation | null) => void;
}

export function OperationProgress({
  api,
  operationId,
  initialOperation = null,
  onOperationChange,
}: OperationProgressProps) {
  const { operation, events, latestEvent, live, polling, error } = useOperation({
    api,
    operationId,
    initialOperation,
  });

  useEffect(() => {
    onOperationChange?.(operation);
  }, [onOperationChange, operation]);

  if (!operationId) {
    return null;
  }

  const summary = operation?.summary ?? 'Admin operation';
  const status = operation?.state ?? 'queued';
  const helper = live
    ? 'Live operator events connected.'
    : polling
      ? 'Live updates disconnected; polling persisted status.'
      : 'Waiting for the persisted operation state.';

  return (
    <section
      id={`operation-${operationId}`}
      className="panel data-panel"
      aria-label="Operation progress"
    >
      <div className="table-heading">
        <strong>{summary}</strong>
        <StatusLabel status={status} />
      </div>
      <p className="muted">{helper}</p>
      {events.length > 0 ? (
        <ol className="operation-event-list" aria-label="Operation events">
          {events.map((event) => (
            <li className="operation-event-row" key={event.id}>
              <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      ) : latestEvent ? <p>{latestEvent.message}</p> : null}
      {operation?.output ? <pre className="operation-output">{operation.output}</pre> : null}
      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
    </section>
  );
}
