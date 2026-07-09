import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { openWorkspaceStore, setCurrentTaskId } from '@ariadne/core';
import { runTaskExec } from '../src/exec.js';
import { program } from '../src/index.js';

const TEST_TMP_ROOT = path.join(process.cwd(), 'packages', 'cli', 'test', '.tmp-exec');

function makeWorkspace(name: string): string {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const root = path.join(TEST_TMP_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

class FakeChildProcess extends EventEmitter {}

describe('ariadne exec', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('records a successful command with exit code 0 and no error entry', async () => {
    const root = makeWorkspace('success');
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Exec success' });
    setCurrentTaskId(task.id, root);

    try {
      const spawnImpl = vi.fn(() => {
        const child = new FakeChildProcess() as ChildProcess;
        process.nextTick(() => child.emit('close', 0, null));
        return child;
      });

      const exitCode = await runTaskExec(store, task.id, 'node', ['-e', 'process.exit(0)'], { spawnImpl });

      expect(exitCode).toBe(0);
      expect(spawnImpl).toHaveBeenCalledWith('node', ['-e', 'process.exit(0)'], { stdio: 'inherit' });

      const commands = store.listCommands(task.id);
      expect(commands).toHaveLength(1);
      expect(commands[0].cmdRedacted).toBe('node -e process.exit(0)');
      expect(commands[0].exitCode).toBe(0);
      expect(store.listErrors(task.id, { resolved: false })).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('records a failing command, creates an error entry, and returns the same exit code', async () => {
    const root = makeWorkspace('failure');
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Exec failure' });
    setCurrentTaskId(task.id, root);

    try {
      const spawnImpl = vi.fn(() => {
        const child = new FakeChildProcess() as ChildProcess;
        process.nextTick(() => child.emit('close', 7, null));
        return child;
      });

      const exitCode = await runTaskExec(store, task.id, 'node', ['-e', 'process.exit(7)'], { spawnImpl });

      expect(exitCode).toBe(7);

      const commands = store.listCommands(task.id);
      expect(commands).toHaveLength(1);
      expect(commands[0].cmdRedacted).toBe('node -e process.exit(7)');
      expect(commands[0].exitCode).toBe(7);

      const errors = store.listErrors(task.id, { resolved: false });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Command failed (exit 7): node -e process.exit(7)');
    } finally {
      store.close();
    }
  });

  it('redacts obviously secret-bearing flags before recording commands', async () => {
    const root = makeWorkspace('redaction');
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Exec redaction' });
    setCurrentTaskId(task.id, root);

    try {
      const spawnImpl = vi.fn(() => {
        const child = new FakeChildProcess() as ChildProcess;
        process.nextTick(() => child.emit('close', 0, null));
        return child;
      });

      await runTaskExec(store, task.id, 'curl', ['--token', 'abc123', 'https://example.com'], { spawnImpl });

      const commands = store.listCommands(task.id);
      expect(commands).toHaveLength(1);
      expect(commands[0].cmdRedacted).toContain('***');
      expect(commands[0].cmdRedacted).not.toContain('abc123');
    } finally {
      store.close();
    }
  });

  it('errors clearly when no current task is set', async () => {
    const root = makeWorkspace('no-current-task');
    const originalCwd = process.cwd();
    process.chdir(root);

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(program.parseAsync(['node', 'ariadne', 'exec', 'node', '-e', 'process.exit(0)'])).rejects.toThrow(
        'process.exit:1',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'No task specified and no current task set. Run "ariadne task new <title>" first, or pass --task <id>.',
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});
