import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import type { AriadneBridge, AriadneRequestType } from './bridge';
import type { Task, WebviewState } from '@host/messages';

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

describe('App', () => {
  it('renders the task rail, toolbar, and tabs from the initial state', () => {
    render(<App bridge={bridge()} initialState={baseState} />);
    expect(screen.getByRole('heading', { name: 'Ariadne' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync to Cloud' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export to Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Context' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Panel task/ })).toBeInTheDocument();
  });

  it('switches to the activity and context tabs', async () => {
    render(<App bridge={bridge()} initialState={baseState} />);

    await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Context' }));
    expect(screen.getByRole('button', { name: 'Context' })).toHaveAttribute('aria-pressed', 'true');
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
