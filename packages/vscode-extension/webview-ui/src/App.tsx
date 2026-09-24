import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { TaskTemplates, type Task, type TaskTemplateId, type WebviewTabId } from '@host/messages';
import type { AriadneBridge } from './bridge';
import type { WebviewState } from '@host/messages';
import { DecisionsPanel, ErrorsPanel, QuestionsPanel, TodosPanel } from './panels/EntityPanels';
import ActivityPanel from './panels/ActivityPanel';
import ContextPanel from './panels/ContextPanel';
import OverviewPanel from './panels/OverviewPanel';
import FilesPanel from './panels/FilesPanel';
import GraphifyPanel from './panels/GraphifyPanel';
import ReviewPanel from './panels/ReviewPanel';
import SearchPanel from './panels/SearchPanel';
import type { SearchCategory, SearchHit } from './panels/SearchPanel';
import SyncPanel from './panels/SyncPanel';

const categoryTabMap: Record<SearchCategory, TabId> = {
  title: 'overview',
  goal: 'overview',
  checkpoint: 'overview',
  decision: 'decisions',
  todo: 'todos',
  error: 'errors',
  question: 'questions',
  file: 'files',
  commit: 'files',
};

type TabId = 'overview' | 'activity' | 'context' | 'review' | 'graphify' | 'todos' | 'decisions' | 'errors' | 'questions' | 'files' | 'search' | 'sync';

interface NavigationTarget {
  tabId: WebviewTabId;
  entityId?: string;
}

interface AppProps {
  bridge: AriadneBridge;
  initialState?: WebviewState;
}

interface Banner {
  kind: 'error' | 'info';
  message: string;
}

interface FilesNavigationHighlight {
  path?: string;
  captureId?: string;
  commitSha?: string;
}

type TaskTemplateSelection = 'none' | TaskTemplateId;

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'context', label: 'Context' },
  { id: 'review', label: 'Review' },
  { id: 'graphify', label: 'Graphify' },
  { id: 'todos', label: 'Todos' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'errors', label: 'Errors' },
  { id: 'questions', label: 'Questions' },
  { id: 'files', label: 'Files' },
  { id: 'search', label: 'Search' },
  { id: 'sync', label: 'Sync' },
];

function readError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function taskSummary(task: Task): string {
  const parts: string[] = [task.status];
  if (task.branch) parts.push(task.branch);
  if (task.goal) parts.push(task.goal);
  return parts.join(' · ');
}

function taskMatchesFilter(task: Task, filter: string): boolean {
  const value = filter.trim().toLowerCase();
  if (!value) return true;
  return [task.id, task.title, task.goal ?? '', task.branch ?? '', task.status].some((field) =>
    field.toLowerCase().includes(value),
  );
}

function isTabId(value: WebviewTabId): value is TabId {
  return tabs.some((tab) => tab.id === value);
}

