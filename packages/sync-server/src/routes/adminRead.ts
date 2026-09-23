import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { requireSingletonAdmin } from '../adminAccess.js';
import { ApiError } from '../errors.js';
import { asyncHandler, type AdminSessionRequest } from '../middleware.js';
import type { OperatorClient } from '../operatorClient.js';
import type { AdminOperation, BackupRecord, OperationsStore } from '../operationsStore.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ApiError(400, 'invalid_request', 'limit must be an integer from 1 to 200');
  }
  return limit;
}

function parseLogSource(value: unknown): 'operations' | 'backup' {
  if (value === 'operations' || value === 'backup') {
    return value;
  }
  throw new ApiError(400, 'invalid_request', 'source must be operations or backup');
}

interface TaskSummaryRow {
  total: string;
  active: string;
  updated24h: string;
}

interface OperationSummaryRow {
  running: string;
  failed24h: string;
}

interface DatabaseHealth {
  status: 'healthy' | 'unavailable';
  healthy: boolean;
  latencyMs: number | null;
}

async function checkDatabase(pool: Pool): Promise<DatabaseHealth> {
  const started = performance.now();
  try {
    await pool.query('SELECT 1');
    return {
      status: 'healthy',
      healthy: true,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  } catch {
    return { status: 'unavailable', healthy: false, latencyMs: null };
  }
}

function serializeBackup(record: BackupRecord): BackupRecord {
  return { ...record };
}

function serializeOperationLog(operation: AdminOperation): object {
  return {
    id: operation.id,
    source: operation.type.startsWith('backup_') ? 'backup' : 'operations',
    severity: operation.state === 'failed' ? 'error' : operation.state === 'running' ? 'warning' : 'info',
    message: operation.output ?? operation.summary,
    createdAt: operation.completedAt ?? operation.startedAt ?? operation.createdAt,
  };
}

export interface AdminReadRouterOptions {
  operationsStore: OperationsStore;
  operatorClient: OperatorClient | null;
}

export function createAdminReadRouter(pool: Pool, options: AdminReadRouterOptions): Router {
  const router = Router();

  router.get(
    '/overview',
    asyncHandler(async (req: AdminSessionRequest, res) => {
      const membership = await requireSingletonAdmin(pool, req.userId!);
      const database = await checkDatabase(pool);
      if (!database.healthy) {
        throw new ApiError(503, 'database_unavailable', 'Database health check failed');
      }
      const [tasks, operations, backups] = await Promise.all([
        pool.query<TaskSummaryRow>(
          `SELECT count(*)::text AS total,
                  count(*) FILTER (WHERE status = 'active')::text AS active,
                  count(*) FILTER (WHERE updated_at >= now() - interval '24 hours')::text AS "updated24h"
             FROM tasks
            WHERE team_id = $1`,
          [membership.teamId],
        ),
        pool.query<OperationSummaryRow>(
          `SELECT count(*) FILTER (WHERE state = 'running')::text AS running,
                  count(*) FILTER (
                    WHERE state = 'failed' AND completed_at >= now() - interval '24 hours'
                  )::text AS "failed24h"
             FROM admin_operations`,
        ),
        options.operationsStore.listBackupRecords(1),
      ]);
      const taskSummary = tasks.rows[0];
      const operationSummary = operations.rows[0];
      noStore(res);
      res.status(200).json({
        generatedAt: new Date().toISOString(),
        database,
        tasks: {
          total: Number(taskSummary.total),
          active: Number(taskSummary.active),
          updatedLast24h: Number(taskSummary.updated24h),
        },
        backup: backups[0]
          ? {
              latestAt: backups[0].createdAt,
              latestVerifiedAt: backups[0].verifiedAt,
              status: backups[0].status,
            }
          : { latestAt: null, latestVerifiedAt: null, status: 'unavailable' },
        operations: {
          running: Number(operationSummary.running),
          failedLast24h: Number(operationSummary.failed24h),
        },
      });
    }),
  );

  router.get(
    '/backups',
    asyncHandler(async (req: AdminSessionRequest, res) => {
      await requireSingletonAdmin(pool, req.userId!);
      const limit = parseLimit((req.query as Record<string, unknown>).limit);
      const backups = await options.operationsStore.listBackupRecords(limit);
      noStore(res);
      res.status(200).json({ backups: backups.map(serializeBackup) });
    }),
  );

  router.get(
    '/services',
    asyncHandler(async (req: AdminSessionRequest, res) => {
      await requireSingletonAdmin(pool, req.userId!);
      const database = await checkDatabase(pool);
      noStore(res);
      res.status(200).json({
        services: [
          {
            name: 'sync-server',
            state: 'running',
            detail: 'The sync server is serving this request',
          },
          {
            name: 'database',
            state: database.healthy ? 'available' : 'unavailable',
            detail: database.healthy
              ? `Database query succeeded in ${database.latencyMs} ms`
              : 'Database health check failed',
          },
          {
            name: 'operator',
            state: options.operatorClient === null ? 'unavailable' : 'available',
            detail:
              options.operatorClient === null
                ? 'The operator client is not configured'
                : 'The operator client is configured',
          },
        ],
      });
    }),
  );

  router.get(
    '/logs',
    asyncHandler(async (req: AdminSessionRequest, res) => {
      await requireSingletonAdmin(pool, req.userId!);
      const query = req.query as Record<string, unknown>;
      const source = parseLogSource(query.source);
      const limit = parseLimit(query.limit);
      const operations = await options.operationsStore.listOperations(MAX_LIMIT);
      const logs = operations
        .filter((operation) => source === 'operations' || operation.type.startsWith('backup_'))
        .slice(0, limit)
        .map(serializeOperationLog);
      noStore(res);
      res.status(200).json({
        entries: logs,
      });
    }),
  );

  return router;
}
