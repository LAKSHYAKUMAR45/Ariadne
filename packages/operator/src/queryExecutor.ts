import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readFile, stat, statfs } from 'node:fs/promises';
import { z } from 'zod';
import {
  decodeOperatorLogCursor,
  encodeOperatorLogCursor,
  type BackupReadResult,
  type DeploymentStatusResult,
  type HostMetricsResult,
  type LogsReadResult,
  type OperatorLogSeverity,
  type OperatorQuery,
  type OperatorQueryExecutor,
  type OperatorQueryResult,
  type ServiceStatusResult,
} from './queryProtocol.js';

export const DEFAULT_QUERY_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_QUERY_ENV = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});
export const DEFAULT_QUERY_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_LOG_LINE_BYTES = 4 * 1024;

const ROOT_FILESYSTEM_PATH = '/';
const PROC_STAT_PATH = '/proc/stat';
const PROC_MEMINFO_PATH = '/proc/meminfo';
const BACKUP_ROOT = '/var/backups/ariadne';
const STATUS_SCRIPT = '/usr/local/lib/ariadne/status';
const DEPLOYMENT_STATUS_SCRIPT = '/usr/local/lib/ariadne/deployment-status';
const SYSTEMCTL = '/usr/bin/systemctl';
const JOURNALCTL = '/usr/bin/journalctl';
const OPERATOR_UNIT = 'ariadne-operator.service';
const BACKUP_UNIT = 'ariadne-backup.service';
const FIXED_SERVICE_ORDER = ['sync-server', 'operator', 'postgres'] as const;
const FIXED_RESPONSE_ERROR_LIMIT = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const PATH_PATTERN = /(?:\/[A-Za-z0-9._-]+)+/g;
const KEY_VALUE_SECRET_PATTERN =
  /\b[A-Za-z0-9_]*(?:password|secret|token|database_url)[A-Za-z0-9_]*=[^\s]+/gi;
const BEARER_PATTERN = /Authorization:\s*Bearer\s+\S+/gi;
const DATABASE_URL_PATTERN = /\bpostgres(?:ql)?:\/\/[^\s]+/gi;

