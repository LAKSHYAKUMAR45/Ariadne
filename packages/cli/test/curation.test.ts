import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore, setCurrentTaskId, closeRegistry } from '@ariadne-dev/core';
import { program } from '../src/index.js';

// Functional coverage for the CLI's curation command groups (todo, decision,
// error, question) plus checkpoint/export — previously only their *shape*
// (command/subcommand registration) was tested in cli.test.ts, not that the
// commander action handlers actually call into TaskStore and produce the
// expected output. Follows the same convention as status.test.ts: parse argv
// through the real `program` against a temp workspace.
describe('ariadne curation commands (todo/decision/error/question/checkpoint/export)', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let previousRegistryPath: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-curation-test-'));
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

  function setCurrentTask(title: string): string {
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title });
    setCurrentTaskId(task.id, root);
    store.close();
    return task.id;
  }

  it('decisions edit rejects a call with neither --text nor --rationale', async () => {
    // Regression note: this must run before any other test invokes
    // `decisions edit ... --text`, because commander's Command instance is a
    // process-wide singleton (imported once from ../src/index.js) and option
    // values persist across parseAsync calls on the same subcommand object —
    // a later invocation without --text would otherwise silently inherit a
    // stale value from an earlier one and skip this guard entirely.
    setCurrentTask('Decision guard task');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['node', 'ariadne', 'decisions', 'edit', 'some-id']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Nothing to edit'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('todo add/list/done/reopen/block/edit/delete round-trip against the current task', async () => {
    setCurrentTask('Todo task');

    await program.parseAsync(['node', 'ariadne', 'todo', 'add', 'Write tests']);
    const addedLine = loggedLines().find((l) => l.startsWith('Added todo'))!;
    const todoId = addedLine.match(/Added todo (\S+):/)![1];

    await program.parseAsync(['node', 'ariadne', 'todo', 'list']);
    expect(loggedLines()).toContainEqual(expect.stringContaining('Write tests'));

    await program.parseAsync(['node', 'ariadne', 'todo', 'edit', todoId, '--text', 'Write more tests']);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Todo ${todoId} updated.`));

    await program.parseAsync(['node', 'ariadne', 'todo', 'done', todoId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Marked todo ${todoId} done.`));

    await program.parseAsync(['node', 'ariadne', 'todo', 'block', todoId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Marked todo ${todoId} blocked.`));

    await program.parseAsync(['node', 'ariadne', 'todo', 'reopen', todoId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Reopened todo ${todoId} (set to pending).`));

    await program.parseAsync(['node', 'ariadne', 'todo', 'delete', todoId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Todo ${todoId} deleted.`));

    await program.parseAsync(['node', 'ariadne', 'todo', 'list']);
    expect(loggedLines()).toContainEqual('No todos found.');
  });

  it('decision add/decisions list/edit/delete round-trip against the current task', async () => {
    setCurrentTask('Decision task');

    await program.parseAsync(['node', 'ariadne', 'decision', 'Use SQLite', '--rationale', 'Simplicity']);
    const addedLine = loggedLines().find((l) => l.startsWith('Recorded decision'))!;
    const decisionId = addedLine.match(/Recorded decision (\S+):/)![1];

    await program.parseAsync(['node', 'ariadne', 'decisions', 'list']);
    expect(loggedLines()).toContainEqual(expect.stringContaining('Use SQLite'));

    await program.parseAsync([
      'node',
      'ariadne',
      'decisions',
      'edit',
      decisionId,
      '--text',
      'Use SQLite with WAL',
    ]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Decision ${decisionId} updated.`));

    await program.parseAsync(['node', 'ariadne', 'decisions', 'delete', decisionId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Decision ${decisionId} deleted.`));

    await program.parseAsync(['node', 'ariadne', 'decisions', 'list']);
    expect(loggedLines()).toContainEqual('No decisions found.');
  });

  it('error add/list/resolve/reopen/edit/delete round-trip against the current task', async () => {
    setCurrentTask('Error task');

    await program.parseAsync(['node', 'ariadne', 'error', 'add', 'Build broke']);
    const addedLine = loggedLines().find((l) => l.startsWith('Recorded error'))!;
    const errorId = addedLine.match(/Recorded error (\S+)\./)![1];

    await program.parseAsync(['node', 'ariadne', 'error', 'list']);
    expect(loggedLines()).toContainEqual(expect.stringContaining('Build broke'));
    expect(loggedLines()).toContainEqual(expect.stringContaining('[open]'));

    await program.parseAsync(['node', 'ariadne', 'error', 'edit', errorId, '--message', 'Build broke on CI']);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Error ${errorId} updated.`));

    await program.parseAsync(['node', 'ariadne', 'error', 'resolve', errorId, '--resolution', 'Fixed lockfile']);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Marked error ${errorId} resolved.`));

    // Resolved errors are excluded from the default (unresolved-only) list.
    await program.parseAsync(['node', 'ariadne', 'error', 'list']);
    expect(loggedLines()).toContainEqual('No errors found.');

    await program.parseAsync(['node', 'ariadne', 'error', 'list', '--all']);
    expect(loggedLines()).toContainEqual(expect.stringContaining('[resolved]'));

    await program.parseAsync(['node', 'ariadne', 'error', 'reopen', errorId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Reopened error ${errorId}.`));

    await program.parseAsync(['node', 'ariadne', 'error', 'delete', errorId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Error ${errorId} deleted.`));
  });

  it('question add/list/resolve/reopen/edit/delete round-trip against the current task', async () => {
    setCurrentTask('Question task');

    await program.parseAsync(['node', 'ariadne', 'question', 'add', 'Which IPC transport?']);
    const addedLine = loggedLines().find((l) => l.startsWith('Added open question'))!;
    const questionId = addedLine.match(/Added open question (\S+):/)![1];

    await program.parseAsync(['node', 'ariadne', 'question', 'list']);
    expect(loggedLines()).toContainEqual(expect.stringContaining('Which IPC transport?'));

    await program.parseAsync([
      'node',
      'ariadne',
      'question',
      'edit',
      questionId,
      '--text',
      'Which IPC transport did we pick?',
    ]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Question ${questionId} updated.`));

    await program.parseAsync(['node', 'ariadne', 'question', 'resolve', questionId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Marked question ${questionId} resolved.`));

    // Resolved questions are excluded from the default (unresolved-only) list.
    await program.parseAsync(['node', 'ariadne', 'question', 'list']);
    expect(loggedLines()).toContainEqual('No open questions found.');

    await program.parseAsync(['node', 'ariadne', 'question', 'list', '--all']);
    expect(loggedLines()).toContainEqual(expect.stringContaining('[resolved]'));

    await program.parseAsync(['node', 'ariadne', 'question', 'reopen', questionId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Reopened question ${questionId}.`));

    await program.parseAsync(['node', 'ariadne', 'question', 'delete', questionId]);
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Question ${questionId} deleted.`));
  });

  it('checkpoint records a checkpoint at the given level for the current task', async () => {
    setCurrentTask('Checkpoint task');

    await program.parseAsync(['node', 'ariadne', 'checkpoint', 'Finished the schema', '--level', 'session']);

    expect(loggedLines()).toContainEqual(expect.stringContaining('Recorded session checkpoint'));
  });

  it('export writes a Markdown file for the current task to the default .ariadne/export path', async () => {
    const taskId = setCurrentTask('Export task');
    await program.parseAsync(['node', 'ariadne', 'decision', 'Ship it']);

    await program.parseAsync(['node', 'ariadne', 'export']);

    const expectedPath = path.join(root, '.ariadne', 'export', `${taskId}.md`);
    expect(fs.existsSync(expectedPath)).toBe(true);
    const markdown = fs.readFileSync(expectedPath, 'utf8');
    expect(markdown).toContain('Export task');
    expect(loggedLines()).toContainEqual(expect.stringContaining(`Exported task ${taskId} to ${expectedPath}`));
  });

  it('export honors --out to write to a custom path', async () => {
    setCurrentTask('Custom export task');
    const outPath = path.join(root, 'custom-export.md');

    await program.parseAsync(['node', 'ariadne', 'export', '--out', outPath]);

    expect(fs.existsSync(outPath)).toBe(true);
  });
});
