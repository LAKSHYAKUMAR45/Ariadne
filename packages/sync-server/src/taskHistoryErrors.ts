import { ApiError } from './errors.js';

export class TaskHistoryValidationError extends ApiError {
  constructor(message: string) {
    super(400, 'invalid_capture', message);
    this.name = 'TaskHistoryValidationError';
  }
}

export class TaskHistoryLimitError extends ApiError {
  constructor(message: string) {
    super(413, 'capture_too_large', message);
    this.name = 'TaskHistoryLimitError';
  }
}

export class TaskHistoryConflictError extends ApiError {
  constructor(captureId: string) {
    super(409, 'capture_conflict', `Capture ${captureId} already exists with different contents`);
    this.name = 'TaskHistoryConflictError';
  }
}

/**
 * A different capture id already records the same commit or checkpoint event
 * for this task. Distinct from `capture_conflict` (same capture id, different
 * content) so a client can tell "retry with my id" from "this event is taken".
 */
export class CaptureEventConflictError extends ApiError {
  constructor(kind: 'git_commit' | 'checkpoint') {
    super(
      409,
      'capture_event_conflict',
      kind === 'git_commit'
        ? 'Another capture already records this task commit'
        : 'Another capture already records this task checkpoint',
    );
    this.name = 'CaptureEventConflictError';
  }
}

/**
 * A concurrent deletion collected a blob this upload was about to reference,
 * or vice versa. Mapped explicitly so a lost race is a retryable client error
 * rather than a raw Postgres 500.
 */
export class CaptureStorageConflictError extends ApiError {
  constructor() {
    super(
      503,
      'capture_storage_conflict',
      'Capture storage changed concurrently; retry the upload',
    );
    this.name = 'CaptureStorageConflictError';
  }
}

export class CaptureNotFoundError extends ApiError {
  constructor(captureId: string) {
    super(404, 'capture_not_found', `No capture with id ${captureId}`);
    this.name = 'CaptureNotFoundError';
  }
}

export class ForbiddenActorError extends ApiError {
  constructor() {
    super(403, 'forbidden_actor', 'Actor is not an active member of the team');
    this.name = 'ForbiddenActorError';
  }
}

export class CaptureIntegrityError extends ApiError {
  constructor(message: string) {
    super(500, 'capture_integrity_error', message);
    this.name = 'CaptureIntegrityError';
  }
}
