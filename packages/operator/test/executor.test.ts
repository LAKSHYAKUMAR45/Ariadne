import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createOperatorExecutor,
  DEFAULT_EXEC_ENV,
  MAX_BACKUP_RESULT_BYTES,
  type OperatorResultEvent,
  type OperatorSpawnOptions,
  type OperatorSpawnedProcess,
  type SpawnImplementation,
} from '../src/executor.js';
import type { OperatorRequest } from '../src/protocol.js';

interface Invocation {
  file: string;
  args: readonly string[];
  options: OperatorSpawnOptions;
}

function createSpawnRecorder(): { invocations: Invocation[]; spawnImpl: typeof spawnStub } {
  const invocations: Invocation[] = [];

  function spawnStub(
    file: string,
    args: readonly string[],
    options: OperatorSpawnOptions,
  ): OperatorSpawnedProcess {
    invocations.push({ file, args, options });
    const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    queueMicrotask(() => {
      for (const listener of listeners) listener(0, null);
    });
    return {
      stdout: null,
      stderr: null,
      kill: () => true,
      on(event: string, listener: (...values: never[]) => void) {
        if (event === 'close') {
          listeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        }
        return this;
      },
    } as OperatorSpawnedProcess;
  }

  return { invocations, spawnImpl: spawnStub };
}

async function run(request: OperatorRequest): Promise<Invocation> {
  const { invocations, spawnImpl } = createSpawnRecorder();
  await createOperatorExecutor({ spawnImpl }).execute(request);
  expect(invocations).toHaveLength(1);
  return invocations[0];
}

describe('operator executor command mapping', () => {
  it('runs the fixed backup script with no arguments', async () => {
    const invocation = await run({ operationId: 'op-1', type: 'backup_create' });

    expect(invocation.file).toBe('/usr/local/lib/ariadne/backup');
    expect(invocation.args).toEqual([]);
    expect(invocation.options.shell).toBe(false);
  });

  it('passes only the validated basename to verify and restore', async () => {
    const verify = await run({
      operationId: 'op-2',
      type: 'backup_verify',
      backupName: 'ariadne-20260401T021500Z.dump',
    });
    expect(verify.file).toBe('/usr/local/lib/ariadne/verify-backup');
    expect(verify.args).toEqual(['ariadne-20260401T021500Z.dump']);

    const restore = await run({
      operationId: 'op-3',
      type: 'backup_restore',
      backupName: 'ariadne-20260401T021500Z.dump',
    });
    expect(restore.file).toBe('/usr/local/lib/ariadne/restore-backup');
    expect(restore.args).toEqual(['ariadne-20260401T021500Z.dump']);
  });

  it('supplies the restore confirmation environment from the operator itself', async () => {
    const restore = await run({
      operationId: 'op-4',
      type: 'backup_restore',
      backupName: 'ariadne-20260401T021500Z.dump',
    });

    expect(restore.options.env.ARIADNE_RESTORE_CONFIRM).toBe('ariadne-20260401T021500Z.dump');
    expect(restore.options.env.PATH).toBe(DEFAULT_EXEC_ENV.PATH);
  });

  it('never confirms a restore for any other operation', async () => {
    const requests: OperatorRequest[] = [
      { operationId: 'op-5', type: 'backup_create' },
      { operationId: 'op-6', type: 'backup_verify', backupName: 'ariadne-20260401T021500Z.dump' },
      { operationId: 'op-7', type: 'service_restart', service: 'sync-server' },
      { operationId: 'op-8', type: 'deployment_apply', revision: 'a'.repeat(40) },
    ];

    for (const request of requests) {
      const invocation = await run(request);
      expect(invocation.options.env.ARIADNE_RESTORE_CONFIRM, request.type).toBeUndefined();
    }
  });

  it('keeps the shared default environment free of restore confirmation', async () => {
    expect(Object.keys(DEFAULT_EXEC_ENV)).not.toContain('ARIADNE_RESTORE_CONFIRM');

    await run({
      operationId: 'op-9',
      type: 'backup_restore',
      backupName: 'ariadne-20260401T021500Z.dump',
    });
    expect(Object.keys(DEFAULT_EXEC_ENV)).not.toContain('ARIADNE_RESTORE_CONFIRM');
  });
});

