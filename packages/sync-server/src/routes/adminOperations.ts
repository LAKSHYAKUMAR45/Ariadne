import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireSingletonAdmin } from '../adminAccess.js';
import { ApiError } from '../errors.js';
import { asyncHandler, type AuthenticatedRequest } from '../middleware.js';
import {
  OperatorClientError,
  type OperatorClientErrorCode,
  type OperatorClient,
  type OperatorSubmitRequest,
} from '../operatorClient.js';
import {
  AdminOperationNotFoundError,
  OperationTransitionError,
  type AdminOperation,
  type AdminOperationType,
  type OperationsStore,
} from '../operationsStore.js';

/**
 * Plan 04 supplies the dashboard reauthentication middleware that sets this
 * marker. Until then these routes fail closed: an unmarked request is rejected
 * rather than being granted a temporary bypass.
 */
export interface ReauthenticatedAdminRequest extends AuthenticatedRequest {
  adminReauthenticated?: boolean;
}

export const ADMIN_OPERATION_SOURCE = 'admin_api';
export const OPERATOR_CALLBACK_SOURCE = 'operator_callback';
export const OPERATOR_CALLBACK_TOKEN_HEADER = 'x-ariadne-operator-token';
export const OPERATOR_CALLBACK_UID = 0;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_STREAM_DURATION_MS = 30 * 60 * 1000;
const MAX_OPERATION_LIST_LIMIT = 200;
const DEFAULT_OPERATION_LIST_LIMIT = 50;
const OPERATOR_SUBMISSION_FAILED_MESSAGE = 'Operator submission failed';
const OPERATOR_SUBMISSION_UNCERTAIN_MESSAGE =
  'Operator submission status is uncertain; awaiting callback or reconciliation';
const UNCERTAIN_SUBMISSION_FAILURE_CODES = new Set<OperatorClientErrorCode>([
  'operator_timeout',
  'operator_unavailable',
]);

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const BACKUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const serviceRestartBodySchema = z.object({
  service: z.enum(['sync-server', 'postgres']),
});

const deployBodySchema = z.object({
  revision: z.string().regex(REVISION_PATTERN),
});

export interface AdminOperationsRouterOptions {
  operationsStore: OperationsStore;
  /** `null` when no operator socket is configured for this deployment. */
  operatorClient: OperatorClient | null;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  maxStreamDurationMs?: number;
  generateOperationId?: () => string;
}

interface OperationSpec {
  type: AdminOperationType;
  summary: string;
  metadata: Record<string, string>;
  buildOperatorRequest(operationId: string): OperatorSubmitRequest;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function invalidRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw invalidRequest(message);
  }
  return parsed.data;
}

function requireOperationId(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw invalidRequest('operationId must be an opaque identifier');
  }
  return value;
}

function requireBackupName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !BACKUP_NAME_PATTERN.test(value)
  ) {
    throw invalidRequest('backup name must be a plain file name without path separators');
  }
  return value;
}

function parseListLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_OPERATION_LIST_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OPERATION_LIST_LIMIT) {
    throw invalidRequest(`limit must be an integer from 1 to ${MAX_OPERATION_LIST_LIMIT}`);
  }
  return limit;
}

function serializeOperation(operation: AdminOperation): AdminOperation {
  return { ...operation };
}

