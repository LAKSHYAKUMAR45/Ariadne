import { describe, it, expect } from 'vitest';
import { program } from '../src/index.js';

describe('ariadne CLI surface', () => {
  it('registers the expected top-level commands', () => {
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['task', 'checkpoint', 'todo', 'status', 'resume', 'where']));
  });

  it('registers task and todo subcommands', () => {
    const taskCmd = program.commands.find((c) => c.name() === 'task')!;
    expect(taskCmd.commands.map((c) => c.name())).toEqual(expect.arrayContaining(['new', 'list', 'use']));

    const todoCmd = program.commands.find((c) => c.name() === 'todo')!;
    expect(todoCmd.commands.map((c) => c.name())).toEqual(expect.arrayContaining(['add', 'list', 'done']));
  });
});
