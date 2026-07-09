import * as vscode from 'vscode';
import type { Checkpoint, Decision, OpenQuestion, Task, TaskError, TaskStore, Todo } from '@ariadne-dev/core';

/**
 * A minimal, read-only VS Code TreeDataProvider for browsing tasks and their
 * checkpoints/todos/decisions/errors/open questions (docs/04-ROADMAP.md §3 —
 * "tree view / timeline / knowledge-base browser UI"). This is deliberately
 * read-only for v1: it's a browsing surface, not an editing one — use the
 * `@ariadne` chat participant or CLI to mutate task state. The whole shape
 * (label/description-building pure functions, separate from the
 * `vscode.TreeDataProvider` class itself) mirrors the `commands.ts` /
 * `extension.ts` split elsewhere in this package, so the pure functions can
 * be unit-tested directly and the class only wires them into `vscode.TreeItem`.
 */

export type TaskCategory = 'checkpoints' | 'todos' | 'decisions' | 'errors' | 'questions';

export const TASK_CATEGORIES: readonly TaskCategory[] = ['checkpoints', 'todos', 'decisions', 'errors', 'questions'];

export interface TaskNode {
  kind: 'task';
  task: Task;
}

export interface CategoryNode {
  kind: 'category';
  category: TaskCategory;
  task: Task;
}

export interface LeafNode {
  kind: 'leaf';
  category: TaskCategory;
  id: string;
  label: string;
  description?: string;
}

export type AriadneTreeNode = TaskNode | CategoryNode | LeafNode;

const CATEGORY_LABELS: Record<TaskCategory, string> = {
  checkpoints: 'Checkpoints',
  todos: 'Todos',
  decisions: 'Decisions',
  errors: 'Errors',
  questions: 'Open Questions',
};

// ---------------------------------------------------------------------
// Pure label/description builders (no vscode dependency — unit-testable
// directly)
// ---------------------------------------------------------------------

export function taskTreeLabel(task: Task): string {
  return task.title;
}

export function taskTreeDescription(task: Task, currentTaskId: string | undefined): string {
  const parts: string[] = [task.status];
  if (task.id === currentTaskId) parts.unshift('current');
  return parts.join(' \u00b7 ');
}

export function categoryTreeLabel(category: TaskCategory, count: number): string {
  return `${CATEGORY_LABELS[category]} (${count})`;
}

export function checkpointTreeLabel(checkpoint: Checkpoint): string {
  return `[${checkpoint.level}] ${checkpoint.summary}`;
}

export function todoTreeLabel(todo: Todo): string {
  const marker = todo.status === 'done' ? '\u2713' : todo.status === 'blocked' ? '\u26d4' : '\u25cb';
  return `${marker} ${todo.text}`;
}

export function decisionTreeLabel(decision: Decision): string {
  return decision.text;
}

export function errorTreeLabel(error: TaskError): string {
  return `${error.resolved ? '\u2713' : '\u2717'} ${error.message}`;
}

export function questionTreeLabel(question: OpenQuestion): string {
  return `${question.resolved ? '\u2713' : '?'} ${question.text}`;
}

// ---------------------------------------------------------------------
// Pure tree-shape builders (take a TaskStore, return plain node arrays —
// unit-testable with an in-memory TaskStore, no vscode dependency)
// ---------------------------------------------------------------------

/** Root-level nodes: every task in the current workspace, most recently updated first. */
export function listRootTasks(store: TaskStore): Task[] {
  return [...store.listTasks()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A task's children: one category node per category, in a fixed order. */
export function listCategoryNodes(task: Task): CategoryNode[] {
  return TASK_CATEGORIES.map((category) => ({ kind: 'category', category, task }));
}

/** A category node's children: the individual checkpoints/todos/decisions/errors/questions for that task. */
export function listCategoryLeaves(store: TaskStore, task: Task, category: TaskCategory): LeafNode[] {
  switch (category) {
    case 'checkpoints':
      return store.listCheckpoints(task.id).map((cp) => ({
        kind: 'leaf',
        category,
        id: cp.id,
        label: checkpointTreeLabel(cp),
        description: cp.createdAt,
      }));
    case 'todos':
      return store.listTodos(task.id).map((todo) => ({
        kind: 'leaf',
        category,
        id: todo.id,
        label: todoTreeLabel(todo),
      }));
    case 'decisions':
      return store.listDecisions(task.id).map((decision) => ({
        kind: 'leaf',
        category,
        id: decision.id,
        label: decisionTreeLabel(decision),
        description: decision.rationale ?? undefined,
      }));
    case 'errors':
      return store.listErrors(task.id).map((error) => ({
        kind: 'leaf',
        category,
        id: error.id,
        label: errorTreeLabel(error),
      }));
    case 'questions':
      return store.listOpenQuestions(task.id).map((question) => ({
        kind: 'leaf',
        category,
        id: question.id,
        label: questionTreeLabel(question),
      }));
    default: {
      const exhaustive: never = category;
      throw new Error(`Unknown task category: ${exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------
// vscode.TreeDataProvider wiring
// ---------------------------------------------------------------------

export class AriadneTreeDataProvider implements vscode.TreeDataProvider<AriadneTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<AriadneTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly getStore: () => TaskStore | undefined,
    private readonly getCurrentTaskId: () => string | undefined,
  ) {}

  /** Call after any mutation (new task, checkpoint, todo, etc.) so the view reflects the latest state. */
  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(node: AriadneTreeNode): vscode.TreeItem {
    if (node.kind === 'task') {
      const isCurrent = node.task.id === this.getCurrentTaskId();
      const item = new vscode.TreeItem(taskTreeLabel(node.task), vscode.TreeItemCollapsibleState.Collapsed);
      item.description = taskTreeDescription(node.task, this.getCurrentTaskId());
      item.contextValue = 'ariadneTask';
      item.iconPath = new vscode.ThemeIcon(isCurrent ? 'star-full' : 'circle-outline');
      return item;
    }

    if (node.kind === 'category') {
      const store = this.getStore();
      const count = store ? listCategoryLeaves(store, node.task, node.category).length : 0;
      const collapsibleState =
        count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      const item = new vscode.TreeItem(categoryTreeLabel(node.category, count), collapsibleState);
      item.contextValue = 'ariadneCategory';
      return item;
    }

    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = `ariadneLeaf.${node.category}`;
    if (node.description) item.description = node.description;
    return item;
  }

  getChildren(node?: AriadneTreeNode): AriadneTreeNode[] {
    const store = this.getStore();
    if (!store) return [];

    if (!node) {
      return listRootTasks(store).map((task) => ({ kind: 'task', task }) satisfies TaskNode);
    }
    if (node.kind === 'task') {
      return listCategoryNodes(node.task);
    }
    if (node.kind === 'category') {
      return listCategoryLeaves(store, node.task, node.category);
    }
    return [];
  }
}
