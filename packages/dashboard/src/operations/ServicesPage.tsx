import { useEffect, useState } from 'react';
import { isAbortError } from '../api/client';
import { isServicesResponse } from '../api/guards';
import { useAuth } from '../auth/AuthProvider';
import { usePrivilegedAction } from '../auth/usePrivilegedAction';

export function ServicesPage() {
  const { api } = useAuth();
  const [services, setServices] = useState<import('../api/types').ServiceStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const action = usePrivilegedAction();

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/api/v1/admin/services', isServicesResponse, controller.signal)
      .then((response) => setServices(response.services))
      .catch((loadError: unknown) => {
        if (!isAbortError(loadError)) {
          setLoadError(loadError instanceof Error ? loadError.message : 'Unable to load services.');
        }
      });
    return () => controller.abort();
  }, [api]);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Runtime</p>
          <h1>Services</h1>
          <p>Current application components and the one safe restart control in this MVP.</p>
        </div>
        <button
          className="primary-action page-action"
          type="button"
          disabled={action.busy}
          onClick={() =>
            void action.run(
              '/api/v1/admin/operations/service-restart',
              'Restart queued',
              { service: 'sync-server' },
            )
          }
        >
          Restart sync server
        </button>
      </header>
      {action.message ? <div className="notice notice--success" role="status">{action.message}</div> : null}
      {loadError || action.error ? <div className="notice notice--error" role="alert">{loadError ?? action.error}</div> : null}
      {action.progress}
      <section className="service-grid" aria-label="Service status">
        {services.map((service) => {
          const healthy = service.state === 'running' || service.state === 'available';
          return (
            <article className="panel service-card" key={service.name}>
              <div className="service-title">
                <span className={`status-dot ${healthy ? 'status-dot--good' : 'status-dot--warning'}`} />
                <span>{service.state}</span>
              </div>
              <h2>{service.name}</h2>
              <p>{service.detail}</p>
            </article>
          );
        })}
        {services.length === 0 && !loadError ? <p className="pane-message">Checking services...</p> : null}
      </section>
      {action.dialog}
    </div>
  );
}
