import { describe, expect, it } from 'vitest';
import {
  createOperatorExecutor,
  DEFAULT_EXEC_ENV,
  type OperatorSpawnOptions,
  type OperatorSpawnedProcess,
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