function writeSseEvent(res: Response, name: string, payload: unknown, id?: number): void {
  if (res.writableEnded) {
    return;
  }
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  res.write(`${idLine}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function createAdminOperationsRouter(
  pool: Pool,
  options: AdminOperationsRouterOptions,
): Router {
  const router = Router();
  const store = options.operationsStore;
  const operatorClient = options.operatorClient;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxStreamDurationMs = options.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS;
  const generateOperationId = options.generateOperationId ?? (() => randomUUID());

  async function requireReauthenticatedAdmin(
    req: ReauthenticatedAdminRequest,
  ): Promise<string> {
    await requireSingletonAdmin(pool, req.userId!);
    if (req.adminReauthenticated !== true) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'This action requires a freshly reauthenticated dashboard session',
      );
    }
    return req.userId!;
  }

  async function markSubmissionFailed(
    operationId: string,
    actorUserId: string,
    reason: string,
  ): Promise<void> {
    try {
      await store.transitionOperation({
        id: operationId,
        nextState: 'failed',
        actorUserId,
        source: ADMIN_OPERATION_SOURCE,
        message: OPERATOR_SUBMISSION_FAILED_MESSAGE,
        // Only the fixed error code is persisted: transport detail can carry
        // deployment paths or command fragments.
        metadata: { reason },
        output: null,
      });
    } catch (error: unknown) {
      console.error('Failed to record operator submission failure', {
        operationId,
        reason,
        error,
      });
    }
  }

  async function recordUncertainSubmission(
    operationId: string,
    actorUserId: string,
    reason: OperatorClientErrorCode,
  ): Promise<void> {
    try {
      await store.recordAuditEvent({
        actorUserId,
        action: 'admin_operation.submission_uncertain',
        source: ADMIN_OPERATION_SOURCE,
        outcome: 'queued',
        metadata: {
          operationId,
          state: 'queued',
          reason,
          message: OPERATOR_SUBMISSION_UNCERTAIN_MESSAGE,
        },
      });
    } catch (error: unknown) {
      console.error('Failed to record uncertain operator submission', {
        operationId,
        reason,
        error,
      });
    }
  }

  async function submitOperation(
    req: ReauthenticatedAdminRequest,
    res: Response,
    spec: OperationSpec,
  ): Promise<void> {
    const userId = await requireReauthenticatedAdmin(req);
    const operationId = generateOperationId();

    // Queued record first: an operator submission must never run without an
    // audited operation row to attribute it to.
    const operation = await store.createOperation({
      id: operationId,
      requestedBy: userId,
      type: spec.type,
      summary: spec.summary,
      source: ADMIN_OPERATION_SOURCE,
      metadata: spec.metadata,
    });

    if (!operatorClient) {
      await markSubmissionFailed(operationId, userId, 'operator_unavailable');
      throw new ApiError(
        503,
        'operator_unavailable',
        'The operator service is not configured for this deployment',
      );
    }

    try {
      await operatorClient.submit(spec.buildOperatorRequest(operationId));
    } catch (error: unknown) {
      if (error instanceof OperatorClientError) {
        if (UNCERTAIN_SUBMISSION_FAILURE_CODES.has(error.code)) {
          await recordUncertainSubmission(operationId, userId, error.code);
        } else {
          await markSubmissionFailed(operationId, userId, error.code);
        }
        throw new ApiError(error.status, error.code, error.message);
      }
      await markSubmissionFailed(operationId, userId, 'operator_submission_error');
      throw error;
    }

    noStore(res);
    res.status(202).json({ accepted: true, operation: serializeOperation(operation) });
  }

  router.get(
    '/operations',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      await requireReauthenticatedAdmin(req);
      const limit = parseListLimit((req.query as Record<string, unknown>).limit);
      const operations = await store.listOperations(limit);
      noStore(res);
      res.status(200).json({ operations: operations.map(serializeOperation) });
    }),
  );

  router.get(
    '/operations/:operationId',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      await requireReauthenticatedAdmin(req);
      const operationId = requireOperationId(req.params.operationId);
      const operation = await store.getOperation(operationId);
      if (!operation) {
        throw new ApiError(404, 'operation_not_found', 'No such admin operation');
      }
      noStore(res);
      res.status(200).json({ operation: serializeOperation(operation) });
    }),
  );

  router.get(
    '/operations/:operationId/events',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      await requireReauthenticatedAdmin(req);
      const operationId = requireOperationId(req.params.operationId);
      const existing = await store.getOperation(operationId);
      if (!existing) {
        throw new ApiError(404, 'operation_not_found', 'No such admin operation');
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const parsedLastEventId = Number(req.header('last-event-id'));
      let lastEventId = Number.isInteger(parsedLastEventId) ? parsedLastEventId : 0;
      let closed = false;
      let polling = false;

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': heartbeat\n\n');
        }
      }, heartbeatIntervalMs);
      const poller = setInterval(() => {
        void poll();
      }, pollIntervalMs);
      const durationLimit = setTimeout(() => {
        writeSseEvent(res, 'timeout', { operationId });
        close();
      }, maxStreamDurationMs);

      function close(): void {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        clearInterval(poller);
        clearTimeout(durationLimit);
        if (!res.writableEnded) {
          res.end();
        }
      }

      async function poll(): Promise<void> {
        if (closed || polling) {
          return;
        }
        polling = true;
        try {
          const events = await store.listOperationEvents(operationId);
          for (const event of events) {
            if (event.id <= lastEventId) {
              continue;
            }
            lastEventId = event.id;
            writeSseEvent(
              res,
              'operation_event',
              {
                id: event.id,
                operationId: event.operationId,
                state: event.state,
                message: event.message,
                metadata: event.metadata,
                createdAt: event.createdAt,
              },
              event.id,
            );
          }

          const current = await store.getOperation(operationId);
          if (!current || current.state === 'succeeded' || current.state === 'failed') {
            writeSseEvent(res, 'complete', {
              operationId,
              state: current?.state ?? 'failed',
            });
            close();
          }
        } catch (error: unknown) {
          console.error('Admin operation event stream failed', { operationId, error });
          close();
        } finally {
          polling = false;
        }
      }

      req.on('close', close);
      res.on('close', close);

      await poll();
    }),
  );

  router.post(
    '/operations/service-restart',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      const { service } = parseBody(
        serviceRestartBodySchema,
        req.body,
        'service must be one of: sync-server, postgres',
      );
      await submitOperation(req, res, {
        type: 'service_restart',
        summary: `Restart ${service} service`,
        metadata: { service },
        buildOperatorRequest: (operationId) => ({
          operationId,
          type: 'service_restart',
          service,
        }),
      });
    }),
  );

  router.post(
    '/operations/deploy',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      const { revision } = parseBody(
        deployBodySchema,
        req.body,
        'revision must be a 40-character lowercase hexadecimal commit sha',
      );
      await submitOperation(req, res, {
        type: 'deployment_apply',
        summary: `Deploy revision ${revision}`,
        metadata: { revision },
        buildOperatorRequest: (operationId) => ({
          operationId,
          type: 'deployment_apply',
          revision,
        }),
      });
    }),
  );

  router.post(
    '/operations/backups',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      await submitOperation(req, res, {
        type: 'backup_create',
        summary: 'Create database backup',
        metadata: {},
        buildOperatorRequest: (operationId) => ({ operationId, type: 'backup_create' }),
      });
    }),
  );

  router.post(
    '/operations/backups/:name/verify',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      const backupName = requireBackupName(req.params.name);
      await submitOperation(req, res, {
        type: 'backup_verify',
        summary: `Verify backup ${backupName}`,
        metadata: { backupName },
        buildOperatorRequest: (operationId) => ({
          operationId,
          type: 'backup_verify',
          backupName,
        }),
      });
    }),
  );

  router.post(
    '/operations/backups/:name/restore',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      const backupName = requireBackupName(req.params.name);
      await submitOperation(req, res, {
        type: 'backup_restore',
        summary: `Restore backup ${backupName}`,
        metadata: { backupName },
        buildOperatorRequest: (operationId) => ({
          operationId,
          type: 'backup_restore',
          backupName,
        }),
      });
    }),
  );

  return router;
}


const callbackBodySchema = z
  .object({
    operationId: z.string().regex(OPERATION_ID_PATTERN),
    state: z.enum(['running', 'succeeded', 'failed']),
    message: z.string().min(1).max(2000).optional(),
    output: z.string().nullable().optional(),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

export interface OperatorCallbackRouterOptions {
  operationsStore: OperationsStore;
  /**
   * Returns the shared credential the root operator writes to the `/run`
   * tmpfs, or `null` when none is provisioned. Read per request so a token
   * regenerated after a reboot is picked up without a restart.
   */
  readCallbackToken(): Promise<string | null> | string | null;
  /**
   * Peer UID of the calling process when the platform exposes it, or `null`
   * when it does not. Node has no portable `SO_PEERCRED` accessor, so this is
   * an injection point: when a UID is available it must be root's.
   */
  verifyPeerUid?(socket: Socket | undefined): number | null;
}

function timingSafeMatches(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(providedBytes, expectedBytes);
}

function callbackForbidden(): ApiError {
  // One fixed message for every rejection reason: a caller must not learn
  // whether the token, its length, or the peer identity was wrong.
  return new ApiError(403, 'callback_forbidden', 'Operator callback credentials were rejected');
}

/**
 * Result-reporting channel for the root-owned operator service.
 *
 * Mounted without the dashboard session middleware — the operator holds no JWT
 * — and therefore authenticates only with the shared root-created credential
 * (plus a peer UID check where the platform offers one). A callback may move
 * exactly one operation (the id in its own URL) and only through transitions
 * the operations store considers legal.
 */
export function createOperatorCallbackRouter(options: OperatorCallbackRouterOptions): Router {
  const router = Router();
  const store = options.operationsStore;

  async function authenticate(req: Request): Promise<void> {
    const expected = await options.readCallbackToken();
    if (!expected) {
      throw new ApiError(
        503,
        'callback_unavailable',
        'No operator callback credential is provisioned for this deployment',
      );
    }

    const peerUid = options.verifyPeerUid?.(req.socket) ?? null;
    if (peerUid !== null && peerUid !== OPERATOR_CALLBACK_UID) {
      throw callbackForbidden();
    }

    const provided = req.header(OPERATOR_CALLBACK_TOKEN_HEADER);
    if (typeof provided !== 'string' || !timingSafeMatches(provided, expected)) {
      throw callbackForbidden();
    }
  }

  router.post(
    '/operations/:operationId/callback',
    asyncHandler(async (req, res) => {
      await authenticate(req);

      const operationId = requireOperationId(req.params.operationId);
      const parsed = callbackBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw invalidRequest('callback payload is not a valid operation result');
      }
      if (parsed.data.operationId !== operationId) {
        throw invalidRequest('a callback may only update its own operation');
      }

      const existing = await store.getOperation(operationId);
      if (!existing) {
        throw new ApiError(404, 'operation_not_found', 'No such admin operation');
      }

      const { state, message, output, metadata } = parsed.data;

      // Repeating the start report is how the operator recovers from a dropped
      // callback; it must not be an error, and it must not append an event.
      if (state === 'running' && existing.state === 'running') {
        noStore(res);
        res.status(200).json({ operation: serializeOperation(existing) });
        return;
      }

      try {
        // A result that arrives without its start report still has to pass
        // through `running` so the stored lifecycle stays complete.
        if (state !== 'running' && existing.state === 'queued') {
          await store.transitionOperation({
            id: operationId,
            nextState: 'running',
            actorUserId: existing.requestedBy,
            source: OPERATOR_CALLBACK_SOURCE,
            message: 'Operation started',
            metadata: { reportedBy: 'operator' },
          });
        }

        const operation = await store.transitionOperation({
          id: operationId,
          nextState: state,
          actorUserId: existing.requestedBy,
          source: OPERATOR_CALLBACK_SOURCE,
          message: message ?? `Operation ${state}`,
          metadata: { ...(metadata ?? {}), reportedBy: 'operator' },
          output: output === undefined ? undefined : output,
        });

        noStore(res);
        res.status(200).json({ operation: serializeOperation(operation) });
      } catch (error: unknown) {
        if (error instanceof OperationTransitionError) {
          throw new ApiError(409, 'illegal_transition', 'Operation is already in a terminal state');
        }
        if (error instanceof AdminOperationNotFoundError) {
          throw new ApiError(404, 'operation_not_found', 'No such admin operation');
        }
        throw error;
      }
    }),
  );

  return router;
}
