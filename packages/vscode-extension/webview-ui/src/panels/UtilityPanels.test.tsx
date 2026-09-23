import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { within } from '@testing-library/react';
import type { AriadneBridge } from '../bridge';
import type { Checkpoint, SearchResult, Task, TaskFileCaptureWithEntries, WebviewState } from '@host/messages';
import OverviewPanel from './OverviewPanel';
import FilesPanel from './FilesPanel';
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
      default:
        return payload;
    }
  });

  return {
    request,
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe('UtilityPanels', () => {
  it('renders the overview goal, branch, counts, and latest checkpoint', () => {
    render(<OverviewPanel state={baseState} />);

    expect(screen.getByRole('heading', { name: 'Utility panels' })).toBeInTheDocument();
    expect(screen.getByText(/feat\/utility-panels/)).toBeInTheDocument();
    expect(screen.getByText(/2 pending todos/)).toBeInTheDocument();
    expect(screen.getByText(/1 unresolved error/)).toBeInTheDocument();
    expect(screen.getByText(/3 open questions/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Latest checkpoint' })).getByText('Added overview counts')).toBeInTheDocument();
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

    await userEvent.click(screen.getByRole('button', { name: 'Pull import-new' }));
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('sync.pull', {
        importNew: true,
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'List remote' }));
    await waitFor(() => expect(harness.request).toHaveBeenCalledWith('sync.listRemote'));

    expect(screen.getByLabelText('Sync output')).toHaveTextContent('remote output');
  });
});
