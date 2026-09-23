import { useEffect, useState } from 'react';
import { usePrivilegedAction } from '../auth/usePrivilegedAction';
import { getJson } from '../api/client';

interface Backup {
  filename: string;
  sha256: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
  verifiedAt: string | null;
  restoreVerificationMessage: string | null;
}

interface BackupsResponse {
  backups: Backup[];
}

interface BackupsPageProps {
  csrfToken?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function BackupsPage({ csrfToken }: BackupsPageProps) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const action = usePrivilegedAction(csrfToken);

  useEffect(() => {
    const controller = new AbortController();
    getJson<BackupsResponse>('/api/v1/admin/backups', controller.signal)
      .then((response) => setBackups(response.backups))
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setLoadError(loadError instanceof Error ? loadError.message : 'Unable to load backups.');
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Recovery</p>
          <h1>Backups</h1>
          <p>Create and verify protected PostgreSQL recovery points.</p>
        </div>
        <button
          className="primary-action page-action"
          type="button"
          disabled={action.busy}
          onClick={() => void action.run('/api/v1/admin/operations/backups', 'Backup queued')}
        >
          Create backup
        </button>
      </header>
      {action.message ? <div className="notice notice--success" role="status">{action.message}</div> : null}
      {loadError || action.error ? <div className="notice notice--error" role="alert">{loadError ?? action.error}</div> : null}
      <section className="panel data-panel">
        <div className="table-heading">
          <strong>Recovery points</strong>
          <span>{backups.length} recorded</span>
        </div>
        {backups.length === 0 ? <p className="pane-message">No backups have been recorded.</p> : (
          <div className="data-list">
            {backups.map((backup) => (
              <article className="data-row" key={backup.filename}>
                <span className={`status-dot ${backup.status === 'verified' ? 'status-dot--good' : 'status-dot--warning'}`} />
                <div className="data-main">
                  <strong>{backup.filename}</strong>
                  <span>{new Date(backup.createdAt).toLocaleString()} · {formatSize(backup.sizeBytes)}</span>
                </div>
                <span className="status-pill status-pill--neutral">{backup.status}</span>
                <button
                  className="quiet-action row-action"
                  type="button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      `/api/v1/admin/operations/backups/${encodeURIComponent(backup.filename)}/verify`,
                      'Verification queued',
                    )
                  }
                >
                  Verify
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      {action.dialog}
    </div>
  );
}
