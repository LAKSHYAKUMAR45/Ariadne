import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { within } from '@testing-library/react';
import type { AriadneBridge } from '../bridge';
import type { Checkpoint, SearchResult, Task, TaskFileCaptureWithEntries, WebviewState } from '@host/messages';
import ActivityPanel from './ActivityPanel';
import ContextPanel from './ContextPanel';
import OverviewPanel from './OverviewPanel';
import FilesPanel from './FilesPanel';
import GraphifyPanel from './GraphifyPanel';
import ReviewPanel from './ReviewPanel';
import SearchPanel from './SearchPanel';
import SyncPanel from './SyncPanel';

const task: Task = {
  id: 'task-1',
  title: 'Utility panels',
  goal: 'Make the webview actionable',
  status: 'active',
  parentTaskId: null,
  branch: 'feat/utility-panels',
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:05:00.000Z',
  remoteId: null,
  syncedAt: null,
};

const checkpoints: Checkpoint[] = [
  {
    id: 'checkpoint-1',
    taskId: task.id,
    parentCheckpointId: null,
    level: 'session',
    summary: 'Established panel layout',
    createdAt: '2026-09-23T10:06:00.000Z',
    remoteId: null,
    syncedAt: null,
  },
  {
    id: 'checkpoint-2',
    taskId: task.id,
    parentCheckpointId: 'checkpoint-1',
    level: 'micro',
    summary: 'Added overview counts',
    createdAt: '2026-09-23T10:07:00.000Z',
    remoteId: null,
    syncedAt: null,
  },
];

const captures: TaskFileCaptureWithEntries[] = [
  {
    id: 'capture-1',
    taskId: task.id,
    trigger: 'explicit',
    gitCommitSha: null,
    checkpointId: null,
    createdAt: '2026-09-23T10:08:00.000Z',
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
    taskId: task.id,
    trigger: 'checkpoint',
    gitCommitSha: null,
    checkpointId: 'checkpoint-1',
    createdAt: '2026-09-23T10:09:00.000Z',
    syncedAt: null,
    failedAt: '2026-09-23T10:09:30.000Z',
    failureCode: 'capture_failed',
    entries: [
      {
        captureId: 'capture-2',
        path: 'src/SearchPanel.tsx',
        content: 'export function SearchPanel() {}\n',
        unifiedDiff: ['@@ -1,0 +1,1 @@', '+export function SearchPanel() {}'].join('\n'),
        byteLength: 33,
        contentSha256: 'sha256-2',
      },
    ],
  },
  {
    id: 'capture-3',
    taskId: task.id,
    trigger: 'git_commit',
    gitCommitSha: 'abc1234',
    checkpointId: null,
    createdAt: '2026-09-23T10:10:00.000Z',
    syncedAt: '2026-09-23T10:10:30.000Z',
    failedAt: null,
    failureCode: null,
    entries: [
      {
        captureId: 'capture-3',
        path: 'src/FilesPanel.tsx',
        content: 'export function FilesPanel() {}\n',
        unifiedDiff: ['@@ -1,0 +1,1 @@', '+export function FilesPanel() {}'].join('\n'),
        byteLength: 32,
        contentSha256: 'sha256-3',
      },
    ],
  },
];

const searchResults: SearchResult[] = [
  {
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
    matches: [
      {
        category: 'decision',
        id: 'decision-1',
        text: 'Use a thin panel wrapper',
        createdAt: '2026-09-23T10:09:00.000Z',
      },
      {
        category: 'file',
        id: 'src/App.tsx',
        text: 'src/App.tsx',
        createdAt: '2026-09-23T10:08:00.000Z',
      },
      {
        category: 'commit',
        id: 'abc1234',
        text: 'abc1234',
        createdAt: '2026-09-23T10:10:00.000Z',
      },
    ],
  },
];

const baseState: WebviewState = {
  workspaceRoot: '/repo',
  currentTaskId: task.id,
  currentTask: task,
  tasks: [task],
  checkpoints,
  todos: [],
  decisions: [],
  errors: [],
  questions: [],
  fileCaptures: captures,
  searchResults,
  counts: { pendingTodos: 2, unresolvedErrors: 1, openQuestions: 3 },
};

