import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError, isAbortError } from '../api/client';
import {
  isAcceptedOperationResponse,
  isCapturedFile,
  isTasksResponse,
  isTimelineResponse,
} from '../api/guards';
import { useAuth } from '../auth/AuthProvider';
import { OperationProgress } from '../components/OperationProgress';
import type {
  AdminOperation,
  AdminOperationState,
  CapturedFile,
  CapturedFileMetadata,
  TaskSummary,
  TimelineEvent,
} from '../api/types';
import { CaptureDeleteDialog } from './CaptureDeleteDialog';
import { buildCopilotCliCommand, buildTaskContextMarkdown } from './taskContextMarkdown';

type MobilePane = 'tasks' | 'timeline' | 'file';

interface PendingCaptureDelete {
  taskId: string;
  captureId: string;
  files: CapturedFileMetadata[];
  requiresReauthentication: boolean;
}

interface FocusTarget {
  captureId: string;
  path: string;
}

interface LoadTimelineOptions {
  clearSelection?: boolean;
  nextPane?: MobilePane;
  deletedCaptureId?: string | null;
  focusTarget?: FocusTarget | null;
  preserveEventsOnError?: boolean;
  allowRetry?: boolean;
}

interface TimelineRetryRequest {
  taskId: string;
  options: LoadTimelineOptions;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function hasFreshReauthentication(value: string | null): boolean {
  return value !== null && Date.parse(value) > Date.now();
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

function isCaptureEvent(event: TimelineEvent): event is TimelineEvent & { kind: 'capture'; metadata: { files?: CapturedFileMetadata[] } } {
  return event.kind === 'capture';
}

function firstCaptureTarget(events: TimelineEvent[]): FocusTarget | null {
  for (const event of events) {
    if (!isCaptureEvent(event)) {
      continue;
    }
    const firstFile = event.metadata.files?.[0];
    if (firstFile) {
      return {
        captureId: event.id,
        path: firstFile.path,
      };
    }
  }
  return null;
}

function nextCaptureTarget(events: TimelineEvent[], deletedCaptureId: string): FocusTarget | null {
  const captures = events.filter(isCaptureEvent);
  const currentIndex = captures.findIndex((event) => event.id === deletedCaptureId);

  if (currentIndex === -1) {
    return firstCaptureTarget(events);
  }

  const nextEvent = captures[currentIndex + 1] ?? captures[currentIndex - 1] ?? null;
  const nextFile = nextEvent?.metadata.files?.[0];
  return nextEvent && nextFile
    ? {
        captureId: nextEvent.id,
        path: nextFile.path,
      }
    : null;
}

function focusKey(target: FocusTarget): string {
  return `${target.captureId}:${target.path}`;
}

export function TasksPage() {
  const { api, reauthenticate, session } = useAuth();
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<MobilePane>('tasks');
  const [pendingDelete, setPendingDelete] = useState<PendingCaptureDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteOperation, setDeleteOperation] = useState<AdminOperation | null>(null);
  const [timelineRetry, setTimelineRetry] = useState<TimelineRetryRequest | null>(null);
  const timelineControllerRef = useRef<AbortController | null>(null);
  const fileControllerRef = useRef<AbortController | null>(null);
  const deleteControllerRef = useRef<AbortController | null>(null);
  const fileButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const nextFocusTargetRef = useRef<FocusTarget | null>(null);
  const deleteTaskIdRef = useRef<string | null>(null);
  const deletedCaptureIdRef = useRef<string | null>(null);
  const deleteOperationStateRef = useRef<AdminOperationState | null>(null);

  const clearSelectedFile = useCallback(() => {
    fileControllerRef.current?.abort();
    fileControllerRef.current = null;
    setSelectedCaptureId(null);
    setSelectedFile(null);
    setMode('snapshot');
  }, []);

  const abortPendingDelete = useCallback(() => {
    deleteControllerRef.current?.abort();
    deleteControllerRef.current = null;
    setPendingDelete(null);
    setDeleteBusy(false);
    setDeleteError(null);
  }, []);

  const loadTimeline = useCallback(async (taskId: string, options: LoadTimelineOptions = {}): Promise<void> => {
    timelineControllerRef.current?.abort();
    const controller = new AbortController();
    timelineControllerRef.current = controller;

    if (options.clearSelection) {
      clearSelectedFile();
    }

    if (options.nextPane) {
      setActivePane(options.nextPane);
    }

    setDetailLoading(true);
    setError(null);
    setTimelineRetry(null);

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

      if (options.deletedCaptureId) {
        const stillPresent = response.events.some(
          (event) => isCaptureEvent(event) && event.id === options.deletedCaptureId,
        );
        if (!stillPresent) {
          setStatusMessage('Capture deleted.');
          nextFocusTargetRef.current = options.focusTarget ?? firstCaptureTarget(response.events);
          setTasks((current) =>
            current.map((task) =>
              task.taskId === taskId
                ? {
                    ...task,
                    captureCount: response.events.filter(isCaptureEvent).length,
                  }
                : task,
            ),
          );
        }
      }
    } catch (loadError: unknown) {
      if (controller.signal.aborted || isAbortError(loadError)) {
        return;
      }
      if (!options.preserveEventsOnError) {
        setEvents([]);
      }
      setError(loadError instanceof Error ? loadError.message : 'Unable to load task history.');
      if (options.allowRetry) {
        setTimelineRetry({ taskId, options });
      }
    } finally {
      if (timelineControllerRef.current === controller) {
        setDetailLoading(false);
      }
    }
  }, [api, clearSelectedFile]);

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
      deleteControllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const target = nextFocusTargetRef.current;
    if (!target) {
      return;
    }

