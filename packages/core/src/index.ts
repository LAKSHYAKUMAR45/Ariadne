export { TaskStore } from './TaskStore.js';
export { openDatabase } from './db.js';
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
} from './CheckpointEngine.js';
export {
  getHeadSha,
  getCurrentBranch,
  listRecentCommits,
  syncTaskGit,
} from './GitWatcher.js';
export type { GitLogEntry, SyncGitResult } from './GitWatcher.js';
export {
  findWorkspaceRoot,
  stateDbPath,
  openWorkspaceStore,
  readCurrentTaskId,
  setCurrentTaskId,
} from './workspace.js';
