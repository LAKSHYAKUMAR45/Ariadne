import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { TaskFileCaptureWithEntries } from '@host/messages';
import type { AriadneBridge } from '../bridge';
import { useHighlightScroll } from './EntityPanels';

interface FilesPanelProps {
  bridge: AriadneBridge;
  captures: TaskFileCaptureWithEntries[];
  highlightPath?: string;
  highlightCaptureId?: string;
  highlightCommitSha?: string;
}

function lineClassName(line: string): string {
  if (line.startsWith('+')) return 'diff-line diff-line-add';
  if (line.startsWith('-')) return 'diff-line diff-line-remove';
  return 'diff-line diff-line-context';
}

function renderDiffText(diff: string): ReactNode {
  return diff.split('\n').map((line, index) => (
    <span key={`${index}-${line}`} className={lineClassName(line)} style={{ display: 'block' }}>
      {line}
    </span>
  ));
}

type TriggerFilter = 'all' | 'explicit' | 'checkpoint' | 'commit';
type StatusFilter = 'all' | 'captured' | 'failed' | 'synced';

function statusForCapture(capture: TaskFileCaptureWithEntries): Exclude<StatusFilter, 'all'> {
  if (capture.failedAt) return 'failed';
  if (capture.syncedAt) return 'synced';
  return 'captured';
}

function triggerForCapture(capture: TaskFileCaptureWithEntries): Exclude<TriggerFilter, 'all'> {
  return capture.trigger === 'git_commit' ? 'commit' : capture.trigger;
}

function highlightStyle(isHighlighted: boolean): CSSProperties {
  return isHighlighted ? { boxShadow: '0 0 0 2px var(--vscode-focusBorder) inset', background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))' } : {};
}

