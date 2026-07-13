import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore, closeRegistry } from '@ariadne-dev/core';
import * as syncClient from '../src/syncClient.js';
import { program } from '../src/index.js';

// Unit-level coverage for `ariadne sync *` — mocks the HTTP layer
// (syncClient) entirely so these tests run with no real network/Postgres
// dependency (that round trip is instead exercised manually against a real
// sync-server + Postgres — see packages/sync-server/README.md). Verifies
// the CLI correctly wires TaskStore <-> syncClient <-> ~/.ariadne/sync-config.json.
vi.mock('../src/syncClient.js', () => ({
  register: vi.fn(),
  login: vi.fn(),
  pushTasks: vi.fn(),
  pullTasks: vi.fn(),
  pushCheckpoints: vi.fn(),
  pullCheckpoints: vi.fn(),
  listAllRemoteTasks: vi.fn(),
}));

describe('ariadne sync commands', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let previousRegistryPath: string | undefined;
  let previousSyncConfigPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-sync-test-'));
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(root, 'registry.db');
    previousSyncConfigPath = process.env.ARIADNE_SYNC_CONFIG_PATH;
    process.env.ARIADNE_SYNC_CONFIG_PATH = path.join(root, 'sync-config.json');
    closeRegistry();

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    process.env.ARIADNE_SYNC_CONFIG_PATH = previousSyncConfigPath;
    closeRegistry();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((args) => String(args[0]));
  }

  function writeSyncConfig(): void {
    fs.writeFileSync(
      process.env.ARIADNE_SYNC_CONFIG_PATH!,
      JSON.stringify({ serverUrl: 'http://fake-sync-server.test', token: 'fake-token', username: 'tester' }),
      'utf8',
    );
  }

  it('login stores the token/server/username in ~/.ariadne/sync-config.json', async () => {
    vi.mocked(syncClient.login).mockResolvedValue({ token: 'tok-123', userId: 'u1', username: 'alice' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'login', 'alice', 'secret', '--server', 'http://example.test/']);

    expect(syncClient.login).toHaveBeenCalledWith('http://example.test', 'alice', 'secret');
    const config = JSON.parse(fs.readFileSync(process.env.ARIADNE_SYNC_CONFIG_PATH!, 'utf8'));
    expect(config).toMatchObject({ serverUrl: 'http://example.test', token: 'tok-123', username: 'alice' });
  });

  it('register creates the account then logs in', async () => {
    vi.mocked(syncClient.register).mockResolvedValue({ userId: 'u2', username: 'bob' });
    vi.mocked(syncClient.login).mockResolvedValue({ token: 'tok-456', userId: 'u2', username: 'bob' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'register', 'bob', 'secret', '--server', 'http://example.test']);

    expect(syncClient.register).toHaveBeenCalledWith('http://example.test', 'bob', 'secret');
    expect(syncClient.login).toHaveBeenCalledWith('http://example.test', 'bob', 'secret');
  });

  it('push sends new tasks/checkpoints and records the returned remoteId/syncedAt locally', async () => {
    writeSyncConfig();
    vi.mocked(syncClient.pushTasks).mockResolvedValue({
      results: [{ localId: 'placeholder', remoteId: 'remote-task-1', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    vi.mocked(syncClient.pushCheckpoints).mockResolvedValue({
      results: [{ localId: 'placeholder', remoteId: 'remote-ckpt-1' }],
    });

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'A task to sync']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    const checkpoint = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'work done' });
    store.close();

    // Correct the mocked responses' localIds to match the real generated
    // task/checkpoint ids (ulids we don't know ahead of time), then invoke push.
    vi.mocked(syncClient.pushTasks).mockResolvedValue({
      results: [{ localId: task.id, remoteId: 'remote-task-1', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    vi.mocked(syncClient.pushCheckpoints).mockResolvedValue({
      results: [{ localId: checkpoint.id, remoteId: 'remote-ckpt-1' }],
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

    expect(syncClient.pushTasks).toHaveBeenCalledWith(
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([
        expect.objectContaining({ localId: task.id, remoteId: null, title: 'A task to sync', workspaceLabel: expect.any(String) }),
      ]),
    );

    const storeAfter = openWorkspaceStore(root);
    const synced = storeAfter.getTask(task.id)!;
    expect(synced.remoteId).toBe('remote-task-1');
    expect(synced.syncedAt).toBe('2026-01-01T00:00:00.000Z');
    // Checkpoint push only happens once the parent task has a remoteId, so it
    // runs as part of this same `sync push` invocation (task was pushed above).
    expect(syncClient.pushCheckpoints).toHaveBeenCalled();
    const syncedCheckpoint = storeAfter.listCheckpoints(task.id)[0];
    expect(syncedCheckpoint.remoteId).toBe('remote-ckpt-1');
    storeAfter.close();

    expect(loggedLines().some((l) => l.includes('Pushed 1 task'))).toBe(true);
  });

  it('pull applies a remote task update to the matching local task (by remoteId) and logs unknown/unlinked ones as skipped', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Locally known task']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2025-01-01T00:00:00.000Z');
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({
      tasks: [
        {
          remoteId: 'remote-task-1',
          title: 'Renamed by teammate',
          goal: 'new goal',
          status: 'active',
          branch: 'main',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        {
          remoteId: 'remote-task-unknown',
          title: 'A task from a workspace we have never linked',
          goal: null,
          status: 'active',
          branch: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
      serverTime: '2026-02-01T00:00:05.000Z',
    });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({ checkpoints: [], serverTime: '2026-02-01T00:00:05.000Z' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull']);

    const storeAfter = openWorkspaceStore(root);
    const updated = storeAfter.getTask(task.id)!;
    expect(updated.title).toBe('Renamed by teammate');
    expect(updated.goal).toBe('new goal');
    expect(updated.syncedAt).toBe('2026-02-01T00:00:05.000Z');
    storeAfter.close();

    expect(
      loggedLines().some((l) => l.includes('Pulled 1 task update') && l.includes('tasks from other workspaces skipped')),
    ).toBe(true);

    const config = JSON.parse(fs.readFileSync(process.env.ARIADNE_SYNC_CONFIG_PATH!, 'utf8'));
    expect(config.lastTasksPullAt).toBe('2026-02-01T00:00:05.000Z');
  });

  it('pull --import-new creates local tasks for remote tasks never linked here instead of skipping them', async () => {
    writeSyncConfig();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({
      tasks: [
        {
          remoteId: 'remote-task-new',
          title: "Teammate's task",
          goal: 'shipped from another machine',
          status: 'active',
          branch: 'feature/y',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
      serverTime: '2026-02-01T00:00:05.000Z',
    });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({
      checkpoints: [{ remoteId: 'remote-ckpt-imported', level: 'micro', summary: 'a checkpoint from the teammate', createdAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:06.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull', '--import-new']);

    const storeAfter = openWorkspaceStore(root);
    const imported = storeAfter.getTaskByRemoteId('remote-task-new');
    expect(imported).toBeTruthy();
    expect(imported!.title).toBe("Teammate's task");
    expect(imported!.goal).toBe('shipped from another machine');
    expect(imported!.branch).toBe('feature/y');
    expect(imported!.syncedAt).toBe('2026-02-01T00:00:05.000Z');
    // Checkpoints for the newly-imported task should also get pulled in the same run.
    const checkpoints = storeAfter.listCheckpoints(imported!.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].remoteId).toBe('remote-ckpt-imported');
    storeAfter.close();

    expect(loggedLines().some((l) => l.includes('1 new task(s) imported'))).toBe(true);
  });

  it('pull inserts new remote checkpoints for tasks already linked locally', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with remote checkpoints']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-2', '2025-01-01T00:00:00.000Z');
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({ tasks: [], serverTime: '2026-02-01T00:00:05.000Z' });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({
      checkpoints: [
        { remoteId: 'remote-ckpt-9', level: 'milestone', summary: 'From a teammate machine', createdAt: '2026-02-01T00:00:00.000Z' },
      ],
      serverTime: '2026-02-01T00:00:06.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull']);

    const storeAfter = openWorkspaceStore(root);
    const checkpoints = storeAfter.listCheckpoints(task.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].remoteId).toBe('remote-ckpt-9');
    expect(checkpoints[0].summary).toBe('From a teammate machine');
    storeAfter.close();

    expect(loggedLines().some((l) => l.includes('Pulled 1 new checkpoint'))).toBe(true);
  });

  it('logout clears the stored token', async () => {
    writeSyncConfig();
    await program.parseAsync(['node', 'ariadne', 'sync', 'logout']);
    const config = JSON.parse(fs.readFileSync(process.env.ARIADNE_SYNC_CONFIG_PATH!, 'utf8'));
    expect(config.token).toBe('');
    expect(config.serverUrl).toBe('http://fake-sync-server.test');
  });

  it('list-remote prints every server task including ones never linked locally, with owner + workspace', async () => {
    writeSyncConfig();
    vi.mocked(syncClient.listAllRemoteTasks).mockResolvedValue({
      tasks: [
        {
          remoteId: 'remote-task-1',
          title: 'Linked here',
          goal: null,
          status: 'active',
          branch: null,
          workspaceLabel: 'laptop1:ariadne',
          owner: 'alice',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        {
          remoteId: 'remote-task-unknown',
          title: 'Never touched this workspace',
          goal: null,
          status: 'active',
          branch: null,
          workspaceLabel: 'desktop2:atom',
          owner: 'bob',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'list-remote']);

    expect(syncClient.listAllRemoteTasks).toHaveBeenCalledWith('http://fake-sync-server.test', 'fake-token');
    const lines = loggedLines();
    expect(lines.some((l) => l.includes('Linked here') && l.includes('alice') && l.includes('laptop1:ariadne'))).toBe(true);
    expect(lines.some((l) => l.includes('Never touched this workspace') && l.includes('bob') && l.includes('desktop2:atom'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('2 task(s) total'))).toBe(true);
  });
});
