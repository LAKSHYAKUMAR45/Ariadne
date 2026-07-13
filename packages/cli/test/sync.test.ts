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
  pushTodos: vi.fn().mockResolvedValue({ results: [] }),
  pullTodos: vi.fn().mockResolvedValue({ todos: [], serverTime: new Date().toISOString() }),
  pushDecisions: vi.fn().mockResolvedValue({ results: [] }),
  pullDecisions: vi.fn().mockResolvedValue({ decisions: [], serverTime: new Date().toISOString() }),
  pushErrors: vi.fn().mockResolvedValue({ results: [] }),
  pullErrors: vi.fn().mockResolvedValue({ errors: [], serverTime: new Date().toISOString() }),
  pushOpenQuestions: vi.fn().mockResolvedValue({ results: [] }),
  pullOpenQuestions: vi.fn().mockResolvedValue({ openQuestions: [], serverTime: new Date().toISOString() }),
  pushCommands: vi.fn().mockResolvedValue({ results: [] }),
  pullCommands: vi.fn().mockResolvedValue({ commands: [], serverTime: new Date().toISOString() }),
}));

describe('ariadne sync commands', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let previousRegistryPath: string | undefined;
  let previousSyncConfigPath: string | undefined;

  /**
   * Commander stores parsed option values on each (sub)command instance
   * and — since `program` is a singleton reused across every test in this
   * file — retains them across separate `parseAsync` calls when a later
   * call omits a flag it previously received (e.g. `--profile`). Reset
   * every subcommand's option values before each test so "omit this flag"
   * assertions aren't polluted by a previous test's explicit flag.
   */
  function resetCommanderOptionState(cmd: import('commander').Command): void {
    (cmd as unknown as { _optionValues: Record<string, unknown> })._optionValues = {};
    (cmd as unknown as { _optionValueSources: Record<string, unknown> })._optionValueSources = {};
    for (const sub of cmd.commands) resetCommanderOptionState(sub);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderOptionState(program);

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

  /** Reads back whatever profile is current on disk — tolerates both the legacy flat shape and the multi-profile shape, since `writeSyncConfig` always writes the latter. */
  function readCurrentProfileConfig(): Record<string, unknown> {
    const raw = JSON.parse(fs.readFileSync(process.env.ARIADNE_SYNC_CONFIG_PATH!, 'utf8'));
    if (raw.profiles) return raw.profiles[raw.currentProfile];
    return raw;
  }

  it('login stores the token/server/username in ~/.ariadne/sync-config.json', async () => {
    vi.mocked(syncClient.login).mockResolvedValue({ token: 'tok-123', userId: 'u1', username: 'alice' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'login', 'alice', 'secret', '--server', 'http://example.test/']);

    expect(syncClient.login).toHaveBeenCalledWith('http://example.test', 'alice', 'secret');
    const config = readCurrentProfileConfig();
    expect(config).toMatchObject({ serverUrl: 'http://example.test', token: 'tok-123', username: 'alice' });
  });

  it('register creates the account then logs in', async () => {
    vi.mocked(syncClient.register).mockResolvedValue({ userId: 'u2', username: 'bob' });
    vi.mocked(syncClient.login).mockResolvedValue({ token: 'tok-456', userId: 'u2', username: 'bob' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'register', 'bob', 'secret', '--server', 'http://example.test']);

    expect(syncClient.register).toHaveBeenCalledWith('http://example.test', 'bob', 'secret');
    expect(syncClient.login).toHaveBeenCalledWith('http://example.test', 'bob', 'secret');
  });

  it('supports multiple named profiles: logging into a second profile does not disturb the first, and push/pull respect --profile', async () => {
    vi.mocked(syncClient.login).mockResolvedValueOnce({ token: 'tok-work', userId: 'u1', username: 'alice' });
    await program.parseAsync(['node', 'ariadne', 'sync', 'login', 'alice', 'secret', '--server', 'http://work.test']);

    vi.mocked(syncClient.login).mockResolvedValueOnce({ token: 'tok-personal', userId: 'u2', username: 'alice2' });
    await program.parseAsync([
      'node', 'ariadne', 'sync', 'login', 'alice2', 'secret', '--server', 'http://personal.test', '--profile', 'personal',
    ]);

    const raw = JSON.parse(fs.readFileSync(process.env.ARIADNE_SYNC_CONFIG_PATH!, 'utf8'));
    expect(raw.profiles.default).toMatchObject({ serverUrl: 'http://work.test', token: 'tok-work' });
    expect(raw.profiles.personal).toMatchObject({ serverUrl: 'http://personal.test', token: 'tok-personal' });
    // Logging into a named profile makes it current.
    expect(raw.currentProfile).toBe('personal');

    // push without --profile uses the (now current) "personal" profile.
    vi.mocked(syncClient.pushTasks).mockResolvedValue({
      results: [{ localId: 'placeholder', remoteId: 'remote-1', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'A task']);
    await program.parseAsync(['node', 'ariadne', 'sync', 'push']);
    expect(syncClient.pushTasks).toHaveBeenCalledWith('http://personal.test', 'tok-personal', expect.anything());

    // --profile default explicitly targets the other profile without switching current.
    vi.mocked(syncClient.pullTasks).mockResolvedValue({ tasks: [], serverTime: '2026-02-01T00:00:00.000Z' });
    await program.parseAsync(['node', 'ariadne', 'sync', 'pull', '--profile', 'default']);
    expect(syncClient.pullTasks).toHaveBeenCalledWith('http://work.test', 'tok-work', { since: undefined, offset: 0 });

    const rawAfter = JSON.parse(fs.readFileSync(process.env.ARIADNE_SYNC_CONFIG_PATH!, 'utf8'));
    expect(rawAfter.currentProfile).toBe('personal'); // unaffected by the explicit --profile pull above
  });

  it('sync profile list shows every configured profile and flags the current one', async () => {
    vi.mocked(syncClient.login).mockResolvedValueOnce({ token: 'tok-a', userId: 'u1', username: 'alice' });
    await program.parseAsync(['node', 'ariadne', 'sync', 'login', 'alice', 'secret', '--server', 'http://a.test']);
    vi.mocked(syncClient.login).mockResolvedValueOnce({ token: 'tok-b', userId: 'u2', username: 'bob' });
    await program.parseAsync(['node', 'ariadne', 'sync', 'login', 'bob', 'secret', '--server', 'http://b.test', '--profile', 'team-b']);

    await program.parseAsync(['node', 'ariadne', 'sync', 'profile', 'list']);

    const lines = loggedLines();
    expect(lines.some((l) => l.includes('default') && l.includes('http://a.test'))).toBe(true);
    expect(lines.some((l) => l.includes('*') && l.includes('team-b') && l.includes('http://b.test'))).toBe(true);
  });

  it('sync profile use switches the current profile, and errors for an unknown name', async () => {
    vi.mocked(syncClient.login).mockResolvedValue({ token: 'tok-a', userId: 'u1', username: 'alice' });
    await program.parseAsync(['node', 'ariadne', 'sync', 'login', 'alice', 'secret', '--server', 'http://a.test']);

    await program.parseAsync(['node', 'ariadne', 'sync', 'profile', 'use', 'default']);
    expect(loggedLines().some((l) => l.includes('Current sync profile is now "default"'))).toBe(true);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    try {
      await expect(program.parseAsync(['node', 'ariadne', 'sync', 'profile', 'use', 'nonexistent'])).rejects.toThrow(
        'process.exit:1',
      );
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No sync profile named "nonexistent"'));
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
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

  it('push also sends pending todos (bidirectional) and decisions (create-once) for a linked task', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with sub-entities']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });
    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite' });
    store.close();

    vi.mocked(syncClient.pushTodos).mockResolvedValue({
      results: [{ localId: todo.id, remoteId: 'remote-todo-1', updatedAt: '2026-01-01T00:00:01.000Z' }],
    });
    vi.mocked(syncClient.pushDecisions).mockResolvedValue({
      results: [{ localId: decision.id, remoteId: 'remote-dec-1' }],
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

    expect(syncClient.pushTodos).toHaveBeenCalledWith(
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([expect.objectContaining({ localId: todo.id, remoteId: null, remoteTaskId: 'remote-task-1', text: 'Write tests' })]),
    );
    expect(syncClient.pushDecisions).toHaveBeenCalledWith(
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([expect.objectContaining({ localId: decision.id, remoteTaskId: 'remote-task-1', text: 'Use SQLite' })]),
    );

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getTodo(todo.id)!.remoteId).toBe('remote-todo-1');
    expect(storeAfter.getDecision(decision.id)!.remoteId).toBe('remote-dec-1');
    storeAfter.close();

    expect(loggedLines().some((l) => l.includes('Pushed 1 todo'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pushed 1 decision'))).toBe(true);
  });

  it('pull applies remote todo updates (bidirectional) and inserts new create-once sub-entities for a linked task', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with sub-entities']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });
    store.setTodoRemoteSync(todo.id, 'remote-todo-1', '2026-01-01T00:00:00.000Z');
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({ tasks: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({ checkpoints: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullTodos).mockResolvedValue({
      todos: [{ remoteId: 'remote-todo-1', text: 'Write tests', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullDecisions).mockResolvedValue({
      decisions: [{ remoteId: 'remote-dec-9', text: 'From teammate', rationale: null, createdAt: '2026-01-15T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:00.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull']);

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getTodo(todo.id)!.status).toBe('done');
    const decisions = storeAfter.listDecisions(task.id);
    expect(decisions.some((d) => d.remoteId === 'remote-dec-9' && d.text === 'From teammate')).toBe(true);
    storeAfter.close();

    expect(loggedLines().some((l) => l.includes('updated 1 existing todo'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pulled 1 new decision'))).toBe(true);
  });

  it('pull detects a task conflict (changed both locally and remotely) and reports it, defaulting to remote-wins', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Conflicted task']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    // Task was synced at T0, then edited locally after (title changed, updatedAt > syncedAt).
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    store.updateTaskTitle(task.id, 'Locally renamed');
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({
      tasks: [
        {
          remoteId: 'remote-task-1',
          title: 'Remotely renamed',
          goal: null,
          status: 'active',
          branch: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      serverTime: '2026-01-02T00:00:05.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull']);

    const lines = loggedLines();
    expect(lines.some((l) => l.includes('⚠ Conflict on task') && l.includes('title'))).toBe(true);
    expect(lines.some((l) => l.includes('1 conflict(s), resolved via remote-wins'))).toBe(true);

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getTask(task.id)!.title).toBe('Remotely renamed'); // remote-wins applied
    storeAfter.close();
  });

  it('pull --on-conflict local-wins keeps the local version of a conflicted task instead of applying the remote one', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Conflicted task']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    store.updateTaskTitle(task.id, 'Locally renamed');
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({
      tasks: [
        {
          remoteId: 'remote-task-1',
          title: 'Remotely renamed',
          goal: null,
          status: 'active',
          branch: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      serverTime: '2026-01-02T00:00:05.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull', '--on-conflict', 'local-wins']);

    const lines = loggedLines();
    expect(lines.some((l) => l.includes('resolved via local-wins'))).toBe(true);

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getTask(task.id)!.title).toBe('Locally renamed'); // local version kept
    storeAfter.close();
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

    const config = readCurrentProfileConfig();
    expect(config.lastTasksPullAt).toBe('2026-02-01T00:00:05.000Z');
  });

  it('pull transparently pages through the incremental feed until hasMore is false', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task A']);
    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task B']);
    const store = openWorkspaceStore(root);
    const [taskB, taskA] = store.listTasks(); // most recently created first
    store.setTaskRemoteSync(taskA.id, 'remote-a', '2025-01-01T00:00:00.000Z');
    store.setTaskRemoteSync(taskB.id, 'remote-b', '2025-01-01T00:00:00.000Z');
    store.close();

    const remoteTask = (remoteId: string, title: string) => ({
      remoteId,
      title,
      goal: null,
      status: 'active' as const,
      branch: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });

    vi.mocked(syncClient.pullTasks)
      .mockResolvedValueOnce({
        tasks: [remoteTask('remote-a', 'A updated (page 1)')],
        serverTime: '2026-02-01T00:00:01.000Z',
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        tasks: [remoteTask('remote-b', 'B updated (page 2)')],
        serverTime: '2026-02-01T00:00:02.000Z',
        hasMore: false,
        nextOffset: null,
      });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({ checkpoints: [], serverTime: '2026-02-01T00:00:02.000Z' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull']);

    expect(syncClient.pullTasks).toHaveBeenCalledTimes(2);
    expect(syncClient.pullTasks).toHaveBeenNthCalledWith(1, 'http://fake-sync-server.test', 'fake-token', { since: undefined, offset: 0 });
    expect(syncClient.pullTasks).toHaveBeenNthCalledWith(2, 'http://fake-sync-server.test', 'fake-token', { since: undefined, offset: 1 });

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getTask(taskA.id)!.title).toBe('A updated (page 1)');
    expect(storeAfter.getTask(taskB.id)!.title).toBe('B updated (page 2)');
    storeAfter.close();

    // The cursor advances to the LAST page's serverTime, not the first.
    const config = readCurrentProfileConfig();
    expect(config.lastTasksPullAt).toBe('2026-02-01T00:00:02.000Z');
  });

  it('pull --import-new creates local tasks for remote tasks never linked here instead of skipping them', async () => {
    writeSyncConfig();

    // pullTasks (the incremental feed) returns nothing new — this simulates
    // the realistic case the since-cursor bug fix targets: a task that was
    // already "seen" (and previously skipped) by an earlier incremental
    // pull, so it would no longer appear here. --import-new must still find
    // it via the separate browse-all endpoint below, not this feed.
    vi.mocked(syncClient.pullTasks).mockResolvedValue({ tasks: [], serverTime: '2026-02-01T00:00:05.000Z' });
    vi.mocked(syncClient.listAllRemoteTasks).mockResolvedValue({
      tasks: [
        {
          remoteId: 'remote-task-new',
          title: "Teammate's task",
          goal: 'shipped from another machine',
          status: 'active',
          branch: 'feature/y',
          workspaceLabel: 'desktop2:org/atom',
          owner: 'teammate',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({
      checkpoints: [{ remoteId: 'remote-ckpt-imported', level: 'micro', summary: 'a checkpoint from the teammate', createdAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:06.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull', '--import-new']);

    expect(syncClient.listAllRemoteTasks).toHaveBeenCalledWith('http://fake-sync-server.test', 'fake-token', { offset: 0 });
    const storeAfter = openWorkspaceStore(root);
    const imported = storeAfter.getTaskByRemoteId('remote-task-new');
    expect(imported).toBeTruthy();
    expect(imported!.title).toBe("Teammate's task");
    expect(imported!.goal).toBe('shipped from another machine');
    expect(imported!.branch).toBe('feature/y');
    expect(imported!.syncedAt).toBeTruthy();
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
    const config = readCurrentProfileConfig();
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

    expect(syncClient.listAllRemoteTasks).toHaveBeenCalledWith('http://fake-sync-server.test', 'fake-token', { offset: 0 });
    const lines = loggedLines();
    expect(lines.some((l) => l.includes('Linked here') && l.includes('alice') && l.includes('laptop1:ariadne'))).toBe(true);
    expect(lines.some((l) => l.includes('Never touched this workspace') && l.includes('bob') && l.includes('desktop2:atom'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('2 task(s) total'))).toBe(true);
  });

  it('list-remote transparently pages through the server browse endpoint until hasMore is false', async () => {
    writeSyncConfig();
    const remoteTask = (remoteId: string, title: string) => ({
      remoteId,
      title,
      goal: null,
      status: 'active' as const,
      branch: null,
      workspaceLabel: 'laptop1:ariadne',
      owner: 'alice',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.listAllRemoteTasks)
      .mockResolvedValueOnce({ tasks: [remoteTask('remote-1', 'Page 1 task')], hasMore: true, nextOffset: 1 })
      .mockResolvedValueOnce({ tasks: [remoteTask('remote-2', 'Page 2 task')], hasMore: false, nextOffset: null });

    await program.parseAsync(['node', 'ariadne', 'sync', 'list-remote']);

    expect(syncClient.listAllRemoteTasks).toHaveBeenCalledTimes(2);
    expect(syncClient.listAllRemoteTasks).toHaveBeenNthCalledWith(1, 'http://fake-sync-server.test', 'fake-token', { offset: 0 });
    expect(syncClient.listAllRemoteTasks).toHaveBeenNthCalledWith(2, 'http://fake-sync-server.test', 'fake-token', { offset: 1 });
    const lines = loggedLines();
    expect(lines.some((l) => l.includes('Page 1 task'))).toBe(true);
    expect(lines.some((l) => l.includes('Page 2 task'))).toBe(true);
    expect(lines.some((l) => l.includes('2 task(s) total'))).toBe(true);
  });

  it('unlink clears a task\'s remoteId/syncedAt locally without contacting the server', async () => {
    writeSyncConfig();
    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'A task to unlink']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-9', '2026-01-01T00:00:00.000Z');
    store.close();

    await program.parseAsync(['node', 'ariadne', 'sync', 'unlink', task.id]);

    const storeAfter = openWorkspaceStore(root);
    const after = storeAfter.getTask(task.id)!;
    expect(after.remoteId).toBeNull();
    expect(after.syncedAt).toBeNull();
    storeAfter.close();
    expect(loggedLines().some((l) => l.includes('Unlinked task') && l.includes('remote-task-9'))).toBe(true);
  });

  it('unlink is a no-op (with a message) for a task that was never linked', async () => {
    writeSyncConfig();
    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Never linked']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.close();

    await program.parseAsync(['node', 'ariadne', 'sync', 'unlink', task.id]);

    expect(loggedLines().some((l) => l.includes('not linked') && l.includes('nothing to do'))).toBe(true);
  });
});
