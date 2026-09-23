import type {
  Checkpoint,
  Decision,
  OpenQuestion,
  SearchResult,
  TaskStore,
  Task,
  TaskError,
  TaskFileCaptureWithEntries,
  Todo,
} from '@ariadne-dev/core';

export const WebviewRequestTypes = {
  StateGet: 'state.get',
  TaskSwitch: 'task.switch',
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

export type WebviewRequest = {
  id: string;
  type: WebviewRequestType;
  payload?: unknown;
};

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
  setCurrentTaskId?: (id: string) => void;
  sync?: SyncActions;
  writeExport?: (taskId: string, markdown: string) => string;
}

export type WebviewResponse =
  | { id: string; ok: true; data: unknown; state?: WebviewState }
  | { id: string; ok: false; error: string };

export type HostToWebviewMessage =
  | { type: 'stateUpdate'; state: WebviewState }
  | WebviewResponse;
