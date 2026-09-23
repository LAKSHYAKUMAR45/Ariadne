import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError, isAbortError } from '../api/client';
import { isDeploymentsResponse, isOperationListResponse } from '../api/guards';
import type {
  AdminOperation,
  ConfirmationRequest,
  DeploymentCandidate,
  DeploymentsResponse,
} from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { usePrivilegedAction } from '../auth/usePrivilegedAction';
import { AsyncState } from '../components/AsyncState';
import { OperationProgress } from '../components/OperationProgress';
import { StatusLabel } from '../components/StatusLabel';
import {
  formatAbsoluteTime,
  hasFreshReauthentication,
  isOperationActive,
} from './helpers';

function deployConfirmation(
  revision: string,
  requiresReauthentication: boolean,
): ConfirmationRequest {
  const expectedConfirmation = `DEPLOY ${revision}`;

  return {
    title: 'Deploy selected revision',
    impact:
      'Create a safety backup, apply migrations, cut over to the selected immutable revision, and wait for health checks before success.',
    expectedConfirmation,
    confirmationLabel: `Type ${expectedConfirmation} to continue`,
    requiresReauthentication,
  };
}

function rollbackConfirmation(
  revision: string,
  requiresReauthentication: boolean,
): ConfirmationRequest {
  const expectedConfirmation = `ROLLBACK ${revision}`;

  return {
    title: 'Rollback deployment',
    impact:
      'Restore the recorded rollback revision through the guarded workflow, including safety backup, migration handling, and health checks.',
    expectedConfirmation,
    confirmationLabel: `Type ${expectedConfirmation} to continue`,
    requiresReauthentication,
  };
}

