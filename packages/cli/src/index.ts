#!/usr/bin/env node
import { Command } from 'commander';
import type { TaskStore, TodoStatus } from '@ariadne/core';
import { openWorkspaceStore, findWorkspaceRoot } from './workspace.js';
import { readCurrentTaskId, setCurrentTaskId } from './currentTask.js';

const program = new Command();
program.name('ariadne').description('Chats are disposable, tasks are permanent.').version('0.1.0');

/** Resolves which task id to operate on: explicit --task flag wins, else the workspace's current task. */
function resolveTaskId(store: TaskStore, explicitId: string | undefined): string {
  const id = explicitId ?? readCurrentTaskId();
  if (!id) {
    console.error('No task specified and no current task set. Run "ariadne task new <title>" first, or pass --task <id>.');
    process.exit(1);
  }
  const task = store.getTask(id);
  if (!task) {
    console.error(`No task found with id "${id}".`);
    process.exit(1);
  }
  return id;
}

function withStore<T>(fn: (store: TaskStore) => T): T {
  const store = openWorkspaceStore();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------
// task
// ---------------------------------------------------------------------

const task = program.command('task').description('Manage tasks');

task
  .command('new <title>')
  .description('Create a new task and mark it current')
  .option('-g, --goal <goal>', 'Goal / intent for this task')
  .action((title: string, opts: { goal?: string }) => {
    withStore((store) => {
      const created = store.createTask({ title, goal: opts.goal });
      setCurrentTaskId(created.id);
      console.log(`Created task ${created.id}: ${created.title}`);
    });
  });

task
  .command('list')
  .description('List tasks')
  .option('-s, --status <status>', 'Filter by status (active|paused|done|archived)')
  .action((opts: { status?: 'active' | 'paused' | 'done' | 'archived' }) => {
    withStore((store) => {
      const tasks = store.listTasks(opts.status ? { status: opts.status } : undefined);
      if (tasks.length === 0) {
        console.log('No tasks found.');
        return;
      }
      const current = readCurrentTaskId();
      for (const t of tasks) {
        const marker = t.id === current ? '*' : ' ';
        console.log(`${marker} [${t.status}] ${t.id}  ${t.title}`);
      }
    });
  });

task
  .command('use <id>')
  .description('Set the current task (used by other commands when --task is omitted)')
  .action((id: string) => {
    withStore((store) => {
      resolveTaskId(store, id);
      setCurrentTaskId(id);
      console.log(`Current task set to ${id}.`);
    });
  });

// ---------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------

program
  .command('checkpoint <summary>')
  .description('Record a checkpoint for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-l, --level <level>', 'micro|session|milestone', 'micro')
  .action((summary: string, opts: { task?: string; level: 'micro' | 'session' | 'milestone' }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      const cp = store.createCheckpoint({ taskId, level: opts.level, summary });
      console.log(`Recorded ${cp.level} checkpoint ${cp.id}.`);
    });
  });

// ---------------------------------------------------------------------
// todo
// ---------------------------------------------------------------------

const todo = program.command('todo').description('Manage todos');

todo
  .command('add <text>')
  .description('Add a todo to the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .action((text: string, opts: { task?: string }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      const created = store.createTodo({ taskId, text });
      console.log(`Added todo ${created.id}: ${created.text}`);
    });
  });

todo
  .command('list')
  .description('List todos for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-s, --status <status>', 'Filter by status (pending|done|blocked)')
  .action((opts: { task?: string; status?: TodoStatus }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      const todos = store.listTodos(taskId, opts.status ? { status: opts.status } : undefined);
      if (todos.length === 0) {
        console.log('No todos found.');
        return;
      }
      for (const t of todos) {
        console.log(`[${t.status}] ${t.id}  ${t.text}`);
      }
    });
  });

todo
  .command('done <id>')
  .description('Mark a todo as done')
  .action((id: string) => {
    withStore((store) => {
      store.updateTodoStatus(id, 'done');
      console.log(`Marked todo ${id} done.`);
    });
  });

// ---------------------------------------------------------------------
// status / resume
// ---------------------------------------------------------------------

function printStatus(store: TaskStore, taskId: string): void {
  const t = store.getTask(taskId)!;
  console.log(`Task: ${t.title}  (${t.status})`);
  if (t.goal) console.log(`Goal: ${t.goal}`);

  const latest = store.latestCheckpoint(taskId);
  if (latest) {
    console.log(`\nLatest checkpoint (${latest.level}, ${latest.createdAt}):`);
    console.log(`  ${latest.summary}`);
  }

  const openQuestions = store.listOpenQuestions(taskId, { resolved: false });
  if (openQuestions.length > 0) {
    console.log(`\nOpen questions:`);
    for (const q of openQuestions) console.log(`  - ${q.text}`);
  }

  const unresolvedErrors = store.listErrors(taskId, { resolved: false });
  if (unresolvedErrors.length > 0) {
    console.log(`\nUnresolved errors:`);
    for (const e of unresolvedErrors) console.log(`  - ${e.message}`);
  }

  const pendingTodos = store.listTodos(taskId, { status: 'pending' });
  if (pendingTodos.length > 0) {
    console.log(`\nPending todos:`);
    for (const td of pendingTodos) console.log(`  - [${td.id}] ${td.text}`);
  }

  const recentFiles = store.listFiles(taskId, 10);
  if (recentFiles.length > 0) {
    console.log(`\nRecently touched files:`);
    for (const f of recentFiles) console.log(`  - (${f.role}) ${f.path}`);
  }

  const recentCommits = store.listCommits(taskId, 5);
  if (recentCommits.length > 0) {
    console.log(`\nRecent commits:`);
    for (const c of recentCommits) console.log(`  - ${c.sha.slice(0, 7)} ${c.message ?? ''}`);
  }
}

program
  .command('status')
  .description('Show a summary of the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .action((opts: { task?: string }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      printStatus(store, taskId);
    });
  });

program
  .command('resume')
  .description('Alias of "status" — reload context for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .action((opts: { task?: string }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      printStatus(store, taskId);
    });
  });

program
  .command('where')
  .description('Print the resolved workspace root and state db path')
  .action(() => {
    console.log(findWorkspaceRoot());
  });

export { program };

if (require.main === module) {
  program.parse(process.argv);
}