const serviceStatusScriptSchema = z
  .object({
    services: z
      .array(
        z
          .object({
            name: z.enum(['sync-server', 'operator', 'postgres']),
            state: z.enum(['running', 'stopped', 'failed', 'unavailable']),
            detail: z.string().min(1).max(200).optional(),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();

const deploymentStatusSchema = z
  .object({
    currentRevision: z.string().regex(REVISION_PATTERN),
    rollbackRevision: z.string().regex(REVISION_PATTERN).nullable(),
    schemaVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    candidates: z
      .array(
        z
          .object({
            revision: z.string().regex(REVISION_PATTERN),
            committedAt: z.string().datetime({ offset: true }),
            subject: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const backupMetadataSchema = z
  .object({
    basename: z.string().min(1),
    timestamp: z.string().regex(/^\d{8}T\d{6}Z$/),
    database: z.string().min(1).max(100),
    image: z.string().min(1).max(200),
    schemaVersion: z.string().min(1).max(100),
    dumpBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(SHA256_PATTERN),
    activeKeyId: z.string().min(1).max(100),
    keyIds: z.array(z.string().min(1).max(100)).max(50),
    format: z.literal('custom'),
  })
  .strict();

const journalEntrySchema = z
  .object({
    __REALTIME_TIMESTAMP: z.string().regex(/^\d+$/),
    PRIORITY: z.string().regex(/^\d+$/),
    MESSAGE: z.string(),
  })
  .passthrough();

export type OperatorQueryErrorCode =
  | 'dependency_unavailable'
  | 'command_failed'
  | 'command_timeout'
  | 'invalid_result'
  | 'response_too_large'
  | 'backup_not_found'
  | 'integrity_error';

export class OperatorQueryError extends Error {
  readonly code: OperatorQueryErrorCode;

  constructor(code: OperatorQueryErrorCode, message: string) {
    super(message);
    this.name = 'OperatorQueryError';
    this.code = code;
  }
}

export interface QuerySpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export interface QuerySpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type QuerySpawnImplementation = (
  file: string,
  args: readonly string[],
  options: QuerySpawnOptions,
) => QuerySpawnedProcess;

export interface QueryClock {
  setTimeout(handler: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface QueryFileSystem {
  readFile(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ isFile(): boolean; size: number }>;
  statfs(filePath: string): Promise<{ bsize: number; blocks: number; bfree: number }>;
  createReadStream(filePath: string): NodeJS.ReadableStream;
}

export interface CreateOperatorQueryExecutorOptions {
  spawnImpl?: QuerySpawnImplementation;
  fileSystem?: QueryFileSystem;
  clock?: QueryClock;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxLogResponseBytes?: number;
  maxCommandOutputBytes?: number;
  maxLogLineBytes?: number;
}

interface CompletedCommand {
  stdout: string;
  stderr: string;
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: QuerySpawnOptions,
): QuerySpawnedProcess {
  return spawn(file, [...args], options);
}

const defaultClock: QueryClock = {
  setTimeout(handler, delayMs) {
    return setTimeout(handler, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

const defaultFileSystem: QueryFileSystem = {
  async readFile(filePath: string): Promise<string> {
    return await readFile(filePath, 'utf8');
  },
  async stat(filePath: string): Promise<{ isFile(): boolean; size: number }> {
    return await stat(filePath);
  },
  async statfs(filePath: string): Promise<{ bsize: number; blocks: number; bfree: number }> {
    const result = await statfs(filePath);
    return {
      bsize: result.bsize,
      blocks: Number(result.blocks),
      bfree: Number(result.bfree),
    };
  },
  createReadStream(filePath: string): NodeJS.ReadableStream {
    return fs.createReadStream(filePath);
  },
};

function toUnavailable(message: string): OperatorQueryError {
  return new OperatorQueryError('dependency_unavailable', message);
}

function toInvalidResult(message: string): OperatorQueryError {
  return new OperatorQueryError('invalid_result', message);
}

function sanitizeFailureContext(stderr: string): string {
  const stripped = stderr.replace(ANSI_PATTERN, '').trim();
  if (stripped.length === 0) {
    return '';
  }
  const redacted = applyLogRedactions(stripped).message;
  return takeUtf8Head(redacted, FIXED_RESPONSE_ERROR_LIMIT);
}

async function runCommand(
  spawnImpl: QuerySpawnImplementation,
  clock: QueryClock,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimitBytes: number,
  file: string,
  args: readonly string[],
): Promise<CompletedCommand> {
  return await new Promise<CompletedCommand>((resolve, reject) => {
    let child: QuerySpawnedProcess;
    try {
      child = spawnImpl(file, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      if (isUnavailableError(error)) {
        reject(toUnavailable('Operator query dependency is unavailable'));
        return;
      }
      reject(error);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timeout = clock.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Best effort only.
      }
      reject(new OperatorQueryError('command_timeout', 'Operator query timed out'));
    }, timeoutMs);

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clock.clearTimeout(timeout);
      callback();
    };

    const appendChunk = (
      bucket: Buffer[],
      bytes: number,
      chunk: Buffer | string,
      onBytes: (next: number) => void,
    ): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = bytes + buffer.length;
      if (nextBytes > outputLimitBytes) {
        settle(() => {
          reject(new OperatorQueryError('response_too_large', 'Operator query response exceeded the byte limit'));
        });
        return;
      }
      bucket.push(buffer);
      onBytes(nextBytes);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      appendChunk(stdout, stdoutBytes, chunk, (next) => {
        stdoutBytes = next;
      });
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      appendChunk(stderr, stderrBytes, chunk, (next) => {
        stderrBytes = next;
      });
    });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);

    child.on('error', (error: Error) => {
      settle(() => {
        if (isUnavailableError(error)) {
          reject(toUnavailable('Operator query dependency is unavailable'));
          return;
        }
        reject(error);
      });
    });

    child.on('close', (code: number | null) => {
      settle(() => {
        if (code !== 0) {
          const suffix = sanitizeFailureContext(Buffer.concat(stderr, stderrBytes).toString('utf8'));
          reject(
            new OperatorQueryError(
              'command_failed',
              suffix ? `Operator query command failed: ${suffix}` : 'Operator query command failed',
            ),
          );
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
        });
      });
    });
  });
}

function isUnavailableError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES');
}

function parseCpuPercent(statText: string): number {
  const line = statText.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) {
    throw toInvalidResult('Host metrics are unavailable');
  }
  const fields = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number.parseInt(value, 10));
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value) || value < 0)) {
    throw toInvalidResult('Host metrics are unavailable');
  }
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  const active = user + nice + system + irq + softirq + steal;
  const total = active + idle + iowait;
  if (total <= 0) {
    return 0;
  }
  return Number(((active / total) * 100).toFixed(2));
}

function parseMeminfo(meminfoText: string): { usedBytes: number; totalBytes: number } {
  const values = new Map<string, number>();
  for (const line of meminfoText.split('\n')) {
    const match = /^([A-Za-z()_]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (!match) {
      continue;
    }
    values.set(match[1], Number.parseInt(match[2], 10) * 1024);
  }
  const totalBytes = values.get('MemTotal');
  const availableBytes = values.get('MemAvailable');
  if (!totalBytes || availableBytes === undefined) {
    throw toInvalidResult('Host metrics are unavailable');
  }
  return {
    usedBytes: Math.max(0, totalBytes - availableBytes),
    totalBytes,
  };
}

async function readHostMetrics(fileSystem: QueryFileSystem): Promise<HostMetricsResult> {
  try {
    const [statText, meminfoText, filesystem] = await Promise.all([
      fileSystem.readFile(PROC_STAT_PATH),
      fileSystem.readFile(PROC_MEMINFO_PATH),
      fileSystem.statfs(ROOT_FILESYSTEM_PATH),
    ]);
    const memory = parseMeminfo(meminfoText);
    return {
      cpuPercent: parseCpuPercent(statText),
      memoryUsedBytes: memory.usedBytes,
      memoryTotalBytes: memory.totalBytes,
      filesystemUsedBytes: (filesystem.blocks - filesystem.bfree) * filesystem.bsize,
      filesystemTotalBytes: filesystem.blocks * filesystem.bsize,
    };
  } catch (error: unknown) {
    if (error instanceof OperatorQueryError) {
      throw error;
    }
    if (isUnavailableError(error)) {
      throw toUnavailable('Host metrics are unavailable');
    }
    throw error;
  }
}

function parseJsonStrict<T>(raw: string, schema: z.ZodSchema<T>, message: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw toInvalidResult(message);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw toInvalidResult(message);
  }
  return result.data;
}

function parseSystemctlState(stdout: string): ServiceStatusResult['services'][number] {
  const values = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (values.length < 3) {
    throw toInvalidResult('Service status is unavailable');
  }

  const [activeState, subState, result] = values;
  if (activeState === 'active' && subState === 'running') {
    return { name: 'operator', state: 'running' };
  }
  if (activeState === 'failed' || result === 'failed') {
    return { name: 'operator', state: 'failed' };
  }
  if (activeState === 'inactive' || subState === 'dead' || subState === 'exited') {
    return { name: 'operator', state: 'stopped' };
  }
  const detail = normalizeDetail(`${activeState}/${subState}`);
  return detail ? { name: 'operator', state: 'unavailable', detail } : { name: 'operator', state: 'unavailable' };
}

function normalizeDetail(value: string): string | undefined {
  const sanitized = value.replace(/[^a-z0-9/_-]/gi, '').slice(0, 200);
  return sanitized.length > 0 ? sanitized : undefined;
}

async function readServiceStatus(
  spawnImpl: QuerySpawnImplementation,
  clock: QueryClock,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimitBytes: number,
): Promise<ServiceStatusResult> {
  const [script, operatorUnit] = await Promise.all([
    runCommand(spawnImpl, clock, env, timeoutMs, outputLimitBytes, STATUS_SCRIPT, []),
    runCommand(
      spawnImpl,
      clock,
      env,
      timeoutMs,
      outputLimitBytes,
      SYSTEMCTL,
      ['show', '--property=ActiveState,SubState,Result', '--value', OPERATOR_UNIT],
    ),
  ]);

  const parsed = parseJsonStrict(script.stdout, serviceStatusScriptSchema, 'Service status is unavailable');
  const services = new Map(parsed.services.map((service) => [service.name, service] as const));
  services.set('operator', parseSystemctlState(operatorUnit.stdout));

  return {
    services: FIXED_SERVICE_ORDER.map((name) => {
      const service = services.get(name);
      if (!service) {
        throw toInvalidResult('Service status is unavailable');
      }
      return service;
    }),
  };
}

async function readDeploymentStatus(
  spawnImpl: QuerySpawnImplementation,
  clock: QueryClock,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimitBytes: number,
): Promise<DeploymentStatusResult> {
  const command = await runCommand(
    spawnImpl,
    clock,
    env,
    timeoutMs,
    outputLimitBytes,
    DEPLOYMENT_STATUS_SCRIPT,
    [],
  );
  return parseJsonStrict(command.stdout, deploymentStatusSchema, 'Deployment status is unavailable');
}

function sourceArgs(source: OperatorQuery & { type: 'logs_read' }): string[] {
  const args = ['--no-pager', '--output', 'json', '--utc'];
  switch (source.source) {
    case 'sync-server':
      return [...args, '--identifier', 'ariadne-sync-server'];
    case 'operator':
      return [...args, '--unit', OPERATOR_UNIT];
    case 'deployment':
      return [...args, '--unit', OPERATOR_UNIT, '--identifier', 'ariadne-deploy'];
    case 'backup':
      return [...args, '--unit', BACKUP_UNIT];
  }
}

function priorityToSeverity(priority: string): OperatorLogSeverity {
  const value = Number.parseInt(priority, 10);
  if (value <= 3) {
    return 'error';
  }
  if (value === 4) {
    return 'warning';
  }
  return 'info';
}

function microsToIso(value: string): string {
  const micros = Number.parseInt(value, 10);
  if (!Number.isFinite(micros) || micros < 0) {
    throw toInvalidResult('Log source is unavailable');
  }
  const iso = new Date(Math.floor(micros / 1000)).toISOString();
  if (!ISO_TIMESTAMP_PATTERN.test(iso)) {
    throw toInvalidResult('Log source is unavailable');
  }
  return iso;
}

function applyLogRedactions(message: string): { message: string; redacted: boolean } {
  let redacted = false;
  let value = message.replace(ANSI_PATTERN, '');
  const replace = (pattern: RegExp, replacement: string): void => {
    value = value.replace(pattern, () => {
      redacted = true;
      return replacement;
    });
  };

  replace(BEARER_PATTERN, 'Authorization: [REDACTED]');
  replace(DATABASE_URL_PATTERN, '[REDACTED]');
  replace(KEY_VALUE_SECRET_PATTERN, '[REDACTED]');
  replace(PATH_PATTERN, '[REDACTED]');

  return { message: value, redacted };
}

function takeUtf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/g, '');
}

async function readLogs(
  spawnImpl: QuerySpawnImplementation,
  clock: QueryClock,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimitBytes: number,
  maxLogResponseBytes: number,
  maxLogLineBytes: number,
  query: Extract<OperatorQuery, { type: 'logs_read' }>,
): Promise<LogsReadResult> {
  const command = await runCommand(
    spawnImpl,
    clock,
    env,
    timeoutMs,
    outputLimitBytes,
    JOURNALCTL,
    sourceArgs(query),
  );

  const cursor = query.cursor ?? null;
  const decodedCursor = cursor === null ? null : decodeOperatorLogCursor(cursor);

  const matchedEntries: LogsReadResult['entries'] = [];
  let jsonBytes = Buffer.byteLength('{"entries":[],"nextCursor":null}', 'utf8');
  let currentTimestamp = '';
  let currentSequence = -1;
  let moreAvailable = false;

  for (const line of command.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw toInvalidResult('Log source is unavailable');
    }
    const entry = journalEntrySchema.safeParse(parsed);
    if (!entry.success) {
      throw toInvalidResult('Log source is unavailable');
    }

    const timestamp = microsToIso(entry.data.__REALTIME_TIMESTAMP);
    if (timestamp === currentTimestamp) {
      currentSequence += 1;
    } else {
      currentTimestamp = timestamp;
      currentSequence = 0;
    }

    if (query.since && timestamp < query.since) {
      continue;
    }
    if (
      decodedCursor &&
      (timestamp < decodedCursor.timestamp ||
        (timestamp === decodedCursor.timestamp && currentSequence <= decodedCursor.sequence))
    ) {
      continue;
    }

    const severity = priorityToSeverity(entry.data.PRIORITY);
    if (query.severity && severity !== query.severity) {
      continue;
    }

    const sanitized = applyLogRedactions(entry.data.MESSAGE);
    const message = takeUtf8Head(sanitized.message, maxLogLineBytes);
    const normalized = {
      sequence: currentSequence,
      timestamp,
      severity,
      message,
      redacted: sanitized.redacted,
    } satisfies LogsReadResult['entries'][number];

    const addedBytes = Buffer.byteLength(`${matchedEntries.length === 0 ? '' : ','}${JSON.stringify(normalized)}`, 'utf8');
    if (jsonBytes + addedBytes > maxLogResponseBytes) {
      moreAvailable = true;
      break;
    }

    matchedEntries.push(normalized);
    jsonBytes += addedBytes;
    if (matchedEntries.length >= query.limit) {
      moreAvailable = true;
      break;
    }
  }

  const lastEntry = matchedEntries.at(-1);
  const nextCursor =
    lastEntry && (moreAvailable || matchedEntries.length === query.limit)
      ? encodeOperatorLogCursor({ timestamp: lastEntry.timestamp, sequence: lastEntry.sequence })
      : null;

  return { entries: matchedEntries, nextCursor };
}

