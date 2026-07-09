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
      expect.arrayContaining(['new', 'list', 'use', 'pause', 'done', 'archive', 'reopen']),
    );

    const todoCmd = program.commands.find((c) => c.name() === 'todo')!;
    expect(todoCmd.commands.map((c) => c.name())).toEqual(expect.arrayContaining(['add', 'list', 'done']));
  });

  it('registers question subcommands', () => {
    const questionCmd = program.commands.find((c) => c.name() === 'question')!;
    expect(questionCmd.commands.map((c) => c.name())).toEqual(expect.arrayContaining(['add', 'list', 'resolve']));
  });

  it('registers error subcommands', () => {
    const errorCmd = program.commands.find((c) => c.name() === 'error')!;
    expect(errorCmd.commands.map((c) => c.name())).toEqual(expect.arrayContaining(['add', 'list', 'resolve']));
  });
});
