import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@ariadne-dev/core';
import { TaskStore, closeRegistry, openWorkspaceStore, setCurrentTaskId } from '@ariadne-dev/core';
import { program } from '../src/index.js';

describe('ariadne CLI surface', () => {
  it('registers the expected top-level commands', () => {
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining([
        'task',
        'checkpoint',
        'decision',
        'error',
        'todo',
        'question',
        'exec',
        'status',
        'resume',
        'where',
        'search',
        'capture',
        'git-sync',
        'export',
        'workspace',
        'backup',
        'restore',
        'init',
      ]),
    );
  });

  it('registers workspace subcommands', () => {
    const workspaceCmd = program.commands.find((c) => c.name() === 'workspace')!;
    expect(workspaceCmd.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['list', 'prune', 'forget']),
    );
  });

  it('registers task and todo subcommands', () => {
    const taskCmd = program.commands.find((c) => c.name() === 'task')!;
    expect(taskCmd.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['new', 'list', 'use', 'pause', 'done', 'archive', 'reopen', 'edit']),
    );

    const todoCmd = program.commands.find((c) => c.name() === 'todo')!;
    expect(todoCmd.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['add', 'list', 'done', 'reopen', 'block', 'edit', 'delete']),
    );
  });

  it('registers question subcommands', () => {
    const questionCmd = program.commands.find((c) => c.name() === 'question')!;
    expect(questionCmd.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['add', 'list', 'resolve', 'reopen', 'edit', 'delete']),
    );
  });

  it('registers error subcommands', () => {
    const errorCmd = program.commands.find((c) => c.name() === 'error')!;
    expect(errorCmd.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['add', 'list', 'resolve', 'reopen', 'edit', 'delete']),
    );
  });

  it('registers a decisions (plural) curation command group', () => {
    const decisionsCmd = program.commands.find((c) => c.name() === 'decisions')!;
    expect(decisionsCmd).toBeDefined();
    expect(decisionsCmd.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['list', 'edit', 'delete']),
    );
  });

  it('registers --all-workspaces on task list and search for cross-workspace discovery', () => {
    const taskCmd = program.commands.find((c) => c.name() === 'task')!;
    const taskListCmd = taskCmd.commands.find((c) => c.name() === 'list')!;
    expect(taskListCmd.options.some((o) => o.long === '--all-workspaces')).toBe(true);

    const searchCmd = program.commands.find((c) => c.name() === 'search')!;
    expect(searchCmd.options.some((o) => o.long === '--all-workspaces')).toBe(true);
  });
});

