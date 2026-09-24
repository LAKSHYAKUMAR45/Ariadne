import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import type { AriadneBridge, AriadneRequestType } from './bridge';
import type { SearchResult, Task, TaskFileCaptureWithEntries, WebviewState } from '@host/messages';

const task1: Task = {
  id: 'task-1',
  title: 'Panel task',
  goal: 'Make UI useful',
  status: 'active',
  parentTaskId: null,
  branch: 'feat/ui',
  createdAt: '',
  updatedAt: '',
  remoteId: null,
  syncedAt: null,
};

const task2: Task = {
  id: 'task-2',
  title: 'Other task',
  goal: 'Exercise the shell',
  status: 'paused',
  parentTaskId: null,
  branch: 'feat/other',
  createdAt: '',
  updatedAt: '',
  remoteId: null,
  syncedAt: null,
};

const fileCaptures: TaskFileCaptureWithEntries[] = [
  {
    id: 'capture-1',
    taskId: task1.id,
    trigger: 'explicit',
    gitCommitSha: null,
    checkpointId: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    syncedAt: null,
    failedAt: null,
    failureCode: null,
    entries: [
      {
        captureId: 'capture-1',
        path: 'src/App.tsx',
        content: 'console.log("updated");\n',
        unifiedDiff: ['@@ -1,1 +1,1 @@', '-console.log("old");', '+console.log("updated");'].join('\n'),
        byteLength: 24,
        contentSha256: 'sha256-1',
      },
    ],
  },
  {
    id: 'capture-2',
    taskId: task1.id,
    trigger: 'git_commit',
    gitCommitSha: 'abc1234',
    checkpointId: null,
    createdAt: '2026-09-23T00:01:00.000Z',
    syncedAt: '2026-09-23T00:02:00.000Z',
    failedAt: null,
    failureCode: null,
    entries: [
      {
        captureId: 'capture-2',
        path: 'src/FilesPanel.tsx',
        content: 'export function FilesPanel() {}\n',
        unifiedDiff: ['@@ -1,0 +1,1 @@', '+export function FilesPanel() {}'].join('\n'),
        byteLength: 32,
        contentSha256: 'sha256-2',
      },
    ],
  },
];

const fileAndCommitSearchResults: SearchResult[] = [
  {
    taskId: task1.id,
    taskTitle: task1.title,
    taskStatus: task1.status,
    matches: [
      { category: 'file', id: 'src/App.tsx', text: 'src/App.tsx', createdAt: '2026-09-23T00:00:00.000Z' },
      { category: 'commit', id: 'abc1234', text: 'abc1234', createdAt: '2026-09-23T00:01:00.000Z' },
    ],
  },
];

const baseState: WebviewState = {
  workspaceRoot: '/repo',
  currentTaskId: task1.id,
  currentTask: task1,
  tasks: [task1],
  checkpoints: [],
  todos: [],
  decisions: [],
  errors: [],
  questions: [],
  fileCaptures: [],
  searchResults: [],
  counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
};

type BridgeHarness = AriadneBridge & {
  request: ReturnType<typeof vi.fn>;
  emitState: (state: WebviewState) => void;
};

function makeRequestMock(impl: (type: AriadneRequestType, payload?: unknown) => Promise<unknown>): BridgeHarness['request'] {
  return vi.fn(impl) as BridgeHarness['request'];
}

function bridge(overrides: Partial<BridgeHarness> = {}): BridgeHarness {
  let listener: ((state: WebviewState) => void) | undefined;
  const request = makeRequestMock(async (type) => {
    switch (type) {
      case 'tasks.list':
        return { tasks: [task1, task2] };
      case 'sync.push':
        return { output: 'Pushed to cloud' };
      case 'export.markdown':
        return { path: '/repo/.ariadne/export/task-1.md', markdown: '# task' };
      case 'review.get':
        return { review: { taskId: task1.id, canMarkDone: true, checks: [] } };
      case 'task.switch':
        return { currentTaskId: task2.id };
      default:
        return baseState;
    }
  });

  const harness: BridgeHarness = {
    request,
    subscribe: vi.fn((nextListener: (state: WebviewState) => void) => {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    }),
    emitState: (state: WebviewState) => {
      listener?.(state);
    },
    ...overrides,
  };

  return harness;
}

function countRequests(harness: BridgeHarness, type: string): number {
  return harness.request.mock.calls.filter((call: unknown[]) => call[0] === type).length;
}

