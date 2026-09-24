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
  return isHighlighted ? { boxShadow: '0 0 0 2px #facc15 inset', background: '#1e293b' } : {};
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
    <div>
      <section aria-label="File captures">
        <h3>File captures</h3>
        <div style={styles.filters}>
          <label style={styles.filterField}>
            <span>Filter captured files</span>
            <input
              aria-label="Filter captured files"
              value={pathFilter}
              onChange={(event) => setPathFilter(event.target.value)}
              style={styles.input}
            />
          </label>
          <label style={styles.filterField}>
            <span>Trigger</span>
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
            <span>Status</span>
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
          <p>No file captures for this task yet.</p>
        ) : filteredCaptures.length === 0 ? (
          <p>No captures match this filter.</p>
        ) : (
          <ul>
            {filteredCaptures.map((capture) => {
              const isHighlighted =
                capture.id === highlightedCaptureId ||
                capture.id === highlightCaptureId ||
                capture.entries.some((entry) => entry.path === highlightPath);
              return (
                <li key={capture.id} data-entity-id={capture.id} style={highlightStyle(isHighlighted)}>
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
                        <span>{entry.path}</span>
                        <button type="button" onClick={() => void openPath(entry.path)}>
                          Open {entry.path}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {busyCaptureId === capture.id ? <p>Loading capture…</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {missingCommitMessage ? <p role="alert">{missingCommitMessage}</p> : null}
      {message ? <p role="alert">{message}</p> : null}

      <section aria-label="Selected capture details">
        <h3>Selected capture</h3>
        {selectedCapture ? (
          <div>
            <p>
              <strong>{selectedCapture.id}</strong>
            </p>
            <ul>
              {selectedCapture.entries.map((entry) => (
                <li key={entry.path}>
                  <p>Path: {entry.path}</p>
                  <pre aria-label="Unified diff">{renderDiffText(entry.unifiedDiff)}</pre>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>Select a capture to view its diff.</p>
        )}
      </section>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 16,
  },
  filterField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  input: {
    minWidth: 240,
  },
  select: {
    minWidth: 140,
  },
  captureButton: {
    display: 'block',
    marginBottom: 8,
  },
  meta: {
    margin: '4px 0 8px',
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
};
