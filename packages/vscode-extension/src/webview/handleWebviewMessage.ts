import {
  buildContext,
  exportTaskMarkdown,
  listTasksAcrossWorkspaces,
  searchAcrossWorkspaces,
  findTaskWorkspace,
  openRegistry,
  openWorkspaceStoreReadOnly,
  searchWorkspace,
  type Task,
  type TaskStore,
  type TaskStatus,
  type CheckpointLevel,
  type TodoStatus,
} from '@ariadne-dev/core';
import {
  WebviewRequestTypes,
  type SyncActions,
  type WebviewCounts,
  type WebviewDispatcherDeps,
  type WebviewRequest,
  type WebviewResponse,
  type WebviewState,
} from './messages.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPayload(message: WebviewRequest): Record<string, unknown> {
  return isRecord(message.payload) ? message.payload : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'done' || value === 'blocked';
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'active' || value === 'paused' || value === 'done' || value === 'archived';
}

function isCheckpointLevel(value: unknown): value is CheckpointLevel {
  return value === 'micro' || value === 'session' || value === 'milestone';
}

function errorResponse(id: string, error: string): WebviewResponse {
  return { id, ok: false, error };
}

function requireCurrentTaskId(deps: WebviewDispatcherDeps, id: string): string | WebviewResponse {
  const currentTaskId = deps.currentTaskId;
  if (!currentTaskId) {
    return errorResponse(id, 'No current Ariadne task is selected.');
  }
  return currentTaskId;
}

function resolveTaskStoreForSwitch(
  deps: WebviewDispatcherDeps,
  taskId: string,
  responseId: string,
): { store: TaskStore; workspaceRoot: string | undefined } | WebviewResponse {
  if (deps.store.getTask(taskId)) {
    return { store: deps.store, workspaceRoot: deps.workspaceRoot };
  }

  if (!deps.workspaceRoot) {
    return errorResponse(responseId, 'task.switch cannot resolve cross-workspace tasks without a workspace root.');
  }

  const otherRoot = findTaskWorkspace(openRegistry(), taskId);
  if (!otherRoot || otherRoot === deps.workspaceRoot) {
    return errorResponse(responseId, `Task not found: ${taskId}`);
  }

  const otherStore = openWorkspaceStoreReadOnly(otherRoot);
  const task = otherStore.getTask(taskId);
  if (!task) {
    otherStore.close();
    return errorResponse(responseId, `Task not found: ${taskId}`);
  }

  return { store: otherStore, workspaceRoot: otherRoot };
}

function buildCounts(currentTaskId: string | undefined, store: WebviewDispatcherDeps['store']): WebviewCounts {
  if (!currentTaskId) {
    return { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 };
  }
  return {
    pendingTodos: store.listTodos(currentTaskId).filter((todo) => todo.status === 'pending').length,
    unresolvedErrors: store.listErrors(currentTaskId).filter((error) => !error.resolved).length,
    openQuestions: store.listOpenQuestions(currentTaskId).filter((question) => !question.resolved).length,
  };
}

export function buildWebviewState(deps: WebviewDispatcherDeps): WebviewState {
  const currentTask = deps.currentTaskId ? deps.store.getTask(deps.currentTaskId) : undefined;
  const currentTaskId = currentTask?.id ?? deps.currentTaskId;
  return {
    workspaceRoot: deps.workspaceRoot,
    currentTaskId,
    currentTask,
    tasks: deps.store.listTasks(),
    checkpoints: currentTaskId ? deps.store.listCheckpoints(currentTaskId) : [],
    todos: currentTaskId ? deps.store.listTodos(currentTaskId) : [],
    decisions: currentTaskId ? deps.store.listDecisions(currentTaskId) : [],
    errors: currentTaskId ? deps.store.listErrors(currentTaskId) : [],
    questions: currentTaskId ? deps.store.listOpenQuestions(currentTaskId) : [],
    fileCaptures: currentTaskId ? deps.store.getTaskFileCaptures(currentTaskId) : [],
    searchResults: [],
    counts: buildCounts(currentTaskId, deps.store),
  };
}

