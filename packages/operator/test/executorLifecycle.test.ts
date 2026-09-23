import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAIN_GRACE_MS,
  createOperatorExecutor,
  type OperatorSpawnOptions,
  type OperatorSpawnedProcess,
} from '../src/executor.js';

const HELPER_SCRIPT = path.join(__dirname, 'fixtures', 'holds-stdout.cjs');
const POSIX = process.platform !== 'win32';

/**
 * Fake child that can emit `exit` and `close` independently, so the tests can
 * reproduce a descendant holding the stdout pipe open after the direct child
 * has already gone away.
 */
class LifecycleChild extends EventEmitter implements OperatorSpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly directKillSignals: Array<NodeJS.Signals | undefined> = [];

  constructor(readonly pid: number | undefined) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.directKillSignals.push(signal);
    return true;
  }

  exitOnly(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }

  closeToo(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

describe('operator executor process lifecycle', () => {
  const reapPids: number[] = [];

  afterEach(() => {
    for (const pid of reapPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('spawns into its own process group on POSIX and never detaches on Windows', async () => {
    let options: OperatorSpawnOptions | undefined;

    await createOperatorExecutor({
      spawnImpl(_file, _args, spawnOptions) {
        options = spawnOptions;
        const child = new LifecycleChild(4242);
        process.nextTick(() => child.closeToo(0));
        return child;
      },
    }).execute({ operationId: 'op-detached', type: 'backup_create' });

    expect(options?.detached).toBe(POSIX);
  });

  it('terminates the whole process group on timeout, escalating SIGTERM to SIGKILL', async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let child: LifecycleChild | undefined;

    const executor = createOperatorExecutor({
      timeoutMs: 20,
      killGraceMs: 15,
      drainGraceMs: 20,
      killImpl(pid, signal) {
        killed.push({ pid, signal });
      },
      spawnImpl() {
        child = new LifecycleChild(9911);
        return child;
      },
    });

    const execution = executor.execute({ operationId: 'op-group-timeout', type: 'backup_create' });

    await expect(execution).rejects.toThrowError(/timed out/i);

    expect(killed).toEqual([
      { pid: -9911, signal: 'SIGTERM' },
      { pid: -9911, signal: 'SIGKILL' },
    ]);
    // The group signal is authoritative; the direct child handle is not
    // signalled separately when a group kill succeeded.
    expect(child?.directKillSignals).toEqual([]);
  });

  it('falls back to signalling the direct child when no pid is available', async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let child: LifecycleChild | undefined;

    const execution = createOperatorExecutor({
      timeoutMs: 20,
      killGraceMs: 15,
      drainGraceMs: 20,
      killImpl(pid, signal) {
        killed.push({ pid, signal });
      },
      spawnImpl() {
        child = new LifecycleChild(undefined);
        return child;
      },
    }).execute({ operationId: 'op-nopid-timeout', type: 'backup_create' });

    await expect(execution).rejects.toThrowError(/timed out/i);
    expect(killed).toEqual([]);
    expect(child?.directKillSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('settles on exit with a bounded drain when a held pipe prevents close', async () => {
    let child: LifecycleChild | undefined;
    let result: { success: boolean; exitCode: number | null; output: string } | undefined;

    const executor = createOperatorExecutor({
      drainGraceMs: 30,
      reporter: {
        onResult(event) {
          result = {
            success: event.success,
            exitCode: event.exitCode,
            output: event.output,
          };
        },
      },
      spawnImpl() {
        child = new LifecycleChild(1234);
        process.nextTick(() => {
          child?.stdout.write('partial output\n');
          // `exit` fires, but the stdout pipe is never ended: a surviving
          // descendant still holds the write end.
          child?.exitOnly(0, null);
        });
        return child;
      },
    });

    const started = Date.now();
    await expect(
      executor.execute({ operationId: 'op-held-pipe', type: 'backup_create' }),
    ).resolves.toBeUndefined();

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result?.success).toBe(true);
    expect(result?.exitCode).toBe(0);
    expect(result?.output).toContain('partial output');
  });

  it('prefers the real close event over the drain fallback', async () => {
    let child: LifecycleChild | undefined;

    const executor = createOperatorExecutor({
      drainGraceMs: 60_000,
      spawnImpl() {
        child = new LifecycleChild(4321);
        process.nextTick(() => {
          child?.exitOnly(0, null);
          setTimeout(() => child?.closeToo(0, null), 5);
        });
        return child;
      },
    });

    const started = Date.now();
    await executor.execute({ operationId: 'op-close-wins', type: 'backup_create' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('exposes a bounded default drain window', () => {
    expect(DEFAULT_DRAIN_GRACE_MS).toBeGreaterThan(0);
    expect(DEFAULT_DRAIN_GRACE_MS).toBeLessThanOrEqual(30_000);
  });

  it.runIf(POSIX)(
    'releases the slot when a real descendant keeps stdout open past the timeout',
    async () => {
      let grandchildPid: number | undefined;
      let resultSeen = false;

      const executor = createOperatorExecutor({
        timeoutMs: 400,
        killGraceMs: 200,
        drainGraceMs: 500,
        reporter: {
          onProgress(event) {
            const match = /grandchild:(\d+)/.exec(event.chunk);
            if (match) {
              grandchildPid = Number(match[1]);
              reapPids.push(grandchildPid);
            }
          },
          onResult() {
            resultSeen = true;
          },
        },
        // The fixed command table only names installed privileged scripts, so
        // the fixture is substituted here while every real spawn option
        // (detached, stdio pipes, env) is passed straight through.
        spawnImpl(_file, _args, options) {
          return spawn(process.execPath, [HELPER_SCRIPT], options) as OperatorSpawnedProcess;
        },
      });

      const started = Date.now();
      await expect(
        executor.execute({ operationId: 'op-real-descendant', type: 'backup_create' }),
      ).rejects.toThrowError(/timed out/i);
      const elapsed = Date.now() - started;

      // Without the exit-plus-drain settlement this never resolves at all.
      expect(elapsed).toBeLessThan(5_000);
      expect(resultSeen).toBe(true);
      expect(grandchildPid).toBeGreaterThan(0);
    },
    20_000,
  );
});

describe('bounded output tail encoding', () => {
  it('never emits a replacement character at the truncation boundary', async () => {
    // Four-byte code points guarantee the tail boundary lands mid-sequence for
    // at least some of the sizes exercised below.
    const emoji = '😀';
    const emojiBytes = Buffer.byteLength(emoji, 'utf8');
    expect(emojiBytes).toBe(4);

    for (const maxBytes of [10, 11, 12, 13]) {
      let output = '';
      await createOperatorExecutor({
        outputTailBytes: maxBytes,
        reporter: {
          onResult(event) {
            output = event.output;
          },
        },
        spawnImpl() {
          const child = new LifecycleChild(1);
          process.nextTick(() => {
            child.stdout.write(Buffer.from(emoji.repeat(20), 'utf8'));
            child.closeToo(0);
          });
          return child;
        },
      }).execute({ operationId: `op-utf8-${maxBytes}`, type: 'backup_create' });

      expect(output, `maxBytes=${maxBytes}`).not.toContain('\uFFFD');
      expect(output, `maxBytes=${maxBytes}`).toBe(emoji.repeat(Math.floor(maxBytes / emojiBytes)));
    }
  });

  it('keeps multi-byte characters intact when chunks split a code point', async () => {
    const text = 'héllo wörld ✓ 😀';
    const bytes = Buffer.from(text, 'utf8');
    let output = '';

    await createOperatorExecutor({
      outputTailBytes: 1024,
      reporter: {
        onResult(event) {
          output = event.output;
        },
      },
      spawnImpl() {
        const child = new LifecycleChild(1);
        process.nextTick(() => {
          for (const byte of bytes) {
            child.stdout.write(Buffer.from([byte]));
          }
          child.closeToo(0);
        });
        return child;
      },
    }).execute({ operationId: 'op-utf8-split', type: 'backup_create' });

    expect(output).toBe(text);
  });
});