export function DeploymentsPage() {
  const { api, session } = useAuth();
  const [deployments, setDeployments] = useState<DeploymentsResponse | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<string | null>(null);
  const [recentOperations, setRecentOperations] = useState<AdminOperation[]>([]);
  const [reconnectedOperation, setReconnectedOperation] = useState<AdminOperation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const deploymentsControllerRef = useRef<AbortController | null>(null);
  const operationsControllerRef = useRef<AbortController | null>(null);
  const action = usePrivilegedAction();

  const activeOperation = action.operation ?? reconnectedOperation;
  const controlsLocked = action.busy || isOperationActive(activeOperation);

  const loadDeployments = useCallback(async (): Promise<void> => {
    deploymentsControllerRef.current?.abort();
    const controller = new AbortController();
    deploymentsControllerRef.current = controller;

    try {
      const response = await api.get('/api/v1/admin/deployments', isDeploymentsResponse, controller.signal);
      if (controller.signal.aborted || deploymentsControllerRef.current !== controller) {
        return;
      }
      setDeployments(response);
      setSelectedRevision((current) =>
        current && response.candidates.some((candidate) => candidate.revision === current)
          ? current
          : null,
      );
      setError(null);
    } catch (loadDeploymentsError: unknown) {
      if (isAbortError(loadDeploymentsError)) {
        return;
      }
      setError(
        loadDeploymentsError instanceof Error
          ? loadDeploymentsError.message
          : 'Unable to load deployment status.',
      );
      setDeployments(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadOperations = useCallback(async (): Promise<void> => {
    operationsControllerRef.current?.abort();
    const controller = new AbortController();
    operationsControllerRef.current = controller;

    try {
      const response = await api.get(
        '/api/v1/admin/operations?limit=20',
        isOperationListResponse,
        controller.signal,
      );
      if (controller.signal.aborted || operationsControllerRef.current !== controller) {
        return;
      }

      const filtered = response.operations.filter(
        (operation) =>
          operation.type === 'deployment_apply' || operation.type === 'deployment_rollback',
      );
      setRecentOperations(filtered);
      setReconnectedOperation(filtered.find((operation) => isOperationActive(operation)) ?? null);
    } catch (loadOperationsError: unknown) {
      if (isAbortError(loadOperationsError)) {
        return;
      }
      if (loadOperationsError instanceof AdminApiError && loadOperationsError.code === 'reauthentication_required') {
        setRecentOperations([]);
        setReconnectedOperation(null);
        return;
      }
      setRecentOperations([]);
      setReconnectedOperation(null);
    }
  }, [api, session?.reauthenticatedUntil]);

  useEffect(() => {
    void loadDeployments();
    void loadOperations();

    return () => {
      deploymentsControllerRef.current?.abort();
      operationsControllerRef.current?.abort();
    };
  }, [loadDeployments, loadOperations]);

  useEffect(() => {
    if (action.operation?.state === 'succeeded' || action.operation?.state === 'failed') {
      void loadDeployments();
      void loadOperations();
    }
  }, [action.operation?.state, loadDeployments, loadOperations]);

  const selectedCandidate = useMemo<DeploymentCandidate | null>(
    () => deployments?.candidates.find((candidate) => candidate.revision === selectedRevision) ?? null,
    [deployments?.candidates, selectedRevision],
  );

  const progress = useMemo(() => {
    if (action.operation?.id) {
      return action.progress;
    }
    if (!reconnectedOperation) {
      return null;
    }
    return (
      <OperationProgress
        api={api}
        operationId={reconnectedOperation.id}
        initialOperation={reconnectedOperation}
        onOperationChange={setReconnectedOperation}
      />
    );
  }, [action.operation?.id, action.progress, api, reconnectedOperation]);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Delivery</p>
          <h1>Deployments</h1>
          <p>Deploy only immutable candidate SHAs returned by the guarded status endpoint.</p>
        </div>
      </header>
      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
      {action.message ? <div className="notice notice--success" role="status">{action.message}</div> : null}
      {progress}
      <div className="status-board operations-board">
        <section className="panel status-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Current</p>
              <h2>Current</h2>
            </div>
          </div>
          <AsyncState
            loading={loading}
            empty={deployments === null}
            error={error}
            loadingLabel="Loading deployments"
            emptyTitle="No deployment status"
            emptyMessage="Deployment facts will appear once the operator responds."
          >
            <div className="deployment-summary">
              <div className="status-timestamp">
                <strong>Current</strong>
                <code>{deployments?.currentRevision}</code>
              </div>
              <div className="status-timestamp">
                <strong>Rollback target</strong>
                <code>{deployments?.rollbackRevision ?? 'No rollback available'}</code>
              </div>
              <div className="status-timestamp">
                <strong>Schema version</strong>
                <code>{deployments?.schemaVersion}</code>
              </div>
            </div>
          </AsyncState>
        </section>
        <section className="panel data-panel">
          <div className="table-heading">
            <strong>Candidate revisions</strong>
            <span>{deployments?.candidates.length ?? 0} candidates</span>
          </div>
          <AsyncState
            loading={loading}
            empty={(deployments?.candidates.length ?? 0) === 0}
            error={error}
            loadingLabel="Loading candidates"
            emptyTitle="No candidates"
            emptyMessage="The trusted remote did not return any deployable revisions."
          >
            <div className="data-list">
              {deployments?.candidates.map((candidate) => {
                const isCurrent = candidate.revision === deployments.currentRevision;
                const isRollback = candidate.revision === deployments.rollbackRevision;

                return (
                  <label className="data-row data-row--stacked candidate-row" key={candidate.revision}>
                    <input
                      checked={selectedRevision === candidate.revision}
                      className="candidate-radio"
                      name="deployment-candidate"
                      type="radio"
                      onChange={() => setSelectedRevision(candidate.revision)}
                    />
                    <div className="data-main">
                      <strong>{candidate.subject}</strong>
                      <span>
                        <code>{candidate.revision}</code> · {formatAbsoluteTime(candidate.committedAt)}
                      </span>
                    </div>
                    <div className="row-pill-group">
                      {isCurrent ? <span className="status-pill status-pill--good">Current</span> : null}
                      {isRollback ? <span className="status-pill status-pill--warning">Rollback target</span> : null}
                    </div>
                  </label>
                );
              })}
            </div>
          </AsyncState>
          <div className="dialog-actions operations-actions">
            <button
              className="primary-action"
              type="button"
              disabled={!selectedCandidate || controlsLocked}
              onClick={() =>
                selectedCandidate
                  ? void action.run(
                      '/api/v1/admin/operations/deploy',
                      'Deployment queued',
                      { revision: selectedCandidate.revision },
                      {
                        confirmation: deployConfirmation(
                          selectedCandidate.revision,
                          !hasFreshReauthentication(session?.reauthenticatedUntil),
                        ),
                      },
                    )
                  : undefined
              }
            >
              Deploy selected revision
            </button>
            <button
              className="quiet-action"
              type="button"
              disabled={!deployments?.rollbackRevision || controlsLocked}
              onClick={() =>
                deployments?.rollbackRevision
                  ? void action.run(
                      '/api/v1/admin/operations/rollback',
                      'Rollback queued',
                      { revision: deployments.rollbackRevision },
                      {
                        confirmation: rollbackConfirmation(
                          deployments.rollbackRevision,
                          !hasFreshReauthentication(session?.reauthenticatedUntil),
                        ),
                      },
                    )
                  : undefined
              }
            >
              Rollback to previous revision
            </button>
          </div>
        </section>
      </div>
      <section className="panel data-panel">
        <div className="table-heading">
          <strong>Recent deployments</strong>
          <span>{recentOperations.length} recorded</span>
        </div>
        {recentOperations.length === 0 ? (
          <p className="pane-message">No recent deployment operations are available in this session.</p>
        ) : (
          <div className="data-list">
            {recentOperations.map((operation) => (
              <article className="data-row data-row--stacked" key={operation.id}>
                <span className="status-dot status-dot--good" />
                <div className="data-main">
                  <strong>{operation.summary}</strong>
                  <span>{formatAbsoluteTime(operation.createdAt)}</span>
                </div>
                <StatusLabel status={operation.state} />
              </article>
            ))}
          </div>
        )}
      </section>
      {action.dialog}
    </div>
  );
}
