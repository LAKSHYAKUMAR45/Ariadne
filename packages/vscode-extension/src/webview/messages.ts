import type {
  CheckpointLevel,
  Checkpoint,
  ContextPackage,
  Decision,
  OpenQuestion,
  SearchResult,
  TaskStore,
  Task,
  TaskError,
  TaskFileCaptureWithEntries,
  TaskStatus,
  Todo,
  TodoStatus,
} from '@ariadne-dev/core';

export type {
  Checkpoint,
  CheckpointLevel,
  Decision,
  OpenQuestion,
  SearchResult,
  Task,
  TaskError,
  TaskFileCaptureWithEntries,
  TaskStatus,
  Todo,
  TodoStatus,
} from '@ariadne-dev/core';

export const WebviewRequestTypes = {
  StateGet: 'state.get',
  ActivityList: 'activity.list',
  CaptureHealth: 'capture.health',
  TaskCreate: 'task.create',
  TaskUpdate: 'task.update',
  TaskSetStatus: 'task.setStatus',
  TaskSwitch: 'task.switch',
  CheckpointCreate: 'checkpoint.create',
  ContextGet: 'context.get',
  ContextPreview: 'context.preview',
  ContextCopy: 'context.copy',
  ContextOpen: 'context.open',
  FileOpen: 'file.open',
  TasksList: 'tasks.list',
  TodoCreate: 'todo.create',
  TodoUpdateText: 'todo.updateText',
  TodoSetStatus: 'todo.setStatus',
  TodoDelete: 'todo.delete',
  DecisionCreate: 'decision.create',
  DecisionUpdate: 'decision.update',
  DecisionDelete: 'decision.delete',
  ErrorCreate: 'error.create',
  ErrorUpdate: 'error.update',
  ErrorResolve: 'error.resolve',
  ErrorReopen: 'error.reopen',
  ErrorDelete: 'error.delete',
  QuestionCreate: 'question.create',
  QuestionUpdate: 'question.update',
  QuestionResolve: 'question.resolve',
  QuestionReopen: 'question.reopen',
  QuestionDelete: 'question.delete',
  FilesList: 'files.list',
  FilesGetCapture: 'files.getCapture',
  SearchRun: 'search.run',
  SyncPush: 'sync.push',
  SyncPull: 'sync.pull',
  SyncListRemote: 'sync.listRemote',
  ExportMarkdown: 'export.markdown',
} as const;

export type WebviewRequestType = (typeof WebviewRequestTypes)[keyof typeof WebviewRequestTypes];

export interface WebviewRequestBase<T extends WebviewRequestType = WebviewRequestType> {
  id: string;
  type: T;
}

export type WebviewTabId =
  | 'overview'
  | 'todos'
  | 'decisions'
  | 'errors'
  | 'questions'
  | 'files'
  | 'search'
  | 'sync'
  | 'activity'
  | 'context'
  | 'review'
  | 'graphify';

export type ActivityKind =
  | 'checkpoint'
  | 'todo'
  | 'decision'
  | 'error'
  | 'question'
  | 'file-capture'
  | 'commit'
  | 'command';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  createdAt: string;
  entityId?: string;
  targetTab?: WebviewTabId;
  status?: 'info' | 'success' | 'warning' | 'error';
}

export interface CaptureHealth {
  workspaceRoot?: string;
  currentTaskId?: string;
  currentTaskTitle?: string;
  passiveCaptureEnabled: boolean;
  shellIntegrationAvailable: boolean;
  gitExtensionAvailable: boolean;
  branchMatches: boolean | 'unknown';
  currentBranch?: string;
  taskBranch?: string | null;
  lastFileCapture?: ActivityItem;
  lastCommand?: ActivityItem;
  lastCommit?: ActivityItem;
  unresolvedErrors: number;
  warnings: string[];
}

export interface ContextSectionSummary {
  id: string;
  label: string;
  count: number;
  truncatedCount?: number;
}

export interface ContextPreview {
  context: ContextPackage;
  markdown: string;
  tokenBudget: number;
  sections: ContextSectionSummary[];
}

