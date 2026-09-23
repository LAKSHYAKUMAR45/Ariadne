import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import type { AriadneBridge } from './bridge';
import type { WebviewState } from '@host/messages';

const state: WebviewState = {
  workspaceRoot: '/repo',
  currentTaskId: 'task-1',
  currentTask: {
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
  },
  tasks: [
    {
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
    },
  ],
  checkpoints: [],
  todos: [],
  decisions: [],
  errors: [],
  questions: [],
  fileCaptures: [],
  counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
};

function bridge(overrides: Partial<AriadneBridge> = {}): AriadneBridge {
  return {
    request: vi.fn(async () => state),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe('App', () => {
  it('renders the task rail, toolbar, and tabs from the initial state', () => {
    render(<App bridge={bridge()} initialState={state} />);
    expect(screen.getByRole('heading', { name: 'Ariadne' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync to Cloud' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export to Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Panel task/ })).toBeInTheDocument();
  });

  it('switches tabs without routing', async () => {
    render(<App bridge={bridge()} initialState={state} />);
    const [todosButton] = screen.getAllByRole('button', { name: 'Todos' });
    await userEvent.click(todosButton);
    expect(todosButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Todos' })).toBeInTheDocument();
  });
});
