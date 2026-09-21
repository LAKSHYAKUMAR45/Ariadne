import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  MAX_CAPTURE_ID_LENGTH,
  MAX_CHECKPOINT_ID_LENGTH,
  MAX_PATH_LENGTH,
  SHA256_PATTERN,
  UUID_PATTERN,
} from '../captureValidation.js';
import { ApiError } from '../errors.js';
import { asyncHandler, type AuthenticatedRequest } from '../middleware.js';
import { requireTeamTask } from '../taskAccess.js';
import { requireActiveMembership } from '../teamAccess.js';
import { TaskHistoryLimitError, TaskHistoryValidationError } from '../taskHistoryErrors.js';
import type { StoreCaptureEntryInput, TaskHistoryStore } from '../taskHistoryTypes.js';

/**
 * A single capture may legitimately carry up to 10 MiB of snapshot text plus
 * 10 MiB of diff text (`DEFAULT_SERVER_CAPTURE_LIMITS`). JSON string escaping
 * inflates that on the wire, so this route parses with its own bounded 32 MiB
 * limit — comfortably above the maximum legitimate capture, still a hard cap —
 * while every other route keeps `express.json()`'s 100 KB default. The router
 * is therefore mounted ahead of the global parser in `app.ts`.
 */
export const CAPTURE_REQUEST_BODY_LIMIT = '32mb';

/** Rejects request bytes or decoded text that is not well-formed UTF-8. */
export class CaptureEncodingError extends ApiError {
  constructor(message: string) {
    super(400, 'invalid_capture_encoding', message);
    this.name = 'CaptureEncodingError';
  }
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Matches only *lone* surrogates: with the `u` flag the pattern compares whole
 * code points, and a valid surrogate pair is one non-surrogate code point.
 */
const LONE_SURROGATE_PATTERN = /\p{Surrogate}/u;

function assertUtf8RequestBody(
  _req: Request,
  _res: Response,
  body: Buffer,
  encoding: string | undefined,
): void {
  const charset = encoding?.toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    throw new CaptureEncodingError('Capture uploads must be UTF-8 encoded JSON');
  }
  try {
    UTF8_DECODER.decode(body);
  } catch {
    throw new CaptureEncodingError('Capture upload body is not valid UTF-8');
  }
}

function assertWellFormedText(value: string, field: string): void {
  if (LONE_SURROGATE_PATTERN.test(value)) {
    throw new CaptureEncodingError(`${field} is not well-formed UTF-8 text`);
  }
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  );
}

/**
 * Wraps the route-scoped JSON parser so its two interesting failures become
 * stable capture errors instead of a generic 500/403: an over-limit body is a
 * `capture_too_large` (413), and a UTF-8 failure keeps its own 400 code. The
 * raw `body` that body-parser attaches to verification errors is dropped so no
 * request bytes can reach a log or an error response.
 */
function createCaptureBodyParser(limit: string) {
  const parser = express.json({ limit, verify: assertUtf8RequestBody });

  return (req: Request, res: Response, next: NextFunction): void => {
    parser(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      if (error instanceof CaptureEncodingError) {
        delete (error as { body?: unknown }).body;
        error.status = 400;
        next(error);
        return;
      }
      if (isPayloadTooLarge(error)) {
        next(new TaskHistoryLimitError('Capture upload exceeds the maximum request body size'));
        return;
      }
      next(error);
    });
  };
}

const captureEntrySchema = z
  .object({
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    content: z.string(),
    unifiedDiff: z.string(),
    contentSha256: z.string().regex(SHA256_PATTERN),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

// Entry *count* is intentionally not capped here: the store owns every capture
// limit so over-limit uploads get a single 413 `capture_too_large` shape, and
// the request body limit already bounds how many entries can arrive at all.
const uploadCaptureSchema = z
  .object({
    capture: z
      .object({
        captureId: z.string().min(1).max(MAX_CAPTURE_ID_LENGTH),
        trigger: z.enum(['git_commit', 'checkpoint', 'explicit']),
        gitCommitSha: z.string().max(64).nullable().optional(),
        checkpointId: z.string().max(MAX_CHECKPOINT_ID_LENGTH).nullable().optional(),
        createdAt: z.string().min(1).max(64),
        entries: z.array(captureEntrySchema).min(1),
      })
      .strict(),
  })
  .strict();

export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApiError(400, 'invalid_request', `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export interface TaskHistoryRouterOptions {
  /** Overridable only so tests can exercise the over-limit path cheaply. */
  bodyLimit?: string;
}

interface CaptureAuthorization {
  teamId: string;
  taskId: string;
}

/**
 * Capture upload endpoint (`POST /tasks/:taskId/file-captures`). Uploading
 * requires an active team membership plus access to the referenced team task;
 * everything else — path shape, content hashes, and size limits — is validated
 * server-side before any ciphertext is produced.
 */
export function createTaskHistoryRouter(
  pool: Pool,
  store: TaskHistoryStore,
  options: TaskHistoryRouterOptions = {},
): Router {
  const router = Router();
  const parseCaptureBody = createCaptureBodyParser(options.bodyLimit ?? CAPTURE_REQUEST_BODY_LIMIT);
  const authorizeCaptureUpload = asyncHandler(
    async (req: AuthenticatedRequest, res, next) => {
      const membership = await requireActiveMembership(pool, req.userId!);
      const taskId = requireUuidParam(req.params.taskId, 'taskId');
      await requireTeamTask(pool, membership.teamId, taskId);
      res.locals.captureAuthorization = {
        teamId: membership.teamId,
        taskId,
      } satisfies CaptureAuthorization;
      next();
    },
  );

  router.post(
    '/tasks/:taskId/file-captures',
    authorizeCaptureUpload,
    parseCaptureBody,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const authorization = res.locals.captureAuthorization as CaptureAuthorization | undefined;
      if (!authorization) {
        throw new Error('Capture upload authorization context is missing');
      }

      const parsed = uploadCaptureSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_request', 'Capture upload body is invalid');
      }
      const capture = parsed.data.capture;

      const entries: StoreCaptureEntryInput[] = capture.entries.map((entry) => {
        assertWellFormedText(entry.path, 'Capture entry path');
        assertWellFormedText(entry.content, 'Capture entry content');
        assertWellFormedText(entry.unifiedDiff, 'Capture entry diff');

        const content = Buffer.from(entry.content, 'utf8');
        if (content.length !== entry.byteLength) {
          throw new TaskHistoryValidationError(
            `Capture entry byteLength does not match its content for ${entry.path}`,
          );
        }
        return {
          path: entry.path,
          content,
          unifiedDiff: Buffer.from(entry.unifiedDiff, 'utf8'),
          contentSha256: entry.contentSha256,
        };
      });

      const result = await store.storeCapture({
        captureId: capture.captureId,
        teamId: authorization.teamId,
        taskId: authorization.taskId,
        trigger: capture.trigger,
        gitCommitSha: capture.gitCommitSha ?? null,
        checkpointId: capture.checkpointId ?? null,
        createdAt: capture.createdAt,
        entries,
      });

      res.status(200).json(result);
    }),
  );

  return router;
}
