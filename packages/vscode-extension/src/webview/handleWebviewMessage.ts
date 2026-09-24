import {
  DEFAULT_TOKEN_BUDGET,
  buildContext,
  exportTaskMarkdown,
  listTasksAcrossWorkspaces,
  searchAcrossWorkspaces,
  findTaskWorkspace,
  openRegistry,
  openWorkspaceStoreReadOnly,
  searchWorkspace,
  type ContextPackage,
  type Task,
  type TaskStore,
  type TaskStatus,
  type CheckpointLevel,
  type TodoStatus,
} from '@ariadne-dev/core';
import {
  WebviewRequestTypes,
  type ActivityItem,
  type CaptureHealth,
  type ContextSectionSummary,
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

function truncateText(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function formatCommandDetail(summary: string | null, exitCode: number | null): string | undefined {
  if (summary) return summary;
  return exitCode === null ? undefined : `exit ${exitCode}`;
}

function buildCheckpointActivityItem(checkpoint: ReturnType<TaskStore['listCheckpoints']>[number]): ActivityItem {
  return {
    id: `checkpoint:${checkpoint.id}`,
    kind: 'checkpoint',
    title: truncateText(checkpoint.summary),
    createdAt: checkpoint.createdAt,
    entityId: checkpoint.id,
    targetTab: 'overview',
    status: 'info',
  };
}

function buildTodoActivityItem(todo: ReturnType<TaskStore['listTodos']>[number]): ActivityItem {
  return {
    id: `todo:${todo.id}`,
    kind: 'todo',
    title: truncateText(todo.text),
    createdAt: todo.createdAt,
    entityId: todo.id,
    targetTab: 'todos',
    status: todo.status === 'done' ? 'success' : todo.status === 'blocked' ? 'warning' : 'info',
  };
}

function buildDecisionActivityItem(decision: ReturnType<TaskStore['listDecisions']>[number]): ActivityItem {
  return {
    id: `decision:${decision.id}`,
    kind: 'decision',
    title: truncateText(decision.text),
    detail: decision.rationale ?? undefined,
    createdAt: decision.createdAt,
    entityId: decision.id,
    targetTab: 'decisions',
    status: 'info',
  };
}

function buildErrorActivityItem(error: ReturnType<TaskStore['listErrors']>[number]): ActivityItem {
  return {
    id: `error:${error.id}`,
    kind: 'error',
    title: truncateText(error.message),
    detail: error.resolved ? error.resolution ?? 'Resolved' : undefined,
    createdAt: error.createdAt,
    entityId: error.id,
    targetTab: 'errors',
    status: error.resolved ? 'success' : 'error',
  };
}

function buildQuestionActivityItem(question: ReturnType<TaskStore['listOpenQuestions']>[number]): ActivityItem {
  return {
    id: `question:${question.id}`,
    kind: 'question',
    title: truncateText(question.text),
    detail: question.resolved ? 'Resolved' : undefined,
    createdAt: question.createdAt,
    entityId: question.id,
    targetTab: 'questions',
    status: question.resolved ? 'success' : 'warning',
  };
}

function buildFileCaptureActivityItem(capture: ReturnType<TaskStore['getTaskFileCaptures']>[number]): ActivityItem {
  return {
    id: `file-capture:${capture.id}`,
    kind: 'file-capture',
    title: `${capture.entries.length} captured file${capture.entries.length === 1 ? '' : 's'}`,
    detail: capture.gitCommitSha ?? capture.trigger,
    createdAt: capture.createdAt,
    entityId: capture.id,
    targetTab: 'files',
    status: capture.failedAt ? 'error' : 'info',
  };
}

function buildCommitActivityItem(commit: ReturnType<TaskStore['listCommits']>[number]): ActivityItem {
  return {
    id: `commit:${commit.sha}`,
    kind: 'commit',
    title: commit.sha.slice(0, 7),
    detail: commit.message ?? undefined,
    createdAt: commit.createdAt,
    entityId: commit.sha,
    targetTab: 'files',
    status: 'info',
  };
}

function buildCommandActivityItem(command: ReturnType<TaskStore['listCommands']>[number]): ActivityItem {
  return {
    id: `command:${command.id}`,
    kind: 'command',
    title: truncateText(command.cmdRedacted),
    detail: formatCommandDetail(command.summary, command.exitCode),
    createdAt: command.createdAt,
    entityId: command.id,
    status: command.exitCode === 0 ? 'success' : command.exitCode === null ? 'info' : 'error',
  };
}

function buildActivityItems(store: TaskStore, taskId: string, limit = 200): { items: ActivityItem[]; truncated: boolean } {
  const items: ActivityItem[] = [
    ...store.listCheckpoints(taskId).map(buildCheckpointActivityItem),
    ...store.listTodos(taskId).map(buildTodoActivityItem),
    ...store.listDecisions(taskId).map(buildDecisionActivityItem),
    ...store.listErrors(taskId).map(buildErrorActivityItem),
    ...store.listOpenQuestions(taskId).map(buildQuestionActivityItem),
    ...store.getTaskFileCaptures(taskId).map(buildFileCaptureActivityItem),
    ...store.listCommits(taskId, 100).map(buildCommitActivityItem),
    ...store.listCommands(taskId, 100).map(buildCommandActivityItem),
  ];
  const sorted = items.sort((left, right) => {
    const byTime = right.createdAt.localeCompare(left.createdAt);
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
  });
  return { items: sorted.slice(0, limit), truncated: sorted.length > limit };
}

function sumCounts(...counts: Array<number | undefined>): number | undefined {
  const total = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  return total > 0 ? total : undefined;
}

function buildContextSectionSummary(
  id: string,
  label: string,
  count: number,
  ...truncatedCounts: Array<number | undefined>
): ContextSectionSummary {
  const truncatedCount = sumCounts(...truncatedCounts);
  return truncatedCount === undefined ? { id, label, count } : { id, label, count, truncatedCount };
}

function pushSection(lines: string[], heading: string, entries: string[], empty: string): void {
  lines.push(`## ${heading}`);
  lines.push('');
  if (entries.length === 0) {
    lines.push(empty);
  } else {
    for (const entry of entries) {
      lines.push(`- ${entry}`);
    }
  }
  lines.push('');
}

export function formatContextPreview(context: ContextPackage): { markdown: string; sections: ContextSectionSummary[] } {
  const summaryEntries = [
    context.goal ? `Goal: ${context.goal}` : undefined,
    context.latestSummary ? `Latest checkpoint: ${context.latestSummary}` : undefined,
    context.branch ? `Task branch: ${context.branch}` : undefined,
    context.workspaceRoot ? `Workspace root: ${context.workspaceRoot}` : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  const todoEntries = [
    ...context.openTodos.map((todo) => `[pending] ${todo}`),
    ...context.blockedTodos.map((todo) => `[blocked] ${todo}`),
  ];
  const questionEntries = context.openQuestions;
  const errorEntries = context.unresolvedErrors;
  const decisionEntries = context.decisions;
  const fileEntries = context.recentFiles.map((file) => `\`${file.path}\` (${file.role})`);
  const commitEntries = context.recentCommits.map((commit) => `\`${commit.sha.slice(0, 7)}\`${commit.message ? ` ${commit.message}` : ''}`);
  const commandEntries = context.recentCommands.map((command) => {
    const exit = command.exitCode === null ? '' : ` (exit ${command.exitCode})`;
    return `\`${command.cmd}\`${exit}`;
  });

  const sections: ContextSectionSummary[] = [
    buildContextSectionSummary('summary', 'Summary', summaryEntries.length),
    buildContextSectionSummary('todos', 'Todos', todoEntries.length, context.truncated.pendingTodos, context.truncated.blockedTodos, context.truncated.resolvedTodos),
    buildContextSectionSummary('questions', 'Questions', questionEntries.length, context.truncated.openQuestions),
    buildContextSectionSummary('errors', 'Errors', errorEntries.length, context.truncated.unresolvedErrors),
    buildContextSectionSummary('decisions', 'Decisions', decisionEntries.length, context.truncated.decisions, context.truncated.historicalDecisions),
    buildContextSectionSummary('files', 'Files', fileEntries.length, context.truncated.recentFiles),
    buildContextSectionSummary('commits', 'Commits', commitEntries.length, context.truncated.recentCommits),
    buildContextSectionSummary('commands', 'Commands', commandEntries.length, context.truncated.commands),
  ];

  const lines: string[] = ['# Ariadne Context Preview', ''];
  lines.push(`- Task ID: ${context.taskId}`);
  if (context.workspaceRoot) lines.push(`- Workspace root: ${context.workspaceRoot}`);
  if (context.branch) lines.push(`- Task branch: ${context.branch}`);
  lines.push('');

  pushSection(lines, 'Summary', summaryEntries, '_No summary context included._');
  pushSection(lines, 'Todos', todoEntries, '_No todo context included._');
  pushSection(lines, 'Questions', questionEntries, '_No question context included._');
  pushSection(lines, 'Errors', errorEntries, '_No error context included._');
  pushSection(lines, 'Decisions', decisionEntries, '_No decision context included._');
  pushSection(lines, 'Files', fileEntries, '_No file context included._');
  pushSection(lines, 'Commits', commitEntries, '_No commit context included._');
  pushSection(lines, 'Commands', commandEntries, '_No command context included._');

  return { markdown: lines.join('\n').trim(), sections };
}

function buildCaptureHealth(deps: WebviewDispatcherDeps): CaptureHealth {
  const task = deps.currentTaskId ? deps.store.getTask(deps.currentTaskId) : undefined;
  const passiveCapture = deps.passiveCapture;
  const warnings: string[] = [];
  const currentBranch = passiveCapture?.currentBranch;
  const taskBranch = task?.branch;

  let branchMatches: boolean | 'unknown' = 'unknown';
  if (taskBranch && currentBranch) {
    branchMatches = taskBranch === currentBranch;
    if (!branchMatches) {
      warnings.push(
        `Current branch "${currentBranch}" does not match the task branch "${taskBranch}".`,
      );
    }
  }

  if (!task) {
    warnings.push('No current task is selected for this workspace.');
  }
  if (!passiveCapture?.enabled) {
    warnings.push('Passive capture is disabled.');
  }
  if (!passiveCapture?.shellIntegrationAvailable) {
    warnings.push('Shell integration is unavailable, so terminal commands will not be captured.');
  }
  if (!passiveCapture?.gitExtensionAvailable) {
    warnings.push('The built-in Git extension is unavailable, so commit capture is limited.');
  }

  const unresolvedErrors = task ? deps.store.listErrors(task.id).filter((error) => !error.resolved).length : 0;
  const lastFileCapture = task ? deps.store.getTaskFileCaptures(task.id)[0] : undefined;
  const lastCommand = task ? deps.store.listCommands(task.id, 1)[0] : undefined;
  const lastCommit = task ? deps.store.listCommits(task.id, 1)[0] : undefined;

  return {
    workspaceRoot: deps.workspaceRoot,
    currentTaskId: task?.id ?? deps.currentTaskId,
    currentTaskTitle: task?.title,
    passiveCaptureEnabled: passiveCapture?.enabled ?? false,
    shellIntegrationAvailable: passiveCapture?.shellIntegrationAvailable ?? false,
    gitExtensionAvailable: passiveCapture?.gitExtensionAvailable ?? false,
    branchMatches,
    currentBranch,
    taskBranch,
    lastFileCapture: lastFileCapture ? buildFileCaptureActivityItem(lastFileCapture) : undefined,
    lastCommand: lastCommand ? buildCommandActivityItem(lastCommand) : undefined,
    lastCommit: lastCommit ? buildCommitActivityItem(lastCommit) : undefined,
    unresolvedErrors,
    warnings,
  };
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

function handleActivityList(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  if (!deps.currentTaskId) {
    return { id: message.id, ok: true, data: { items: [], truncated: false }, state: buildWebviewState(deps) };
  }
  return {
    id: message.id,
    ok: true,
    data: buildActivityItems(deps.store, deps.currentTaskId),
    state: buildWebviewState(deps),
  };
}

function handleCaptureHealth(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  return {
    id: message.id,
    ok: true,
    data: { health: buildCaptureHealth(deps) },
    state: buildWebviewState(deps),
  };
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

function handleContextPreview(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse {
  const taskId = requireCurrentTaskId(deps, message.id);
  if (typeof taskId !== 'string') return taskId;
  const payload = getPayload(message);
  const tokenBudget = payload.tokenBudget === undefined ? DEFAULT_TOKEN_BUDGET : readNumber(payload.tokenBudget);
  if (payload.tokenBudget !== undefined && tokenBudget === undefined) {
    return errorResponse(message.id, 'context.preview requires payload.tokenBudget to be a finite number.');
  }
  const context = buildContext(deps.store, taskId, { tokenBudget, workspaceRoot: deps.workspaceRoot });
  const { markdown, sections } = formatContextPreview(context);
  return {
    id: message.id,
    ok: true,
    data: { preview: { context, markdown, tokenBudget, sections } },
    state: buildWebviewState({ ...deps, currentTaskId: taskId }),
  };
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
      case WebviewRequestTypes.ActivityList:
        return handleActivityList(deps, message);
      case WebviewRequestTypes.CaptureHealth:
        return handleCaptureHealth(deps, message);
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
      case WebviewRequestTypes.ContextPreview:
        return handleContextPreview(deps, message);
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