describe('operator executor backup result channel', () => {
  const VALID_RESULT = {
    filename: 'ariadne-20260401T021500Z.dump',
    sha256: 'a'.repeat(64),
    sizeBytes: 4096,
    createdAt: '2026-04-01T02:15:00Z',
    message: 'backup published and checksummed',
  };

  interface WritingSpawn {
    spawnImpl: SpawnImplementation;
    resultFiles: Array<string | undefined>;
    exitCode: number;
  }

  /** Fake command that writes `contents` to the operator-provided result path. */
  function createWritingSpawn(contents: string | null, exitCode = 0): WritingSpawn {
    const resultFiles: Array<string | undefined> = [];
    const recorder: WritingSpawn = {
      resultFiles,
      exitCode,
      spawnImpl(_file, _args, options) {
        const resultFile = options.env.ARIADNE_RESULT_FILE;
        resultFiles.push(resultFile);
        if (contents !== null && resultFile) {
          fs.writeFileSync(resultFile, contents, { mode: 0o600 });
        }
        const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
        queueMicrotask(() => {
          for (const listener of listeners) listener(recorder.exitCode, null);
        });
        return {
          stdout: null,
          stderr: null,
          kill: () => true,
          on(event: string, listener: (...values: never[]) => void) {
            if (event === 'close') {
              listeners.push(
                listener as (code: number | null, signal: NodeJS.Signals | null) => void,
              );
            }
            return this;
          },
        } as OperatorSpawnedProcess;
      },
    };
    return recorder;
  }

  async function execute(
    request: OperatorRequest,
    spawn: WritingSpawn,
  ): Promise<OperatorResultEvent> {
    const results: OperatorResultEvent[] = [];
    const executor = createOperatorExecutor({
      spawnImpl: spawn.spawnImpl,
      reporter: {
        onResult(event) {
          results.push(event);
        },
      },
    });
    await executor.execute(request).catch(() => undefined);
    expect(results).toHaveLength(1);
    return results[0];
  }

  it('reports the validated backup description a backup script published', async () => {
    const spawn = createWritingSpawn(`${JSON.stringify(VALID_RESULT)}\n`);
    const result = await execute({ operationId: 'op-result-1', type: 'backup_create' }, spawn);

    expect(result.backup).toEqual(VALID_RESULT);
    expect(spawn.resultFiles[0]).toMatch(/^\//);
  });

  it('reports a description published by a failed verification too', async () => {
    const spawn = createWritingSpawn(
      JSON.stringify({ ...VALID_RESULT, message: undefined }),
      1,
    );
    const result = await execute(
      {
        operationId: 'op-result-2',
        type: 'backup_verify',
        backupName: 'ariadne-20260401T021500Z.dump',
      },
      spawn,
    );

    expect(result.success).toBe(false);
    expect(result.backup).toMatchObject({ filename: VALID_RESULT.filename });
  });

  it('never opens a result channel for non-backup operations', async () => {
    for (const request of [
      { operationId: 'op-result-3', type: 'service_restart', service: 'sync-server' },
      { operationId: 'op-result-4', type: 'deployment_apply', revision: 'a'.repeat(40) },
    ] as OperatorRequest[]) {
      const spawn = createWritingSpawn(`${JSON.stringify(VALID_RESULT)}\n`);
      const result = await execute(request, spawn);

      expect(spawn.resultFiles, request.type).toEqual([undefined]);
      expect(result.backup ?? null, request.type).toBeNull();
    }
  });

  it('ignores a result file that is absent, malformed, oversized, or unexpected', async () => {
    const rejected: Array<string | null> = [
      null,
      'not json at all',
      JSON.stringify({ ...VALID_RESULT, filename: '../../etc/passwd' }),
      JSON.stringify({ ...VALID_RESULT, sha256: 'nope' }),
      JSON.stringify({ ...VALID_RESULT, sizeBytes: -1 }),
      JSON.stringify({ ...VALID_RESULT, extra: 'field' }),
      JSON.stringify({ ...VALID_RESULT, message: 'x'.repeat(MAX_BACKUP_RESULT_BYTES) }),
    ];

    for (const contents of rejected) {
      const spawn = createWritingSpawn(contents);
      const result = await execute({ operationId: 'op-result-5', type: 'backup_create' }, spawn);
      expect(result.backup ?? null, String(contents).slice(0, 40)).toBeNull();
    }
  });

  it('removes the result file once the operation has been reported', async () => {
    const spawn = createWritingSpawn(`${JSON.stringify(VALID_RESULT)}\n`);
    await execute({ operationId: 'op-result-6', type: 'backup_create' }, spawn);

    const resultFile = spawn.resultFiles[0];
    expect(resultFile).toBeTruthy();
    expect(fs.existsSync(resultFile!)).toBe(false);
    expect(fs.existsSync(path.dirname(resultFile!))).toBe(false);
  });
});
