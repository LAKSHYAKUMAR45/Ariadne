import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openRegistry, closeRegistry, upsertTaskIndex } from '../src/Registry.js';
import {
  createTaskLinkGroup,
  getTaskLinkGroup,
  listTaskLinkGroups,
  linkTaskToGroup,
  unlinkTaskFromGroup,
  listGroupMembers,
  findGroupsForTask,
  deleteTaskLinkGroup,
} from '../src/CrossRepoLinks.js';
import type { Task } from '../src/types.js';

function fakeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: 't1',
    title: 'Sample task',
    goal: null,
    status: 'active',
    parentTaskId: null,
    branch: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('CrossRepoLinks (task_links / task_link_groups)', () => {
  let registryPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-crossrepolinks-test-'));
    registryPath = path.join(tmpDir, 'registry.db');
  });

  afterEach(() => {
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createTaskLinkGroup creates an empty group, retrievable by id and via listTaskLinkGroups', () => {
    const registryDb = openRegistry(registryPath);
    const group = createTaskLinkGroup(registryDb, 'Feature: dark mode');

    expect(getTaskLinkGroup(registryDb, group.id)).toEqual(group);
    expect(listTaskLinkGroups(registryDb).map((g) => g.id)).toEqual([group.id]);
    expect(listGroupMembers(registryDb, group.id)).toEqual([]);
  });

  it('createTaskLinkGroup without a label defaults label to null', () => {
    const registryDb = openRegistry(registryPath);
    const group = createTaskLinkGroup(registryDb);
    expect(group.label).toBeNull();
  });

  it('linkTaskToGroup requires the task to already be indexed in the registry', () => {
    const registryDb = openRegistry(registryPath);
    const group = createTaskLinkGroup(registryDb);
    expect(() => linkTaskToGroup(registryDb, group.id, 'unknown-task')).toThrow(/isn't known to the registry/i);
  });

  it('linkTaskToGroup requires the group to exist', () => {
    const registryDb = openRegistry(registryPath);
    upsertTaskIndex(registryDb, '/repo/a', fakeTask({ id: 't1' }));
    expect(() => linkTaskToGroup(registryDb, 'unknown-group', 't1')).toThrow(/no task link group found/i);
  });

  it('links two tasks from different repos into one group and lists them as members', () => {
    const registryDb = openRegistry(registryPath);
    upsertTaskIndex(registryDb, '/repo/backend', fakeTask({ id: 'backend-task', title: 'API change' }));
    upsertTaskIndex(registryDb, '/repo/frontend', fakeTask({ id: 'frontend-task', title: 'UI change' }));

    const group = createTaskLinkGroup(registryDb, 'Feature: dark mode');
    linkTaskToGroup(registryDb, group.id, 'backend-task');
    linkTaskToGroup(registryDb, group.id, 'frontend-task');

    const members = listGroupMembers(registryDb, group.id);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.taskId)).toEqual(['backend-task', 'frontend-task']);
    expect(members.map((m) => m.workspaceRoot)).toEqual(['/repo/backend', '/repo/frontend']);
    expect(members[0].title).toBe('API change');
  });

  it('linking the same task to the same group twice is a no-op, not an error', () => {
    const registryDb = openRegistry(registryPath);
    upsertTaskIndex(registryDb, '/repo/a', fakeTask({ id: 't1' }));
    const group = createTaskLinkGroup(registryDb);

    linkTaskToGroup(registryDb, group.id, 't1');
    linkTaskToGroup(registryDb, group.id, 't1');

    expect(listGroupMembers(registryDb, group.id)).toHaveLength(1);
  });

  it('unlinkTaskFromGroup removes only that member, leaving the group and other members intact', () => {
    const registryDb = openRegistry(registryPath);
    upsertTaskIndex(registryDb, '/repo/a', fakeTask({ id: 't1' }));
    upsertTaskIndex(registryDb, '/repo/b', fakeTask({ id: 't2' }));
    const group = createTaskLinkGroup(registryDb);
    linkTaskToGroup(registryDb, group.id, 't1');
    linkTaskToGroup(registryDb, group.id, 't2');

    unlinkTaskFromGroup(registryDb, group.id, 't1');

    expect(listGroupMembers(registryDb, group.id).map((m) => m.taskId)).toEqual(['t2']);
    expect(getTaskLinkGroup(registryDb, group.id)).not.toBeUndefined();
  });

  it('findGroupsForTask returns every group a task belongs to, including when it belongs to more than one', () => {
    const registryDb = openRegistry(registryPath);
    upsertTaskIndex(registryDb, '/repo/a', fakeTask({ id: 't1' }));
    const groupA = createTaskLinkGroup(registryDb, 'Group A');
    const groupB = createTaskLinkGroup(registryDb, 'Group B');
    linkTaskToGroup(registryDb, groupA.id, 't1');
    linkTaskToGroup(registryDb, groupB.id, 't1');

    const groups = findGroupsForTask(registryDb, 't1');
    expect(groups.map((g) => g.id).sort()).toEqual([groupA.id, groupB.id].sort());
  });

  it('findGroupsForTask returns an empty array for a task with no link groups', () => {
    const registryDb = openRegistry(registryPath);
    upsertTaskIndex(registryDb, '/repo/a', fakeTask({ id: 't1' }));
    expect(findGroupsForTask(registryDb, 't1')).toEqual([]);
  });

  it('deleteTaskLinkGroup removes the group and its membership rows, leaving indexed tasks untouched', () => {
    const registryDb = openRegistry(registryPath);
    upsertTaskIndex(registryDb, '/repo/a', fakeTask({ id: 't1' }));
    const group = createTaskLinkGroup(registryDb);
    linkTaskToGroup(registryDb, group.id, 't1');

    deleteTaskLinkGroup(registryDb, group.id);

    expect(getTaskLinkGroup(registryDb, group.id)).toBeUndefined();
    expect(findGroupsForTask(registryDb, 't1')).toEqual([]);
    // The underlying indexed task is untouched by deleting the group.
    expect(registryDb.prepare(`SELECT task_id FROM tasks_index WHERE task_id = ?`).get('t1')).toBeDefined();
  });
});
