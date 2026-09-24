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
  TaskCreateFromTemplate: 'task.createFromTemplate',
  TaskUpdate: 'task.update',
  TaskSetStatus: 'task.setStatus',
  TaskSwitch: 'task.switch',
  CheckpointCreate: 'checkpoint.create',
  ContextGet: 'context.get',
  ContextPreview: 'context.preview',
  ContextCopy: 'context.copy',
  ContextOpen: 'context.open',
  ContextOpenInChat: 'context.openInChat',
  ContextOpenInCli: 'context.openInCli',
  ReviewGet: 'review.get',
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
  SyncProfileList: 'sync.profileList',
  SyncPush: 'sync.push',
  SyncPull: 'sync.pull',
  SyncListRemote: 'sync.listRemote',
  ExportMarkdown: 'export.markdown',
  GraphifyRun: 'graphify.run',
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

export type TaskTemplateId = 'feature' | 'bugfix' | 'review' | 'research' | 'incident';

export interface TaskTemplateDecision {
  text: string;
  rationale?: string;
}

export interface TaskTemplate {
  id: TaskTemplateId;
  label: string;
  description: string;
  todos: string[];
  questions: string[];
  decisions?: TaskTemplateDecision[];
}

export const TaskTemplates: Record<TaskTemplateId, TaskTemplate> = {
  feature: {
    id: 'feature',
    label: 'Feature',
    description: 'Plan and deliver a scoped product or engineering change.',
    todos: ['Clarify acceptance criteria', 'Implement the smallest complete change', 'Add or update tests', 'Update related docs'],
    questions: ['What user-visible behavior defines success?'],
  },
  bugfix: {
    id: 'bugfix',
    label: 'Bugfix',
    description: 'Triage a regression, protect it with tests, and verify the fix.',
    todos: ['Reproduce the bug', 'Add regression coverage', 'Verify the fix'],
    questions: ['What exact user-visible behavior is broken?'],
  },
  review: {
    id: 'review',
    label: 'Review',
    description: 'Inspect a change, validate it, and record findings.',
    todos: ['Inspect the relevant diff', 'Run targeted validation', 'Document findings or approval'],
    questions: ['What risk should this review focus on?'],
  },
  research: {
    id: 'research',
    label: 'Research',
    description: 'Investigate options and leave a recommendation behind.',
    todos: ['Map existing implementation', 'Compare viable approaches', 'Record recommendation'],
    questions: ['What decision should this research unblock?'],
  },
  incident: {
    id: 'incident',
    label: 'Incident',
    description: 'Capture impact, root cause, and the mitigation path.',
    todos: ['Capture symptoms and impact', 'Identify root cause', 'Record mitigation and follow-up'],
    questions: ['Who or what is currently impacted?'],
  },
};

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

export type ReviewCheckStatus = 'pass' | 'warning' | 'fail' | 'unknown';

export interface ReviewCheckAction {
  label: string;
  tabId?: WebviewTabId;
  entityId?: string;
}

export interface ReviewCheck {
  id: string;
  label: string;
  status: ReviewCheckStatus;
  detail: string;
  action?: ReviewCheckAction;
}

export interface ReviewSummary {
  taskId: string;
  checks: ReviewCheck[];
  canMarkDone: boolean;
}

export interface SyncProfile {
  name: string;
  current: boolean;
  serverUrl?: string;
}

export interface GraphifyRequestPayload {
  mode: 'update' | 'query' | 'path' | 'explain';
  query?: string;
  from?: string;
  to?: string;
  target?: string;
}

export interface GraphifyRunResult {
  available: boolean;
  args: string[];
  output: string;
  exitCode: number;
  checkpointSummary?: string;
  truncated: boolean;
}

export type WebviewRequest =
  | (WebviewRequestBase<'state.get' | 'activity.list' | 'capture.health' | 'review.get' | 'tasks.list' | 'sync.profileList' | 'sync.push' | 'sync.listRemote' | 'export.markdown'> & {
      payload?: undefined;
    })
  | (WebviewRequestBase<'task.create'> & {
      payload: { title: string; goal?: string | null; status?: TaskStatus; parentTaskId?: string | null; branch?: string | null };
    })
  | (WebviewRequestBase<'task.createFromTemplate'> & {
      payload: { title: string; goal?: string | null; templateId: TaskTemplateId };
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
  | (WebviewRequestBase<'context.copy' | 'context.open' | 'context.openInChat' | 'context.openInCli'> & {
      payload: { markdown: string };
    })
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
  | (WebviewRequestBase<'files.list' | 'files.getCapture' | 'search.run' | 'sync.pull'> & { payload?: Record<string, unknown> })
  | (WebviewRequestBase<'graphify.run'> & { payload: GraphifyRequestPayload });

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
  profileList: () => string;
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
  openInCopilotChat?: (markdown: string) => Promise<void> | void;
  openInCopilotCli?: (markdown: string) => Promise<void> | void;
  openWorkspaceFile?: (relativePath: string) => Promise<void> | void;
  graphify?: {
    run: (payload: GraphifyRequestPayload, workspaceRoot?: string) => GraphifyRunResult;
  };
}

export type WebviewResponse =
  | { id: string; ok: true; data: unknown; state?: WebviewState }
  | { id: string; ok: false; error: string; state?: WebviewState };

export type HostToWebviewMessage =
  | { type: 'stateUpdate'; state: WebviewState }
  | WebviewResponse;
