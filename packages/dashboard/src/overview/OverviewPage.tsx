import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '../api/client';
import { isOverviewResponse } from '../api/guards';
import type { OverviewResponse } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { AsyncState } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';

const POLL_INTERVAL_MS = 30_000;
const STALE_BACKUP_MS = 24 * 60 * 60 * 1000;
const EMPTY_MESSAGE = 'No overview metrics are currently available.';

interface StatusRowProps {
  name: string;
  status: string;
  detail: string;
  value?: string;
  emphasis?: boolean;
}

function formatAbsoluteTimestamp(value: string | null): string {
  if (!value) {
    return 'Never recorded';
  }

  return value.slice(0, 16).replace('T', ' ') + ' UTC';
}

function formatRelativeTimestamp(value: string | null): string {
  if (!value) {
    return 'never';
  }

  const deltaMs = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(deltaMs / (60 * 1000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }
  return `${bytes} B`;
}

function formatCpuPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

function backupStatus(overview: OverviewResponse): { state: string; detail: string } {
  const verifiedAt = overview.backup.latestVerifiedAt;
  if (!verifiedAt || overview.backup.status !== 'verified') {
    return {
      state: overview.backup.status,
      detail: 'No verified backup has been recorded.',
    };
  }

  const backupAgeMs = Date.now() - Date.parse(verifiedAt);
  if (backupAgeMs > STALE_BACKUP_MS) {
    return {
      state: 'stale',
      detail: `Verified backup is ${formatRelativeTimestamp(verifiedAt).replace(' ago', '')} old.`,
    };
  }

  return {
    state: 'verified',
    detail: 'Recovery point is fresh and verified.',
  };
}

function collectFailures(overview: OverviewResponse): StatusRowProps[] {
  const items: StatusRowProps[] = [];
  const currentBackupStatus = backupStatus(overview);

  if (overview.database.healthy !== true) {
    items.push({
      name: 'Database',
      status: 'failed',
      detail: 'PostgreSQL is unavailable for dashboard reads.',
      emphasis: true,
    });
  }

  if (overview.components.operator.healthy !== true) {
    items.push({
      name: 'Operator',
      status: 'failed',
      detail: overview.components.operator.code ?? 'Privileged operator reads are unavailable.',
      emphasis: true,
    });
  }

  if (currentBackupStatus.state !== 'verified') {
    items.push({
      name: 'Backup freshness',
      status: currentBackupStatus.state,
      detail: currentBackupStatus.detail,
      emphasis: true,
    });
  }

  if (overview.operations.failedLast24h > 0) {
    items.push({
      name: 'Recent failures',
      status: 'failed',
      detail: `${overview.operations.failedLast24h} recent failures need review.`,
      emphasis: true,
    });
  }

  if (items.length === 0) {
    return [
      {
        name: 'No active failures',
        status: 'healthy',
        detail: 'Services, backups, and privileged operations are within their expected ranges.',
      },
    ];
  }

  return items;
}

function OverviewTimestamp({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="status-timestamp">
      <strong>{label}</strong>
      <time dateTime={value ?? undefined}>
        <span>{formatRelativeTimestamp(value)}</span>
        <small>{formatAbsoluteTimestamp(value)}</small>
      </time>
    </div>
  );
}

function StatusRow({ name, status, detail, value, emphasis = false }: StatusRowProps) {
  return (
    <div className={emphasis ? 'status-row status-row--attention' : 'status-row'}>
      <div className="status-row__copy">
        <strong>{name}</strong>
        <span>{detail}</span>
      </div>
      {value ? <strong className="status-row__value">{value}</strong> : null}
      <StatusLabel status={status} />
    </div>
  );
}

export function OverviewPage() {
  const { api } = useAuth();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const overviewRef = useRef<OverviewResponse | null>(null);

  useEffect(() => {
    overviewRef.current = overview;
  }, [overview]);

  const loadOverview = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const hasExistingData = overviewRef.current !== null;

    if (!hasExistingData) {
      setLoading(true);
    }

    try {
      const response = await api.get('/api/v1/admin/overview', isOverviewResponse, controller.signal);
      if (controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      setOverview(response);
      setError(null);
    } catch (loadError: unknown) {
      if (isAbortError(loadError) || controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      setError(
        loadError instanceof Error ? loadError.message : 'Unable to load the live overview.',
      );
      if (!hasExistingData) {
        setOverview(null);
      }
    } finally {
      if (controllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    let pollTimer: number | null = null;

    const startPolling = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }

      if (document.visibilityState === 'visible') {
        pollTimer = window.setInterval(() => {
          void loadOverview();
        }, POLL_INTERVAL_MS);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadOverview();
      }
      startPolling();
    };

    void loadOverview();
    startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      controllerRef.current?.abort();
    };
  }, [loadOverview]);

  const currentBackupStatus = overview ? backupStatus(overview) : null;
  const failures = overview ? collectFailures(overview) : [];

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Live system</p>
          <h1>System overview</h1>
          <p>Failure-first operational state for nodem2 and its guarded Ariadne services.</p>
        </div>
        <button className="quiet-action" type="button" onClick={() => void loadOverview()}>
          Refresh status
        </button>
      </header>

      <AsyncState
        loading={loading && !overview}
        empty={overview === null}
        error={!overview ? error : null}
        partialError={overview ? error : null}
        loadingLabel="Loading live overview"
        emptyTitle="Overview unavailable"
        emptyMessage={EMPTY_MESSAGE}
      >
        {overview ? (
          <>
            <section className="priority-strip" aria-label="Overview freshness">
              <div>
                <span className="status-dot status-dot--good" aria-hidden="true" />
                <span>Updated</span>
                <strong>{formatRelativeTimestamp(overview.generatedAt)}</strong>
              </div>
              <div>
                <span>Generated</span>
                <strong>{formatAbsoluteTimestamp(overview.generatedAt)}</strong>
              </div>
              <div>
                <span>Database size</span>
                <strong>{formatBytes(overview.databaseSizeBytes)}</strong>
              </div>
            </section>

            <div className="status-board">
              <section className="panel status-card">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">Failures</p>
                    <h2>Failures</h2>
                  </div>
                </div>
                <div className="status-rows">
                  {failures.map((item) => (
                    <StatusRow key={`${item.name}-${item.status}`} {...item} />
                  ))}
                </div>
              </section>

              <section className="panel status-card">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">Services</p>
                    <h2>Services</h2>
                  </div>
                </div>
                <div className="status-rows">
                  <StatusRow
                    name="PostgreSQL"
                    status={overview.database.healthy ? 'healthy' : 'unavailable'}
                    detail={overview.database.healthy ? 'Connection healthy.' : 'Database unavailable.'}
                    value={overview.database.latencyMs === null ? 'n/a' : `${overview.database.latencyMs} ms`}
                  />
                  <StatusRow
                    name="Operator"
                    status={overview.components.operator.healthy ? 'available' : 'unavailable'}
                    detail={
                      overview.components.operator.healthy
                        ? 'Privileged actions are available.'
                        : overview.components.operator.code ?? 'Privileged actions are unavailable.'
                    }
                  />
                  <StatusRow
                    name="Host CPU"
                    status={overview.host ? 'healthy' : 'unavailable'}
                    detail={overview.host ? 'Processor load across the host.' : 'Host metrics unavailable'}
                    value={overview.host ? formatCpuPercent(overview.host.cpuPercent) : undefined}
                  />
                  <StatusRow
                    name="Host RAM"
                    status={overview.host ? 'healthy' : 'unavailable'}
                    detail={overview.host ? 'Used / total memory.' : 'Host metrics unavailable'}
                    value={
                      overview.host
                        ? `${formatBytes(overview.host.memoryUsedBytes)} / ${formatBytes(overview.host.memoryTotalBytes)}`
                        : undefined
                    }
                  />
                  <StatusRow
                    name="Host disk"
                    status={overview.host ? 'healthy' : 'unavailable'}
                    detail={overview.host ? 'Used / total filesystem.' : 'Host metrics unavailable'}
                    value={
                      overview.host
                        ? `${formatBytes(overview.host.filesystemUsedBytes)} / ${formatBytes(overview.host.filesystemTotalBytes)}`
                        : undefined
                    }
                  />
                </div>
              </section>

              <section className="panel status-card">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">Backup</p>
                    <h2>Backup</h2>
                  </div>
                  {currentBackupStatus ? <StatusLabel status={currentBackupStatus.state} /> : null}
                </div>
                <p className="status-card__summary">{currentBackupStatus?.detail}</p>
                <div className="timestamp-grid">
                  <OverviewTimestamp label="Latest backup" value={overview.backup.latestAt} />
                  <OverviewTimestamp label="Latest verified" value={overview.backup.latestVerifiedAt} />
                </div>
              </section>

              <section className="panel status-card">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">Operations</p>
                    <h2>Operations</h2>
                  </div>
                </div>
                <div className="status-rows">
                  <StatusRow
                    name="Running"
                    status={overview.operations.running > 0 ? 'running' : 'healthy'}
                    detail={overview.operations.running > 0 ? 'Privileged operations in progress.' : 'No privileged actions are currently running.'}
                    value={String(overview.operations.running)}
                  />
                  <StatusRow
                    name="Failed in 24h"
                    status={overview.operations.failedLast24h > 0 ? 'failed' : 'healthy'}
                    detail="Operator and dashboard mutations in the last 24 hours."
                    value={String(overview.operations.failedLast24h)}
                  />
                </div>
                <div className="timestamp-grid">
                  <OverviewTimestamp label="Last sync push" value={overview.sync.lastPushAt} />
                  <OverviewTimestamp label="Last sync pull" value={overview.sync.lastPullAt} />
                </div>
              </section>

              <section className="panel status-card">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">Counts</p>
                    <h2>Counts</h2>
                  </div>
                </div>
                <div className="status-rows">
                  <StatusRow
                    name="Tasks"
                    status={overview.tasks.active > 0 ? 'running' : 'healthy'}
                    detail={`${overview.tasks.total} total / ${overview.tasks.active} active`}
                    value={`${overview.tasks.updatedLast24h} updated`}
                  />
                  <StatusRow
                    name="Members"
                    status={overview.members.inactive > 0 ? 'review' : 'healthy'}
                    detail={`${overview.members.total} total / ${overview.members.active} active`}
                    value={`${overview.members.inactive} inactive`}
                  />
                </div>
              </section>
            </div>
          </>
        ) : null}
      </AsyncState>
    </div>
  );
}
