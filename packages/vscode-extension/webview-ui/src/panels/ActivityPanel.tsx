import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ActivityItem, ActivityKind, CaptureHealth, WebviewTabId } from '@host/messages';
import type { AriadneBridge } from '../bridge';
import { useStableCallback } from '../useStableCallback';

type ActivityFilterId = 'all' | 'checkpoint' | 'todo' | 'decision' | 'error' | 'question' | 'file-capture' | 'commit' | 'command';

interface ActivityPanelProps {
  bridge: AriadneBridge;
  taskId?: string;
  onNavigate(target: { tabId: WebviewTabId; entityId?: string }): void;
  onBusy(label: string | undefined): void;
  onError(message: string): void;
}

const filters: Array<{ id: ActivityFilterId; label: string; kinds?: ActivityKind[] }> = [
  { id: 'all', label: 'All' },
  { id: 'checkpoint', label: 'Checkpoints', kinds: ['checkpoint'] },
  { id: 'todo', label: 'Todos', kinds: ['todo'] },
  { id: 'decision', label: 'Decisions', kinds: ['decision'] },
  { id: 'error', label: 'Errors', kinds: ['error'] },
  { id: 'question', label: 'Questions', kinds: ['question'] },
  { id: 'file-capture', label: 'Files', kinds: ['file-capture'] },
  { id: 'commit', label: 'Commits', kinds: ['commit'] },
  { id: 'command', label: 'Commands', kinds: ['command'] },
];

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function branchMatchLabel(branchMatches: CaptureHealth['branchMatches']): string {
  if (branchMatches === true) return 'Branch matches task';
  if (branchMatches === false) return 'Branch mismatch';
  return 'Branch unknown';
}

function statusLabel(status: CaptureHealth): string {
  if (status.unresolvedErrors === 0) return 'No unresolved errors';
  if (status.unresolvedErrors === 1) return '1 unresolved error';
  return `${status.unresolvedErrors} unresolved errors`;
}

function activityStatus(item: ActivityItem): string {
  return item.status ?? 'info';
}

