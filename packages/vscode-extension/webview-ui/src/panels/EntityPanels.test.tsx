import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AriadneBridge } from '../bridge';
import type { Decision, OpenQuestion, Task, TaskError, Todo, WebviewState } from '@host/messages';
import { DecisionsPanel, ErrorsPanel, QuestionsPanel, TodosPanel } from './EntityPanels';

const task: Task = {
  id: 'task-1',
  title: 'Editable panels',
  goal: 'Keep host state authoritative',
  status: 'active',
  parentTaskId: null,
  branch: 'feat/panels',
  createdAt: '',
  updatedAt: '',
  remoteId: null,
  syncedAt: null,
};

const todo: Todo = {
  id: 'todo-1',
  taskId: task.id,
  text: 'Existing todo',
  status: 'pending',
  sourceCheckpointId: null,
  createdAt: '',
  updatedAt: '',
  remoteId: null,
  syncedAt: null,
};

const decision: Decision = {
  id: 'decision-1',
  taskId: task.id,
  checkpointId: null,
  text: 'Use the cache',
  rationale: 'Avoid repeat fetches',
  supersedesId: null,
  createdAt: '',
  updatedAt: '',
  remoteId: null,
  syncedAt: null,
};

const error: TaskError = {
  id: 'error-1',
  taskId: task.id,
  message: 'Failed to sync',
  resolved: false,
  resolution: null,
  createdAt: '',
  updatedAt: '',
  remoteId: null,
  syncedAt: null,
};

const question: OpenQuestion = {
  id: 'question-1',
  taskId: task.id,
  text: 'What is the target branch?',
  resolved: false,
  createdAt: '',
  updatedAt: '',
  remoteId: null,
  syncedAt: null,
};

const baseState: WebviewState = {
  workspaceRoot: '/repo',
  currentTaskId: task.id,
  currentTask: task,
  tasks: [task],
  checkpoints: [],
  todos: [todo],
  decisions: [decision],
  errors: [error],
  questions: [question],
  fileCaptures: [],
  searchResults: [],
  counts: { pendingTodos: 1, unresolvedErrors: 1, openQuestions: 1 },
};

type BridgeHarness = AriadneBridge & {
  request: ReturnType<typeof vi.fn>;
};

function createBridge(): BridgeHarness {
  return {
    request: vi.fn(async () => ({})),
    subscribe: vi.fn(() => () => undefined),
  };
}

function renderPanels(state: WebviewState = baseState) {
  const bridge = createBridge();
  const onBusy = vi.fn();
  const onError = vi.fn();
  const user = userEvent.setup();

  return {
    bridge,
    onBusy,
    onError,
    user,
    ...render(
      <>
        <TodosPanel state={state} bridge={bridge} onBusy={onBusy} onError={onError} />
        <DecisionsPanel state={state} bridge={bridge} onBusy={onBusy} onError={onError} />
        <ErrorsPanel state={state} bridge={bridge} onBusy={onBusy} onError={onError} />
        <QuestionsPanel state={state} bridge={bridge} onBusy={onBusy} onError={onError} />
      </>,
    ),
  };
}

