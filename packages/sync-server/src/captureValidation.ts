import { createHash } from 'node:crypto';
import type {
  BlobType,
  FileCaptureTrigger,
  ServerCaptureLimits,
  StoreCaptureEntryInput,
  StoreCaptureInput,
} from './taskHistoryTypes.js';
import { TaskHistoryLimitError, TaskHistoryValidationError } from './taskHistoryErrors.js';

export interface NormalizedEntry {
  path: string;
  content: Buffer;
  unifiedDiff: Buffer;
  contentSha256: string;
  diffSha256: string;
}

export interface NormalizedCapture {
  captureId: string;
  teamId: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  entries: NormalizedEntry[];
}

export interface BlobRow {
  id: string;
  team_id: string;
  plaintext_sha256: string;
  blob_type: BlobType;
  key_id: string;
  aad_version: number;
  compression: string;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  plaintext_bytes: number;
}

export const MAX_CAPTURE_ID_LENGTH = 200;
export const MAX_CHECKPOINT_ID_LENGTH = 200;
export const MAX_PATH_LENGTH = 1024;
export const MAX_REASON_LENGTH = 500;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const GIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const TRIGGERS: readonly FileCaptureTrigger[] = ['git_commit', 'checkpoint', 'explicit'];

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TaskHistoryValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function requireSafeId(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TaskHistoryValidationError(`${field} must be 1-${maxLength} characters`);
  }
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new TaskHistoryValidationError(`${field} contains unsupported characters`);
  }
  return value;
}

export function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new TaskHistoryValidationError(`${field} must be an ISO-8601 timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TaskHistoryValidationError(`${field} must be an ISO-8601 timestamp`);
  }
  return parsed.toISOString();
}

/**
 * Accepts only workspace-relative, normalized POSIX paths. Absolute paths,
 * traversal segments, backslashes, and control characters are rejected before
 * any ciphertext is produced.
 */
export function requireCapturePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new TaskHistoryValidationError(`Capture entry path must be 1-${MAX_PATH_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\\]/.test(value)) {
    throw new TaskHistoryValidationError('Capture entry path contains unsupported characters');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new TaskHistoryValidationError('Capture entry path must be workspace-relative');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TaskHistoryValidationError('Capture entry path must be a normalized relative path');
  }
  return value;
}

export function requireBuffer(value: unknown, field: string): Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new TaskHistoryValidationError(`${field} must be a Buffer`);
  }
  return value;
}

export function normalizeEntries(
  entries: unknown,
  limits: ServerCaptureLimits,
): NormalizedEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TaskHistoryValidationError('Capture must contain at least one entry');
  }
  if (entries.length > limits.maxEntries) {
    throw new TaskHistoryLimitError(`Capture exceeds the ${limits.maxEntries}-entry limit`);
  }

  const seen = new Set<string>();
  const normalized: NormalizedEntry[] = [];
  for (const raw of entries as StoreCaptureEntryInput[]) {
    const path = requireCapturePath(raw?.path);
    if (seen.has(path)) {
      throw new TaskHistoryValidationError('Capture contains duplicate entry paths');
    }
    seen.add(path);

    const content = requireBuffer(raw?.content, 'Capture entry content');
    const unifiedDiff = requireBuffer(raw?.unifiedDiff, 'Capture entry diff');
    if (typeof raw?.contentSha256 !== 'string' || !SHA256_PATTERN.test(raw.contentSha256)) {
      throw new TaskHistoryValidationError('Capture entry contentSha256 must be lowercase hex');
    }

    const actual = sha256Hex(content);
    if (actual !== raw.contentSha256) {
      throw new TaskHistoryValidationError(`Capture entry content hash mismatch for ${path}`);
    }

    normalized.push({
      path,
      content,
      unifiedDiff,
      contentSha256: actual,
      diffSha256: sha256Hex(unifiedDiff),
    });
  }

  normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assertWithinLimits(normalized, limits);
  return normalized;
}

export function assertWithinLimits(entries: NormalizedEntry[], limits: ServerCaptureLimits): void {
  let totalContent = 0;
  let totalDiff = 0;

  for (const entry of entries) {
    if (entry.content.length > limits.maxFileBytes) {
      throw new TaskHistoryLimitError(`Capture entry ${entry.path} exceeds the per-file size limit`);
    }
    if (entry.unifiedDiff.length > limits.maxFileBytes) {
      throw new TaskHistoryLimitError(`Capture diff for ${entry.path} exceeds the per-file size limit`);
    }
    totalContent += entry.content.length;
    totalDiff += entry.unifiedDiff.length;
  }

  if (totalContent > limits.maxCaptureBytes || totalDiff > limits.maxCaptureBytes) {
    throw new TaskHistoryLimitError('Capture exceeds the total capture size limit');
  }
}

export function normalizeCapture(input: StoreCaptureInput, limits: ServerCaptureLimits): NormalizedCapture {
  if (!input || typeof input !== 'object') {
    throw new TaskHistoryValidationError('Capture input must be an object');
  }

  const trigger = input.trigger;
  if (!TRIGGERS.includes(trigger)) {
    throw new TaskHistoryValidationError('Capture trigger is not supported');
  }

  let gitCommitSha: string | null = null;
  if (input.gitCommitSha !== null && input.gitCommitSha !== undefined) {
    if (typeof input.gitCommitSha !== 'string' || !GIT_SHA_PATTERN.test(input.gitCommitSha)) {
      throw new TaskHistoryValidationError('Capture gitCommitSha must be a lowercase hex Git SHA');
    }
    gitCommitSha = input.gitCommitSha;
  }

  let checkpointId: string | null = null;
  if (input.checkpointId !== null && input.checkpointId !== undefined) {
    checkpointId = requireSafeId(input.checkpointId, 'Capture checkpointId', MAX_CHECKPOINT_ID_LENGTH);
  }

  if (trigger === 'git_commit' && gitCommitSha === null) {
    throw new TaskHistoryValidationError('Commit captures require a gitCommitSha');
  }
  if (trigger === 'checkpoint' && checkpointId === null) {
    throw new TaskHistoryValidationError('Checkpoint captures require a checkpointId');
  }

  return {
    captureId: requireSafeId(input.captureId, 'Capture id', MAX_CAPTURE_ID_LENGTH),
    teamId: requireUuid(input.teamId, 'Capture teamId'),
    taskId: requireUuid(input.taskId, 'Capture taskId'),
    trigger,
    gitCommitSha,
    checkpointId,
    createdAt: requireIsoTimestamp(input.createdAt, 'Capture createdAt'),
    entries: normalizeEntries(input.entries, limits),
  };
}