export default function ActivityPanel({ bridge, taskId, onNavigate, onBusy, onError }: ActivityPanelProps) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [health, setHealth] = useState<CaptureHealth | null>(null);
  const [filter, setFilter] = useState<ActivityFilterId>('all');
  const generationRef = useRef(0);
  const reportBusy = useStableCallback(onBusy);
  const reportError = useStableCallback(onError);

  useEffect(() => {
    setFilter('all');
  }, [taskId]);

  useEffect(() => {
    const generation = ++generationRef.current;
    reportError('');
    reportBusy('Loading activity…');

    void Promise.all([
      bridge.request<{ items: ActivityItem[] }>('activity.list'),
      bridge.request<{ health: CaptureHealth }>('capture.health'),
    ])
      .then(([activity, captureHealth]) => {
        if (generation !== generationRef.current) return;
        setItems(Array.isArray(activity.items) ? activity.items : []);
        setHealth(captureHealth.health ?? null);
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) return;
        reportError(formatError(error));
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        reportBusy(undefined);
      });
  }, [bridge, reportBusy, reportError, taskId]);

  const visibleItems = useMemo(() => {
    const kinds = filters.find((entry) => entry.id === filter)?.kinds;
    if (!kinds) return items;
    return items.filter((item) => kinds.includes(item.kind));
  }, [filter, items]);

  return (
    <div style={styles.root}>
      <section aria-label="Capture health" style={styles.section}>
        <h3 style={styles.sectionTitle}>Capture health</h3>
        {health ? (
          <>
            <div style={styles.summaryGrid}>
              <div style={styles.summaryCard}>Passive capture {health.passiveCaptureEnabled ? 'enabled' : 'disabled'}</div>
              <div style={styles.summaryCard}>
                Shell integration {health.shellIntegrationAvailable ? 'available' : 'unavailable'}
              </div>
              <div style={styles.summaryCard}>Git {health.gitExtensionAvailable ? 'available' : 'unavailable'}</div>
              <div style={styles.summaryCard}>{branchMatchLabel(health.branchMatches)}</div>
            </div>

            <dl style={styles.details}>
              <div>
                <dt>Workspace root</dt>
                <dd>{health.workspaceRoot ?? 'No workspace selected'}</dd>
              </div>
              <div>
                <dt>Current task target</dt>
                <dd>
                  {health.currentTaskTitle && health.currentTaskId
                    ? `${health.currentTaskTitle} (${health.currentTaskId})`
                    : health.currentTaskId ?? 'No current task selected'}
                </dd>
              </div>
              <div>
                <dt>Current branch</dt>
                <dd>{health.currentBranch ?? 'Unknown current branch'}</dd>
              </div>
              <div>
                <dt>Task branch</dt>
                <dd>{health.taskBranch ?? 'No task branch set'}</dd>
              </div>
              <div>
                <dt>Last file capture</dt>
                <dd>{health.lastFileCapture ? health.lastFileCapture.title : 'No file captures yet'}</dd>
              </div>
              <div>
                <dt>Last command</dt>
                <dd>{health.lastCommand ? health.lastCommand.title : 'No commands captured yet'}</dd>
              </div>
              <div>
                <dt>Last commit</dt>
                <dd>{health.lastCommit ? health.lastCommit.title : 'No commits captured yet'}</dd>
              </div>
              <div>
                <dt>Unresolved errors</dt>
                <dd>{statusLabel(health)}</dd>
              </div>
            </dl>

            <div>
              <h4 style={styles.subheading}>Warnings</h4>
              {health.warnings.length === 0 ? (
                <p style={styles.muted}>No warnings.</p>
              ) : (
                <ul style={styles.list}>
                  {health.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <p style={styles.muted}>Loading capture health…</p>
        )}
      </section>

      <section aria-label="Activity timeline" style={styles.section}>
        <h3 style={styles.sectionTitle}>Activity timeline</h3>
        <div style={styles.filterRow}>
          {filters.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              aria-pressed={filter === entry.id}
              style={filter === entry.id ? { ...styles.filterButton, ...styles.filterButtonActive } : styles.filterButton}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {visibleItems.length === 0 ? (
          <p style={styles.muted}>No activity recorded for this filter.</p>
        ) : (
          <ol style={styles.timeline}>
            {visibleItems.map((item) => (
              <li key={item.id} style={styles.timelineItem}>
                {item.targetTab ? (
                  <button
                    type="button"
                    onClick={() => onNavigate({ tabId: item.targetTab!, entityId: item.entityId })}
                    aria-label={`Open activity item: ${item.title}`}
                    style={styles.itemButton}
                  >
                    <span style={styles.itemTitle}>{item.title}</span>
                    <span style={styles.itemMeta}>
                      {item.kind} · {activityStatus(item)} · <time dateTime={item.createdAt}>{item.createdAt}</time>
                    </span>
                    {item.detail ? <span style={styles.itemDetail}>{item.detail}</span> : null}
                  </button>
                ) : (
                  <div style={styles.itemCard}>
                    <span style={styles.itemTitle}>{item.title}</span>
                    <span style={styles.itemMeta}>
                      {item.kind} · {activityStatus(item)} · <time dateTime={item.createdAt}>{item.createdAt}</time>
                    </span>
                    {item.detail ? <span style={styles.itemDetail}>{item.detail}</span> : null}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gap: '1rem',
  },
  section: {
    display: 'grid',
    gap: '0.75rem',
  },
  sectionTitle: {
    margin: 0,
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '0.75rem',
  },
  summaryCard: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    padding: '0.75rem',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
  },
  details: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '0.75rem',
    margin: 0,
  },
  subheading: {
    margin: 0,
  },
  list: {
    margin: '0.5rem 0 0',
    paddingLeft: '1.25rem',
  },
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  filterButton: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '4px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    color: 'var(--vscode-foreground)',
    padding: '0.375rem 0.75rem',
    cursor: 'pointer',
  },
  filterButtonActive: {
    background: 'var(--vscode-button-background)',
    border: '1px solid var(--vscode-button-background)',
  },
  timeline: {
    display: 'grid',
    gap: '0.75rem',
    margin: 0,
    paddingLeft: '1.25rem',
  },
  timelineItem: {
    margin: 0,
  },
  itemButton: {
    width: '100%',
    display: 'grid',
    gap: '0.25rem',
    textAlign: 'left',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    color: 'var(--vscode-foreground)',
    padding: '0.75rem',
    cursor: 'pointer',
  },
  itemCard: {
    display: 'grid',
    gap: '0.25rem',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    color: 'var(--vscode-foreground)',
    padding: '0.75rem',
  },
  itemTitle: {
    fontWeight: 600,
  },
  itemMeta: {
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '0.9rem',
  },
  itemDetail: {
    color: 'var(--vscode-descriptionForeground)',
  },
  muted: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
};
