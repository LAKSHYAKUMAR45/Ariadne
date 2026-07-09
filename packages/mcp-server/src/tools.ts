import type {
  Checkpoint,
  CheckpointLevel,
  ContextPackage,
  Decision,
  OpenQuestion,
  SearchResult,
  SyncGitResult,
  Task,
  TaskError,
  TaskStatus,
  TaskStore,
  Todo,
  TodoStatus,
} from '@ariadne/core';
import {
  buildContext,
  syncTaskGit,
  exportTaskMarkdown,
  searchWorkspace,
  resolveTaskAnyWorkspace,
  listTasksAcrossWorkspaces,
  searchAcrossWorkspaces,
} from '@ariadne/core';
import type { CrossWorkspaceTask, CrossWorkspaceSearchResult } from '@ariadne/core';
import { readCurrentTaskId, setCurrentTaskId } from './workspace.js';

/**
 * Pure, MCP-transport-agnostic implementations of every tool this server
 * exposes. Kept separate from `server.ts` (which only wires these into the
 * MCP SDK's tool-registration API) so they're directly unit-testable and so
 * the same logic could be reused by another surface later without pulling in
 * the MCP SDK.
 */

/** Resolves which task id to operate on: explicit id wins, else the workspace's current task. Throws if neither is available. */
export function resolveTaskId(store: TaskStore, workspaceRoot: string, explicitId: string | undefined): string {
  const id = explicitId ?? readCurrentTaskId(workspaceRoot);
  if (!id) {
    throw new Error('No task specified and no current task set. Call task_new first, or pass a taskId.');
  }
  const task = store.getTask(id);
  if (!task) {
    throw new Error(`No task found with id "${id}".`);
  }
  return id;
}

/**
 * Resolves which task to operate on (explicit id, else the workspace's
 * current task) and runs `fn` against whichever store actually owns it.
 * If the id isn't a task in the current workspace's `store`, transparently
 * falls back to the global cross-workspace registry (`resolveTaskAnyWorkspace`)
 * to find and open the real owning workspace's store, closing it again once
 * `fn` returns. This is what lets every taskId-scoped tool (checkpoint_add,
 * todo_add, get_context, git_sync, export_task, etc.) operate on a task from
 * a different workspace without the caller needing to know its root ahead
 * of time — mirroring the CLI's `withResolvedTask`.
 */
function withTaskStore<T>(
  store: TaskStore,
  workspaceRoot: string,
  explicitId: string | undefined,
  fn: (store: TaskStore, taskId: string, workspaceRoot: string) => T,
): T {
  const id = explicitId ?? readCurrentTaskId(workspaceRoot);
  if (!id) {
    throw new Error('No task specified and no current task set. Call task_new first, or pass a taskId.');
  }
  if (store.getTask(id)) {
    return fn(store, id, workspaceRoot);
  }
  const resolved = resolveTaskAnyWorkspace(id, workspaceRoot);
  if (!resolved) {
    throw new Error(`No task found with id "${id}" in this workspace or any other known workspace.`);
  }
  if (resolved.fromCurrentWorkspace) {
    // Shouldn't normally happen (already checked store.getTask above), but
    // close the redundant store resolveTaskAnyWorkspace opened just in case.
    resolved.store.close();
    return fn(store, id, workspaceRoot);
  }
  try {
    return fn(resolved.store, id, resolved.workspaceRoot);
  } finally {
    resolved.store.close();
  }
}

export interface TaskNewArgs {
  title: string;
  goal?: string;
}

export function taskNew(store: TaskStore, workspaceRoot: string, args: TaskNewArgs): Task {
  const created = store.createTask({ title: args.title, goal: args.goal });
  setCurrentTaskId(created.id, workspaceRoot);
  return created;
}

export interface TaskListArgs {
  status?: TaskStatus;
  allWorkspaces?: boolean;
}

/**
 * Lists tasks in this workspace, or (with `allWorkspaces: true`) every task
 * across every workspace Ariadne has ever seen, via the cross-workspace
 * registry's `listTasksAcrossWorkspaces` — each result tagged with its
 * `workspaceRoot` in that mode.
 */
export function taskList(store: TaskStore, args: TaskListArgs): Task[] | CrossWorkspaceTask[] {
  if (args.allWorkspaces) {
    return listTasksAcrossWorkspaces(args.status ? { status: args.status } : undefined);
  }
  return store.listTasks(args.status ? { status: args.status } : undefined);
}

export interface TaskUseArgs {
  taskId: string;
}

export function taskUse(store: TaskStore, workspaceRoot: string, args: TaskUseArgs): Task {
  const task = store.getTask(args.taskId);
  if (!task) {
    throw new Error(`No task found with id "${args.taskId}".`);
  }
  setCurrentTaskId(args.taskId, workspaceRoot);
  return task;
}

export interface TaskSetStatusArgs {
  taskId?: string;
  status: TaskStatus;
}

/** Backs task_pause/task_done/task_archive/task_reopen — all are the same "set task status" operation with a fixed status. */
export function taskSetStatus(store: TaskStore, workspaceRoot: string, args: TaskSetStatusArgs): Task {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) => {
    s.updateTaskStatus(taskId, args.status);
    return s.getTask(taskId)!;
  });
}

export interface CheckpointAddArgs {
  summary: string;
  level?: CheckpointLevel;
  taskId?: string;
}