async function settleAfterStateUpdates(harness: BridgeHarness, state: WebviewState): Promise<void> {
  await act(async () => {
    harness.emitState(state);
    harness.emitState({ ...state });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('App', () => {
  it('renders the task rail, toolbar, and tabs from the initial state', () => {
    render(<App bridge={bridge()} initialState={baseState} />);
    expect(screen.getByRole('heading', { name: 'Ariadne' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync to Cloud' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export to Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Context' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Graphify' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Panel task/ })).toBeInTheDocument();
  });

  it('switches to the activity, context, and review tabs', async () => {
    render(<App bridge={bridge()} initialState={baseState} />);

    await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Context' }));
    expect(screen.getByRole('button', { name: 'Context' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: 'Review' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches tabs without routing', async () => {
    render(<App bridge={bridge()} initialState={baseState} />);
    const [todosButton] = screen.getAllByRole('button', { name: 'Todos' });
    await userEvent.click(todosButton);
    expect(todosButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Todos' })).toBeInTheDocument();
  });

  it('requests sync.push and export.markdown from the toolbar', async () => {
    const harness = bridge();
    render(<App bridge={harness} initialState={baseState} />);

    await userEvent.click(screen.getByRole('button', { name: 'Sync to Cloud' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('sync.push'));
    expect(screen.getByText('Pushed to cloud')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Export to Markdown' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('export.markdown'));
    expect(screen.getByText('Exported task markdown to /repo/.ariadne/export/task-1.md')).toBeInTheDocument();
  });

  it('switches tasks through the bridge and reflects the host state update', async () => {
    const harness = bridge();
    render(
      <App
        bridge={harness}
        initialState={{
          ...baseState,
          tasks: [task1, task2],
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Other task/ }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('task.switch', { id: task2.id }));

    harness.emitState({
      ...baseState,
      currentTaskId: task2.id,
      currentTask: task2,
      tasks: [task1, task2],
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Other task/ })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Other task/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('requests the all-workspaces task list and updates the rail', async () => {
    const harness = bridge();
    render(<App bridge={harness} initialState={baseState} />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'All workspaces' }));

    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('tasks.list', { allWorkspaces: true }));
    expect(screen.getByRole('button', { name: /Other task/ })).toBeInTheDocument();
  });

  it('creates a new task through the New Task form', async () => {
    const harness = bridge();
    render(<App bridge={harness} initialState={baseState} />);

    await userEvent.click(screen.getByRole('button', { name: 'New task' }));
    await userEvent.type(screen.getByLabelText('New task title'), 'Ship the dashboard');
    await userEvent.type(screen.getByLabelText('New task goal'), 'Ship it well');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('task.create', {
        title: 'Ship the dashboard',
        goal: 'Ship it well',
      }),
    );
  });

  it('shows onboarding when no task exists and creates a templated task', async () => {
    const request = vi.fn(async (_type: string, payload?: unknown) => payload ?? {}) as unknown as AriadneBridge['request'];
    render(
      <App
        bridge={{ request, subscribe: vi.fn(() => () => undefined) }}
        initialState={{ ...baseState, currentTaskId: undefined, currentTask: undefined, tasks: [] }}
      />,
    );

    expect(screen.getByText('Start your first Ariadne task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import or sync tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open context help' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await userEvent.type(screen.getByLabelText('New task title'), 'Fix login bug');
    await userEvent.selectOptions(screen.getByLabelText('Task template'), 'bugfix');
    await userEvent.click(screen.getByRole('button', { name: 'Create task from template' }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('task.createFromTemplate', {
        title: 'Fix login bug',
        goal: null,
        templateId: 'bugfix',
      }),
    );
  });

  it('navigates to a search result tab and highlights the matching entity', async () => {
    const harness = bridge({
      request: makeRequestMock(async (type) => {
        if (type === 'search.run') {
          return {
            results: [
              {
                taskId: task1.id,
                taskTitle: task1.title,
                taskStatus: task1.status,
                matches: [
                  { category: 'todo', id: 'todo-1', text: 'Finish onboarding', createdAt: '2026-09-23T00:00:00.000Z' },
                ],
              },
            ],
          };
        }
        return baseState;
      }),
    });

    render(
      <App
        bridge={harness}
        initialState={{
          ...baseState,
          todos: [
            {
              id: 'todo-1',
              taskId: task1.id,
              text: 'Finish onboarding',
              status: 'pending',
              sourceCheckpointId: null,
              createdAt: '',
              updatedAt: '',
              remoteId: null,
              syncedAt: null,
            },
          ],
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.type(screen.getByRole('textbox', { name: /search query/i }), 'onboarding');
    const searchSubmitButtons = screen.getAllByRole('button', { name: 'Search' });
    await userEvent.click(searchSubmitButtons[searchSubmitButtons.length - 1]);

    await userEvent.click(await screen.findByRole('button', { name: /Open todo result: Finish onboarding/ }));

    expect(screen.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
    const highlighted = document.querySelector('[data-entity-id="todo-1"]');
    expect(highlighted).not.toBeNull();
  });

  it('routes file and commit search hits to the Files tab', async () => {
    const harness = bridge();
    render(
      <App
        bridge={harness}
        initialState={{
          ...baseState,
          fileCaptures,
          searchResults: fileAndCommitSearchResults,
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(screen.getByRole('button', { name: /Open file src\/App\.tsx/i }));

    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Open src/App.tsx' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(screen.getByRole('button', { name: /Open commit abc1234/i }));

    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Commit: abc1234/)).toBeInTheDocument();
  });

  it('does not re-request activity data when host state updates while the tab stays mounted', async () => {
    const harness = bridge();
    render(<App bridge={harness} initialState={baseState} />);

    await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await waitFor(() => expect(countRequests(harness, 'activity.list')).toBe(1));
    expect(countRequests(harness, 'capture.health')).toBe(1);

    await settleAfterStateUpdates(harness, { ...baseState, tasks: [task1, task2] });

    expect(countRequests(harness, 'activity.list')).toBe(1);
    expect(countRequests(harness, 'capture.health')).toBe(1);
  });

  it('does not re-request review data when host state updates while the tab stays mounted', async () => {
    const harness = bridge();
    render(<App bridge={harness} initialState={baseState} />);

    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(countRequests(harness, 'review.get')).toBe(1));

    await settleAfterStateUpdates(harness, { ...baseState, tasks: [task1, task2] });

    expect(countRequests(harness, 'review.get')).toBe(1);
  });

  it('shows an error banner when a bridge action fails', async () => {
    const harness = bridge({
      request: makeRequestMock(async (type) => {
        if (type === 'sync.push') {
          throw new Error('sync failed');
        }
        return baseState;
      }),
    });

    render(<App bridge={harness} initialState={baseState} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sync to Cloud' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('sync failed');
  });
});
