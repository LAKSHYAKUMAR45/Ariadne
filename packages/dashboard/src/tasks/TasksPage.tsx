import { useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError } from '../api/client';
import { isCapturedFile, isTasksResponse, isTimelineResponse } from '../api/guards';
import { useAuth } from '../auth/AuthProvider';
import type { CapturedFile, TaskSummary, TimelineEvent } from '../api/types';

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function EventGlyph({ kind }: { kind: string }) {
  const glyphs: Record<string, string> = {
    task: 'TS',
    checkpoint: 'CP',
    capture: 'FL',
    command: '>_',
    commit: 'GT',
    decision: 'DC',
    todo: 'TD',
    error: '!!',
    question: '??',
  };
  return <span className={`event-glyph event-glyph--${kind}`} aria-hidden="true">{glyphs[kind] ?? 'EV'}</span>;
}

export function TasksPage() {
  const { api } = useAuth();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<CapturedFile | null>(null);
  const [mode, setMode] = useState<'snapshot' | 'diff'>('snapshot');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timelineControllerRef = useRef<AbortController | null>(null);
  const fileControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/api/v1/admin/tasks?limit=100', isTasksResponse, controller.signal)
      .then((response) => setTasks(response.tasks))
      .catch((loadError: unknown) => {
        if (!isAbortError(loadError)) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load tasks.');
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [api]);

  useEffect(
    () => () => {
      timelineControllerRef.current?.abort();
      fileControllerRef.current?.abort();
    },
    [],
  );

  const filteredTasks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return tasks;
    }
    return tasks.filter((task) =>
      [task.title, task.goal, task.workspaceLabel, task.branch]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalized)),
    );
  }, [query, tasks]);

  const selectedTask = tasks.find((task) => task.taskId === selectedTaskId) ?? null;

  async function selectTask(taskId: string): Promise<void> {
    timelineControllerRef.current?.abort();
    fileControllerRef.current?.abort();
    const controller = new AbortController();
    timelineControllerRef.current = controller;
    setSelectedTaskId(taskId);
    setSelectedCaptureId(null);
    setSelectedFile(null);
    setEvents([]);
    setDetailLoading(true);
    setError(null);
    try {
      const response = await api.get(
        `/api/v1/admin/tasks/${encodeURIComponent(taskId)}/timeline`,
        isTimelineResponse,
        controller.signal,
      );
      if (timelineControllerRef.current !== controller) {
        return;
      }
      setEvents(response.events);
    } catch (loadError: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      setEvents([]);
      setError(loadError instanceof Error ? loadError.message : 'Unable to load task history.');
    } finally {
      if (timelineControllerRef.current === controller) {
        setDetailLoading(false);
      }
    }
  }

  async function selectFile(captureId: string, path: string): Promise<void> {
    if (!selectedTaskId) {
      return;
    }
    fileControllerRef.current?.abort();
    const controller = new AbortController();
    fileControllerRef.current = controller;
    setSelectedCaptureId(captureId);
    setSelectedFile(null);
    setDetailLoading(true);
    setError(null);
    try {
      const file = await api.get(
        `/api/v1/admin/tasks/${encodeURIComponent(selectedTaskId)}/file-captures/${encodeURIComponent(captureId)}/files/${encodeURIComponent(path)}`,
        isCapturedFile,
        controller.signal,
      );
      if (fileControllerRef.current !== controller) {
        return;
      }
      setSelectedFile(file);
      setMode('snapshot');
    } catch (loadError: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : 'Unable to decrypt this file.');
    } finally {
      if (fileControllerRef.current === controller) {
        setDetailLoading(false);
      }
    }
  }

  return (
    <div className="task-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Synced work</p>
          <h1>Task history</h1>
          <p>Trace decisions, commands, commits, and the exact files captured along the way.</p>
        </div>
        <div className="task-count">
          <strong>{tasks.length}</strong>
          <span>tasks</span>
        </div>
      </header>

      {error ? <div className="notice notice--error" role="alert">{error}</div> : null}

      <div className="task-workbench">
        <aside className="task-list" aria-label="Tasks">
          <div className="pane-heading">
            <strong>Workspace tasks</strong>
            <span>{filteredTasks.length}</span>
          </div>
          <label className="search-field">
            <span className="sr-only">Search tasks</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter title, branch, workspace..."
            />
          </label>
          <div className="scroll-region">
            {loading ? <p className="pane-message">Loading tasks...</p> : null}
            {!loading && filteredTasks.length === 0 ? (
              <p className="pane-message">No tasks match this filter.</p>
            ) : null}
            {filteredTasks.map((task) => (
              <button
                key={task.taskId}
                type="button"
                className={task.taskId === selectedTaskId ? 'task-row task-row--selected' : 'task-row'}
                onClick={() => void selectTask(task.taskId)}
              >
                <span className={`task-state task-state--${task.status}`} />
                <span className="task-row-copy">
                  <strong>{task.title}</strong>
                  <span>{task.workspaceLabel ?? 'Unlabelled workspace'} · {task.branch ?? 'no branch'}</span>
                  <time dateTime={task.updatedAt}>{formatTime(task.updatedAt)}</time>
                </span>
                <span className="capture-count">{task.captureCount}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="timeline-pane" aria-label="Task timeline">
          <div className="pane-heading">
            <div>
              <strong>{selectedTask?.title ?? 'Timeline'}</strong>
              <span>{selectedTask?.status ?? 'Select a task'}</span>
            </div>
            {events.length ? <span>{events.length} events</span> : null}
          </div>
          <div className="scroll-region timeline">
            {!selectedTaskId ? (
              <div className="pane-empty">
                <span>01</span>
                <p>Select a task to inspect its timeline and captured files.</p>
              </div>
            ) : null}
            {detailLoading && events.length === 0 ? <p className="pane-message">Loading timeline...</p> : null}
            {events.map((event) => (
              <article className="timeline-event" key={`${event.kind}-${event.id}`}>
                <EventGlyph kind={event.kind} />
                <div className="event-copy">
                  <div className="event-meta">
                    <strong>{event.kind}</strong>
                    <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                  </div>
                  <p>{event.summary}</p>
                  {event.kind === 'capture' && event.metadata.files?.length ? (
                    <div className="capture-files">
                      {event.metadata.files.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          className={
                            selectedCaptureId === event.id && selectedFile?.path === file.path
                              ? 'file-row file-row--selected'
                              : 'file-row'
                          }
                          onClick={() => void selectFile(event.id, file.path)}
                        >
                          <span>{file.path}</span>
                          <small>{file.byteLength.toLocaleString()} B</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="file-pane" aria-label="Captured file">
          <div className="pane-heading">
            <div>
              <strong>{selectedFile?.path ?? 'File inspector'}</strong>
              <span>{selectedFile ? `${selectedFile.byteLength.toLocaleString()} bytes` : 'Snapshot and diff'}</span>
            </div>
            {selectedFile ? (
              <div className="segmented-control" aria-label="File view">
                <button
                  type="button"
                  className={mode === 'snapshot' ? 'is-active' : ''}
                  onClick={() => setMode('snapshot')}
                >
                  Snapshot
                </button>
                <button
                  type="button"
                  className={mode === 'diff' ? 'is-active' : ''}
                  onClick={() => setMode('diff')}
                >
                  Diff
                </button>
              </div>
            ) : null}
          </div>
          <div className="file-content">
            {detailLoading && !selectedFile ? <p className="pane-message">Decrypting file...</p> : null}
            {!selectedFile && !detailLoading ? (
              <div className="pane-empty">
                <span>02</span>
                <p>Choose a captured file from the timeline to inspect its contents.</p>
              </div>
            ) : null}
            {selectedFile ? (
              <pre className={mode === 'diff' ? 'code-view code-view--diff' : 'code-view'}>
                <code>{mode === 'snapshot' ? selectedFile.content : selectedFile.unifiedDiff}</code>
              </pre>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
