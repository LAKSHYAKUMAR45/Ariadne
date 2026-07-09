import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openWorkspaceStore, setCurrentTaskId, closeRegistry } from '@ariadne-dev/core';
import { program } from '../src/index.js';

// `ariadne status`/`resume` are commander actions in index.ts; exercised
// here by parsing argv through the real `program`, same convention as
// workspaceRegistry.test.ts.
describe('ariadne status/resume workspace + branch visibility', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let previousRegistryPath: string | undefined;

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-status-test-'));
    git(['init', '-q', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.com'], root);
    git(['config', 'user.name', 'Test'], root);
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(root, 'registry.db');
    closeRegistry();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((args) => String(args[0]));
  }

  it('status prints the workspace root and current tracked branch', async () => {
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Branch-visible task' });
    setCurrentTaskId(task.id, root);
    store.updateTaskBranch(task.id, 'feature/xyz');
    store.close();

    await program.parseAsync(['node', 'ariadne', 'status']);

    const lines = loggedLines();
    expect(lines).toContainEqual(expect.stringContaining(`Workspace: ${root}`));
    expect(lines).toContainEqual(expect.stringContaining('Branch: feature/xyz'));
  });

  it('status omits the branch line when the task has no tracked branch yet', async () => {
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'No branch task' });
    setCurrentTaskId(task.id, root);
    store.close();

    await program.parseAsync(['node', 'ariadne', 'status']);

    const lines = loggedLines();
    expect(lines).toContainEqual(expect.stringContaining(`Workspace: ${root}`));
    expect(lines.some((l) => l.startsWith('Branch:'))).toBe(false);
  });
});
