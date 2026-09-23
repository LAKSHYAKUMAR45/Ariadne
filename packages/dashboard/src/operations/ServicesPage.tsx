import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError, isAbortError } from '../api/client';
import { isOperationListResponse, isServicesResponse } from '../api/guards';
import type { AdminOperation, ConfirmationRequest, ServiceStatus } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { usePrivilegedAction } from '../auth/usePrivilegedAction';
import { AsyncState } from '../components/AsyncState';
import { OperationProgress } from '../components/OperationProgress';
import { StatusLabel } from '../components/StatusLabel';
import { hasFreshReauthentication, isOperationActive } from './helpers';

function restartConfirmation(
  service: 'sync-server' | 'postgres',
  requiresReauthentication: boolean,
): ConfirmationRequest {
  const expectedConfirmation = `RESTART ${service}`;

  return {
    title: 'Restart service',
    impact: `Restart ${service} through the guarded operator workflow and wait for readiness checks before completion.`,
    expectedConfirmation,
    confirmationLabel: `Type ${expectedConfirmation} to continue`,
    requiresReauthentication,
  };
}

export function ServicesPage() {
  const { api, session } = useAuth();
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reconnectedOperation, setReconnectedOperation] = useState<AdminOperation | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const reconnectControllerRef = useRef<AbortController | null>(null);
  const action = usePrivilegedAction();

  const activeOperation = action.operation ?? reconnectedOperation;
  const controlsLocked = action.busy || isOperationActive(activeOperation);

  const loadServices = useCallback(async (): Promise<void> => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    try {
      const response = await api.get('/api/v1/admin/services', isServicesResponse, controller.signal);
      if (controller.signal.aborted || loadControllerRef.current !== controller) {
        return;
      }
      setServices(response.services);
      setLoadError(null);
    } catch (loadServicesError: unknown) {
      if (isAbortError(loadServicesError) || loadControllerRef.current !== controller) {
        return;
      }
      setLoadError(
        loadServicesError instanceof Error ? loadServicesError.message : 'Unable to load services.',
      );
      setServices([]);
    } finally {
      if (loadControllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, [api]);

  const reconnectOperation = useCallback(async (): Promise<void> => {
    reconnectControllerRef.current?.abort();
    const controller = new AbortController();
    reconnectControllerRef.current = controller;

    try {
      const response = await api.get(
        '/api/v1/admin/operations?limit=20',
        isOperationListResponse,
        controller.signal,
      );
      if (controller.signal.aborted || reconnectControllerRef.current !== controller) {
        return;
      }
      setReconnectedOperation(response.operations.find((operation) => isOperationActive(operation)) ?? null);
    } catch (reconnectError: unknown) {
      if (isAbortError(reconnectError)) {
        return;
      }
      if (reconnectError instanceof AdminApiError && reconnectError.code === 'reauthentication_required') {
        setReconnectedOperation(null);
        return;
      }
      setReconnectedOperation(null);
    }
  }, [api]);

  useEffect(() => {
    void loadServices();
    void reconnectOperation();

    return () => {
      loadControllerRef.current?.abort();
      reconnectControllerRef.current?.abort();
    };
  }, [loadServices, reconnectOperation]);

  useEffect(() => {
    if (activeOperation?.state === 'succeeded' || activeOperation?.state === 'failed') {
      void reconnectOperation();
      void loadServices();
    }
  }, [activeOperation?.state, loadServices, reconnectOperation]);

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
          <p className="eyebrow">Runtime</p>
          <h1>Services</h1>
          <p>Restart only approved services while keeping the operator boundary read-only.</p>
        </div>
      </header>
      {activeOperation && isOperationActive(activeOperation) ? (
        <div className="notice notice--actionable" role="status">
          <span>{activeOperation.summary} is still running. Restart controls stay locked until it completes.</span>
        </div>
      ) : null}
      {loadError || action.error ? <div className="notice notice--error" role="alert">{loadError ?? action.error}</div> : null}
      {action.message ? <div className="notice notice--success" role="status">{action.message}</div> : null}
      {progress}
      <section className="service-grid" aria-label="Service status">
        <AsyncState
          loading={loading}
          empty={services.length === 0}
          error={loadError}
          loadingLabel="Loading services"
          emptyTitle="No services reported"
          emptyMessage="The operator will surface guarded service state here when it becomes available."
        >
          {services.map((service) => (
            (() => {
              const restartableService =
                service.name === 'sync-server' || service.name === 'postgres'
                  ? service.name
                  : null;

              return (
                <article className="panel service-card" key={service.name}>
                  <div className="service-title">
                    <StatusLabel status={service.state} />
                  </div>
                  <h2>{service.name}</h2>
                  <p>{service.detail ?? 'No additional detail reported.'}</p>
                  {service.name === 'operator' ? (
                    <p className="service-static">Operator boundary is read-only from the browser.</p>
                  ) : null}
                  {restartableService ? (
                    <button
                      className="quiet-action row-action service-action"
                      type="button"
                      disabled={controlsLocked}
                      onClick={() =>
                        void action.run(
                          '/api/v1/admin/operations/service-restart',
                          'Restart queued',
                          { service: restartableService },
                          {
                            confirmation: restartConfirmation(
                              restartableService,
                              !hasFreshReauthentication(session?.reauthenticatedUntil),
                            ),
                          },
                        )
                      }
                    >
                      {`Restart ${restartableService}`}
                    </button>
                  ) : null}
                </article>
              );
            })()
          ))}
        </AsyncState>
      </section>
      {action.dialog}
    </div>
  );
}
