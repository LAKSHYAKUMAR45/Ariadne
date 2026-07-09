import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore, closeRegistry } from '@ariadne/core';
import { program } from '../src/index.js';

// These commands (`workspace list/prune/forget`, `backup`, `restore`) are
// registered as commander actions in index.ts; exercised here by parsing
// argv through the real `program`, same convention as exec.test.ts's
// no-current-task test.
describe('ariadne workspace/backup/restore commands', () => {
  let tmpDir: string;
  let previousRegistryPath: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-registry-test-'));
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(tmpDir, 'registry.db');
    closeRegistry();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWorkspace(name: string): string {
    const root = path.join(tmpDir, name);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    return root;
  }

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((args) => String(args[0]));
  }

  it('workspace list shows every known workspace and flags ones missing on disk', async () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');
    openWorkspaceStore(rootA).close();
    openWorkspaceStore(rootB).close();
    fs.rmSync(rootA, { recursive: true, force: true });

    await program.parseAsync(['node', 'ariadne', 'workspace', 'list']);

    const lines = loggedLines();
    expect(lines.some((l) => l.includes(rootA) && l.includes('missing on disk'))).toBe(true);
    expect(lines.some((l) => l.includes(rootB) && !l.includes('missing on disk'))).toBe(true);
  });

  it('workspace prune removes only workspaces whose directory no longer exists', async () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');
    openWorkspaceStore(rootA).close();
    openWorkspaceStore(rootB).close();
    fs.rmSync(rootA, { recursive: true, force: true });

    await program.parseAsync(['node', 'ariadne', 'workspace', 'prune']);
    expect(loggedLines().some((l) => l.includes(rootA))).toBe(true);

    logSpy.mockClear();
    await program.parseAsync(['node', 'ariadne', 'workspace', 'list']);
    const lines = loggedLines();
    expect(lines.some((l) => l.includes(rootA))).toBe(false);
    expect(lines.some((l) => l.includes(rootB))).toBe(true);
  });

  it('workspace forget removes a workspace explicitly, regardless of whether it still exists on disk', async () => {
    const rootA = makeWorkspace('ws-a');
    openWorkspaceStore(rootA).close();

    await program.parseAsync(['node', 'ariadne', 'workspace', 'forget', rootA]);

    logSpy.mockClear();
    await program.parseAsync(['node', 'ariadne', 'workspace', 'list']);
    expect(loggedLines().some((l) => l.includes(rootA))).toBe(false);
    // The workspace directory itself (and its own state.db) are untouched.
    expect(fs.existsSync(rootA)).toBe(true);
  });

  it('backup copies the current workspace state db and the registry to a timestamped snapshot', async () => {
    const root = makeWorkspace('ws-backup');
    const store = openWorkspaceStore(root);
    store.createTask({ title: 'Backed-up task', goal: null });
    store.close();

    process.chdir(root);
    await program.parseAsync(['node', 'ariadne', 'backup']);

    const outDir = path.join(root, '.ariadne', 'backups');
    const files = fs.readdirSync(outDir);
    expect(files.some((f) => f.startsWith('state-') && f.endsWith('.db'))).toBe(true);
    expect(files.some((f) => f.startsWith('registry-') && f.endsWith('.db'))).toBe(true);
  });

  it('restore copies a snapshot back over the current workspace state db, backing up the existing one first', async () => {
    const root = makeWorkspace('ws-restore');
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Original task', goal: null });
    store.close();

    process.chdir(root);
    await program.parseAsync(['node', 'ariadne', 'backup']);
    const outDir = path.join(root, '.ariadne', 'backups');
    const snapshot = fs.readdirSync(outDir).find((f) => f.startsWith('state-'))!;
    const snapshotPath = path.join(outDir, snapshot);

    // Mutate the live db after the snapshot was taken.
    const store2 = openWorkspaceStore(root);
    store2.createTask({ title: 'Task added after backup', goal: null });
    store2.close();

    await program.parseAsync(['node', 'ariadne', 'restore', snapshotPath]);

    const restoredStore = openWorkspaceStore(root);
    const tasks = restoredStore.listTasks();
    restoredStore.close();
    expect(tasks.map((t) => t.id)).toEqual([task.id]);

    const stateDbDir = path.join(root, '.ariadne');
    const preRestoreBackups = fs.readdirSync(stateDbDir).filter((f) => f.includes('pre-restore'));
    expect(preRestoreBackups.length).toBeGreaterThan(0);
  });

  it('restore errors clearly for a snapshot path that does not exist', async () => {
    const root = makeWorkspace('ws-restore-missing');
    openWorkspaceStore(root).close();
    process.chdir(root);

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        program.parseAsync(['node', 'ariadne', 'restore', path.join(root, 'does-not-exist.db')]),
      ).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