function mutateAndReturnState(
  deps: WebviewDispatcherDeps,
  id: string,
  mutate: () => unknown,
  currentTaskId: string | undefined = deps.currentTaskId,
): WebviewResponse {
  const data = mutate();
  return { id, ok: true, data, state: buildWebviewState({ ...deps, currentTaskId }) };
}

function handleTaskSwitch(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const taskId = readString(payload.id ?? payload.taskId);
  if (!taskId) {
    return errorResponse(message.id, 'task.switch requires payload.id.');
  }
  const resolved = resolveTaskStoreForSwitch(deps, taskId, message.id);
  if (!('store' in resolved)) {
    return resolved;
  }
  resolved.store.setCurrentTaskId(taskId);
  if (resolved.workspaceRoot === deps.workspaceRoot || !resolved.workspaceRoot) {
    deps.setCurrentTaskId?.(taskId);
  } else {
    deps.setCurrentTaskIdForWorkspace?.(taskId, resolved.workspaceRoot);
  }
  return {
    id: message.id,
    ok: true,
    data: { currentTaskId: taskId },
    state: buildWebviewState({
      ...deps,
      store: resolved.store,
      workspaceRoot: resolved.workspaceRoot,
      currentTaskId: taskId,
    }),
  };
}

function handleTasksList(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const allWorkspaces = readBoolean(payload.allWorkspaces) ?? false;
  const tasks = allWorkspaces ? listTasksAcrossWorkspaces() : deps.store.listTasks();
  return { id: message.id, ok: true, data: { tasks }, state: buildWebviewState(deps) };
}

function handleTaskCreate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const title = readString(payload.title);
  if (!title) return errorResponse(message.id, 'task.create requires payload.title.');
  if (payload.status !== undefined && !isTaskStatus(payload.status)) {
    return errorResponse(message.id, 'task.create requires payload.status to be active, paused, done, or archived.');
  }
  const created = deps.store.createTask({
    title,
    goal: readOptionalString(payload.goal),
    status: payload.status as TaskStatus | undefined,
    parentTaskId: readOptionalString(payload.parentTaskId),
    branch: readOptionalString(payload.branch),
  });
  deps.store.setCurrentTaskId(created.id);
  deps.setCurrentTaskId?.(created.id);
  return { id: message.id, ok: true, data: created, state: buildWebviewState({ ...deps, currentTaskId: created.id }) };
}

function handleTaskUpdate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const taskId = readString(payload.id) ?? deps.currentTaskId;
  if (!taskId) return errorResponse(message.id, 'task.update requires a current task or payload.id.');
  if (!deps.store.getTask(taskId)) return errorResponse(message.id, `Task not found: ${taskId}`);
  const title = payload.title === undefined ? undefined : readString(payload.title);
  const goal = payload.goal === undefined ? undefined : readOptionalString(payload.goal);
  const branch = payload.branch === undefined ? undefined : readOptionalString(payload.branch);
  if (payload.title !== undefined && !title) return errorResponse(message.id, 'task.update payload.title must be a non-empty string.');
  if (title !== undefined) deps.store.updateTaskTitle(taskId, title);
  if (goal !== undefined) deps.store.updateTaskGoal(taskId, goal);
  if (branch !== undefined) deps.store.updateTaskBranch(taskId, branch);
  return mutateAndReturnState(deps, message.id, () => deps.store.getTask(taskId), taskId);
}

function handleTaskSetStatus(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const taskId = readString(payload.id) ?? deps.currentTaskId;
  const status = payload.status;
  if (!taskId || !isTaskStatus(status)) {
    return errorResponse(message.id, 'task.setStatus requires a task id and status of active, paused, done, or archived.');
  }
  if (!deps.store.getTask(taskId)) return errorResponse(message.id, `Task not found: ${taskId}`);
  deps.store.updateTaskStatus(taskId, status);
  return mutateAndReturnState(deps, message.id, () => ({ id: taskId, status }), deps.currentTaskId);
}