export function checkpointAdd(store: TaskStore, workspaceRoot: string, args: CheckpointAddArgs): Checkpoint {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) =>
    s.createCheckpoint({ taskId, level: args.level ?? 'micro', summary: args.summary }),
  );
}

export interface TodoAddArgs {
  text: string;
  taskId?: string;
}

export function todoAdd(store: TaskStore, workspaceRoot: string, args: TodoAddArgs): Todo {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) => s.createTodo({ taskId, text: args.text }));
}

export interface TodoListArgs {
  status?: TodoStatus;
  taskId?: string;
}

export function todoList(store: TaskStore, workspaceRoot: string, args: TodoListArgs): Todo[] {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) =>
    s.listTodos(taskId, args.status ? { status: args.status } : undefined),
  );
}

export interface TodoDoneArgs {
  todoId: string;
}

export function todoDone(store: TaskStore, args: TodoDoneArgs): void {
  store.updateTodoStatus(args.todoId, 'done');
}

export interface DecisionAddArgs {
  text: string;
  rationale?: string;
  taskId?: string;
}

export function decisionAdd(store: TaskStore, workspaceRoot: string, args: DecisionAddArgs): Decision {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) =>
    s.recordDecision({ taskId, text: args.text, rationale: args.rationale }),
  );
}

export interface ErrorAddArgs {
  message: string;
  taskId?: string;
}

export function errorAdd(store: TaskStore, workspaceRoot: string, args: ErrorAddArgs): TaskError {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) => s.recordError({ taskId, message: args.message }));
}

export interface ErrorResolveArgs {
  errorId: string;
  resolution?: string;
}

export function errorResolve(store: TaskStore, args: ErrorResolveArgs): void {
  store.resolveError(args.errorId, args.resolution);
}

export interface QuestionAddArgs {
  text: string;
  taskId?: string;
}

export function questionAdd(store: TaskStore, workspaceRoot: string, args: QuestionAddArgs): OpenQuestion {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) => s.recordOpenQuestion({ taskId, text: args.text }));
}

export interface QuestionListArgs {
  taskId?: string;
  resolved?: boolean;
}

export function questionList(store: TaskStore, workspaceRoot: string, args: QuestionListArgs): OpenQuestion[] {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) =>
    s.listOpenQuestions(taskId, args.resolved !== undefined ? { resolved: args.resolved } : undefined),
  );
}

export interface QuestionResolveArgs {
  questionId: string;
}

export function questionResolve(store: TaskStore, args: QuestionResolveArgs): void {
  store.resolveOpenQuestion(args.questionId);
}

export interface SearchArgs {
  query: string;
  limit?: number;
  allWorkspaces?: boolean;
}

/**
 * Cross-entity search (title/goal, checkpoints, decisions, todos, errors,
 * open questions, files, commits). By default scoped to this workspace via
 * `@ariadne/core`'s shared `searchWorkspace`; pass `allWorkspaces: true` to
 * search every workspace Ariadne has ever seen (each result tagged with its
 * `workspaceRoot`) via `searchAcrossWorkspaces`.
 */
export function searchTasks(
  store: TaskStore,
  args: SearchArgs,
): SearchResult[] | CrossWorkspaceSearchResult[] {
  if (args.allWorkspaces) {
    return searchAcrossWorkspaces(args.query, args.limit ? { limit: args.limit } : undefined);
  }
  return searchWorkspace(store, args.query, args.limit ? { limit: args.limit } : undefined);
}

export interface GetContextArgs {
  taskId?: string;
  tokenBudget?: number;
}

/**
 * Assembles the current (or given) task's ranked, token-budgeted context —
 * this is the `task.getContext` tool from the architecture doc. Delegates to
 * `@ariadne/core`'s `buildContext` (the shared `ContextBuilder`), so the MCP
 * server, CLI, and any future surface rank/trim context identically instead
 * of each reimplementing an ad-hoc dump of raw data. Falls back to the
 * cross-workspace registry if `taskId` belongs to a different workspace.
 */
export function getContext(store: TaskStore, workspaceRoot: string, args: GetContextArgs): ContextPackage {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) =>
    buildContext(s, taskId, args.tokenBudget ? { tokenBudget: args.tokenBudget } : undefined),
  );
}

export interface GitSyncArgs {
  taskId?: string;
}

/**
 * Syncs the current git branch and any new commits (since what's already
 * recorded) into the current (or given) task, using @ariadne/core's
 * editor-agnostic GitWatcher (shells out to `git` directly) — so MCP
 * clients without an editor's git integration still get commit/branch
 * capture. Runs against the task's actual owning workspace root (which may
 * differ from the server's workspace if `taskId` belongs elsewhere).
 */
export function gitSync(store: TaskStore, workspaceRoot: string, args: GitSyncArgs): SyncGitResult {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId, ownerRoot) => syncTaskGit(s, taskId, ownerRoot));
}

export interface ExportTaskArgs {
  taskId?: string;
}

/**
 * Renders a task to Markdown as structured text — for a client to save,
 * paste into a PR description, or hand to a human. Mirrors the CLI's
 * `ariadne export` (which additionally writes the result to
 * `.ariadne/export/<task-id>.md`; the MCP tool just returns the text so the
 * calling client/editor decides where, if anywhere, to persist it).
 */
export function exportTask(store: TaskStore, workspaceRoot: string, args: ExportTaskArgs): { taskId: string; markdown: string } {
  return withTaskStore(store, workspaceRoot, args.taskId, (s, taskId) => ({ taskId, markdown: exportTaskMarkdown(s, taskId) }));
}
