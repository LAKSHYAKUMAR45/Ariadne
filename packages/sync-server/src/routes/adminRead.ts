import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { requireSingletonAdmin } from '../adminAccess.js';
import { ApiError } from '../errors.js';
import {
  asyncHandler,
  createDatabaseUnavailableError,
  isDatabaseError,
  rethrowDatabaseUnavailable,
  type AuthenticatedRequest,
} from '../middleware.js';
import { OperatorClientError } from '../operatorClient.js';
import type {
  HostMetricsResult,
  OperatorQueryClient,
} from '../operatorQueryClient.js';
import type { BackupRecord, OperationsStore } from '../operationsStore.js';

interface TaskSummaryRow {
  total: string;
  active: string;
  updated24h: string;
}

interface MemberSummaryRow {
  total: string;
  active: string;
  inactive: string;
  admins: string;
  members: string;
}

interface OperationSummaryRow {
  running: string;
  failed24h: string;
}

interface DatabaseSizeRow {
  sizeBytes: string;
}

interface DatabaseHealth {
  status: 'healthy' | 'unavailable';
  healthy: boolean;
  latencyMs: number | null;
}

export interface AdminReadRouterOptions {
  operationsStore: OperationsStore;
  operatorQueryClient: OperatorQueryClient | null;
  operatorTimeoutMs?: number;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new OperatorClientError('operator_timeout', 504, 'The operator service did not respond in time'));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function mapBackup(record: BackupRecord | undefined): {
  latestAt: string | null;
  latestVerifiedAt: string | null;
  status: string;
} {
  if (!record) {
    return { latestAt: null, latestVerifiedAt: null, status: 'unavailable' };
  }
  return {
    latestAt: record.createdAt,
    latestVerifiedAt: record.verifiedAt,
    status: record.status,
  };
}

export function createAdminReadRouter(pool: Pool, options: AdminReadRouterOptions): Router {
  const router = Router();
  const operatorTimeoutMs = options.operatorTimeoutMs ?? 1_500;

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get(
    '/overview',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      try {
        const membership = await requireSingletonAdmin(pool, req.userId!);
        const database = await checkDatabase(pool);
        if (!database.healthy) {
          throw createDatabaseUnavailableError();
        }

        let taskSummary: TaskSummaryRow;
        let memberSummary: MemberSummaryRow;
        let operationSummary: OperationSummaryRow;
        let latestBackup: BackupRecord | undefined;
        let databaseSizeBytes = 0;

        const [tasks, members, operations, backups, databaseSize] = await Promise.all([
          pool.query<TaskSummaryRow>(
            `SELECT count(*)::text AS total,
                    count(*) FILTER (WHERE status = 'active')::text AS active,
                    count(*) FILTER (
                      WHERE updated_at >= now() - interval '24 hours'
                    )::text AS "updated24h"
               FROM tasks
              WHERE team_id = $1`,
            [membership.teamId],
          ),
          pool.query<MemberSummaryRow>(
            `SELECT count(*)::text AS total,
                    count(*) FILTER (WHERE active = true)::text AS active,
                    count(*) FILTER (WHERE active = false)::text AS inactive,
                    count(*) FILTER (WHERE role = 'admin')::text AS admins,
                    count(*) FILTER (WHERE role = 'member')::text AS members
               FROM team_memberships
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
          pool.query<DatabaseSizeRow>(
            `SELECT pg_database_size(current_database())::bigint::text AS "sizeBytes"`,
          ),
        ]);

        taskSummary = tasks.rows[0];
        memberSummary = members.rows[0];
        operationSummary = operations.rows[0];
        latestBackup = backups[0];
        databaseSizeBytes = Number(databaseSize.rows[0].sizeBytes);

        let host: HostMetricsResult | null = null;
        let operatorComponent: { healthy: boolean; code?: string } = { healthy: true };
        if (options.operatorQueryClient) {
          try {
            host = (await withTimeout(
              options.operatorQueryClient.query({ type: 'host_metrics' }),
              operatorTimeoutMs,
            )) as HostMetricsResult;
          } catch (error: unknown) {
            operatorComponent = {
              healthy: false,
              code:
                error instanceof OperatorClientError ? error.code : 'operator_unavailable',
            };
          }
        } else {
          operatorComponent = {
            healthy: false,
            code: 'operator_unavailable',
          };
        }

        res.status(200).json({
          generatedAt: new Date().toISOString(),
          database,
          host,
          databaseSizeBytes,
          tasks: {
            total: Number(taskSummary.total),
            active: Number(taskSummary.active),
            updatedLast24h: Number(taskSummary.updated24h),
          },
          members: {
            total: Number(memberSummary.total),
            active: Number(memberSummary.active),
            inactive: Number(memberSummary.inactive),
            admins: Number(memberSummary.admins),
            members: Number(memberSummary.members),
          },
          sync: {
            lastPushAt: null,
            lastPullAt: null,
          },
          backup: mapBackup(latestBackup),
          operations: {
            running: Number(operationSummary.running),
            failedLast24h: Number(operationSummary.failed24h),
          },
          components: {
            database: {
              healthy: true,
            },
            operator: operatorComponent,
          },
        });
      } catch (error: unknown) {
        if (isDatabaseError(error)) {
          throw createDatabaseUnavailableError();
        }
        rethrowDatabaseUnavailable(error);
      }
    }),
  );

  return router;
}
