import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { runGraphify, summarizeGraphifyRun, isGraphifyInstalled, GRAPHIFY_INSTALL_HINT } from '../src/Graphify.js';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe('Graphify', () => {
  it('captures stdout/stderr and resolves with exit code 0 on success', async () => {
    const spawnImpl = vi.fn(() => {
      const child = new FakeChildProcess() as unknown as ChildProcess;
      process.nextTick(() => {
        child.stdout?.emit('data', Buffer.from('Node: Foo\n'));
        child.stdout?.emit('data', Buffer.from('  Source: foo.ts L1\n'));
        (child as unknown as FakeChildProcess).emit('close', 0, null);
      });
      return child;
    });

    const result = await runGraphify(['explain', 'Foo'], { spawnImpl, mode: 'capture' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Node: Foo');
    expect(spawnImpl).toHaveBeenCalledWith('graphify', ['explain', 'Foo'], {
      cwd: undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('uses inherit stdio (no capture) when mode is inherit', async () => {
    const spawnImpl = vi.fn(() => {
      const child = new FakeChildProcess() as unknown as ChildProcess;
      process.nextTick(() => (child as unknown as FakeChildProcess).emit('close', 0, null));
      return child;
    });

    const result = await runGraphify(['watch', '.'], { spawnImpl, mode: 'inherit' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(spawnImpl).toHaveBeenCalledWith('graphify', ['watch', '.'], { cwd: undefined, stdio: 'inherit' });
  });

  it('resolves with a non-zero exit code and stderr on failure', async () => {
    const spawnImpl = vi.fn(() => {
      const child = new FakeChildProcess() as unknown as ChildProcess;
      process.nextTick(() => {
        child.stderr?.emit('data', Buffer.from('graph.json not found\n'));
        (child as unknown as FakeChildProcess).emit('close', 1, null);
      });
      return child;
    });

    const result = await runGraphify(['explain', 'Missing'], { spawnImpl });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('graph.json not found');
  });

  it('resolves with exit code 1 and the error message when the binary is missing', async () => {
    const spawnImpl = vi.fn(() => {
      const child = new FakeChildProcess() as unknown as ChildProcess;
      process.nextTick(() => (child as unknown as FakeChildProcess).emit('error', new Error('ENOENT')));
      return child;
    });

    const result = await runGraphify(['query', 'x'], { spawnImpl });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ENOENT');
  });

  it('summarizes a successful run as a single line with the command and first output line', () => {
    const summary = summarizeGraphifyRun(['explain', 'Foo'], { exitCode: 0, stdout: 'Node: Foo\nmore...', stderr: '' });
    expect(summary).toBe('ran "graphify explain Foo" (ok): Node: Foo');
  });

  it('summarizes a failed run with its exit code', () => {
    const summary = summarizeGraphifyRun(['path', 'A', 'B'], { exitCode: 2, stdout: '', stderr: 'no path found' });
    expect(summary).toBe('ran "graphify path A B" (exit 2): no path found');
  });

  it('exposes an install hint mentioning the PyPI package', () => {
    expect(GRAPHIFY_INSTALL_HINT).toContain('graphifyy');
  });

  it('isGraphifyInstalled returns a boolean without throwing for a missing binary', () => {
    expect(typeof isGraphifyInstalled('definitely-not-a-real-graphify-binary')).toBe('boolean');
    expect(isGraphifyInstalled('definitely-not-a-real-graphify-binary')).toBe(false);
  });
});