export type WebviewRequest =
  | (WebviewRequestBase<'state.get' | 'activity.list' | 'capture.health' | 'tasks.list' | 'sync.push' | 'sync.listRemote' | 'export.markdown'> & {
      payload?: undefined;
    })
  | (WebviewRequestBase<'task.create'> & {
      payload: { title: string; goal?: string | null; status?: TaskStatus; parentTaskId?: string | null; branch?: string | null };
    })
  | (WebviewRequestBase<'task.update'> & {
      payload: { id?: string; title?: string; goal?: string | null; branch?: string | null };
    })
  | (WebviewRequestBase<'task.setStatus'> & { payload: { id?: string; status: TaskStatus } })
  | (WebviewRequestBase<'task.switch'> & { payload: { id: string } })
  | (WebviewRequestBase<'checkpoint.create'> & {
      payload: { summary: string; level?: CheckpointLevel; parentCheckpointId?: string | null };
    })
  | (WebviewRequestBase<'context.get'> & { payload?: { tokenBudget?: number } })
  | (WebviewRequestBase<'context.preview'> & { payload?: { tokenBudget?: number } })
  | (WebviewRequestBase<'context.copy' | 'context.open'> & { payload: { markdown: string } })
  | (WebviewRequestBase<'file.open'> & { payload: { path: string } })
  | (WebviewRequestBase<'todo.create'> & { payload: Record<string, unknown> })
  | (WebviewRequestBase<'todo.updateText' | 'todo.setStatus' | 'todo.delete'> & { payload: Record<string, unknown> })
  | (WebviewRequestBase<'decision.create' | 'decision.update' | 'decision.delete'> & { payload: Record<string, unknown> })
  | (WebviewRequestBase<'error.create' | 'error.update' | 'error.resolve' | 'error.reopen' | 'error.delete'> & {
      payload: Record<string, unknown>;
    })
  | (WebviewRequestBase<'question.create' | 'question.update' | 'question.resolve' | 'question.reopen' | 'question.delete'> & {
      payload: Record<string, unknown>;
    })
  | (WebviewRequestBase<'files.list' | 'files.getCapture' | 'search.run' | 'sync.pull'> & { payload?: Record<string, unknown> });

export interface WebviewCounts {
  pendingTodos: number;
  unresolvedErrors: number;
  openQuestions: number;
}

export interface WebviewState {
  workspaceRoot?: string;
  currentTaskId?: string;
  currentTask?: Task;
  tasks: Task[];
  checkpoints: Checkpoint[];
  todos: Todo[];
  decisions: Decision[];
  errors: TaskError[];
  questions: OpenQuestion[];
  fileCaptures: TaskFileCaptureWithEntries[];
  searchResults: SearchResult[];
  counts: WebviewCounts;
}

export interface SyncActions {
  push: () => string;
  pull: (options?: { importNew?: boolean; onConflict?: 'remote-wins' | 'local-wins' }) => string;
  listRemote: () => string;
}

export interface WebviewDispatcherDeps {
  store: TaskStore;
  currentTaskId?: string;
  workspaceRoot?: string;
  passiveCapture?: {
    enabled: boolean;
    shellIntegrationAvailable: boolean;
    gitExtensionAvailable: boolean;
    currentBranch?: string;
  };
  setCurrentTaskId?: (id: string) => void;
  setCurrentTaskIdForWorkspace?: (id: string, workspaceRoot: string) => void;
  sync?: SyncActions;
  writeExport?: (taskId: string, markdown: string) => string;
  copyText?: (text: string) => Promise<void> | void;
  openMarkdown?: (title: string, markdown: string) => Promise<void> | void;
  openWorkspaceFile?: (relativePath: string) => Promise<void> | void;
}

export type WebviewResponse =
  | { id: string; ok: true; data: unknown; state?: WebviewState }
  | { id: string; ok: false; error: string };

export type HostToWebviewMessage =
  | { type: 'stateUpdate'; state: WebviewState }
  | WebviewResponse;
