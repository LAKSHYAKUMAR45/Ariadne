import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore, closeRegistry } from '@ariadne-dev/core';
import * as syncClient from '../src/syncClient.js';
import * as syncTunnel from '../src/syncTunnel.js';
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
  pushFileCapture: vi.fn().mockResolvedValue({ captureId: '', status: 'stored', entryCount: 0 }),
}));

vi.mock('../src/syncTunnel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/syncTunnel.js')>();
  return {
    ...actual,
    ensureConfiguredSyncTunnel: vi.fn().mockImplementation(async (config) => config),
    readProjectSyncConnection: vi.fn().mockReturnValue({
      profile: 'nodem2',
      serverUrl: 'http://127.0.0.1:14300',
      tunnel: {
        sshHost: 'nodem2',
        sshUser: 'root',
        sshHostKey: 'SHA256:5EwJ7UMeWUqsBH7Ws3AoCXT9GAvHw+cI4jbx/hxX6qY',
        remotePort: 4300,
        localPort: 14300,
      },
    }),
    bootstrapSshAccess: vi.fn(),
    ensureSshTunnel: vi.fn(),
    promptHidden: vi.fn().mockResolvedValue('secret'),
    runSyncSetup: vi.fn(),
  };
});

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
    expect(fs.statSync(process.env.ARIADNE_SYNC_CONFIG_PATH!).mode & 0o777).toBe(0o600);
  });

  it('register creates the account then logs in', async () => {
    vi.mocked(syncClient.register).mockResolvedValue({ userId: 'u2', username: 'bob' });
    vi.mocked(syncClient.login).mockResolvedValue({ token: 'tok-456', userId: 'u2', username: 'bob' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'register', 'bob', 'secret', '--server', 'http://example.test']);

    expect(syncClient.register).toHaveBeenCalledWith('http://example.test', 'bob', 'secret');
    expect(syncClient.login).toHaveBeenCalledWith('http://example.test', 'bob', 'secret');
  });

  it('setup bootstraps the nodem2 tunnel, prompts for the account password, registers when requested, and stores tunnel metadata', async () => {
    vi.mocked(syncClient.register).mockResolvedValue({ userId: 'u3', username: 'alice' });
    vi.mocked(syncClient.login).mockResolvedValue({ token: 'tok-setup', userId: 'u3', username: 'alice' });

    await program.parseAsync(['node', 'ariadne', 'sync', 'setup', 'alice', '--register']);

    expect(syncTunnel.readProjectSyncConnection).toHaveBeenCalledWith(root);
    expect(syncTunnel.bootstrapSshAccess).toHaveBeenCalled();
    expect(syncTunnel.ensureSshTunnel).toHaveBeenCalled();
    expect(syncTunnel.promptHidden).toHaveBeenCalledWith('Ariadne password: ');
    expect(syncClient.register).toHaveBeenCalledWith('http://127.0.0.1:14300', 'alice', 'secret');
    expect(syncClient.login).toHaveBeenCalledWith('http://127.0.0.1:14300', 'alice', 'secret');
    expect(readCurrentProfileConfig()).toMatchObject({
      serverUrl: 'http://127.0.0.1:14300',
      username: 'alice',
      token: 'tok-setup',
      tunnel: {
        sshHost: 'nodem2',
        sshUser: 'root',
        sshHostKey: 'SHA256:5EwJ7UMeWUqsBH7Ws3AoCXT9GAvHw+cI4jbx/hxX6qY',
        remotePort: 4300,
        localPort: 14300,
      },
    });
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
    expect(syncTunnel.ensureConfiguredSyncTunnel).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'http://personal.test' }));
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

  it('push also sends pending todos, decisions, errors, open questions, and commands for a linked task', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with sub-entities']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });
    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite' });
    const taskError = store.recordError({ taskId: task.id, message: 'TypeError' });
    const question = store.recordOpenQuestion({ taskId: task.id, text: 'Which DB?' });
    const command = store.recordCommand({ taskId: task.id, cmdRedacted: 'npm test', exitCode: 1, summary: 'failed' });
    store.close();

    vi.mocked(syncClient.pushTodos).mockResolvedValue({
      results: [{ localId: todo.id, remoteId: 'remote-todo-1', updatedAt: '2026-01-01T00:00:01.000Z' }],
    });
    vi.mocked(syncClient.pushDecisions).mockResolvedValue({
      results: [{ localId: decision.id, remoteId: 'remote-dec-1', updatedAt: '2026-01-01T00:00:02.000Z' }],
    });
    vi.mocked(syncClient.pushErrors).mockResolvedValue({
      results: [{ localId: taskError.id, remoteId: 'remote-err-1', updatedAt: '2026-01-01T00:00:03.000Z' }],
    });
    vi.mocked(syncClient.pushOpenQuestions).mockResolvedValue({
      results: [{ localId: question.id, remoteId: 'remote-q-1', updatedAt: '2026-01-01T00:00:04.000Z' }],
    });
    vi.mocked(syncClient.pushCommands).mockResolvedValue({
      results: [{ localId: command.id, remoteId: 'remote-cmd-1', updatedAt: '2026-01-01T00:00:05.000Z' }],
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
      expect.arrayContaining([expect.objectContaining({ localId: decision.id, remoteId: null, remoteTaskId: 'remote-task-1', text: 'Use SQLite' })]),
    );
    expect(syncClient.pushErrors).toHaveBeenCalledWith(
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([expect.objectContaining({ localId: taskError.id, remoteId: null, remoteTaskId: 'remote-task-1', message: 'TypeError' })]),
    );
    expect(syncClient.pushOpenQuestions).toHaveBeenCalledWith(
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([expect.objectContaining({ localId: question.id, remoteId: null, remoteTaskId: 'remote-task-1', text: 'Which DB?' })]),
    );
    expect(syncClient.pushCommands).toHaveBeenCalledWith(
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([expect.objectContaining({ localId: command.id, remoteId: null, remoteTaskId: 'remote-task-1', cmdRedacted: 'npm test' })]),
    );

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getTodo(todo.id)!.remoteId).toBe('remote-todo-1');
    expect(storeAfter.getDecision(decision.id)!.remoteId).toBe('remote-dec-1');
    expect(storeAfter.getDecision(decision.id)!.syncedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(storeAfter.getError(taskError.id)!.remoteId).toBe('remote-err-1');
    expect(storeAfter.getOpenQuestion(question.id)!.remoteId).toBe('remote-q-1');
    expect(storeAfter.getCommand(command.id)!.remoteId).toBe('remote-cmd-1');
    storeAfter.close();

    expect(loggedLines().some((l) => l.includes('Pushed 1 todo'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pushed 1 decision'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pushed 1 error'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pushed 1 open question'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pushed 1 command'))).toBe(true);
  });

  it('push sends a decision supersedes link using the referenced decision remoteId once both rows are linked', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with related decisions']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    const olderDecision = store.recordDecision({ taskId: task.id, text: 'Use SQLite first' });
    const newerDecision = store.recordDecision({
      taskId: task.id,
      text: 'Use Postgres instead',
      supersedesId: olderDecision.id,
    });
    store.close();

    vi.mocked(syncClient.pushDecisions)
      .mockResolvedValueOnce({
        results: [{ localId: olderDecision.id, remoteId: 'remote-dec-older', updatedAt: '2026-01-01T00:00:01.000Z' }],
      })
      .mockResolvedValueOnce({
        results: [{ localId: newerDecision.id, remoteId: 'remote-dec-newer', updatedAt: '2026-01-01T00:00:02.000Z' }],
      });

    await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

    expect(syncClient.pushDecisions).toHaveBeenCalledTimes(2);
    expect(syncClient.pushDecisions).toHaveBeenNthCalledWith(
      1,
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([expect.objectContaining({ localId: olderDecision.id, supersedesId: null })]),
    );
    expect(syncClient.pushDecisions).toHaveBeenNthCalledWith(
      2,
      'http://fake-sync-server.test',
      'fake-token',
      expect.arrayContaining([expect.objectContaining({ localId: newerDecision.id, supersedesId: 'remote-dec-older' })]),
    );
  });

  it('pull applies remote updates for linked todos/decisions/errors/open questions/commands and inserts newly seen rows', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with sub-entities']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });
    store.setTodoRemoteSync(todo.id, 'remote-todo-1', '2026-01-01T00:00:00.000Z');
    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite', rationale: 'simple' });
    store.setDecisionRemoteSync(decision.id, 'remote-dec-1', '2026-01-01T00:00:00.000Z');
    const taskError = store.recordError({ taskId: task.id, message: 'TypeError' });
    store.setErrorRemoteSync(taskError.id, 'remote-err-1', '2026-01-01T00:00:00.000Z');
    const question = store.recordOpenQuestion({ taskId: task.id, text: 'Which DB?' });
    store.setOpenQuestionRemoteSync(question.id, 'remote-q-1', '2026-01-01T00:00:00.000Z');
    const command = store.recordCommand({ taskId: task.id, cmdRedacted: 'npm test', exitCode: 1, summary: 'failed' });
    store.setCommandRemoteSync(command.id, 'remote-cmd-1', '2026-01-01T00:00:00.000Z');
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({ tasks: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({ checkpoints: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullTodos).mockResolvedValue({
      todos: [{ remoteId: 'remote-todo-1', text: 'Write tests', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullDecisions).mockResolvedValue({
      decisions: [
        { remoteId: 'remote-dec-1', text: 'Use Postgres', rationale: 'shared', supersedesId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        { remoteId: 'remote-dec-9', text: 'From teammate', rationale: null, supersedesId: null, createdAt: '2026-01-15T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
      ],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullErrors).mockResolvedValue({
      errors: [
        { remoteId: 'remote-err-1', message: 'ReferenceError', resolved: true, resolution: 'fixed remotely', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        { remoteId: 'remote-err-9', message: 'From teammate', resolved: false, resolution: null, createdAt: '2026-01-15T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
      ],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullOpenQuestions).mockResolvedValue({
      openQuestions: [
        { remoteId: 'remote-q-1', text: 'Which SQL engine?', resolved: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        { remoteId: 'remote-q-9', text: 'From teammate', resolved: false, createdAt: '2026-01-15T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
      ],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullCommands).mockResolvedValue({
      commands: [
        { remoteId: 'remote-cmd-1', cmdRedacted: 'pnpm test', exitCode: 0, summary: 'passed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        { remoteId: 'remote-cmd-9', cmdRedacted: 'pnpm build', exitCode: 0, summary: null, createdAt: '2026-01-15T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
      ],
      serverTime: '2026-02-01T00:00:00.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull']);

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getTodo(todo.id)!.status).toBe('done');
    expect(storeAfter.getDecision(decision.id)).toMatchObject({ text: 'Use Postgres', rationale: 'shared' });
    expect(storeAfter.getError(taskError.id)).toMatchObject({ message: 'ReferenceError', resolved: true, resolution: 'fixed remotely' });
    expect(storeAfter.getOpenQuestion(question.id)).toMatchObject({ text: 'Which SQL engine?', resolved: true });
    expect(storeAfter.getCommand(command.id)).toMatchObject({ cmdRedacted: 'pnpm test', exitCode: 0, summary: 'passed' });
    expect(storeAfter.listDecisions(task.id).some((d) => d.remoteId === 'remote-dec-9' && d.text === 'From teammate')).toBe(true);
    expect(storeAfter.listErrors(task.id).some((e) => e.remoteId === 'remote-err-9' && e.message === 'From teammate')).toBe(true);
    expect(storeAfter.listOpenQuestions(task.id).some((q) => q.remoteId === 'remote-q-9' && q.text === 'From teammate')).toBe(true);
    expect(storeAfter.listCommands(task.id).some((c) => c.remoteId === 'remote-cmd-9' && c.cmdRedacted === 'pnpm build')).toBe(true);
    storeAfter.close();

    expect(loggedLines().some((l) => l.includes('updated 1 existing todo'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pulled 1 new decision') && l.includes('updated 1 existing decision'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pulled 1 new error') && l.includes('updated 1 existing error'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pulled 1 new open question') && l.includes('updated 1 existing open question'))).toBe(true);
    expect(loggedLines().some((l) => l.includes('Pulled 1 new command') && l.includes('updated 1 existing command'))).toBe(true);
  });

  it('pull detects conflicts on decisions/errors/open questions/commands and honors --on-conflict local-wins', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Conflicted sub-entities']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    const decision = store.recordDecision({ taskId: task.id, text: 'Local decision' });
    store.setDecisionRemoteSync(decision.id, 'remote-dec-1', '2026-01-01T00:00:00.000Z');
    const taskError = store.recordError({ taskId: task.id, message: 'Local error' });
    store.setErrorRemoteSync(taskError.id, 'remote-err-1', '2026-01-01T00:00:00.000Z');
    const question = store.recordOpenQuestion({ taskId: task.id, text: 'Local question' });
    store.setOpenQuestionRemoteSync(question.id, 'remote-q-1', '2026-01-01T00:00:00.000Z');
    const command = store.recordCommand({ taskId: task.id, cmdRedacted: 'local cmd', exitCode: 1, summary: 'failed' });
    store.setCommandRemoteSync(command.id, 'remote-cmd-1', '2026-01-01T00:00:00.000Z');
    store.updateDecision(decision.id, { text: 'Locally changed decision' });
    store.updateError(taskError.id, 'Locally changed error');
    store.updateOpenQuestion(question.id, 'Locally changed question');
    store.applyPulledCommand(command.id, {
      cmdRedacted: 'locally changed cmd',
      exitCode: 1,
      summary: 'failed',
      updatedAt: '2026-01-02T00:00:00.000Z',
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({ tasks: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({ checkpoints: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullTodos).mockResolvedValue({ todos: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullDecisions).mockResolvedValue({
      decisions: [{ remoteId: 'remote-dec-1', text: 'Remotely changed decision', rationale: null, supersedesId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullErrors).mockResolvedValue({
      errors: [{ remoteId: 'remote-err-1', message: 'Remotely changed error', resolved: true, resolution: 'fixed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullOpenQuestions).mockResolvedValue({
      openQuestions: [{ remoteId: 'remote-q-1', text: 'Remotely changed question', resolved: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:00.000Z',
    });
    vi.mocked(syncClient.pullCommands).mockResolvedValue({
      commands: [{ remoteId: 'remote-cmd-1', cmdRedacted: 'remotely changed cmd', exitCode: 0, summary: 'passed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
      serverTime: '2026-02-01T00:00:00.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull', '--on-conflict', 'local-wins']);

    const lines = loggedLines();
    expect(lines.some((l) => l.includes('⚠ Conflict on decision'))).toBe(true);
    expect(lines.some((l) => l.includes('⚠ Conflict on error'))).toBe(true);
    expect(lines.some((l) => l.includes('⚠ Conflict on open question'))).toBe(true);
    expect(lines.some((l) => l.includes('⚠ Conflict on command'))).toBe(true);

    const storeAfter = openWorkspaceStore(root);
    expect(storeAfter.getDecision(decision.id)!.text).toBe('Locally changed decision');
    expect(storeAfter.getError(taskError.id)!.message).toBe('Locally changed error');
    expect(storeAfter.getOpenQuestion(question.id)!.text).toBe('Locally changed question');
    expect(storeAfter.getCommand(command.id)!.cmdRedacted).toBe('locally changed cmd');
    storeAfter.close();
  });

  it('pull maps a remote decision supersedesId back to the linked local decision id', async () => {
    writeSyncConfig();

    await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with remote decision chain']);
    const store = openWorkspaceStore(root);
    const [task] = store.listTasks();
    store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
    store.close();

    vi.mocked(syncClient.pullTasks).mockResolvedValue({ tasks: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullCheckpoints).mockResolvedValue({ checkpoints: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullTodos).mockResolvedValue({ todos: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullErrors).mockResolvedValue({ errors: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullOpenQuestions).mockResolvedValue({ openQuestions: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullCommands).mockResolvedValue({ commands: [], serverTime: '2026-02-01T00:00:00.000Z' });
    vi.mocked(syncClient.pullDecisions).mockResolvedValue({
      decisions: [
        { remoteId: 'remote-dec-older', text: 'Use SQLite first', rationale: null, supersedesId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        { remoteId: 'remote-dec-newer', text: 'Use Postgres instead', rationale: 'shared', supersedesId: 'remote-dec-older', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-02-01T00:00:01.000Z' },
      ],
      serverTime: '2026-02-01T00:00:02.000Z',
    });

    await program.parseAsync(['node', 'ariadne', 'sync', 'pull']);

    const storeAfter = openWorkspaceStore(root);
    const decisions = storeAfter.listDecisions(task.id);
    const older = decisions.find((d) => d.remoteId === 'remote-dec-older')!;
    const newer = decisions.find((d) => d.remoteId === 'remote-dec-newer')!;
    expect(newer.supersedesId).toBe(older.id);
    storeAfter.close();
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

  // -------------------------------------------------------------------
  // Task 6 — pending file-capture upload during `sync push`.
  // -------------------------------------------------------------------
  describe('file capture upload', () => {
    const SECRET_CONTENT = 'super-secret-capture-content-marker\n';

    function seedLinkedTaskWithCaptures(count: number): { taskId: string; captureIds: string[] } {
      const store = openWorkspaceStore(root);
      const [task] = store.listTasks();
      store.setTaskRemoteSync(task.id, 'remote-task-1', '2026-01-01T00:00:00.000Z');
      const captureIds: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const capture = store.createTaskFileCapture({
          taskId: task.id,
          trigger: 'explicit',
          entries: [
            {
              path: `src/file-${index}.ts`,
              content: SECRET_CONTENT,
              unifiedDiff: `+${SECRET_CONTENT}`,
              byteLength: Buffer.byteLength(SECRET_CONTENT, 'utf8'),
              contentSha256: 'a'.repeat(64),
            },
          ],
        });
        captureIds.push(capture.id);
      }
      store.close();
      return { taskId: task.id, captureIds };
    }

    function syncedAtFor(captureId: string): string | null {
      const store = openWorkspaceStore(root);
      try {
        const [task] = store.listTasks();
        const capture = store.getTaskFileCaptures(task.id).find((c) => c.id === captureId);
        return capture?.syncedAt ?? null;
      } finally {
        store.close();
      }
    }

    it('uploads pending captures one per request after sub-entity sync and marks them synced', async () => {
      writeSyncConfig();
      await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with captures']);
      const { captureIds } = seedLinkedTaskWithCaptures(2);

      const storeForTodo = openWorkspaceStore(root);
      const [taskRow] = storeForTodo.listTasks();
      const todo = storeForTodo.createTodo({ taskId: taskRow.id, text: 'Write tests' });
      storeForTodo.close();
      vi.mocked(syncClient.pushTodos).mockResolvedValue({
        results: [{ localId: todo.id, remoteId: 'remote-todo-1', updatedAt: '2026-01-01T00:00:01.000Z' }],
      });
      vi.mocked(syncClient.pushFileCapture).mockImplementation(async (_url, _token, _taskId, capture) => ({
        captureId: capture.captureId,
        status: 'stored' as const,
        entryCount: capture.entries.length,
      }));

      await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

      expect(syncClient.pushFileCapture).toHaveBeenCalledTimes(2);
      for (const captureId of captureIds) {
        expect(syncClient.pushFileCapture).toHaveBeenCalledWith(
          'http://fake-sync-server.test',
          'fake-token',
          'remote-task-1',
          expect.objectContaining({
            captureId,
            trigger: 'explicit',
            gitCommitSha: null,
            checkpointId: null,
            entries: [
              expect.objectContaining({
                content: SECRET_CONTENT,
                contentSha256: 'a'.repeat(64),
                byteLength: Buffer.byteLength(SECRET_CONTENT, 'utf8'),
              }),
            ],
          }),
        );
        expect(syncedAtFor(captureId)).not.toBeNull();
      }

      // Captures upload only after the task and its sub-entities are on the server.
      const lastTodoCall = vi.mocked(syncClient.pushTodos).mock.invocationCallOrder.at(-1)!;
      const firstCaptureCall = vi.mocked(syncClient.pushFileCapture).mock.invocationCallOrder[0];
      expect(firstCaptureCall).toBeGreaterThan(lastTodoCall);
      expect(loggedLines().some((l) => l.includes('Uploaded 2 file capture'))).toBe(true);
    });

    it('marks only server-acknowledged capture ids as synced', async () => {
      writeSyncConfig();
      await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with captures']);
      const { captureIds } = seedLinkedTaskWithCaptures(2);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        vi.mocked(syncClient.pushFileCapture).mockImplementation(async (_url, _token, _taskId, capture) => ({
          // The second capture comes back acknowledging a different id.
          captureId: capture.captureId === captureIds[0] ? capture.captureId : 'some-other-capture',
          status: 'stored' as const,
          entryCount: capture.entries.length,
        }));

        await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

        expect(syncedAtFor(captureIds[0])).not.toBeNull();
        expect(syncedAtFor(captureIds[1])).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not acknowledged'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('retries a failed capture upload on the next push', async () => {
      writeSyncConfig();
      await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with captures']);
      const { captureIds } = seedLinkedTaskWithCaptures(1);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const failure = Object.assign(new Error('boom'), {
          name: 'SyncApiError',
          status: 503,
          code: 'capture_storage_conflict',
        });
        vi.mocked(syncClient.pushFileCapture).mockRejectedValueOnce(failure);

        await program.parseAsync(['node', 'ariadne', 'sync', 'push']);
        expect(syncedAtFor(captureIds[0])).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('capture_storage_conflict'));

        vi.mocked(syncClient.pushFileCapture).mockResolvedValue({
          captureId: captureIds[0],
          status: 'stored',
          entryCount: 1,
        });
        await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

        expect(syncClient.pushFileCapture).toHaveBeenCalledTimes(2);
        expect(syncedAtFor(captureIds[0])).not.toBeNull();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('never writes capture content to the console on success or failure', async () => {
      writeSyncConfig();
      await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Task with captures']);
      seedLinkedTaskWithCaptures(2);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        vi.mocked(syncClient.pushFileCapture)
          .mockRejectedValueOnce(
            Object.assign(new Error(`rejected entry containing ${SECRET_CONTENT}`), {
              name: 'SyncApiError',
              status: 400,
              code: 'invalid_capture',
            }),
          )
          .mockImplementation(async (_url, _token, _taskId, capture) => ({
            captureId: capture.captureId,
            status: 'stored' as const,
            entryCount: capture.entries.length,
          }));

        await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

        const written = [
          ...logSpy.mock.calls,
          ...warnSpy.mock.calls,
          ...errorSpy.mock.calls,
        ].map((args) => args.map((arg) => String(arg)).join(' '));
        expect(written.join('\n')).not.toContain('super-secret-capture-content-marker');
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('skips captures for tasks that have no remote id yet', async () => {
      writeSyncConfig();
      await program.parseAsync(['node', 'ariadne', 'task', 'new', 'Unlinked task']);
      const store = openWorkspaceStore(root);
      const [task] = store.listTasks();
      store.createTaskFileCapture({
        taskId: task.id,
        trigger: 'explicit',
        entries: [
          {
            path: 'src/a.ts',
            content: SECRET_CONTENT,
            unifiedDiff: `+${SECRET_CONTENT}`,
            byteLength: Buffer.byteLength(SECRET_CONTENT, 'utf8'),
            contentSha256: 'b'.repeat(64),
          },
        ],
      });
      store.close();
      vi.mocked(syncClient.pushTasks).mockResolvedValue({ results: [] });

      await program.parseAsync(['node', 'ariadne', 'sync', 'push']);

      expect(syncClient.pushFileCapture).not.toHaveBeenCalled();
    });
  });
});
