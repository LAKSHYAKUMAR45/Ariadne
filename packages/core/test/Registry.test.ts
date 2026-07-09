import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskStore } from '../src/TaskStore.js';
import { openWorkspaceStore } from '../src/workspace.js';
import {
  openRegistry,
  closeRegistry,
  listWorkspaces,
  listAllTasks,
  findTaskWorkspace,
  upsertTaskIndex,
  syncWorkspaceTasks,
  forgetWorkspace,
  pruneMissingWorkspaces,
} from '../src/Registry.js';

describe('Registry (cross-workspace task index)', () => {
  let registryPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-registry-test-'));
    registryPath = path.join(tmpDir, 'registry.db');
  });

  afterEach(() => {
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsertTaskIndex records a workspace and a task, and updates on repeated calls', () => {
    const registryDb = openRegistry(registryPath);
    const now = new Date().toISOString();
    upsertTaskIndex(registryDb, '/workspace/a', {
      id: 't1',
      title: 'First title',
      goal: 'Goal',
      status: 'active',
      parentTaskId: null,
      branch: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(listWorkspaces(registryDb).map((w) => w.root)).toEqual(['/workspace/a']);
    expect(listAllTasks(registryDb)).toHaveLength(1);
    expect(listAllTasks(registryDb)[0]).toMatchObject({ taskId: 't1', title: 'First title', status: 'active' });

    upsertTaskIndex(registryDb, '/workspace/a', {
      id: 't1',
      title: 'Renamed', // titles aren't actually mutable in TaskStore today, but the registry should reflect whatever it's given
      goal: 'Goal',
      status: 'done',
      parentTaskId: null,
      branch: null,
      createdAt: now,
      updatedAt: now,
    });

    const tasks = listAllTasks(registryDb);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Renamed', status: 'done' });
  });

  it('findTaskWorkspace resolves a known task id to its owning workspace root', () => {
    const registryDb = openRegistry(registryPath);
    const now = new Date().toISOString();
    upsertTaskIndex(registryDb, '/workspace/b', {
      id: 't2',
      title: 'Task in B',
      goal: null,
      status: 'active',
      parentTaskId: null,
      branch: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(findTaskWorkspace(registryDb, 't2')).toBe('/workspace/b');
    expect(findTaskWorkspace(registryDb, 'unknown-id')).toBeUndefined();
  });

  it('syncWorkspaceTasks bulk-upserts a whole task list in one call', () => {
    const registryDb = openRegistry(registryPath);
    const now = new Date().toISOString();
    syncWorkspaceTasks(registryDb, '/workspace/c', [
      { id: 'a', title: 'A', goal: null, status: 'active', parentTaskId: null, branch: null, createdAt: now, updatedAt: now },
      { id: 'b', title: 'B', goal: null, status: 'paused', parentTaskId: null, branch: null, createdAt: now, updatedAt: now },
    ]);

    const tasks = listAllTasks(registryDb);
    expect(tasks.map((t) => t.taskId).sort()).toEqual(['a', 'b']);
  });

  it('listAllTasks filters by status', () => {
    const registryDb = openRegistry(registryPath);
    const now = new Date().toISOString();
    syncWorkspaceTasks(registryDb, '/workspace/d', [
      { id: 'x', title: 'X', goal: null, status: 'active', parentTaskId: null, branch: null, createdAt: now, updatedAt: now },
      { id: 'y', title: 'Y', goal: null, status: 'done', parentTaskId: null, branch: null, createdAt: now, updatedAt: now },
    ]);

    expect(listAllTasks(registryDb, { status: 'done' }).map((t) => t.taskId)).toEqual(['y']);
  });

  it('TaskStore linked to a workspaceRoot keeps the registry in sync automatically on create/status/branch/touch', () => {
    const previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = registryPath;
    closeRegistry();
    try {
      const dbPath = path.join(tmpDir, 'workspace-e', '.ariadne', 'state.db');
      const workspaceRoot = path.join(tmpDir, 'workspace-e');
      const store = new TaskStore(dbPath, workspaceRoot);
      try {
        const task = store.createTask({ title: 'Linked task', goal: 'Verify auto-sync' });
        let registryDb = openRegistry(registryPath);
        expect(findTaskWorkspace(registryDb, task.id)).toBe(workspaceRoot);
        expect(listAllTasks(registryDb)[0]).toMatchObject({ title: 'Linked task', status: 'active' });

        store.updateTaskStatus(task.id, 'done');
        registryDb = openRegistry(registryPath);
        expect(listAllTasks(registryDb)[0]).toMatchObject({ status: 'done' });

        store.updateTaskBranch(task.id, 'feature/x');
        store.touchTask(task.id);
        registryDb = openRegistry(registryPath);
        expect(listAllTasks(registryDb)).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
      closeRegistry();
    }
  });

  it('openWorkspaceStore backfills all of a workspace\'s existing tasks into the registry on open', () => {
    const previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = registryPath;
    closeRegistry();
    try {
      const workspaceRoot = path.join(tmpDir, 'workspace-f');
      const store = openWorkspaceStore(workspaceRoot);
      const task = store.createTask({ title: 'Backfill me', goal: null });
      store.close();

      // Re-open (simulating a brand-new process / surface) — the backfill on
      // open should mean the registry already has this task indexed.
      const registryDb = openRegistry(registryPath);
      expect(findTaskWorkspace(registryDb, task.id)).toBe(workspaceRoot);
      expect(listAllTasks(registryDb).some((t) => t.taskId === task.id)).toBe(true);
    } finally {
      process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
      closeRegistry();
    }
  });

  it('two separate workspaces both show up in the registry after each is opened', () => {
    const previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = registryPath;
    closeRegistry();
    try {
      const rootA = path.join(tmpDir, 'ws-a');
      const rootB = path.join(tmpDir, 'ws-b');
      const storeA = openWorkspaceStore(rootA);
      const taskA = storeA.createTask({ title: 'Task A', goal: null });
      storeA.close();

      const storeB = openWorkspaceStore(rootB);
      const taskB = storeB.createTask({ title: 'Task B', goal: null });
      storeB.close();

      const registryDb = openRegistry(registryPath);
      const roots = listWorkspaces(registryDb).map((w) => w.root).sort();
      expect(roots).toEqual([rootA, rootB].sort());

      expect(findTaskWorkspace(registryDb, taskA.id)).toBe(rootA);
      expect(findTaskWorkspace(registryDb, taskB.id)).toBe(rootB);
    } finally {
      process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
      closeRegistry();
    }
  });

  it('forgetWorkspace removes a workspace root and all of its indexed tasks', () => {
    const previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = registryPath;
    closeRegistry();
    try {
      const rootA = path.join(tmpDir, 'ws-a');
      const rootB = path.join(tmpDir, 'ws-b');
      const storeA = openWorkspaceStore(rootA);
      const taskA = storeA.createTask({ title: 'Task A', goal: null });
      storeA.close();
      const storeB = openWorkspaceStore(rootB);
      const taskB = storeB.createTask({ title: 'Task B', goal: null });
      storeB.close();

      const registryDb = openRegistry(registryPath);
      forgetWorkspace(registryDb, rootA);

      expect(listWorkspaces(registryDb).map((w) => w.root)).toEqual([rootB]);
      expect(findTaskWorkspace(registryDb, taskA.id)).toBeUndefined();
      expect(findTaskWorkspace(registryDb, taskB.id)).toBe(rootB);
    } finally {
      process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
      closeRegistry();
    }
  });

  it('pruneMissingWorkspaces removes only workspaces whose directory no longer exists on disk', () => {
    const previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = registryPath;
    closeRegistry();
    try {
      const rootA = path.join(tmpDir, 'ws-a');
      const rootB = path.join(tmpDir, 'ws-b');
      const storeA = openWorkspaceStore(rootA);
      const taskA = storeA.createTask({ title: 'Task A', goal: null });
      storeA.close();
      const storeB = openWorkspaceStore(rootB);
      const taskB = storeB.createTask({ title: 'Task B', goal: null });
      storeB.close();

      // Simulate rootA having been deleted from disk since it was last seen.
      fs.rmSync(rootA, { recursive: true, force: true });

      const registryDb = openRegistry(registryPath);
      const pruned = pruneMissingWorkspaces(registryDb);

      expect(pruned).toEqual([rootA]);
      expect(listWorkspaces(registryDb).map((w) => w.root)).toEqual([rootB]);
      expect(findTaskWorkspace(registryDb, taskA.id)).toBeUndefined();
      expect(findTaskWorkspace(registryDb, taskB.id)).toBe(rootB);
    } finally {
      process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
      closeRegistry();
    }
  });
});