function handleCheckpointCreate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const summary = readString(payload.summary);
  const level = payload.level === undefined ? 'micro' : payload.level;
  if (!summary) return errorResponse(message.id, 'checkpoint.create requires payload.summary.');
  if (!isCheckpointLevel(level)) return errorResponse(message.id, 'checkpoint.create requires payload.level to be micro, session, or milestone.');
  const checkpoint = deps.store.createCheckpoint({
    taskId,
    summary,
    level,
    parentCheckpointId: readOptionalString(payload.parentCheckpointId),
  });
  return mutateAndReturnState(deps, message.id, () => checkpoint, taskId);
}

function handleContextGet(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const tokenBudget = payload.tokenBudget === undefined ? undefined : readNumber(payload.tokenBudget);
  if (payload.tokenBudget !== undefined && tokenBudget === undefined) {
    return errorResponse(message.id, 'context.get requires payload.tokenBudget to be a finite number.');
  }
  const context = buildContext(deps.store, taskId, { ...(tokenBudget === undefined ? {} : { tokenBudget }), workspaceRoot: deps.workspaceRoot });
  return { id: message.id, ok: true, data: { context }, state: buildWebviewState({ ...deps, currentTaskId: taskId }) };
}

function handleTodoCreate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const text = readString(payload.text);
  if (!text) return errorResponse(message.id, 'todo.create requires payload.text.');
  const status = payload.status === undefined ? undefined : isTodoStatus(payload.status) ? payload.status : undefined;
  if (payload.status !== undefined && !status) {
    return errorResponse(message.id, 'todo.create requires payload.status to be pending, done, or blocked.');
  }
  const created = deps.store.createTodo({ taskId, text, status, sourceCheckpointId: readOptionalString(payload.sourceCheckpointId) ?? undefined });
  return mutateAndReturnState(deps, message.id, () => created, taskId);
}

function handleTodoUpdateText(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  const text = readString(payload.text);
  if (!id || !text) return errorResponse(message.id, 'todo.updateText requires payload.id and payload.text.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.updateTodoText(id, text);
      return { id };
    },
  );
}

function handleTodoSetStatus(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  const status = payload.status === undefined ? undefined : isTodoStatus(payload.status) ? payload.status : undefined;
  if (!id || !status) return errorResponse(message.id, 'todo.setStatus requires payload.id and payload.status to be pending, done, or blocked.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.updateTodoStatus(id, status);
      return { id, status };
    },
  );
}

function handleTodoDelete(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'todo.delete requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.deleteTodo(id);
      return { id };
    },
  );
}

function handleDecisionCreate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const text = readString(payload.text);
  if (!text) return errorResponse(message.id, 'decision.create requires payload.text.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => deps.store.recordDecision({
      taskId,
      text,
      rationale: readOptionalString(payload.rationale) ?? undefined,
      supersedesId: readOptionalString(payload.supersedesId) ?? undefined,
      checkpointId: readOptionalString(payload.checkpointId) ?? undefined,
    }),
    taskId,
  );
}

function handleDecisionUpdate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'decision.update requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.updateDecision(id, {
        text: readOptionalString(payload.text) ?? undefined,
        rationale: readOptionalString(payload.rationale),
        supersedesId: readOptionalString(payload.supersedesId),
      });
      return { id };
    },
  );
}

function handleDecisionDelete(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'decision.delete requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.deleteDecision(id);
      return { id };
    },
  );
}

function handleErrorCreate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const messageText = readString(payload.message);
  if (!messageText) return errorResponse(message.id, 'error.create requires payload.message.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => deps.store.recordError({
      taskId,
      message: messageText,
      resolved: readBoolean(payload.resolved),
      resolution: readOptionalString(payload.resolution) ?? undefined,
    }),
    taskId,
  );
}

function handleErrorUpdate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  const messageText = readString(payload.message);
  if (!id || !messageText) return errorResponse(message.id, 'error.update requires payload.id and payload.message.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.updateError(id, messageText);
      return { id };
    },
  );
}

function handleErrorResolve(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'error.resolve requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.resolveError(id, readOptionalString(payload.resolution) ?? undefined);
      return { id };
    },
  );
}

