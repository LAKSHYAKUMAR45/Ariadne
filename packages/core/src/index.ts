export { TaskStore } from './TaskStore.js';
export { openDatabase } from './db.js';
export { runMigrations, MIGRATIONS } from './migrations.js';
export type { Migration } from './migrations.js';
export { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
export * from './types.js';
export {
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  buildContext,
} from './ContextBuilder.js';
export type { ContextPackage, ContextFileRef, ContextCommitRef, BuildContextOptions } from './ContextBuilder.js';
export {
  DEFAULT_FILE_TRIGGER_THRESHOLD,
  DEFAULT_IDLE_TRIGGER_MINUTES,
  summarizeFileBatch,
  summarizeCommit,
  summarizeError,
  summarizeIdle,
  maybeCheckpointOnFileActivity,
  checkpointOnCommit,
  checkpointOnError,
  maybeCheckpointOnIdle,
  rollupCheckpoints,
  setTaskStatusWithRollup,
} from './CheckpointEngine.js';
export {
  getHeadSha,
  getCurrentBranch,
  listRecentCommits,
  syncTaskGit,
} from './GitWatcher.js';
export type { GitLogEntry, SyncGitResult } from './GitWatcher.js';
export {
  DEFAULT_REDACTION_RULES,
  MAX_REDACTED_LENGTH,
  redact,
  redactCommand,
} from './Redactor.js';
export type { RedactionRule } from './Redactor.js';
export { exportTaskMarkdown } from './Exporter.js';
export { ensureGitignored } from './gitignore.js';
export { searchWorkspace } from './Search.js';
export type { SearchCategory, SearchMatch, SearchResult, SearchOptions } from './Search.js';
export {
  findWorkspaceRoot,
  stateDbPath,
  openWorkspaceStore,
  openWorkspaceStoreReadOnly,
  readCurrentTaskId,
  setCurrentTaskId,
} from './workspace.js';
export {
  getRegistryPath,
  openRegistry,
  closeRegistry,
  touchWorkspace,
  upsertTaskIndex,
  syncWorkspaceTasks,
  listWorkspaces,
  listAllTasks,
  findTaskWorkspace,
  forgetWorkspace,
  pruneMissingWorkspaces,
} from './Registry.js';
export type { TaskIndexEntry } from './Registry.js';
export {
  listTasksAcrossWorkspaces,
  listKnownWorkspaces,
  searchAcrossWorkspaces,
  resolveTaskAnyWorkspace,
} from './CrossWorkspace.js';
export type {
  CrossWorkspaceTask,
  CrossWorkspaceSearchResult,
  CrossWorkspaceSearchOptions,
  ResolvedTask,
} from './CrossWorkspace.js';