describe('EntityPanels', () => {
  it('sends todo create, edit, status, and delete requests without local mutation', async () => {
    const { bridge, onBusy, onError, rerender, user } = renderPanels();

    await user.type(screen.getByRole('textbox', { name: 'New todo text' }), 'New todo');
    await user.click(screen.getByRole('button', { name: 'Add todo' }));

    expect(bridge.request).toHaveBeenCalledWith('todo.create', { text: 'New todo' });
    expect(onBusy).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Todo text for todo-1' })).toHaveValue('Existing todo');

    await user.clear(screen.getByRole('textbox', { name: 'Todo text for todo-1' }));
    await user.type(screen.getByRole('textbox', { name: 'Todo text for todo-1' }), 'Updated todo');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Todo status for todo-1' }), 'done');
    await user.click(screen.getByRole('button', { name: 'Save todo-1' }));
    await user.click(screen.getByRole('button', { name: 'Delete todo-1' }));

    expect(bridge.request).toHaveBeenCalledWith('todo.updateText', { id: 'todo-1', text: 'Updated todo' });
    expect(bridge.request).toHaveBeenCalledWith('todo.setStatus', { id: 'todo-1', status: 'done' });
    expect(bridge.request).toHaveBeenCalledWith('todo.delete', { id: 'todo-1' });

    rerender(
      <TodosPanel
        state={{
          ...baseState,
          todos: [
            todo,
            {
              ...todo,
              id: 'todo-2',
              text: 'New todo',
            },
          ],
        }}
        bridge={bridge}
        onBusy={onBusy}
        onError={onError}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Todo text for todo-1' })).toHaveValue('Updated todo');
    expect(screen.getByRole('textbox', { name: 'Todo text for todo-2' })).toHaveValue('New todo');
  });

  it('sends decision create, edit, and delete requests', async () => {
    const { bridge, onError, onBusy, user } = renderPanels();

    await user.type(screen.getByRole('textbox', { name: 'New decision text' }), 'Use the cache');
    await user.type(screen.getByRole('textbox', { name: 'New decision rationale' }), 'Avoid repeat fetches');
    await user.click(screen.getByRole('button', { name: 'Add decision' }));

    expect(bridge.request).toHaveBeenCalledWith('decision.create', {
      text: 'Use the cache',
      rationale: 'Avoid repeat fetches',
    });

    await user.clear(screen.getByRole('textbox', { name: 'Decision text for decision-1' }));
    await user.type(screen.getByRole('textbox', { name: 'Decision text for decision-1' }), 'Use the cache v2');
    await user.clear(screen.getByRole('textbox', { name: 'Decision rationale for decision-1' }));
    await user.type(screen.getByRole('textbox', { name: 'Decision rationale for decision-1' }), 'Clarified rationale');
    await user.click(screen.getByRole('button', { name: 'Save decision-1' }));
    await user.click(screen.getByRole('button', { name: 'Delete decision-1' }));

    expect(bridge.request).toHaveBeenCalledWith('decision.update', {
      id: 'decision-1',
      text: 'Use the cache v2',
      rationale: 'Clarified rationale',
    });
    expect(bridge.request).toHaveBeenCalledWith('decision.delete', { id: 'decision-1' });
    expect(onBusy).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('sends error create, edit, resolve, reopen, and delete requests', async () => {
    const { bridge, onError, onBusy, user } = renderPanels();

    await user.type(screen.getByRole('textbox', { name: 'New error message' }), 'Failed to sync');
    await user.click(screen.getByRole('button', { name: 'Add error' }));

    expect(bridge.request).toHaveBeenCalledWith('error.create', { message: 'Failed to sync' });

    await user.clear(screen.getByRole('textbox', { name: 'Error message for error-1' }));
    await user.type(screen.getByRole('textbox', { name: 'Error message for error-1' }), 'Failed to sync again');
    await user.click(screen.getByRole('button', { name: 'Save error-1' }));
    await user.click(screen.getByRole('button', { name: 'Resolve error-1' }));
    await user.click(screen.getByRole('button', { name: 'Reopen error-1' }));
    await user.click(screen.getByRole('button', { name: 'Delete error-1' }));

    expect(bridge.request).toHaveBeenCalledWith('error.update', { id: 'error-1', message: 'Failed to sync again' });
    expect(bridge.request).toHaveBeenCalledWith('error.resolve', { id: 'error-1' });
    expect(bridge.request).toHaveBeenCalledWith('error.reopen', { id: 'error-1' });
    expect(bridge.request).toHaveBeenCalledWith('error.delete', { id: 'error-1' });
    expect(onBusy).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('sends question create, edit, resolve, reopen, and delete requests', async () => {
    const { bridge, onError, onBusy, user } = renderPanels();

    await user.type(screen.getByRole('textbox', { name: 'New question text' }), 'What is the target branch?');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    expect(bridge.request).toHaveBeenCalledWith('question.create', { text: 'What is the target branch?' });

    await user.clear(screen.getByRole('textbox', { name: 'Question text for question-1' }));
    await user.type(screen.getByRole('textbox', { name: 'Question text for question-1' }), 'What is the target branch now?');
    await user.click(screen.getByRole('button', { name: 'Save question-1' }));
    await user.click(screen.getByRole('button', { name: 'Resolve question-1' }));
    await user.click(screen.getByRole('button', { name: 'Reopen question-1' }));
    await user.click(screen.getByRole('button', { name: 'Delete question-1' }));

    expect(bridge.request).toHaveBeenCalledWith('question.update', {
      id: 'question-1',
      text: 'What is the target branch now?',
    });
    expect(bridge.request).toHaveBeenCalledWith('question.resolve', { id: 'question-1' });
    expect(bridge.request).toHaveBeenCalledWith('question.reopen', { id: 'question-1' });
    expect(bridge.request).toHaveBeenCalledWith('question.delete', { id: 'question-1' });
    expect(onBusy).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