type BridgeHarness = AriadneBridge & {
  request: ReturnType<typeof vi.fn>;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createBridge(overrides: Partial<BridgeHarness> = {}): BridgeHarness {
  const request = vi.fn(async (type: string, payload?: unknown) => {
    switch (type) {
      case 'files.getCapture':
        return { capture: captures[0] };
      case 'search.run':
        return { results: searchResults };
      case 'sync.push':
        return { output: 'push output' };
      case 'sync.pull':
        return { output: 'pull output' };
      case 'sync.listRemote':
        return { output: 'remote output' };
      case 'context.get':
        return {
          context: {
            latestSummary: 'Session summary',
            openQuestions: [],
            openTodos: [],
            blockedTodos: [],
            unresolvedErrors: [],
            recentFiles: [],
            recentCommits: [{ sha: 'abc1234def', message: 'fix: sync panel' }],
            recentCommands: [{ cmd: 'pnpm test', exitCode: 0 }],
            decisions: [],
          },
        };
      default:
        return payload;
    }
  });

  return {
    request: request as BridgeHarness['request'],
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe('UtilityPanels', () => {
  it('renders the overview goal, branch, counts, and latest checkpoint', () => {
    const harness = createBridge();
    render(<OverviewPanel state={baseState} bridge={harness} onBusy={() => undefined} onError={() => undefined} />);

    expect(screen.getByRole('heading', { name: 'Utility panels' })).toBeInTheDocument();
    expect(screen.getByText(/feat\/utility-panels/)).toBeInTheDocument();
    expect(screen.getByText(/2 pending todos/)).toBeInTheDocument();
    expect(screen.getByText(/1 unresolved error/)).toBeInTheDocument();
    expect(screen.getByText(/3 open questions/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Latest checkpoint' })).getByText('Added overview counts')).toBeInTheDocument();
  });

  it('edits the task title and goal via task.update', async () => {
    const harness = createBridge();
    render(<OverviewPanel state={baseState} bridge={harness} onBusy={() => undefined} onError={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit title/goal' }));
    const titleInput = screen.getByLabelText('Task title');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Renamed task');
    await userEvent.click(screen.getByRole('button', { name: 'Save task' }));

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('task.update', {
        id: task.id,
        title: 'Renamed task',
        goal: task.goal,
      }),
    );
  });

  it('runs a lifecycle action for the current task', async () => {
    const harness = createBridge();
    render(<OverviewPanel state={baseState} bridge={harness} onBusy={() => undefined} onError={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Pause task' }));
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('task.setStatus', { id: task.id, status: 'paused' }),
    );
  });

  it('creates a checkpoint from the overview panel', async () => {
    const harness = createBridge();
    render(<OverviewPanel state={baseState} bridge={harness} onBusy={() => undefined} onError={() => undefined} />);

    await userEvent.type(screen.getByLabelText('Checkpoint summary'), 'New checkpoint summary');
    await userEvent.selectOptions(screen.getByLabelText('Checkpoint level'), 'milestone');
    await userEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }));

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('checkpoint.create', {
        summary: 'New checkpoint summary',
        level: 'milestone',
      }),
    );
  });

  it('points users to the dedicated activity and context tabs', () => {
    const harness = createBridge();
    render(<OverviewPanel state={baseState} bridge={harness} onBusy={() => undefined} onError={() => undefined} />);

    expect(screen.getByText('Use the Activity tab for timeline history and capture health.')).toBeInTheDocument();
    expect(screen.getByText('Use the Context tab to preview, copy, or open the current task handoff package.')).toBeInTheDocument();
  });

  it('loads activity and filters timeline rows by kind', async () => {
    const onNavigate = vi.fn();
    const harness = createBridge({
      request: vi.fn(async (type: string) => {
        if (type === 'activity.list') {
          return {
            items: [
              { id: 'command:1', kind: 'command', title: 'pnpm test', createdAt: '2026-09-23T10:10:00.000Z', status: 'success' },
              {
                id: 'error:1',
                kind: 'error',
                title: 'Build failed',
                createdAt: '2026-09-23T10:09:00.000Z',
                targetTab: 'errors',
                entityId: 'error-1',
                status: 'error',
              },
            ],
          };
        }
        if (type === 'capture.health') {
          return {
            health: {
              workspaceRoot: '/repo',
              currentTaskId: task.id,
              currentTaskTitle: task.title,
              passiveCaptureEnabled: true,
              shellIntegrationAvailable: true,
              gitExtensionAvailable: true,
              branchMatches: true,
              unresolvedErrors: 0,
              warnings: [],
            },
          };
        }
        return {};
      }) as BridgeHarness['request'],
    });

    render(
      <ActivityPanel
        bridge={harness}
        taskId={task.id}
        onNavigate={onNavigate}
        onBusy={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(await screen.findByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('Passive capture enabled')).toBeInTheDocument();
    expect(screen.getByText('/repo')).toBeInTheDocument();
    expect(screen.getByText('No unresolved errors')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Errors' }));

    expect(screen.queryByText('pnpm test')).not.toBeInTheDocument();
    expect(screen.getByText('Build failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Open activity item: Build failed/i }));
    expect(onNavigate).toHaveBeenCalledWith({ tabId: 'errors', entityId: 'error-1' });
  });

  it('previews context with a budget and offers copy/open actions', async () => {
    const harness = createBridge({
      request: vi.fn(async (type: string, payload?: unknown) => {
        if (type === 'context.preview') {
          return {
            preview: {
              tokenBudget: (payload as { tokenBudget: number }).tokenBudget,
              markdown: '# Context\nUtility panels',
              sections: [{ id: 'summary', label: 'Summary', count: 1 }],
              context: {
                taskId: task.id,
                goal: task.goal,
                branch: task.branch,
                workspaceRoot: '/repo',
                latestSummary: 'Session summary',
                openQuestions: [],
                openTodos: [],
                blockedTodos: [],
                unresolvedErrors: [],
                recentFiles: [],
                recentCommits: [],
                recentCommands: [],
                decisions: [],
                truncated: {},
              },
            },
          };
        }
        return {};
      }) as BridgeHarness['request'],
    });

    render(<ContextPanel bridge={harness} taskId={task.id} onBusy={() => undefined} onError={() => undefined} />);

    await userEvent.clear(screen.getByLabelText('Token budget'));
    await userEvent.type(screen.getByLabelText('Token budget'), '1200');
    await userEvent.click(screen.getByRole('button', { name: 'Preview context' }));

    expect(await screen.findByText('# Context')).toBeInTheDocument();
    expect(screen.getByText('Summary: 1 included')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy context' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('context.copy', { markdown: '# Context\nUtility panels' }));

    await userEvent.click(screen.getByRole('button', { name: 'Open as Markdown' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('context.open', { markdown: '# Context\nUtility panels' }));
  });

  it('shows review checks and can mark the task done from review mode', async () => {
    const harness = createBridge({
      request: vi.fn(async (type: string, payload?: unknown) => {
        if (type === 'review.get') {
          return {
            review: {
              taskId: task.id,
              canMarkDone: true,
              checks: [
                { id: 'pending-todos', label: 'Pending todos', status: 'pass', detail: 'No pending todos.' },
                { id: 'sync-status', label: 'Sync status', status: 'unknown', detail: 'No sync action has run in this panel session.' },
              ],
            },
          };
        }
        return payload ?? {};
      }) as BridgeHarness['request'],
    });

    render(<ReviewPanel bridge={harness} taskId={task.id} onBusy={() => undefined} onError={() => undefined} />);

    expect(await screen.findByText('Pending todos')).toBeInTheDocument();
    expect(screen.getByText('No sync action has run in this panel session.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark task done' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('task.setStatus', { id: task.id, status: 'done' }));
  });

  it('does not render stale review data after the selected task changes', async () => {
    const firstReview = createDeferred<{
      review: {
        taskId: string;
        canMarkDone: boolean;
        checks: Array<{ id: string; label: string; status: 'pass' | 'warning' | 'fail' | 'unknown'; detail: string }>;
      };
    }>();
    const nextTaskId = 'task-2';
    let reviewRequests = 0;

    const harness = createBridge({
      request: vi.fn(async (type: string) => {
        if (type === 'review.get') {
          reviewRequests += 1;
          if (reviewRequests > 1) {
            return {
              review: {
                taskId: nextTaskId,
                canMarkDone: true,
                checks: [{ id: 'pending-todos', label: 'Pending todos', status: 'pass', detail: 'No pending todos.' }],
              },
            };
          }
          return firstReview.promise;
        }
        return {};
      }) as BridgeHarness['request'],
    });

    const { rerender } = render(
      <ReviewPanel bridge={harness} taskId={task.id} onBusy={() => undefined} onError={() => undefined} />,
    );

    rerender(<ReviewPanel bridge={harness} taskId={nextTaskId} onBusy={() => undefined} onError={() => undefined} />);

    firstReview.resolve({
      review: {
        taskId: task.id,
        canMarkDone: false,
        checks: [{ id: 'unresolved-errors', label: 'Unresolved errors', status: 'fail', detail: '1 unresolved error needs resolution.' }],
      },
    });

    expect(await screen.findByText('No pending todos.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('1 unresolved error needs resolution.')).not.toBeInTheDocument());
  });

  it('does not render a stale context preview after the token budget changes', async () => {
    const firstPreview = createDeferred<{
      preview: {
        tokenBudget: number;
        markdown: string;
        sections: Array<{ id: string; label: string; count: number }>;
        context: {
          taskId: string;
          goal: string | null;
          branch: string | null;
          workspaceRoot: string;
          latestSummary: string;
          openQuestions: never[];
          openTodos: never[];
          blockedTodos: never[];
          unresolvedErrors: never[];
          recentFiles: never[];
          recentCommits: never[];
          recentCommands: never[];
          decisions: never[];
          truncated: Record<string, never>;
        };
      };
    }>();

    const harness = createBridge({
      request: vi.fn(async (type: string, payload?: unknown) => {
        if (type === 'context.preview') {
          const tokenBudget = (payload as { tokenBudget: number }).tokenBudget;
          if (tokenBudget === 4000) {
            return firstPreview.promise;
          }
          return {
            preview: {
              tokenBudget,
              markdown: `# Context\nBudget ${tokenBudget}`,
              sections: [{ id: 'summary', label: 'Summary', count: 1 }],
              context: {
                taskId: task.id,
                goal: task.goal,
                branch: task.branch,
                workspaceRoot: '/repo',
                latestSummary: 'Session summary',
                openQuestions: [],
                openTodos: [],
                blockedTodos: [],
                unresolvedErrors: [],
                recentFiles: [],
                recentCommits: [],
                recentCommands: [],
                decisions: [],
                truncated: {},
              },
            },
          };
        }
        return {};
      }) as BridgeHarness['request'],
    });

    render(<ContextPanel bridge={harness} taskId={task.id} onBusy={() => undefined} onError={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Preview context' }));
    await userEvent.clear(screen.getByLabelText('Token budget'));
    await userEvent.type(screen.getByLabelText('Token budget'), '1200');

    firstPreview.resolve({
      preview: {
        tokenBudget: 4000,
        markdown: '# Context\nBudget 4000',
        sections: [{ id: 'summary', label: 'Summary', count: 1 }],
        context: {
          taskId: task.id,
          goal: task.goal,
          branch: task.branch,
          workspaceRoot: '/repo',
          latestSummary: 'Session summary',
          openQuestions: [],
          openTodos: [],
          blockedTodos: [],
          unresolvedErrors: [],
          recentFiles: [],
          recentCommits: [],
          recentCommands: [],
          decisions: [],
          truncated: {},
        },
      },
    });

    await waitFor(() => expect(screen.queryByText('Budget 4000')).not.toBeInTheDocument());
    expect(screen.getByText('Preview the current task handoff package to inspect or share it.')).toBeInTheDocument();
  });

  it('clears busy when an in-flight context preview is invalidated by a budget change', async () => {
    const firstPreview = createDeferred<{
      preview: {
        tokenBudget: number;
        markdown: string;
        sections: Array<{ id: string; label: string; count: number }>;
        context: {
          taskId: string;
          goal: string | null;
          branch: string | null;
          workspaceRoot: string;
          latestSummary: string;
          openQuestions: never[];
          openTodos: never[];
          blockedTodos: never[];
          unresolvedErrors: never[];
          recentFiles: never[];
          recentCommits: never[];
          recentCommands: never[];
          decisions: never[];
          truncated: Record<string, never>;
        };
      };
    }>();
    const onBusy = vi.fn();

    const harness = createBridge({
      request: vi.fn(async (type: string) => {
        if (type === 'context.preview') {
          return firstPreview.promise;
        }
        return {};
      }) as BridgeHarness['request'],
    });

    render(<ContextPanel bridge={harness} taskId={task.id} onBusy={onBusy} onError={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Preview context' }));
    await waitFor(() => expect(onBusy).toHaveBeenCalledWith('Previewing context…'));

    await userEvent.clear(screen.getByLabelText('Token budget'));
    await userEvent.type(screen.getByLabelText('Token budget'), '1200');

    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(undefined));

    firstPreview.resolve({
      preview: {
        tokenBudget: 4000,
        markdown: '# Context\nBudget 4000',
        sections: [{ id: 'summary', label: 'Summary', count: 1 }],
        context: {
          taskId: task.id,
          goal: task.goal,
          branch: task.branch,
          workspaceRoot: '/repo',
          latestSummary: 'Session summary',
          openQuestions: [],
          openTodos: [],
          blockedTodos: [],
          unresolvedErrors: [],
          recentFiles: [],
          recentCommits: [],
          recentCommands: [],
          decisions: [],
          truncated: {},
        },
      },
    });

    await waitFor(() => expect(screen.queryByText('Budget 4000')).not.toBeInTheDocument());
  });

  it('renders capture health warnings when no current task is selected', async () => {
    const harness = createBridge({
      request: vi.fn(async (type: string) => {
        if (type === 'activity.list') {
          return { items: [] };
        }
        if (type === 'capture.health') {
          return {
            health: {
              workspaceRoot: '/repo',
              passiveCaptureEnabled: false,
              shellIntegrationAvailable: false,
              gitExtensionAvailable: false,
              branchMatches: 'unknown',
              unresolvedErrors: 0,
              warnings: ['No current task is selected for this workspace.'],
            },
          };
        }
        return {};
      }) as BridgeHarness['request'],
    });

    render(
      <ActivityPanel
        bridge={harness}
        taskId={undefined}
        onNavigate={() => undefined}
        onBusy={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(await screen.findByText('Passive capture disabled')).toBeInTheDocument();
    expect(screen.getByText('Branch unknown')).toBeInTheDocument();
    expect(screen.getByText('No current task is selected for this workspace.')).toBeInTheDocument();
    expect(screen.getByText('No current task selected')).toBeInTheDocument();
  });

  it('highlights the checkpoint matching highlightCheckpointId', () => {
    const harness = createBridge();
    render(
      <OverviewPanel
        state={baseState}
        bridge={harness}
        onBusy={() => undefined}
        onError={() => undefined}
        highlightCheckpointId="checkpoint-1"
      />,
    );

    const highlighted = document.querySelector('[data-entity-id="checkpoint-1"]');
    expect(highlighted).not.toBeNull();
    expect(highlighted).toHaveStyle({ background: '#1e293b' });
  });

  it('loads a file capture diff lazily when a capture is selected', async () => {
    const harness = createBridge();
    render(<FilesPanel bridge={harness} captures={captures} />);

    await userEvent.click(screen.getByRole('button', { name: /capture-1/i }));

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('files.getCapture', {
        id: 'capture-1',
      }),
    );
    expect(screen.getByLabelText('Unified diff')).toHaveTextContent('-console.log("old");');
    expect(screen.getByLabelText('Unified diff')).toHaveTextContent('+console.log("updated");');
  });

  it('filters captured files and opens an existing captured file', async () => {
    const harness = createBridge();
    render(<FilesPanel bridge={harness} captures={captures} highlightPath="src/App.tsx" />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Filter captured files' }), 'App');
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open src/App.tsx' }));

    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('file.open', { path: 'src/App.tsx' }));
  });

  it('submits search queries and groups results by category', async () => {
    const harness = createBridge();
    render(<SearchPanel bridge={harness} initialResults={[]} />);

    await userEvent.type(screen.getByRole('textbox', { name: /search query/i }), 'panel');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('search.run', {
        query: 'panel',
        allWorkspaces: false,
      }),
    );

    expect(screen.getByRole('heading', { name: 'decision' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'file' })).toBeInTheDocument();
    expect(screen.getByText('Use a thin panel wrapper')).toBeInTheDocument();
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
  });

  it('keeps explicit search results when a host state update provides empty initial results', async () => {
    const harness = createBridge();
    const { rerender } = render(<SearchPanel bridge={harness} initialResults={[]} />);

    await userEvent.type(screen.getByRole('textbox', { name: /search query/i }), 'panel');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Use a thin panel wrapper');

    rerender(<SearchPanel bridge={harness} initialResults={[]} />);

    expect(screen.getByText('Use a thin panel wrapper')).toBeInTheDocument();
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
  });

  it('invokes onNavigate with the matching hit when a search result is clicked', async () => {
    const harness = createBridge();
    const onNavigate = vi.fn();
    render(<SearchPanel bridge={harness} initialResults={searchResults} onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole('button', { name: /Open decision result: Use a thin panel wrapper/ }));

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'decision-1', category: 'decision', taskId: task.id }),
    );
  });

  it('labels file and commit search hits as navigable to Files', async () => {
    const onNavigate = vi.fn();
    const harness = createBridge();
    render(<SearchPanel bridge={harness} initialResults={searchResults} onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole('button', { name: /Open file src\/App\.tsx/i }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ category: 'file', id: 'src/App.tsx' }));

    await userEvent.click(screen.getByRole('button', { name: /Open commit abc1234/i }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ category: 'commit', id: 'abc1234' }));
  });

  it('submits all-workspaces searches when the toggle is enabled', async () => {
    const harness = createBridge();
    render(<SearchPanel bridge={harness} initialResults={[]} />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Search all workspaces' }));
    await userEvent.type(screen.getByRole('textbox', { name: /search query/i }), 'panel');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('search.run', {
        query: 'panel',
        allWorkspaces: true,
      }),
    );
  });

  it('invokes every sync action and keeps the latest output visible', async () => {
    const harness = createBridge();
    render(<SyncPanel bridge={harness} />);

    await userEvent.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('sync.push'));

    await userEvent.click(screen.getByRole('button', { name: 'Pull' }));
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('sync.pull', {
        importNew: false,
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'List remote' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('sync.listRemote'));

    expect(screen.getByLabelText('Sync output')).toHaveTextContent('remote output');
  });

  it('requires confirmation before pulling with import-new', async () => {
    const harness = createBridge();
    render(<SyncPanel bridge={harness} />);

    await userEvent.click(screen.getByRole('button', { name: 'Pull import-new' }));
    expect(harness.request).not.toHaveBeenCalledWith('sync.pull', { importNew: true });
    expect(screen.getByText('Import new remote tasks into this workspace?')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Import new remote tasks into this workspace?')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pull import-new' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm pull import-new' }));
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('sync.pull', {
        importNew: true,
      }),
    );
  });

  it('shows sign-in guidance when a sync action fails with an auth-shaped error', async () => {
    const harness = createBridge({
      request: vi.fn(async () => {
        throw new Error('401 unauthorized: token expired');
      }),
    });
    render(<SyncPanel bridge={harness} />);

    await userEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ariadne sync setup');
  });

  it('shows a clear idle/running/last-action status', async () => {
    const harness = createBridge();
    render(<SyncPanel bridge={harness} />);

    expect(screen.getByLabelText('Sync status')).toHaveTextContent('Idle');

    await userEvent.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() => expect(screen.getByLabelText('Sync status')).toHaveTextContent('Last action: sync.push completed'));
  });

  it('runs a graphify query and displays bounded output', async () => {
    const harness = createBridge({
      request: vi.fn(async (type: string) => {
        if (type === 'graphify.run') {
          return {
            result: {
              available: true,
              args: ['query', 'how does auth work'],
              output: 'Auth uses middleware.',
              exitCode: 0,
              truncated: false,
            },
          };
        }
        return {};
      }) as BridgeHarness['request'],
    });

    render(<GraphifyPanel bridge={harness} workspaceRoot="/repo" onBusy={() => undefined} onError={() => undefined} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Query' }));
    await userEvent.type(screen.getByLabelText('Graphify query'), 'how does auth work');
    await userEvent.click(screen.getByRole('button', { name: 'Run query' }));

    expect(await screen.findByText('Auth uses middleware.')).toBeInTheDocument();
  });

  it('disables graphify actions when no workspace is selected', async () => {
    const harness = createBridge();

    render(<GraphifyPanel bridge={harness} workspaceRoot={undefined} onBusy={() => undefined} onError={() => undefined} />);

    expect(screen.getByText('Open a workspace folder to run Graphify.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run update' })).toBeDisabled();

    await userEvent.click(screen.getByRole('tab', { name: 'Query' }));
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(harness.request).not.toHaveBeenCalledWith('graphify.run', expect.anything());
  });
});
