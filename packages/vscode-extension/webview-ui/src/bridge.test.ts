import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVsCodeBridge, type VsCodeApi } from './bridge';
import type { WebviewState } from '@host/messages';

const baseState: WebviewState = {
  workspaceRoot: '/repo',
  currentTaskId: 'task-1',
  currentTask: {
    id: 'task-1',
    title: 'Original task',
    goal: 'Keep state current',
    status: 'active',
    parentTaskId: null,
    branch: null,
    createdAt: '',
    updatedAt: '',
    remoteId: null,
    syncedAt: null,
  },
  tasks: [],
  checkpoints: [],
  todos: [],
  decisions: [],
  errors: [],
  questions: [],
  fileCaptures: [],
  searchResults: [],
  counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
};

function makeApi(): VsCodeApi {
  let storedState: unknown;
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => storedState),
    setState: vi.fn((value: unknown) => {
      storedState = value;
    }),
  };
}

describe('createVsCodeBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hydrates state from error responses while still rejecting the request promise', async () => {
    const api = makeApi();
    const bridge = createVsCodeBridge(api);
    const listener = vi.fn();
    bridge.subscribe(listener);

    const request = bridge.request('task.createFromTemplate', {
      title: 'Broken seed',
      templateId: 'feature',
    });

    const posted = (api.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { id: string };
    const responseState: WebviewState = {
      ...baseState,
      currentTaskId: 'task-2',
      currentTask: {
        ...baseState.currentTask!,
        id: 'task-2',
        title: 'Broken seed',
      },
    };

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: posted.id,
          ok: false,
          error: 'Task was created but template seeding failed: seed write failed',
          state: responseState,
        },
      }),
    );

    await expect(request).rejects.toThrow('Task was created but template seeding failed: seed write failed');
    expect(api.setState).toHaveBeenCalledWith(responseState);
    expect(listener).toHaveBeenCalledWith(responseState);
  });
});
