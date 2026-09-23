import { useOperation } from '../hooks/useOperation';
import type { AdminApiClient, AdminOperation } from '../api/types';
import { StatusLabel } from './StatusLabel';

interface OperationProgressProps {
  api: AdminApiClient;
  operationId: string | null;
  initialOperation?: AdminOperation | null;
}

export function OperationProgress({
  api,
  operationId,
  initialOperation = null,
}: OperationProgressProps) {
  const { operation, latestEvent, live, polling, error } = useOperation({
    api,
    operationId,
    initialOperation,
  });

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
    <section className="panel data-panel" aria-label="Operation progress">
      <div className="table-heading">
        <strong>{summary}</strong>
        <StatusLabel status={status} />
      </div>
      <p className="muted">{helper}</p>
      {latestEvent ? <p>{latestEvent.message}</p> : null}
      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
    </section>
  );
}
