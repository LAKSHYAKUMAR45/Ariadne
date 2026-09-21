/**
 * Public types for encrypted task file history storage. Kept separate from the
 * repository implementation so routes can depend on the contract alone.
 */
/** Mirrors `FileCaptureTrigger` in @ariadne-dev/core without a package dependency. */
export type FileCaptureTrigger = 'git_commit' | 'checkpoint' | 'explicit';

export type BlobType = 'snapshot' | 'diff';

export interface StoreCaptureEntryInput {
  path: string;
  content: Buffer;
  unifiedDiff: Buffer;
  contentSha256: string;
}

export interface StoreCaptureInput {
  captureId: string;
  teamId: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  entries: StoreCaptureEntryInput[];
}

export interface StoreCaptureResult {
  captureId: string;
  status: 'stored' | 'duplicate';
  entryCount: number;
}

export interface CaptureEntry {
  path: string;
  content: Buffer;
  unifiedDiff: Buffer;
  /** Verified SHA-256 of the returned snapshot plaintext. */
  contentSha256: string;
  /** Verified SHA-256 of the returned unified diff plaintext. */
  diffSha256: string;
}

export interface CaptureRecord {
  captureId: string;
  teamId: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  entries: CaptureEntry[];
}

export interface DeleteCaptureInput {
  teamId: string;
  taskId: string;
  captureId: string;
  actorUserId: string;
  reason: string;
}

export interface DeleteCaptureResult {
  deletionId: string;
  captureId: string;
  deletedPaths: string[];
  deletedEntryCount: number;
  deletedBlobCount: number;
}

export interface TaskHistoryStore {
  storeCapture(input: StoreCaptureInput): Promise<StoreCaptureResult>;
  readCapture(teamId: string, taskId: string, captureId: string): Promise<CaptureRecord>;
  deleteCapture(input: DeleteCaptureInput): Promise<DeleteCaptureResult>;
}

export interface ServerCaptureLimits {
  /** Inclusive maximum byte length of a single snapshot or diff payload. */
  maxFileBytes: number;
  /** Inclusive maximum total snapshot (and, separately, diff) bytes per capture. */
  maxCaptureBytes: number;
  /** Inclusive maximum number of entries in one capture. */
  maxEntries: number;
}

/** Server-side mirror of the client guardrails in docs §7.2. */
export const DEFAULT_SERVER_CAPTURE_LIMITS: ServerCaptureLimits = {
  maxFileBytes: 1024 * 1024,
  maxCaptureBytes: 10 * 1024 * 1024,
  maxEntries: 2000,
};
