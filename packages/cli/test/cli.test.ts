import { describe, it, expect } from 'vitest';
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
        'git-sync',
        'export',
      ]),
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
