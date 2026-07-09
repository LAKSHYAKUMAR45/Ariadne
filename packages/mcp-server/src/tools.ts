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
import { buildContext, syncTaskGit, exportTaskMarkdown, searchWorkspace } from '@ariadne/core';
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
}

export function taskList(store: TaskStore, args: TaskListArgs): Task[] {
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
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  store.updateTaskStatus(taskId, args.status);
  return store.getTask(taskId)!;
}

export interface CheckpointAddArgs {
  summary: string;
  level?: CheckpointLevel;
  taskId?: string;
}

export function checkpointAdd(store: TaskStore, workspaceRoot: string, args: CheckpointAddArgs): Checkpoint {
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return store.createCheckpoint({ taskId, level: args.level ?? 'micro', summary: args.summary });
}

export interface TodoAddArgs {
  text: string;
  taskId?: string;
}

export function todoAdd(store: TaskStore, workspaceRoot: string, args: TodoAddArgs): Todo {
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return store.createTodo({ taskId, text: args.text });
}

export interface TodoListArgs {
  status?: TodoStatus;
  taskId?: string;
}

export function todoList(store: TaskStore, workspaceRoot: string, args: TodoListArgs): Todo[] {
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return store.listTodos(taskId, args.status ? { status: args.status } : undefined);
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
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return store.recordDecision({ taskId, text: args.text, rationale: args.rationale });
}

export interface ErrorAddArgs {
  message: string;
  taskId?: string;
}

export function errorAdd(store: TaskStore, workspaceRoot: string, args: ErrorAddArgs): TaskError {
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return store.recordError({ taskId, message: args.message });
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
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return store.recordOpenQuestion({ taskId, text: args.text });
}

export interface QuestionListArgs {
  taskId?: string;
  resolved?: boolean;
}

export function questionList(store: TaskStore, workspaceRoot: string, args: QuestionListArgs): OpenQuestion[] {
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return store.listOpenQuestions(taskId, args.resolved !== undefined ? { resolved: args.resolved } : undefined);
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
}

/** Cross-entity workspace search (title/goal, checkpoints, decisions, todos, errors, open questions, files, commits), delegating to @ariadne/core's shared searchWorkspace. */
export function searchTasks(store: TaskStore, args: SearchArgs): SearchResult[] {
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
 * of each reimplementing an ad-hoc dump of raw data.
 */
export function getContext(store: TaskStore, workspaceRoot: string, args: GetContextArgs): ContextPackage {
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return buildContext(store, taskId, args.tokenBudget ? { tokenBudget: args.tokenBudget } : undefined);
}

export interface GitSyncArgs {
  taskId?: string;
}

/**
 * Syncs the current git branch and any new commits (since what's already
 * recorded) into the current (or given) task, using @ariadne/core's
 * editor-agnostic GitWatcher (shells out to `git` directly) — so MCP
 * clients without an editor's git integration still get commit/branch
 * capture.
 */
export function gitSync(store: TaskStore, workspaceRoot: string, args: GitSyncArgs): SyncGitResult {
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return syncTaskGit(store, taskId, workspaceRoot);
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
  const taskId = resolveTaskId(store, workspaceRoot, args.taskId);
  return { taskId, markdown: exportTaskMarkdown(store, taskId) };
}