describe('ariadne capture + checkpoint commands', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let previousRegistryPath: string | undefined;

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function initRepo(dir: string): void {
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
  }

  function write(relPath: string, content: string): void {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  function commitAll(message: string, force = false): string {
    git(force ? ['add', '-f', '-A'] : ['add', '-A'], root);
    git(['commit', '-q', '-m', message], root);
    return git(['rev-parse', 'HEAD'], root);
  }

  function resetCommanderOptionState(cmd: import('commander').Command): void {
    (cmd as unknown as { _optionValues: Record<string, unknown> })._optionValues = {};
    (cmd as unknown as { _optionValueSources: Record<string, unknown> })._optionValueSources = {};
    for (const sub of cmd.commands) resetCommanderOptionState(sub);
  }

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((args) => String(args[0]));
  }

  function createCurrentTask(title: string): string {
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title });
    setCurrentTaskId(task.id, root);
    store.close();
    return task.id;
  }

  beforeEach(() => {
    resetCommanderOptionState(program);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-capture-test-'));
    initRepo(root);
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
    vi.restoreAllMocks();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('captures files after a checkpoint is persisted', async () => {
    const taskId = createCurrentTask('Checkpoint capture task');
    write('src/app.ts', 'export const value = 1;\n');
    commitAll('Add app');
    write('src/app.ts', 'export const value = 2;\n');
    let store = openWorkspaceStore(root);
    store.touchFile({ taskId, path: 'src/app.ts', role: 'edited' });
    store.close();

    await program.parseAsync(['node', 'ariadne', 'checkpoint', 'Saved current state', '--level', 'micro']);

    store = openWorkspaceStore(root);
    const checkpoint = store.listCheckpoints(taskId)[0]!;
    const capture = store.getTaskFileCaptures(taskId)[0]!;
    store.close();

    expect(capture.checkpointId).toBe(checkpoint.id);
    expect(capture.entries.map((entry) => entry.path)).toEqual(['src/app.ts']);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Capture ${capture.id}: 1 file(s),`));
  });

  it('does not capture when checkpoint creation fails', async () => {
    const taskId = createCurrentTask('Failing checkpoint task');
    vi.spyOn(TaskStore.prototype, 'createCheckpoint').mockImplementation(() => {
      throw new Error('checkpoint write failed');
    });

    await expect(program.parseAsync(['node', 'ariadne', 'checkpoint', 'Will fail', '--level', 'micro'])).rejects.toThrow(
      'checkpoint write failed',
    );

    const store = openWorkspaceStore(root);
    expect(store.getTaskFileCaptures(taskId)).toEqual([]);
    store.close();
  });

  it('surfaces checkpoint capture and failure-recording errors together without a success-shaped result', async () => {
    const taskId = createCurrentTask('Checkpoint capture failure task');
    const captureFailure = new Error('capture exploded with secret contents');
    const recordFailure = new Error('recordError write failed');
    vi.spyOn(core, 'captureTaskFiles').mockImplementation(() => {
      throw captureFailure;
    });
    vi.spyOn(TaskStore.prototype, 'recordError').mockImplementation(() => {
      throw recordFailure;
    });

    await expect(program.parseAsync(['node', 'ariadne', 'checkpoint', 'Will fail', '--level', 'micro'])).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({
          message: expect.stringContaining('Task file capture failed after checkpoint'),
        });
        expect((error as Error).message).toContain('failed to record the capture failure');
        expect((error as AggregateError).errors).toEqual([captureFailure, recordFailure]);
        expect((error as Error).message).not.toContain('secret contents');
        expect((error as Error).message).not.toContain('recordError write failed');
        return true;
      },
    );

    const store = openWorkspaceStore(root);
    expect(store.listCheckpoints(taskId)).toHaveLength(1);
    expect(store.getTaskFileCaptures(taskId)).toEqual([]);
    expect(store.listErrors(taskId)).toEqual([]);
    store.close();
    expect(loggedLines().some((line) => line.startsWith('Capture '))).toBe(false);
    expect(loggedLines()).not.toContain('No eligible task files captured (0 file(s), 0 byte(s)).');
  });

  it('captures the active task with the explicit capture command', async () => {
    const taskId = createCurrentTask('Explicit capture task');
    write('notes.md', 'first version\n');
    commitAll('Add notes');
    write('notes.md', 'second version\n');
    let store = openWorkspaceStore(root);
    store.touchFile({ taskId, path: 'notes.md', role: 'edited' });
    store.close();

    await program.parseAsync(['node', 'ariadne', 'capture']);

    store = openWorkspaceStore(root);
    const capture = store.getTaskFileCaptures(taskId)[0]!;
    store.close();

    expect(capture.trigger).toBe('explicit');
    expect(capture.entries.map((entry) => entry.path)).toEqual(['notes.md']);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Capture ${capture.id}: 1 file(s),`));
  });

  it('surfaces explicit capture and failure-recording errors together without a success-shaped result', async () => {
    const taskId = createCurrentTask('Explicit capture failure task');
    const captureFailure = new Error('explicit capture exploded with secret payload');
    const recordFailure = new Error('recordError insert failed');
    vi.spyOn(core, 'captureTaskFiles').mockImplementation(() => {
      throw captureFailure;
    });
    vi.spyOn(TaskStore.prototype, 'recordError').mockImplementation(() => {
      throw recordFailure;
    });

    await expect(program.parseAsync(['node', 'ariadne', 'capture'])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as Error).message).toContain('Task file capture failed after explicit capture');
      expect((error as Error).message).toContain('failed to record the capture failure');
      expect((error as AggregateError).errors).toEqual([captureFailure, recordFailure]);
      expect((error as Error).message).not.toContain('secret payload');
      expect((error as Error).message).not.toContain('recordError insert failed');
      return true;
    });

    const store = openWorkspaceStore(root);
    expect(store.getTaskFileCaptures(taskId)).toEqual([]);
    expect(store.listErrors(taskId)).toEqual([]);
    store.close();
    expect(loggedLines().some((line) => line.startsWith('Capture '))).toBe(false);
    expect(loggedLines()).not.toContain('No eligible task files captured (0 file(s), 0 byte(s)).');
  });

  it('prints skipped path reasons without leaking file contents', async () => {
    const taskId = createCurrentTask('Skipped paths task');
    write('keep.ts', 'export const keep = 1;\n');
    write('.env', 'API_KEY=super-secret-value\n');
    commitAll('Track files', true);
    write('keep.ts', 'export const keep = 2;\n');
    write('.env', 'API_KEY=super-secret-value-updated\n');
    let store = openWorkspaceStore(root);
    store.touchFile({ taskId, path: 'keep.ts', role: 'edited' });
    store.touchFile({ taskId, path: '.env', role: 'edited' });
    store.close();

    await program.parseAsync(['node', 'ariadne', 'capture']);

    const output = loggedLines().join('\n');
    expect(output).toContain('Skipped files:');
    expect(output).toContain('.env (always_excluded)');
    expect(output).not.toContain('API_KEY=super-secret-value-updated');
    expect(output).not.toContain('export const keep = 2;');
  });
});