export default function FilesPanel({
  bridge,
  captures,
  highlightPath,
  highlightCaptureId,
  highlightCommitSha,
}: FilesPanelProps) {
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(captures[0]?.id ?? null);
  const [loadedCaptures, setLoadedCaptures] = useState<Record<string, TaskFileCaptureWithEntries>>({});
  const [busyCaptureId, setBusyCaptureId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pathFilter, setPathFilter] = useState('');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const captureMap = useMemo(() => {
    const entries = captures.map((capture) => [capture.id, capture] as const);
    return new Map(entries);
  }, [captures]);

  const highlightedCaptureId = useMemo(() => {
    if (highlightCaptureId && captureMap.has(highlightCaptureId)) {
      return highlightCaptureId;
    }

    if (highlightPath) {
      return captures.find((capture) => capture.entries.some((entry) => entry.path === highlightPath))?.id;
    }

    if (highlightCommitSha) {
      return captures.find((capture) => capture.gitCommitSha === highlightCommitSha)?.id;
    }

    return undefined;
  }, [captureMap, captures, highlightCaptureId, highlightCommitSha, highlightPath]);

  const filteredCaptures = useMemo(() => {
    const normalizedPathFilter = pathFilter.trim().toLowerCase();
    return captures.filter((capture) => {
      const matchesPath =
        normalizedPathFilter.length === 0 ||
        capture.entries.some((entry) => entry.path.toLowerCase().includes(normalizedPathFilter));
      const matchesTrigger = triggerFilter === 'all' || triggerForCapture(capture) === triggerFilter;
      const matchesStatus = statusFilter === 'all' || statusForCapture(capture) === statusFilter;
      return matchesPath && matchesTrigger && matchesStatus;
    });
  }, [captures, pathFilter, statusFilter, triggerFilter]);

  useEffect(() => {
    if (filteredCaptures.length === 0) {
      setSelectedCaptureId(null);
      return;
    }

    if (highlightedCaptureId && filteredCaptures.some((capture) => capture.id === highlightedCaptureId)) {
      setSelectedCaptureId(highlightedCaptureId);
      return;
    }

    if (!selectedCaptureId || !filteredCaptures.some((capture) => capture.id === selectedCaptureId)) {
      setSelectedCaptureId(filteredCaptures[0].id);
    }
  }, [filteredCaptures, highlightedCaptureId, selectedCaptureId]);

  const selectedCapture =
    (selectedCaptureId ? loadedCaptures[selectedCaptureId] ?? captureMap.get(selectedCaptureId) : undefined) ?? undefined;
  const missingCommitMessage =
    highlightCommitSha && !highlightedCaptureId ? `No file capture found for commit ${highlightCommitSha}` : null;

  useHighlightScroll(highlightedCaptureId);

  async function selectCapture(captureId: string): Promise<void> {
    setSelectedCaptureId(captureId);
    setMessage(null);

    if (loadedCaptures[captureId]) {
      return;
    }

    setBusyCaptureId(captureId);
    try {
      const result = await bridge.request<{ capture: TaskFileCaptureWithEntries }>('files.getCapture', { id: captureId });
      setLoadedCaptures((current) => ({ ...current, [captureId]: result.capture }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyCaptureId(null);
    }
  }

  async function openPath(path: string): Promise<void> {
    setMessage(null);
    try {
      await bridge.request('file.open', { path });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div style={styles.root}>
      <section aria-label="File captures" style={styles.card}>
        <h3 style={styles.sectionTitle}>File captures</h3>
        <div style={styles.filters}>
          <label style={styles.filterField}>
            <span style={styles.fieldLabel}>Filter captured files</span>
            <input
              aria-label="Filter captured files"
              value={pathFilter}
              onChange={(event) => setPathFilter(event.target.value)}
              style={styles.input}
            />
          </label>
          <label style={styles.filterField}>
            <span style={styles.fieldLabel}>Trigger</span>
            <select
              aria-label="Capture trigger"
              value={triggerFilter}
              onChange={(event) => setTriggerFilter(event.target.value as TriggerFilter)}
              style={styles.select}
            >
              <option value="all">all</option>
              <option value="explicit">explicit</option>
              <option value="checkpoint">checkpoint</option>
              <option value="commit">commit</option>
            </select>
          </label>
          <label style={styles.filterField}>
            <span style={styles.fieldLabel}>Status</span>
            <select
              aria-label="Capture status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              style={styles.select}
            >
              <option value="all">all</option>
              <option value="captured">captured</option>
              <option value="failed">failed</option>
              <option value="synced">synced</option>
            </select>
          </label>
        </div>
        {captures.length === 0 ? (
          <p style={styles.subtleText}>No file captures for this task yet.</p>
        ) : filteredCaptures.length === 0 ? (
          <p style={styles.subtleText}>No captures match this filter.</p>
        ) : (
          <ul style={styles.captureList}>
            {filteredCaptures.map((capture) => {
              const isHighlighted =
                capture.id === highlightedCaptureId ||
                capture.id === highlightCaptureId ||
                capture.entries.some((entry) => entry.path === highlightPath);
              return (
                <li
                  key={capture.id}
                  data-entity-id={capture.id}
                  style={{ ...styles.captureItem, ...highlightStyle(isHighlighted) }}
                >
                  <button
                    type="button"
                    onClick={() => void selectCapture(capture.id)}
                    aria-pressed={capture.id === selectedCaptureId}
                    style={styles.captureButton}
                  >
                    {capture.id} · {triggerForCapture(capture)} · {statusForCapture(capture)} · {capture.entries.length} file(s)
                  </button>
                  {capture.gitCommitSha ? <p style={styles.meta}>Commit: {capture.gitCommitSha}</p> : null}
                  <ul style={styles.entryList}>
                    {capture.entries.map((entry) => (
                      <li key={entry.path} style={styles.entryRow}>
                        <span style={styles.subtleText}>{entry.path}</span>
                        <button type="button" onClick={() => void openPath(entry.path)} style={styles.secondaryButton}>
                          Open {entry.path}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {busyCaptureId === capture.id ? <p style={styles.subtleText}>Loading capture…</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {missingCommitMessage ? (
        <p role="alert" style={styles.errorBanner}>
          {missingCommitMessage}
        </p>
      ) : null}
      {message ? (
        <p role="alert" style={styles.errorBanner}>
          {message}
        </p>
      ) : null}

      <section aria-label="Selected capture details" style={styles.card}>
        <h3 style={styles.sectionTitle}>Selected capture</h3>
        {selectedCapture ? (
          <div>
            <p style={styles.captureId}>
              <strong>{selectedCapture.id}</strong>
            </p>
            <ul style={styles.diffList}>
              {selectedCapture.entries.map((entry) => (
                <li key={entry.path} style={styles.diffItem}>
                  <p style={styles.subtleText}>Path: {entry.path}</p>
                  <pre aria-label="Unified diff" style={styles.diffBlock}>
                    {renderDiffText(entry.unifiedDiff)}
                  </pre>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p style={styles.subtleText}>Select a capture to view its diff.</p>
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
  card: {
    display: 'grid',
    gap: '0.5rem',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    padding: '0.75rem',
  },
  sectionTitle: {
    margin: 0,
  },
  subtleText: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 4,
  },
  filterField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  fieldLabel: {
    fontSize: '0.85rem',
    color: 'var(--vscode-descriptionForeground)',
  },
  input: {
    minWidth: 240,
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '0.4rem 0.6rem',
    boxSizing: 'border-box',
  },
  select: {
    minWidth: 140,
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '0.4rem 0.6rem',
    boxSizing: 'border-box',
  },
  captureList: {
    display: 'grid',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  captureItem: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    padding: '0.625rem 0.75rem',
  },
  captureButton: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    marginBottom: 8,
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '4px',
    background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-foreground)',
    padding: '0.5rem 0.75rem',
  },
  secondaryButton: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '4px',
    background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-foreground)',
    padding: '0.3rem 0.6rem',
  },
  meta: {
    margin: '4px 0 8px',
    color: 'var(--vscode-descriptionForeground)',
  },
  entryList: {
    margin: '0 0 8px',
    paddingLeft: 20,
  },
  entryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    marginBottom: 6,
  },
  errorBanner: {
    margin: 0,
    borderRadius: '6px',
    padding: '0.625rem 0.875rem',
    background: 'var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground))',
    border: '1px solid var(--vscode-inputValidation-errorBorder, transparent)',
  },
  captureId: {
    margin: 0,
  },
  diffList: {
    display: 'grid',
    gap: '0.75rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  diffItem: {
    display: 'grid',
    gap: '0.375rem',
  },
  diffBlock: {
    margin: 0,
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-textCodeBlock-background, var(--vscode-editor-background))',
    padding: '0.75rem',
    overflowX: 'auto',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '0.85rem',
  },
};