export default function App({ bridge, initialState }: AppProps) {
  const [state, setState] = useState<WebviewState | undefined>(initialState);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [taskFilter, setTaskFilter] = useState('');
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [visibleTasks, setVisibleTasks] = useState<Task[]>(initialState?.tasks ?? []);
  const [highlightId, setHighlightId] = useState<string | undefined>(undefined);
  const [filesHighlight, setFilesHighlight] = useState<FilesNavigationHighlight>({});
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskGoal, setNewTaskGoal] = useState('');
  const [newTaskTemplate, setNewTaskTemplate] = useState<TaskTemplateSelection>('none');

  useEffect(() => {
    const unsubscribe = bridge.subscribe((nextState) => {
      setState(nextState);
      if (!allWorkspaces) {
        setVisibleTasks(nextState.tasks);
      }
      setBusyLabel(null);
    });
    return unsubscribe;
  }, [bridge, allWorkspaces]);

  useEffect(() => {
    if (!state) {
      void bridge
        .request<WebviewState>('state.get')
        .then((nextState) => {
          setState(nextState);
          setVisibleTasks(nextState.tasks);
        })
        .catch((error) => setBanner({ kind: 'error', message: readError(error) }));
    }
  }, [bridge, state]);

  useEffect(() => {
    if (!allWorkspaces) {
      setVisibleTasks(state?.tasks ?? []);
    }
  }, [allWorkspaces, state?.tasks]);

  useEffect(() => {
    setHighlightId(undefined);
    setFilesHighlight({});
  }, [state?.currentTaskId]);

  const filteredTasks = useMemo(
    () => visibleTasks.filter((task) => taskMatchesFilter(task, taskFilter)),
    [taskFilter, visibleTasks],
  );
  const showOnboarding = (state?.tasks.length ?? 0) === 0 || !state?.currentTask;

  const handlePanelError = useCallback((message: string): void => {
    setBanner(message ? { kind: 'error', message } : null);
  }, []);

  const handleBusy = useCallback((label: string | undefined): void => {
    setBusyLabel(label ?? null);
  }, []);

  async function switchTask(taskId: string): Promise<boolean> {
    setBusyLabel(`Switching to ${taskId}…`);
    setBanner(null);
    try {
      await bridge.request<{ currentTaskId: string }>('task.switch', { id: taskId });
      return true;
    } catch (error) {
      setBanner({ kind: 'error', message: readError(error) });
      setBusyLabel(null);
      return false;
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = newTaskTitle.trim();
    if (!title) return;

    setBusyLabel('Creating task…');
    setBanner(null);
    try {
      const goal = newTaskGoal.trim() || null;
      if (newTaskTemplate === 'none') {
        await bridge.request('task.create', { title, goal });
      } else {
        await bridge.request('task.createFromTemplate', {
          title,
          goal,
          templateId: newTaskTemplate,
        });
      }
      setNewTaskTitle('');
      setNewTaskGoal('');
      setNewTaskTemplate('none');
      setIsCreatingTask(false);
    } catch (error) {
      setBanner({ kind: 'error', message: readError(error) });
    } finally {
      setBusyLabel(null);
    }
  }

  function cancelCreateTask(): void {
    setIsCreatingTask(false);
    setNewTaskTemplate('none');
  }

  function renderCreateTaskForm(): ReactElement {
    const submitLabel = newTaskTemplate === 'none' ? 'Create task' : 'Create task from template';

    return (
      <form onSubmit={(event) => void createTask(event)} aria-label="New task" style={styles.newTaskForm}>
        <input
          aria-label="New task title"
          placeholder="Task title"
          value={newTaskTitle}
          onChange={(event) => setNewTaskTitle(event.target.value)}
          style={styles.filterInput}
        />
        <input
          aria-label="New task goal"
          placeholder="Task goal (optional)"
          value={newTaskGoal}
          onChange={(event) => setNewTaskGoal(event.target.value)}
          style={styles.filterInput}
        />
        <label style={styles.fieldLabel}>
          <span>Task template</span>
          <select
            aria-label="Task template"
            value={newTaskTemplate}
            onChange={(event) => setNewTaskTemplate(event.target.value as TaskTemplateSelection)}
            style={styles.selectInput}
          >
            <option value="none">none</option>
            {Object.values(TaskTemplates).map((template) => (
              <option key={template.id} value={template.id}>
                {template.id}
              </option>
            ))}
          </select>
        </label>
        <div style={styles.actionsRow}>
          <button type="submit" style={styles.toolbarButton}>
            {submitLabel}
          </button>
          <button type="button" onClick={cancelCreateTask} style={styles.toolbarButton}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  async function navigateToSearchHit(hit: SearchHit): Promise<void> {
    setBanner(null);
    if (hit.taskId !== state?.currentTaskId) {
      const switched = await switchTask(hit.taskId);
      if (!switched) return;
    }

    if (hit.category === 'file') {
      setHighlightId(undefined);
      setFilesHighlight({ path: hit.id });
      setActiveTab('files');
      return;
    }

    if (hit.category === 'commit') {
      setHighlightId(undefined);
      setFilesHighlight({ commitSha: hit.id });
      setActiveTab('files');
      return;
    }

    setFilesHighlight({});
    setActiveTab(categoryTabMap[hit.category]);
    setHighlightId(hit.id);
  }

  function navigateToPanel(target: NavigationTarget): void {
    if (!isTabId(target.tabId)) return;
    setActiveTab(target.tabId);
    if (target.tabId === 'files') {
      setHighlightId(undefined);
      setFilesHighlight({ captureId: target.entityId });
      return;
    }

    setFilesHighlight({});
    setHighlightId(target.entityId);
  }

  function selectTab(tabId: TabId): void {
    setActiveTab(tabId);
    setHighlightId(undefined);
    setFilesHighlight({});
  }

  async function toggleAllWorkspaces(nextValue: boolean): Promise<void> {
    setAllWorkspaces(nextValue);
    setBanner(null);
    if (!nextValue) {
      setVisibleTasks(state?.tasks ?? []);
      setBusyLabel(null);
      return;
    }

    setBusyLabel('Loading all workspaces…');
    try {
      const result = await bridge.request<{ tasks: Task[] }>('tasks.list', { allWorkspaces: true });
      setVisibleTasks(result.tasks);
    } catch (error) {
      setBanner({ kind: 'error', message: readError(error) });
      setAllWorkspaces(false);
      setVisibleTasks(state?.tasks ?? []);
    } finally {
      setBusyLabel(null);
    }
  }

  async function runSyncPush(): Promise<void> {
    setBusyLabel('Syncing to cloud…');
    setBanner(null);
    try {
      const result = await bridge.request<{ output: string }>('sync.push');
      setBusyLabel(result.output);
    } catch (error) {
      setBanner({ kind: 'error', message: readError(error) });
      setBusyLabel(null);
    }
  }

  async function runExportMarkdown(): Promise<void> {
    setBusyLabel('Exporting to Markdown…');
    setBanner(null);
    try {
      const result = await bridge.request<{ path: string; markdown: string }>('export.markdown');
      setBusyLabel(`Exported task markdown to ${result.path}`);
    } catch (error) {
      setBanner({ kind: 'error', message: readError(error) });
      setBusyLabel(null);
    }
  }

  const tabContent = (() => {
    switch (activeTab) {
      case 'overview':
        return showOnboarding ? (
          <section style={styles.onboardingCard} aria-label="Onboarding">
            <div style={styles.onboardingHeader}>
              <h3 style={styles.onboardingTitle}>Start your first Ariadne task</h3>
              <p style={styles.subtleText}>
                Create a task from scratch or use a template to seed the work with the right starting prompts.
              </p>
            </div>
            <div style={styles.actionsRow}>
              <button type="button" onClick={() => setActiveTab('sync')} style={styles.toolbarButton}>
                Import or sync tasks
              </button>
              <button type="button" onClick={() => setActiveTab('context')} style={styles.toolbarButton}>
                Open context help
              </button>
            </div>
            {isCreatingTask ? (
              renderCreateTaskForm()
            ) : (
              <button type="button" onClick={() => setIsCreatingTask(true)} style={styles.primaryButton}>
                Create task
              </button>
            )}
          </section>
        ) : state ? (
          <OverviewPanel
            state={state}
            bridge={bridge}
            onBusy={handleBusy}
            onError={handlePanelError}
            highlightCheckpointId={highlightId}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'activity':
        return state ? (
          <ActivityPanel
            bridge={bridge}
            taskId={state.currentTaskId}
            onNavigate={navigateToPanel}
            onBusy={handleBusy}
            onError={handlePanelError}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'context':
        return state ? (
          <ContextPanel bridge={bridge} taskId={state.currentTaskId} onBusy={handleBusy} onError={handlePanelError} />
        ) : (
          <p>No task selected.</p>
        );
      case 'review':
        return state ? (
          <ReviewPanel
            bridge={bridge}
            taskId={state.currentTaskId}
            onNavigate={navigateToPanel}
            onBusy={handleBusy}
            onError={handlePanelError}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'graphify':
        return <GraphifyPanel bridge={bridge} workspaceRoot={state?.workspaceRoot} onBusy={handleBusy} onError={handlePanelError} />;
      case 'todos':
        return state ? (
          <TodosPanel
            state={state}
            bridge={bridge}
            onBusy={handleBusy}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'decisions':
        return state ? (
          <DecisionsPanel
            state={state}
            bridge={bridge}
            onBusy={handleBusy}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'errors':
        return state ? (
          <ErrorsPanel
            state={state}
            bridge={bridge}
            onBusy={handleBusy}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'questions':
        return state ? (
          <QuestionsPanel
            state={state}
            bridge={bridge}
            onBusy={handleBusy}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'files':
        return state ? (
          <FilesPanel
            bridge={bridge}
            captures={state.fileCaptures}
            highlightPath={filesHighlight.path}
            highlightCaptureId={filesHighlight.captureId}
            highlightCommitSha={filesHighlight.commitSha}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'search':
        return <SearchPanel bridge={bridge} initialResults={state?.searchResults ?? []} onNavigate={(hit) => void navigateToSearchHit(hit)} />;
      case 'sync':
        return <SyncPanel bridge={bridge} />;
      default:
        return null;
    }
  })();

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Ariadne</h1>
          <p style={styles.subtle}>{busyLabel ?? 'Ready'}</p>
        </div>
        <div style={styles.toolbar}>
          <button type="button" onClick={runSyncPush} style={styles.toolbarButton}>
            Sync to Cloud
          </button>
          <button type="button" onClick={runExportMarkdown} style={styles.toolbarButton}>
            Export to Markdown
          </button>
        </div>
      </header>

      {banner ? (
        <div role="alert" style={banner.kind === 'error' ? styles.errorBanner : styles.infoBanner}>
          {banner.message}
        </div>
      ) : null}

      <div style={styles.main}>
        <aside style={styles.taskRail}>
          <div style={styles.railHeader}>
            <label style={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={allWorkspaces}
                onChange={(event) => void toggleAllWorkspaces(event.target.checked)}
              />
              All workspaces
            </label>
            <input
              value={taskFilter}
              onChange={(event) => setTaskFilter(event.target.value)}
              placeholder="Filter tasks"
              aria-label="Filter tasks"
              style={styles.filterInput}
            />
            {isCreatingTask && !showOnboarding ? (
              renderCreateTaskForm()
            ) : !showOnboarding ? (
              <button type="button" onClick={() => setIsCreatingTask(true)} style={styles.toolbarButton}>
                New task
              </button>
            ) : null}
          </div>

          <div style={styles.taskList}>
            {filteredTasks.length === 0 ? (
              <p style={styles.emptyState}>{showOnboarding ? 'No tasks yet. Create one or sync an existing task.' : 'No tasks match the current filter.'}</p>
            ) : (
              filteredTasks.map((task) => {
                const active = task.id === state?.currentTaskId;
                return (
                  <button
                    key={task.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      void switchTask(task.id);
                      setHighlightId(undefined);
                    }}
                    style={active ? { ...styles.taskButton, ...styles.taskButtonActive } : styles.taskButton}
                  >
                    <strong>{task.title}</strong>
                    <span style={styles.taskMeta}>{taskSummary(task)}</span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <main style={styles.content}>
          <div style={styles.tabBar}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={activeTab === tab.id}
                onClick={() => selectTab(tab.id)}
                style={activeTab === tab.id ? { ...styles.tabButton, ...styles.tabButtonActive } : styles.tabButton}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <section style={styles.panel}>
            {activeTab === 'overview' ? (
              <h2 style={styles.sectionTitle}>{tabs.find((tab) => tab.id === activeTab)?.label}</h2>
            ) : (
              <div style={styles.sectionTitle}>{tabs.find((tab) => tab.id === activeTab)?.label}</div>
            )}
            {tabContent}
          </section>
        </main>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#f4f7fb',
    background: '#0f172a',
    minHeight: '100vh',
    padding: '1rem',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    marginBottom: '0.75rem',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
  },
  subtle: {
    margin: '0.25rem 0 0',
    color: '#94a3b8',
  },
  toolbar: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  toolbarButton: {
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#e2e8f0',
    borderRadius: '0.5rem',
    padding: '0.5rem 0.875rem',
    cursor: 'pointer',
  },
  errorBanner: {
    borderRadius: '0.75rem',
    padding: '0.75rem 1rem',
    background: '#7f1d1d',
    color: '#fecaca',
    marginBottom: '0.75rem',
  },
  infoBanner: {
    borderRadius: '0.75rem',
    padding: '0.75rem 1rem',
    background: '#1e3a8a',
    color: '#dbeafe',
    marginBottom: '0.75rem',
  },
  main: {
    display: 'grid',
    gridTemplateColumns: '320px minmax(0, 1fr)',
    gap: '1rem',
    minHeight: 'calc(100vh - 6rem)',
  },
  taskRail: {
    border: '1px solid #334155',
    borderRadius: '0.75rem',
    background: '#111827',
    padding: '0.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  railHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  toggleLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  filterInput: {
    width: '100%',
    border: '1px solid #334155',
    borderRadius: '0.5rem',
    background: '#0f172a',
    color: '#e2e8f0',
    padding: '0.5rem 0.75rem',
    boxSizing: 'border-box',
  },
  newTaskForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  actionsRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    color: '#cbd5e1',
    fontSize: '0.875rem',
  },
  selectInput: {
    width: '100%',
    border: '1px solid #334155',
    borderRadius: '0.5rem',
    background: '#0f172a',
    color: '#e2e8f0',
    padding: '0.5rem 0.75rem',
    boxSizing: 'border-box',
  },
  taskList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    overflowY: 'auto',
  },
  taskButton: {
    border: '1px solid #334155',
    borderRadius: '0.75rem',
    background: '#0f172a',
    color: '#e2e8f0',
    textAlign: 'left',
    padding: '0.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    cursor: 'pointer',
  },
  taskButtonActive: {
    boxShadow: '0 0 0 1px #60a5fa inset',
  },
  taskMeta: {
    fontSize: '0.875rem',
    color: '#94a3b8',
  },
  emptyState: {
    color: '#94a3b8',
    margin: 0,
  },
  subtleText: {
    margin: 0,
    color: '#cbd5e1',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  tabBar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  tabButton: {
    border: '1px solid #334155',
    borderRadius: '999px',
    background: '#111827',
    color: '#e2e8f0',
    padding: '0.45rem 0.9rem',
    cursor: 'pointer',
  },
  tabButtonActive: {
    background: '#1d4ed8',
    boxShadow: '0 0 0 1px #60a5fa inset',
  },
  panel: {
    border: '1px solid #334155',
    borderRadius: '0.75rem',
    background: '#111827',
    padding: '1rem',
    minHeight: '20rem',
  },
  sectionTitle: {
    marginTop: 0,
  },
  onboardingCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    padding: '1rem',
    border: '1px solid #334155',
    borderRadius: '0.75rem',
    background: '#0f172a',
  },
  onboardingHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  onboardingTitle: {
    margin: 0,
    fontSize: '1.25rem',
  },
  primaryButton: {
    border: '1px solid #2563eb',
    background: '#2563eb',
    color: '#eff6ff',
    borderRadius: '0.5rem',
    padding: '0.625rem 1rem',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
};