async function sha256OfStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return hash.digest('hex');
}

async function readBackup(
  fileSystem: QueryFileSystem,
  query: Extract<OperatorQuery, { type: 'backup_read' }>,
): Promise<BackupReadResult> {
  const base = `${BACKUP_ROOT}/${query.backupName.slice(0, -'.dump'.length)}`;
  const dumpPath = `${base}.dump`;
  const checksumPath = `${base}.sha256`;
  const metadataPath = `${base}.json`;

  try {
    const [checksumText, metadataText, stats] = await Promise.all([
      fileSystem.readFile(checksumPath),
      fileSystem.readFile(metadataPath),
      fileSystem.stat(dumpPath),
    ]);

    if (!stats.isFile()) {
      throw new OperatorQueryError('backup_not_found', 'Backup is unavailable');
    }

    const metadata = parseJsonStrict(metadataText, backupMetadataSchema, 'Backup metadata is unavailable');
    if (metadata.basename !== query.backupName) {
      throw new OperatorQueryError('integrity_error', 'Backup metadata is unavailable');
    }

    const checksumMatch = /^([0-9a-f]{64})\s{2}([^\s]+)$/.exec(checksumText.trim());
    if (!checksumMatch || checksumMatch[2] !== query.backupName || checksumMatch[1] !== metadata.sha256) {
      throw new OperatorQueryError('integrity_error', 'Backup metadata is unavailable');
    }
    if (stats.size !== metadata.dumpBytes) {
      throw new OperatorQueryError('integrity_error', 'Backup metadata is unavailable');
    }

    const digest = await sha256OfStream(fileSystem.createReadStream(dumpPath));
    if (digest !== metadata.sha256) {
      throw new OperatorQueryError('integrity_error', 'Backup metadata is unavailable');
    }

    return {
      filename: query.backupName,
      sha256: metadata.sha256,
      sizeBytes: metadata.dumpBytes,
      stream: fileSystem.createReadStream(dumpPath),
    };
  } catch (error: unknown) {
    if (error instanceof OperatorQueryError) {
      throw error;
    }
    if (isUnavailableError(error)) {
      throw new OperatorQueryError('backup_not_found', 'Backup is unavailable');
    }
    throw error;
  }
}