function handleErrorReopen(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'error.reopen requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.unresolveError(id);
      return { id };
    },
  );
}

function handleErrorDelete(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'error.delete requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.deleteError(id);
      return { id };
    },
  );
}

function handleQuestionCreate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const text = readString(payload.text);
  if (!text) return errorResponse(message.id, 'question.create requires payload.text.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => deps.store.recordOpenQuestion({
      taskId,
      text,
      resolved: readBoolean(payload.resolved),
    }),
    taskId,
  );
}

function handleQuestionUpdate(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  const text = readString(payload.text);
  if (!id || !text) return errorResponse(message.id, 'question.update requires payload.id and payload.text.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.updateOpenQuestion(id, text);
      return { id };
    },
  );
}

function handleQuestionResolve(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'question.resolve requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.resolveOpenQuestion(id);
      return { id };
    },
  );
}

function handleQuestionReopen(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'question.reopen requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.unresolveOpenQuestion(id);
      return { id };
    },
  );
}

function handleQuestionDelete(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const id = readString(payload.id);
  if (!id) return errorResponse(message.id, 'question.delete requires payload.id.');
  return mutateAndReturnState(
    deps,
    message.id,
    () => {
      deps.store.deleteOpenQuestion(id);
      return { id };
    },
  );
}

function handleFilesList(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const captures = deps.store.getTaskFileCaptures(taskId);
  return { id: message.id, ok: true, data: { captures }, state: buildWebviewState({ ...deps, currentTaskId: taskId }) };
}

function handleFilesGetCapture(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const captureId = readString(payload.id);
  if (!captureId) return errorResponse(message.id, 'files.getCapture requires payload.id.');
  const capture = deps.store.getTaskFileCaptures(taskId).find((entry) => entry.id === captureId);
  if (!capture) return errorResponse(message.id, `File capture not found: ${captureId}`);
  return { id: message.id, ok: true, data: { capture }, state: buildWebviewState({ ...deps, currentTaskId: taskId }) };
}

function handleSearchRun(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const payload = getPayload(message);
  const query = readString(payload.query);
  if (!query) return errorResponse(message.id, 'search.run requires payload.query.');
  const allWorkspaces = readBoolean(payload.allWorkspaces) ?? false;
  const limit = readNumber(payload.limit);
  const maxMatchesPerTask = readNumber(payload.maxMatchesPerTask);
  const totalLimit = readNumber(payload.totalLimit);
  const recentOnly = readNumber(payload.recentOnly);
  const results = allWorkspaces
    ? searchAcrossWorkspaces(query, {
        ...(limit !== undefined ? { limit } : {}),
        ...(maxMatchesPerTask !== undefined ? { maxMatchesPerTask } : {}),
        ...(totalLimit !== undefined ? { totalLimit } : {}),
        ...(recentOnly !== undefined ? { recentOnly } : {}),
        allWorkspaces: true,
      })
    : searchWorkspace(deps.store as TaskStore, query, {
        ...(limit !== undefined ? { limit } : {}),
        ...(maxMatchesPerTask !== undefined ? { maxMatchesPerTask } : {}),
      });
  return { id: message.id, ok: true, data: { results }, state: buildWebviewState(deps) };
}

function handleSyncPush(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  if (!deps.sync) return errorResponse(message.id, 'Sync actions are not configured.');
  return { id: message.id, ok: true, data: { output: deps.sync.push() }, state: buildWebviewState(deps) };
}

function handleSyncPull(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  if (!deps.sync) return errorResponse(message.id, 'Sync actions are not configured.');
  const payload = getPayload(message);
  const options = {
    importNew: readBoolean(payload.importNew),
    onConflict: payload.onConflict === 'remote-wins' || payload.onConflict === 'local-wins'
      ? (payload.onConflict as 'remote-wins' | 'local-wins')
      : undefined,
  };
  return { id: message.id, ok: true, data: { output: deps.sync.pull(options) }, state: buildWebviewState(deps) };
}

function handleSyncListRemote(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  if (!deps.sync) return errorResponse(message.id, 'Sync actions are not configured.');
  return { id: message.id, ok: true, data: { output: deps.sync.listRemote() }, state: buildWebviewState(deps) };
}

