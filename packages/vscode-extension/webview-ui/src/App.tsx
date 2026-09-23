import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type { Task } from '@host/messages';
import type { AriadneBridge } from './bridge';
import type { WebviewState } from '@host/messages';
import { DecisionsPanel, ErrorsPanel, QuestionsPanel, TodosPanel } from './panels/EntityPanels';
import OverviewPanel from './panels/OverviewPanel';
import FilesPanel from './panels/FilesPanel';
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

type TabId = 'overview' | 'todos' | 'decisions' | 'errors' | 'questions' | 'files' | 'search' | 'sync';

interface AppProps {
  bridge: AriadneBridge;
  initialState?: WebviewState;
}

interface Banner {
  kind: 'error' | 'info';
  message: string;
}

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
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
  const parts = [task.status];
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

export default function App({ bridge, initialState }: AppProps) {
  const [state, setState] = useState<WebviewState | undefined>(initialState);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [taskFilter, setTaskFilter] = useState('');
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [visibleTasks, setVisibleTasks] = useState<Task[]>(initialState?.tasks ?? []);
  const [highlightId, setHighlightId] = useState<string | undefined>(undefined);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskGoal, setNewTaskGoal] = useState('');

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

  const filteredTasks = useMemo(
    () => visibleTasks.filter((task) => taskMatchesFilter(task, taskFilter)),
    [taskFilter, visibleTasks],
  );

  function handlePanelError(message: string): void {
    setBanner(message ? { kind: 'error', message } : null);
  }

  async function switchTask(taskId: string): Promise<void> {
    setBusyLabel(`Switching to ${taskId}…`);
    setBanner(null);
    try {
      await bridge.request<{ currentTaskId: string }>('task.switch', { id: taskId });
    } catch (error) {
      setBanner({ kind: 'error', message: readError(error) });
      setBusyLabel(null);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = newTaskTitle.trim();
    if (!title) return;

    setBusyLabel('Creating task…');
    setBanner(null);
    try {
      await bridge.request('task.create', { title, goal: newTaskGoal.trim() || null });
      setNewTaskTitle('');
      setNewTaskGoal('');
      setIsCreatingTask(false);
    } catch (error) {
      setBanner({ kind: 'error', message: readError(error) });
    } finally {
      setBusyLabel(null);
    }
  }

  async function navigateToSearchHit(hit: SearchHit): Promise<void> {
    setBanner(null);
    if (hit.taskId !== state?.currentTaskId) {
      await switchTask(hit.taskId);
    }
    setActiveTab(categoryTabMap[hit.category]);
    setHighlightId(hit.id);
  }

  function selectTab(tabId: TabId): void {
    setActiveTab(tabId);
    setHighlightId(undefined);
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
        return state ? (
          <OverviewPanel
            state={state}
            bridge={bridge}
            onBusy={setBusyLabel}
            onError={handlePanelError}
            highlightCheckpointId={highlightId}
          />
        ) : (
          <p>No task selected.</p>
        );
      case 'todos':
        return (
          <TodosPanel
            state={state}
            bridge={bridge}
            onBusy={setBusyLabel}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        );
      case 'decisions':
        return (
          <DecisionsPanel
            state={state}
            bridge={bridge}
            onBusy={setBusyLabel}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        );
      case 'errors':
        return (
          <ErrorsPanel
            state={state}
            bridge={bridge}
            onBusy={setBusyLabel}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        );
      case 'questions':
        return (
          <QuestionsPanel
            state={state}
            bridge={bridge}
            onBusy={setBusyLabel}
            onError={handlePanelError}
            highlightId={highlightId}
          />
        );
      case 'files':
        return state ? <FilesPanel bridge={bridge} captures={state.fileCaptures} /> : <p>No task selected.</p>;
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
            {isCreatingTask ? (
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
                <div style={styles.actionsRow}>
                  <button type="submit" style={styles.toolbarButton}>
                    Create task
                  </button>
                  <button type="button" onClick={() => setIsCreatingTask(false)} style={styles.toolbarButton}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" onClick={() => setIsCreatingTask(true)} style={styles.toolbarButton}>
                New task
              </button>
            )}
          </div>

          <div style={styles.taskList}>
            {filteredTasks.length === 0 ? (
              <p style={styles.emptyState}>No tasks match the current filter.</p>
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
};
