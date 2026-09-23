import path from 'node:path';
import { z } from 'zod';

const REVISION_PATTERN = /^[0-9a-f]{40}$/;

const operatorIdSchema = z.string().min(1, 'operationId is required');

export function isBackupBasename(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value === path.posix.basename(value) &&
    value === path.win32.basename(value)
  );
}

const backupNameSchema = z
  .string()
  .min(1, 'backupName is required')
  .refine(isBackupBasename, 'backupName must be a basename without path separators');

const serviceRestartRequestSchema = z
  .object({
    operationId: operatorIdSchema,
    type: z.literal('service_restart'),
    service: z.enum(['sync-server', 'postgres']),
  })
  .strict();

const deploymentApplyRequestSchema = z
  .object({
    operationId: operatorIdSchema,
    type: z.literal('deployment_apply'),
    revision: z
      .string()
      .regex(REVISION_PATTERN, 'revision must be a 40-character lowercase hexadecimal sha'),
  })
  .strict();

const backupCreateRequestSchema = z
  .object({
    operationId: operatorIdSchema,
    type: z.literal('backup_create'),
  })
  .strict();

const backupVerifyRequestSchema = z
  .object({
    operationId: operatorIdSchema,
    type: z.literal('backup_verify'),
    backupName: backupNameSchema,
  })
  .strict();

const backupRestoreRequestSchema = z
  .object({
    operationId: operatorIdSchema,
    type: z.literal('backup_restore'),
    backupName: backupNameSchema,
  })
  .strict();

export const operatorRequestSchema = z.discriminatedUnion('type', [
  serviceRestartRequestSchema,
  deploymentApplyRequestSchema,
  backupCreateRequestSchema,
  backupVerifyRequestSchema,
  backupRestoreRequestSchema,
]);

export type OperatorRequest = z.infer<typeof operatorRequestSchema>;

export interface OperatorAccepted {
  operationId: string;
  accepted: true;
}

export function parseOperatorRequest(input: unknown): OperatorRequest {
  return operatorRequestSchema.parse(input);
}