function handleExportMarkdown(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  if (!deps.writeExport) return errorResponse(message.id, 'Export writer is not configured.');
  const markdown = exportTaskMarkdown(deps.store as TaskStore, taskId);
  const context = buildContext(deps.store, taskId, { workspaceRoot: deps.workspaceRoot });
  const path = deps.writeExport(taskId, markdown);
  return {
    id: message.id,
    ok: true,
    data: { path, markdown, context },
    state: buildWebviewState({ ...deps, currentTaskId: taskId }),
  };
}

export function handleWebviewMessage(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  try {
    switch (message.type) {
      case WebviewRequestTypes.StateGet:
        return { id: message.id, ok: true, data: buildWebviewState(deps) };
      case WebviewRequestTypes.TaskCreate:
        return handleTaskCreate(deps, message);
      case WebviewRequestTypes.TaskUpdate:
        return handleTaskUpdate(deps, message);
      case WebviewRequestTypes.TaskSetStatus:
        return handleTaskSetStatus(deps, message);
      case WebviewRequestTypes.TaskSwitch:
        return handleTaskSwitch(deps, message);
      case WebviewRequestTypes.CheckpointCreate:
        return handleCheckpointCreate(deps, message);
      case WebviewRequestTypes.ContextGet:
        return handleContextGet(deps, message);
      case WebviewRequestTypes.TasksList:
        return handleTasksList(deps, message);
      case WebviewRequestTypes.TodoCreate:
        return handleTodoCreate(deps, message);
      case WebviewRequestTypes.TodoUpdateText:
        return handleTodoUpdateText(deps, message);
      case WebviewRequestTypes.TodoSetStatus:
        return handleTodoSetStatus(deps, message);
      case WebviewRequestTypes.TodoDelete:
        return handleTodoDelete(deps, message);
      case WebviewRequestTypes.DecisionCreate:
        return handleDecisionCreate(deps, message);
      case WebviewRequestTypes.DecisionUpdate:
        return handleDecisionUpdate(deps, message);
      case WebviewRequestTypes.DecisionDelete:
        return handleDecisionDelete(deps, message);
      case WebviewRequestTypes.ErrorCreate:
        return handleErrorCreate(deps, message);
      case WebviewRequestTypes.ErrorUpdate:
        return handleErrorUpdate(deps, message);
      case WebviewRequestTypes.ErrorResolve:
        return handleErrorResolve(deps, message);
      case WebviewRequestTypes.ErrorReopen:
        return handleErrorReopen(deps, message);
      case WebviewRequestTypes.ErrorDelete:
        return handleErrorDelete(deps, message);
      case WebviewRequestTypes.QuestionCreate:
        return handleQuestionCreate(deps, message);
      case WebviewRequestTypes.QuestionUpdate:
        return handleQuestionUpdate(deps, message);
      case WebviewRequestTypes.QuestionResolve:
        return handleQuestionResolve(deps, message);
      case WebviewRequestTypes.QuestionReopen:
        return handleQuestionReopen(deps, message);
      case WebviewRequestTypes.QuestionDelete:
        return handleQuestionDelete(deps, message);
      case WebviewRequestTypes.FilesList:
        return handleFilesList(deps, message);
      case WebviewRequestTypes.FilesGetCapture:
        return handleFilesGetCapture(deps, message);
      case WebviewRequestTypes.SearchRun:
        return handleSearchRun(deps, message);
      case WebviewRequestTypes.SyncPush:
        return handleSyncPush(deps, message);
      case WebviewRequestTypes.SyncPull:
        return handleSyncPull(deps, message);
      case WebviewRequestTypes.SyncListRemote:
        return handleSyncListRemote(deps, message);
      case WebviewRequestTypes.ExportMarkdown:
        return handleExportMarkdown(deps, message);
      default:
        return errorResponse(
          (message as WebviewRequest).id,
          `Unsupported webview request: ${(message as WebviewRequest).type}`,
        );
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return errorResponse(message.id, messageText);
  }
}
