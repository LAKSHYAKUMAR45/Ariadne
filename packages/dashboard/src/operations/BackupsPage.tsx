import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError, isAbortError } from '../api/client';
import { isBackupsResponse, isOperationListResponse } from '../api/guards';
import type { AdminOperation, BackupRecord, ConfirmationRequest } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { usePrivilegedAction } from '../auth/usePrivilegedAction';
import { AsyncState } from '../components/AsyncState';
import { OperationProgress } from '../components/OperationProgress';
import { StatusLabel } from '../components/StatusLabel';
import {
  formatAbsoluteTime,
  formatBytes,
  hasFreshReauthentication,
  isOperationActive,
} from './helpers';

function restoreEligibility(backup: BackupRecord): { allowed: boolean; detail: string } {
  if (backup.status === 'verified') {
    return {
      allowed: true,
      detail:
        backup.restoreVerificationMessage ?? 'Verified and eligible for restore or download.',
    };
  }

  if (backup.status === 'created') {
    return {
      allowed: false,
      detail: 'Verification required before restore or download.',
    };
  }

  if (backup.status === 'verify_failed') {
    return {
      allowed: false,
      detail:
        backup.restoreVerificationMessage ??
        'The latest verification failed. Verify again before restore or download.',
    };
  }

  return {
    allowed: false,
    detail:
      backup.restoreVerificationMessage ??
      'Only currently verified backups can be restored or downloaded.',
  };
}

function restoreConfirmation(
  backup: BackupRecord,
  requiresReauthentication: boolean,
): ConfirmationRequest {
  const expectedConfirmation = `RESTORE ${backup.filename}`;

  return {
    title: 'Restore verified backup',
    impact:
      'Create and verify a fresh safety backup, restore production data, run migrations, restart dependent services, and wait for health checks before success.',
    expectedConfirmation,
    confirmationLabel: `Type ${expectedConfirmation} to continue`,
    requiresReauthentication,
  };
}

export function BackupsPage() {
  const { api, session } = useAuth();
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [reconnectedOperation, setReconnectedOperation] = useState<AdminOperation | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const reconnectControllerRef = useRef<AbortController | null>(null);
  const action = usePrivilegedAction();

  const activeOperation = action.operation ?? reconnectedOperation;
  const controlsLocked = action.busy || isOperationActive(activeOperation);

  const loadBackups = useCallback(async (): Promise<void> => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    try {
      const response = await api.get('/api/v1/admin/backups', isBackupsResponse, controller.signal);
      if (controller.signal.aborted || loadControllerRef.current !== controller) {
        return;
      }
      setBackups(response.backups);
      setLoadError(null);
    } catch (loadBackupsError: unknown) {
      if (isAbortError(loadBackupsError) || loadControllerRef.current !== controller) {
        return;
      }
      setLoadError(
        loadBackupsError instanceof Error ? loadBackupsError.message : 'Unable to load backups.',
      );
      setBackups([]);
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
      setReconnectedOperation(
        response.operations.find(
          (operation) =>
            (operation.type === 'backup_create' ||
              operation.type === 'backup_verify' ||
              operation.type === 'backup_restore') &&
            isOperationActive(operation),
        ) ?? null,
      );
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
    void loadBackups();
    void reconnectOperation();

    return () => {
      loadControllerRef.current?.abort();
      reconnectControllerRef.current?.abort();
    };
  }, [loadBackups, reconnectOperation]);

  useEffect(() => {
    if (action.operation?.state === 'succeeded' || action.operation?.state === 'failed') {
      void loadBackups();
      void reconnectOperation();
    }
  }, [action.operation?.state, loadBackups, reconnectOperation]);

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

  async function downloadBackup(backup: BackupRecord): Promise<void> {
    setDownloadError(null);
    let objectUrl: string | null = null;

    try {
      const blob = await api.download(
        `/api/v1/admin/backups/${encodeURIComponent(backup.filename)}/download`,
      );
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = backup.filename;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (downloadBackupError: unknown) {
      setDownloadError(
        downloadBackupError instanceof Error
          ? downloadBackupError.message
          : 'Unable to download the selected backup.',
      );
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Recovery</p>
          <h1>Backups</h1>
          <p>Create, verify, download, and restore protected PostgreSQL recovery points.</p>
        </div>
        <button
          className="primary-action page-action"
          type="button"
          disabled={controlsLocked}
          onClick={() => void action.run('/api/v1/admin/operations/backups', 'Backup queued')}
        >
          Create backup
        </button>
      </header>
      {action.message ? <div className="notice notice--success" role="status">{action.message}</div> : null}
      {loadError || downloadError || action.error ? (
        <div className="notice notice--error" role="alert">
          {loadError ?? downloadError ?? action.error}
        </div>
      ) : null}
      {progress}
      <section className="panel data-panel">
        <div className="table-heading">
          <strong>Recovery points</strong>
          <span>{backups.length} recorded</span>
        </div>
        <AsyncState
          loading={loading}
          empty={backups.length === 0}
          error={loadError}
          loadingLabel="Loading backups"
          emptyTitle="No backups recorded"
          emptyMessage="Create a verified backup before protected restore and download workflows can run."
        >
          <div className="data-list">
            {backups.map((backup) => {
              const eligibility = restoreEligibility(backup);
              return (
                <article className="data-row data-row--stacked" key={backup.filename}>
                  <span className={`status-dot ${eligibility.allowed ? 'status-dot--good' : 'status-dot--warning'}`} />
                  <div className="data-main">
                    <strong>{backup.filename}</strong>
                    <span>{formatAbsoluteTime(backup.createdAt)} · {formatBytes(backup.sizeBytes)}</span>
                    <p className="data-detail">{eligibility.detail}</p>
                  </div>
                  <StatusLabel status={backup.status} />
                  <div className="row-action-group">
                    <button
                      aria-label={`Verify ${backup.filename}`}
                      className="quiet-action row-action"
                      type="button"
                      disabled={controlsLocked}
                      onClick={() =>
                        void action.run(
                          `/api/v1/admin/operations/backups/${encodeURIComponent(backup.filename)}/verify`,
                          'Verification queued',
                        )
                      }
                    >
                      Verify
                    </button>
                    <button
                      aria-label={`Download ${backup.filename}`}
                      className="quiet-action row-action"
                      type="button"
                      disabled={!eligibility.allowed || controlsLocked}
                      onClick={() => void downloadBackup(backup)}
                    >
                      Download
                    </button>
                    <button
                      aria-label={`Restore ${backup.filename}`}
                      className="quiet-action row-action"
                      type="button"
                      disabled={!eligibility.allowed || controlsLocked}
                      onClick={() =>
                        void action.run(
                          `/api/v1/admin/operations/backups/${encodeURIComponent(backup.filename)}/restore`,
                          'Restore queued',
                          {},
                          {
                            confirmation: restoreConfirmation(
                              backup,
                              !hasFreshReauthentication(session?.reauthenticatedUntil),
                            ),
                          },
                        )
                      }
                    >
                      Restore
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </AsyncState>
      </section>
      {action.dialog}
    </div>
  );
}