export function createOperatorQueryExecutor(
  options: CreateOperatorQueryExecutorOptions = {},
): OperatorQueryExecutor {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const clock = options.clock ?? defaultClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const env = options.env ?? DEFAULT_QUERY_ENV;
  const maxLogResponseBytes = options.maxLogResponseBytes ?? DEFAULT_QUERY_RESPONSE_BYTES;
  const maxCommandOutputBytes = options.maxCommandOutputBytes ?? DEFAULT_QUERY_RESPONSE_BYTES;
  const maxLogLineBytes = options.maxLogLineBytes ?? DEFAULT_LOG_LINE_BYTES;

  return {
    async execute(query: OperatorQuery): Promise<OperatorQueryResult> {
      switch (query.type) {
        case 'host_metrics':
          return { type: 'host_metrics', value: await readHostMetrics(fileSystem) };
        case 'service_status':
          return {
            type: 'service_status',
            value: await readServiceStatus(
              spawnImpl,
              clock,
              env,
              timeoutMs,
              maxCommandOutputBytes,
            ),
          };
        case 'deployment_status':
          return {
            type: 'deployment_status',
            value: await readDeploymentStatus(
              spawnImpl,
              clock,
              env,
              timeoutMs,
              maxCommandOutputBytes,
            ),
          };
        case 'logs_read':
          return {
            type: 'logs_read',
            value: await readLogs(
              spawnImpl,
              clock,
              env,
              timeoutMs,
              maxCommandOutputBytes,
              maxLogResponseBytes,
              maxLogLineBytes,
              query,
            ),
          };
        case 'backup_read':
          return { type: 'backup_read', value: await readBackup(fileSystem, query) };
      }
    },
  };
}
