import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore } from '../src/workspace.js';
import { closeRegistry } from '../src/Registry.js';
import {
  listTasksAcrossWorkspaces,
  listKnownWorkspaces,
  searchAcrossWorkspaces,
  resolveTaskAnyWorkspace,
} from '../src/CrossWorkspace.js';

describe('CrossWorkspace (orchestration over Registry + real per-workspace stores)', () => {
  let tmpDir: string;
  let previousRegistryPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-crossws-test-'));
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(tmpDir, 'registry.db');
    closeRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWorkspace(name: string) {
    return path.join(tmpDir, name);
  }

  it('listTasksAcrossWorkspaces sees tasks from multiple workspaces', () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');

    const storeA = openWorkspaceStore(rootA);
    const taskA = storeA.createTask({ title: 'Task in A', goal: 'Goal A' });
    storeA.close();

    const storeB = openWorkspaceStore(rootB);
    const taskB = storeB.createTask({ title: 'Task in B', goal: 'Goal B' });
    storeB.close();

    const all = listTasksAcrossWorkspaces();
    const ids = all.map((t) => t.taskId).sort();
    expect(ids).toEqual([taskA.id, taskB.id].sort());
  });

  it('listKnownWorkspaces lists every workspace root that has been opened', () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');
    openWorkspaceStore(rootA).close();
    openWorkspaceStore(rootB).close();

    const roots = listKnownWorkspaces().map((w) => w.root).sort();
    expect(roots).toEqual([rootA, rootB].sort());
  });

  it('searchAcrossWorkspaces finds matches across multiple workspaces and tags each with its workspace root', () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');

    const storeA = openWorkspaceStore(rootA);
    storeA.createTask({ title: 'Fix the flaky login test', goal: null });
    storeA.close();

    const storeB = openWorkspaceStore(rootB);
    storeB.createTask({ title: 'Refactor login flow', goal: null });
    storeB.close();

    const results = searchAcrossWorkspaces('login');
    expect(results).toHaveLength(2);
    const roots = results.map((r) => r.workspaceRoot).sort();
    expect(roots).toEqual([rootA, rootB].sort());
  });

  it('searchAcrossWorkspaces skips a workspace whose directory no longer exists', () => {
    const rootA = makeWorkspace('ws-a');
    const rootGone = makeWorkspace('ws-gone');

    const storeA = openWorkspaceStore(rootA);
    storeA.createTask({ title: 'Investigate login bug', goal: null });
    storeA.close();

    const storeGone = openWorkspaceStore(rootGone);
    storeGone.createTask({ title: 'Another login task', goal: null });
    storeGone.close();
    // Simulate the workspace having vanished from disk since it was last seen.
    fs.rmSync(rootGone, { recursive: true, force: true });

    const results = searchAcrossWorkspaces('login');
    expect(results.map((r) => r.workspaceRoot)).toEqual([rootA]);
  });

  it('searchAcrossWorkspaces defaults to recent workspaces only, but can explicitly scan everything', () => {
    vi.useFakeTimers();
    try {
      const workspaceCount = 35;
      const query = 'needle';
      const oldMatchingRoots: string[] = [];
      const recentMatchingRoots: string[] = [];
      const baseTime = Date.parse('2024-01-01T00:00:00.000Z');

      for (let i = 0; i < workspaceCount; i += 1) {
        vi.setSystemTime(new Date(baseTime + i * 1000));
        const root = makeWorkspace(`ws-${String(i).padStart(2, '0')}`);
        const store = openWorkspaceStore(root);

        if (i === 5) {
          const task = store.createTask({ title: 'Legacy workspace task', goal: null });
          store.createCheckpoint({ taskId: task.id, level: 'session', summary: 'Captured legacy needle detail' });
          oldMatchingRoots.push(root);
        } else if (i >= workspaceCount - 2) {
          store.createTask({ title: `Recent ${query} task ${i}`, goal: null });
          recentMatchingRoots.push(root);
        } else {
          store.createTask({ title: `Unrelated task ${i}`, goal: null });
        }

        store.close();
      }

      const defaultResults = searchAcrossWorkspaces(query, { totalLimit: 10 });
      expect(defaultResults).toHaveLength(recentMatchingRoots.length);
      expect(defaultResults.map((r) => r.workspaceRoot).sort()).toEqual(recentMatchingRoots.sort());
      expect(defaultResults.some((r) => oldMatchingRoots.includes(r.workspaceRoot))).toBe(false);

      const allResults = searchAcrossWorkspaces(query, { allWorkspaces: true, totalLimit: 10 });
      expect(allResults).toHaveLength(oldMatchingRoots.length + recentMatchingRoots.length);
      expect(allResults.some((r) => oldMatchingRoots.includes(r.workspaceRoot))).toBe(true);
      expect(allResults.filter((r) => recentMatchingRoots.includes(r.workspaceRoot))).toHaveLength(recentMatchingRoots.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolveTaskAnyWorkspace finds a task in the current workspace without touching the registry fallback', () => {
    const rootA = makeWorkspace('ws-a');
    const store = openWorkspaceStore(rootA);
    const task = store.createTask({ title: 'Local task', goal: null });
    store.close();

    const resolved = resolveTaskAnyWorkspace(task.id, rootA);
    expect(resolved?.fromCurrentWorkspace).toBe(true);
    expect(resolved?.workspaceRoot).toBe(rootA);
    resolved?.store.close();
  });

  it('resolveTaskAnyWorkspace transparently opens the owning workspace when the task is elsewhere', () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');

    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task only in B', goal: 'For cross-workspace lookup' });
    storeB.createCheckpoint({ taskId: task.id, level: 'session', summary: 'Some progress' });
    storeB.close();

    const resolved = resolveTaskAnyWorkspace(task.id, rootA);
    expect(resolved?.fromCurrentWorkspace).toBe(false);
    expect(resolved?.workspaceRoot).toBe(rootB);
    expect(resolved?.task.title).toBe('Task only in B');
    // Full read access, not just registry metadata:
    expect(resolved?.store.listCheckpoints(task.id)).toHaveLength(1);
    resolved?.store.close();
  });

  it('resolveTaskAnyWorkspace returns undefined for a completely unknown task id', () => {
    const rootA = makeWorkspace('ws-a');
    openWorkspaceStore(rootA).close();

    expect(resolveTaskAnyWorkspace('does-not-exist', rootA)).toBeUndefined();
  });

  it('searchAcrossWorkspaces does not write a .gitignore into workspaces it only reads from', () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');

    const storeA = openWorkspaceStore(rootA);
    storeA.createTask({ title: 'Fix login bug', goal: null });
    storeA.close();
    const storeB = openWorkspaceStore(rootB);
    storeB.createTask({ title: 'Unrelated task', goal: null });
    storeB.close();

    // openWorkspaceStore() above already wrote .gitignore once for each
    // workspace (that's the normal "actively working in it" path) — delete
    // both so we can tell whether the read-only cross-workspace search path
    // re-creates them, which it must not.
    fs.rmSync(path.join(rootA, '.gitignore'), { force: true });
    fs.rmSync(path.join(rootB, '.gitignore'), { force: true });

    searchAcrossWorkspaces('login');

    expect(fs.existsSync(path.join(rootA, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(rootB, '.gitignore'))).toBe(false);
  });

  it('resolveTaskAnyWorkspace does not write a .gitignore into the other workspace it transparently opens', () => {
    const rootA = makeWorkspace('ws-a');
    const rootB = makeWorkspace('ws-b');

    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task only in B', goal: null });
    storeB.close();
    openWorkspaceStore(rootA).close();

    fs.rmSync(path.join(rootB, '.gitignore'), { force: true });

    const resolved = resolveTaskAnyWorkspace(task.id, rootA);
    resolved?.store.close();

    expect(fs.existsSync(path.join(rootB, '.gitignore'))).toBe(false);
  });
});
