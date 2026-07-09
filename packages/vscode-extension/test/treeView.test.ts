import { describe, it, expect, vi } from 'vitest';
import { TaskStore } from '@ariadne-dev/core';
import type { Task } from '@ariadne-dev/core';

// Minimal fake of the `vscode` module surface treeView.ts touches — mirrors
// the pattern in extension.test.ts. Must be declared before importing
// treeView.ts.
vi.mock('vscode', () => {
  class ThemeIcon {
    constructor(public id: string) {}
  }
  class TreeItem {
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    constructor(
      public label: string,
      public collapsibleState?: number,
    ) {}
  }
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e: T): void {
      for (const listener of this.listeners) listener(e);
    }
  }
  return {
    ThemeIcon,
    TreeItem,
    EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
});

const {
  taskTreeLabel,
  taskTreeDescription,
  categoryTreeLabel,
  checkpointTreeLabel,
  todoTreeLabel,
  decisionTreeLabel,
  errorTreeLabel,
  questionTreeLabel,
  listRootTasks,
  listCategoryNodes,
  listCategoryLeaves,
  AriadneTreeDataProvider,
  TASK_CATEGORIES,
} = await import('../src/treeView.js');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Sample task',
    goal: null,
    status: 'active',
    parentTaskId: null,
    branch: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('treeView pure label builders', () => {
  it('taskTreeLabel returns the task title', () => {
    expect(taskTreeLabel(makeTask({ title: 'Fix login bug' }))).toBe('Fix login bug');
  });

  it('taskTreeDescription includes status, and "current" when it matches the current task id', () => {
    const task = makeTask({ id: 't1', status: 'paused' });
    expect(taskTreeDescription(task, undefined)).toBe('paused');
    expect(taskTreeDescription(task, 't1')).toBe('current \u00b7 paused');
    expect(taskTreeDescription(task, 'other')).toBe('paused');
  });

  it('categoryTreeLabel formats the category name with a count', () => {
    expect(categoryTreeLabel('todos', 3)).toBe('Todos (3)');
    expect(categoryTreeLabel('questions', 0)).toBe('Open Questions (0)');
  });

  it('checkpointTreeLabel/todoTreeLabel/decisionTreeLabel/errorTreeLabel/questionTreeLabel format each entity', () => {
    expect(checkpointTreeLabel({ id: 'c1', taskId: 't1', parentCheckpointId: null, level: 'micro', summary: 'Did X', createdAt: '' })).toBe(
      '[micro] Did X',
    );
    expect(todoTreeLabel({ id: 'td1', taskId: 't1', text: 'Write docs', status: 'pending', createdAt: '' })).toBe('\u25cb Write docs');
    expect(todoTreeLabel({ id: 'td2', taskId: 't1', text: 'Ship it', status: 'done', createdAt: '' })).toBe('\u2713 Ship it');
    expect(todoTreeLabel({ id: 'td3', taskId: 't1', text: 'Blocked one', status: 'blocked', createdAt: '' })).toBe('\u26d4 Blocked one');
    expect(decisionTreeLabel({ id: 'd1', taskId: 't1', text: 'Use SQLite', rationale: null, createdAt: '' })).toBe('Use SQLite');
    expect(
      errorTreeLabel({ id: 'e1', taskId: 't1', message: 'Build failed', resolved: false, resolution: null, createdAt: '' }),
    ).toBe('\u2717 Build failed');
    expect(
      errorTreeLabel({ id: 'e2', taskId: 't1', message: 'Build failed', resolved: true, resolution: 'fixed', createdAt: '' }),
    ).toBe('\u2713 Build failed');
    expect(questionTreeLabel({ id: 'q1', taskId: 't1', text: 'Which DB?', resolved: false, createdAt: '' })).toBe('? Which DB?');
    expect(questionTreeLabel({ id: 'q2', taskId: 't1', text: 'Which DB?', resolved: true, createdAt: '' })).toBe('\u2713 Which DB?');
  });
});

