import { pipeline } from 'node:stream/promises';
import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireSingletonAdmin } from '../adminAccess.js';
import { ApiError } from '../errors.js';
import {
  asyncHandler,
  rethrowDatabaseUnavailable,
  type AuthenticatedRequest,
} from '../middleware.js';
import { OperatorClientError } from '../operatorClient.js';
import type { OperatorQueryClient } from '../operatorQueryClient.js';
import type { BackupRecordStatus, OperationsStore } from '../operationsStore.js';

const backupListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .strict();

const backupNameParamSchema = z
  .object({
    name: z.string().regex(/^ariadne-\d{8}T\d{6}Z\.dump$/),
  })
  .strict();

interface BackupStatusRow {
  filename: string;
  status: BackupRecordStatus;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function requireOperatorQueryClient(
  operatorQueryClient: OperatorQueryClient | null,
): OperatorQueryClient {
  if (!operatorQueryClient) {
    throw new ApiError(503, 'operator_unavailable', 'The operator service is not configured');
  }
  return operatorQueryClient;
}

export function createAdminBackupsRouter(
  pool: Pool,
  options: {
    operationsStore: OperationsStore;
    operatorQueryClient: OperatorQueryClient | null;
  },
): Router {
  const router = Router();

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get(
    '/backups',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      try {
        await requireSingletonAdmin(pool, req.userId!);
        const parsed = backupListQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          throw new ApiError(400, 'invalid_request', parsed.error.message);
        }
        const backups = await options.operationsStore.listBackupRecords(parsed.data.limit);
        res.status(200).json({ backups });
      } catch (error: unknown) {
        rethrowDatabaseUnavailable(error);
      }
    }),
  );

  router.get(
    '/backups/:name/download',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      try {
        await requireSingletonAdmin(pool, req.userId!);
        const params = backupNameParamSchema.safeParse(req.params);
        if (!params.success) {
          throw new ApiError(400, 'invalid_request', params.error.message);
        }

        const { rows } = await pool.query<BackupStatusRow>(
          `SELECT filename, status
             FROM backup_records
            WHERE filename = $1
            LIMIT 1`,
          [params.data.name],
        );
        const backup = rows[0];
        if (!backup) {
          throw new ApiError(404, 'backup_not_found', 'No such backup artifact');
        }
        if (backup.status !== 'verified') {
          throw new ApiError(
            409,
            'backup_not_verified',
            'Only currently verified backups can be downloaded',
          );
        }

        const operatorQueryClient = requireOperatorQueryClient(options.operatorQueryClient);
        const abortController = new AbortController();
        req.on('aborted', () => abortController.abort());
        res.on('close', () => {
          if (!res.writableFinished) {
            abortController.abort();
          }
        });

        const download = await operatorQueryClient.downloadBackup(
          params.data.name,
          abortController.signal,
        );

        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(download.sizeBytes));
        res.setHeader('X-Ariadne-Backup-Sha256', download.sha256);
        res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);

        try {
          await pipeline(download.stream, res);
        } catch (error: unknown) {
          if (abortController.signal.aborted || res.destroyed) {
            return;
          }
          throw error;
        }
      } catch (error: unknown) {
        if (error instanceof OperatorClientError) {
          throw new ApiError(error.status, error.code, error.message);
        }
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        rethrowDatabaseUnavailable(error);
      }
    }),
  );

  return router;
}