    const button = fileButtonRefs.current.get(focusKey(target));
    if (!button) {
      return;
    }

    button.focus();
    nextFocusTargetRef.current = null;
  }, [events]);

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
  const [contextActionError, setContextActionError] = useState<string | null>(null);
  const [contextActionFeedback, setContextActionFeedback] = useState<string | null>(null);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);

  const closeExportMenu = useCallback(() => {
    if (exportMenuRef.current) exportMenuRef.current.open = false;
  }, []);

  const downloadTaskContext = useCallback(() => {
    if (!selectedTask) return;
    setContextActionError(null);
    let objectUrl: string | null = null;
    try {
      const markdown = buildTaskContextMarkdown(selectedTask, events);
      const blob = new Blob([markdown], { type: 'text/markdown' });
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `ariadne-task-${selectedTask.localId}-context.md`;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      setContextActionFeedback('Context downloaded.');
    } catch (downloadError: unknown) {
      setContextActionError(
        downloadError instanceof Error ? downloadError.message : 'Unable to download the task context.',
      );
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }, [events, selectedTask]);

  const copyTaskContextForChat = useCallback(async () => {
    if (!selectedTask) return;
    setContextActionError(null);
    try {
      const markdown = buildTaskContextMarkdown(selectedTask, events);
      await navigator.clipboard.writeText(markdown);
      setContextActionFeedback('Copied context for Copilot Chat.');
    } catch (copyError: unknown) {
      setContextActionError(
        copyError instanceof Error ? copyError.message : 'Unable to copy the task context.',
      );
    }
  }, [events, selectedTask]);

  const copyTaskContextCliCommand = useCallback(async () => {
    if (!selectedTask) return;
    setContextActionError(null);
    try {
      const markdown = buildTaskContextMarkdown(selectedTask, events);
      await navigator.clipboard.writeText(buildCopilotCliCommand(markdown));
      setContextActionFeedback('Copied Copilot CLI command.');
    } catch (copyError: unknown) {
      setContextActionError(
        copyError instanceof Error ? copyError.message : 'Unable to copy the Copilot CLI command.',
      );
    }
  }, [events, selectedTask]);

  useEffect(() => {
    if (!contextActionFeedback) return;
    const timer = window.setTimeout(() => setContextActionFeedback(null), 3000);
    return () => window.clearTimeout(timer);
  }, [contextActionFeedback]);

  const selectedCapture = useMemo(
    () =>
      events.find(
        (event): event is TimelineEvent & { kind: 'capture'; metadata: { files?: CapturedFileMetadata[] } } =>
          isCaptureEvent(event) && event.id === selectedCaptureId,
      ) ?? null,
    [events, selectedCaptureId],
  );

  async function selectTask(taskId: string): Promise<void> {
    abortPendingDelete();
    setStatusMessage(null);
    setDeleteOperation(null);
    deleteOperationStateRef.current = null;
    deleteTaskIdRef.current = null;
    deletedCaptureIdRef.current = null;
    setTimelineRetry(null);
    setContextActionError(null);
    setContextActionFeedback(null);
    setSelectedTaskId(taskId);
    await loadTimeline(taskId, {
      clearSelection: true,
      nextPane: 'timeline',
    });
  }

  async function selectFile(captureId: string, path: string): Promise<void> {
    if (!selectedTaskId) {
      return;
    }

    fileControllerRef.current?.abort();
    const controller = new AbortController();
    fileControllerRef.current = controller;
    setStatusMessage(null);
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
      setActivePane('file');
    } catch (loadError: unknown) {
      if (controller.signal.aborted || isAbortError(loadError)) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : 'Unable to decrypt this file.');
    } finally {
      if (fileControllerRef.current === controller) {
        setDetailLoading(false);
      }
    }
  }

  async function confirmDelete(input: { confirmation: string; password?: string }): Promise<void> {
    if (!pendingDelete) {
      return;
    }

    const controller = new AbortController();
    deleteControllerRef.current = controller;
    setDeleteBusy(true);
    setDeleteError(null);
    setStatusMessage(null);

    try {
      if (pendingDelete.requiresReauthentication) {
        await reauthenticate(input.password ?? '', controller.signal);
      }

      const response = await api.mutate(
        'DELETE',
        `/api/v1/admin/tasks/${encodeURIComponent(pendingDelete.taskId)}/file-captures/${encodeURIComponent(pendingDelete.captureId)}`,
        { confirmation: input.confirmation },
        isAcceptedOperationResponse,
        controller.signal,
      );
      if (deleteControllerRef.current !== controller) {
        return;
      }

      deleteTaskIdRef.current = pendingDelete.taskId;
      deletedCaptureIdRef.current = pendingDelete.captureId;
      deleteOperationStateRef.current = response.operation.state;
      nextFocusTargetRef.current = nextCaptureTarget(events, pendingDelete.captureId);
      setDeleteOperation(response.operation);
      setPendingDelete(null);
    } catch (deleteActionError: unknown) {
      if (controller.signal.aborted || isAbortError(deleteActionError)) {
        return;
      }

      if (deleteActionError instanceof AdminApiError && deleteActionError.code === 'reauthentication_required') {
        setPendingDelete((current) =>
          current
            ? {
                ...current,
                requiresReauthentication: true,
              }
            : current,
        );
      }

      setDeleteError(
        deleteActionError instanceof Error
          ? deleteActionError.message
          : 'The file capture could not be deleted.',
      );
    } finally {
      if (deleteControllerRef.current === controller) {
        deleteControllerRef.current = null;
        setDeleteBusy(false);
      }
    }
  }

  const handleDeleteOperationChange = useCallback((operation: AdminOperation | null) => {
    if (!operation) {
      deleteOperationStateRef.current = null;
      return;
    }

    const previousState = deleteOperationStateRef.current;
    deleteOperationStateRef.current = operation.state;

    if (operation.state === previousState) {
      return;
    }

    if (operation.state === 'succeeded') {
      clearSelectedFile();
      setActivePane('timeline');

      const deleteTaskId = deleteTaskIdRef.current;
      if (deleteTaskId && deleteTaskId === selectedTaskId) {
        void loadTimeline(deleteTaskId, {
          deletedCaptureId: deletedCaptureIdRef.current,
          focusTarget: nextFocusTargetRef.current,
          nextPane: 'timeline',
          preserveEventsOnError: true,
          allowRetry: true,
        });
      }
      return;
    }

    if (operation.state === 'failed') {
      setStatusMessage(null);
    }
  }, [clearSelectedFile, loadTimeline, selectedTaskId]);

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

      {statusMessage ? <div className="notice notice--success" role="status">{statusMessage}</div> : null}
      {error ? (
        <div className="notice notice--error notice--actionable" role="alert">
          <span>{error}</span>
          {timelineRetry ? (
            <button
              className="quiet-action"
              type="button"
              onClick={() => void loadTimeline(timelineRetry.taskId, timelineRetry.options)}
            >
              Retry timeline
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="task-workbench" data-active-pane={activePane}>
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
            <div className="pane-actions">
              {selectedTask ? (
                <details className="export-menu" ref={exportMenuRef}>
                  <summary className="quiet-action export-menu__trigger">Export</summary>
                  <div className="export-menu__list" role="menu">
                    <button
                      className="export-menu__item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closeExportMenu();
                        downloadTaskContext();
                      }}
                    >
                      Download context
                    </button>
                    <button
                      className="export-menu__item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closeExportMenu();
                        void copyTaskContextForChat();
                      }}
                    >
                      Copy for Copilot Chat
                    </button>
                    <button
                      className="export-menu__item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closeExportMenu();
                        void copyTaskContextCliCommand();
                      }}
                    >
                      Copy Copilot CLI command
                    </button>
                  </div>
                </details>
              ) : null}
              {selectedTaskId ? (
                <button className="quiet-action pane-toggle" type="button" onClick={() => setActivePane('tasks')}>
                  Tasks
                </button>
              ) : null}
              {events.length ? <span>{events.length} events</span> : null}
            </div>
          </div>
          {contextActionFeedback ? (
            <div className="notice notice--success" role="status">{contextActionFeedback}</div>
          ) : null}
          {contextActionError ? (
            <div className="notice notice--error" role="alert">{contextActionError}</div>
          ) : null}
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
                      {event.metadata.files.map((file) => {
                        const key = focusKey({ captureId: event.id, path: file.path });
                        return (
                          <button
                            key={file.path}
                            ref={(node) => {
                              if (node) {
                                fileButtonRefs.current.set(key, node);
                                return;
                              }
                              fileButtonRefs.current.delete(key);
                            }}
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
                        );
                      })}
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
            <div className="file-pane__controls">
              {selectedCapture ? (
                <button
                  className="quiet-action destructive-action"
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setStatusMessage(null);
                    setPendingDelete({
                      taskId: selectedTaskId ?? '',
                      captureId: selectedCapture.id,
                      files: selectedCapture.metadata.files ?? [],
                      requiresReauthentication: !hasFreshReauthentication(session?.reauthenticatedUntil ?? null),
                    });
                  }}
                >
                  Delete capture {selectedCapture.id}
                </button>
              ) : null}
              {selectedCapture ? (
                <button className="quiet-action pane-toggle" type="button" onClick={() => setActivePane('timeline')}>
                  Timeline
                </button>
              ) : null}
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
          </div>
          <div className="file-content">
            {deleteOperation ? (
              <div className="file-pane__progress">
                <OperationProgress
                  api={api}
                  operationId={deleteOperation.id}
                  initialOperation={deleteOperation}
                  onOperationChange={handleDeleteOperationChange}
                />
              </div>
            ) : null}
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

      {pendingDelete ? (
        <CaptureDeleteDialog
          captureId={pendingDelete.captureId}
          files={pendingDelete.files}
          requiresReauthentication={pendingDelete.requiresReauthentication}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => {
            if (!deleteBusy) {
              setPendingDelete(null);
              setDeleteError(null);
            }
          }}
          onConfirm={confirmDelete}
        />
      ) : null}
    </div>
  );
}