describe('treeView pure tree-shape builders', () => {
  function makeStoreWithTasks() {
    const store = new TaskStore(':memory:');
    return store;
  }

  it('listRootTasks returns every task, most recently updated first', async () => {
    const store = makeStoreWithTasks();
    const a = store.createTask({ title: 'Older' });
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure a distinct (later) updatedAt timestamp
    const b = store.createTask({ title: 'Newer' });
    store.touchTask(b.id); // bump updatedAt so it's unambiguously newer

    const roots = listRootTasks(store);
    expect(roots.map((t) => t.id)).toEqual([b.id, a.id]);
    store.close();
  });

  it('listCategoryNodes returns one node per TASK_CATEGORIES entry, tagged with the task', () => {
    const task = makeTask();
    const nodes = listCategoryNodes(task);
    expect(nodes.map((n) => n.category)).toEqual([...TASK_CATEGORIES]);
    expect(nodes.every((n) => n.task === task)).toBe(true);
  });

  it('listCategoryLeaves returns checkpoints/todos/decisions/errors/questions for a task', () => {
    const store = makeStoreWithTasks();
    const task = store.createTask({ title: 'A' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Did a thing' });
    store.createTodo({ taskId: task.id, text: 'Write tests' });
    store.recordDecision({ taskId: task.id, text: 'Use SQLite' });
    store.recordError({ taskId: task.id, message: 'Build failed' });
    store.recordOpenQuestion({ taskId: task.id, text: 'Which DB?' });

    expect(listCategoryLeaves(store, task, 'checkpoints')).toHaveLength(1);
    expect(listCategoryLeaves(store, task, 'todos')).toHaveLength(1);
    expect(listCategoryLeaves(store, task, 'decisions')).toHaveLength(1);
    expect(listCategoryLeaves(store, task, 'errors')).toHaveLength(1);
    expect(listCategoryLeaves(store, task, 'questions')).toHaveLength(1);
    store.close();
  });

  it('listCategoryLeaves returns an empty array for a task with no entries in that category', () => {
    const store = makeStoreWithTasks();
    const task = store.createTask({ title: 'Empty' });
    for (const category of TASK_CATEGORIES) {
      expect(listCategoryLeaves(store, task, category)).toEqual([]);
    }
    store.close();
  });
});

describe('AriadneTreeDataProvider', () => {
  function makeStoreWithOneTask() {
    const store = new TaskStore(':memory:');
    const task = store.createTask({ title: 'Root task' });
    store.createTodo({ taskId: task.id, text: 'Write tests' });
    return { store, task };
  }

  it('getChildren() with no argument returns one task node per task', () => {
    const { store, task } = makeStoreWithOneTask();
    const provider = new AriadneTreeDataProvider(
      () => store,
      () => undefined,
    );

    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].kind).toBe('task');
    expect((children[0] as { task: Task }).task.id).toBe(task.id);
    store.close();
  });

  it('getChildren() returns an empty array when there is no store (e.g. no workspace open)', () => {
    const provider = new AriadneTreeDataProvider(
      () => undefined,
      () => undefined,
    );
    expect(provider.getChildren()).toEqual([]);
  });

  it('getChildren(taskNode) returns one category node per category', () => {
    const { store, task } = makeStoreWithOneTask();
    const provider = new AriadneTreeDataProvider(
      () => store,
      () => undefined,
    );

    const children = provider.getChildren({ kind: 'task', task });
    expect(children.map((n) => (n as { category: string }).category)).toEqual([...TASK_CATEGORIES]);
    store.close();
  });

  it('getChildren(categoryNode) returns the leaves for that category', () => {
    const { store, task } = makeStoreWithOneTask();
    const provider = new AriadneTreeDataProvider(
      () => store,
      () => undefined,
    );

    const todoLeaves = provider.getChildren({ kind: 'category', category: 'todos', task });
    expect(todoLeaves).toHaveLength(1);
    expect((todoLeaves[0] as { label: string }).label).toBe('\u25cb Write tests');

    const decisionLeaves = provider.getChildren({ kind: 'category', category: 'decisions', task });
    expect(decisionLeaves).toEqual([]);
    store.close();
  });

  it('getTreeItem marks the current task with a filled star icon and other tasks with an outline', () => {
    const { store, task } = makeStoreWithOneTask();
    const provider = new AriadneTreeDataProvider(
      () => store,
      () => task.id,
    );

    const item = provider.getTreeItem({ kind: 'task', task });
    expect((item.iconPath as { id: string }).id).toBe('star-full');
    expect(item.description).toContain('current');

    const otherProvider = new AriadneTreeDataProvider(
      () => store,
      () => 'some-other-task',
    );
    const otherItem = otherProvider.getTreeItem({ kind: 'task', task });
    expect((otherItem.iconPath as { id: string }).id).toBe('circle-outline');
    store.close();
  });

  it('getTreeItem on a category node reflects the live leaf count and sets collapsibleState accordingly', () => {
    const { store, task } = makeStoreWithOneTask();
    const provider = new AriadneTreeDataProvider(
      () => store,
      () => undefined,
    );

    const todosItem = provider.getTreeItem({ kind: 'category', category: 'todos', task });
    expect(todosItem.label).toBe('Todos (1)');
    expect(todosItem.collapsibleState).toBe(1); // Collapsed

    const decisionsItem = provider.getTreeItem({ kind: 'category', category: 'decisions', task });
    expect(decisionsItem.label).toBe('Decisions (0)');
    expect(decisionsItem.collapsibleState).toBe(0); // None
    store.close();
  });

  it('refresh() fires onDidChangeTreeData so a registered vscode.TreeView re-queries getChildren', () => {
    const provider = new AriadneTreeDataProvider(
      () => undefined,
      () => undefined,
    );
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    provider.refresh();
    expect(fired).toHaveLength(1);
  });
});
