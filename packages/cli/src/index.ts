#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskStore, TodoStatus } from '@ariadne/core';
import { buildContext, syncTaskGit, exportTaskMarkdown } from '@ariadne/core';
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
// question
// ---------------------------------------------------------------------

const question = program.command('question').description('Manage open questions');

question
  .command('add <text>')
  .description('Add an open question to the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .action((text: string, opts: { task?: string }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      const created = store.recordOpenQuestion({ taskId, text });
      console.log(`Added open question ${created.id}: ${created.text}`);
    });
  });

question
  .command('list')
  .description('List open questions for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-a, --all', 'Include resolved questions (default: unresolved only)')
  .action((opts: { task?: string; all?: boolean }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      const questions = store.listOpenQuestions(taskId, opts.all ? undefined : { resolved: false });
      if (questions.length === 0) {
        console.log('No open questions found.');
        return;
      }
      for (const q of questions) {
        console.log(`[${q.resolved ? 'resolved' : 'open'}] ${q.id}  ${q.text}`);
      }
    });
  });

question
  .command('resolve <id>')
  .description('Mark an open question as resolved')
  .action((id: string) => {
    withStore((store) => {
      store.resolveOpenQuestion(id);
      console.log(`Marked question ${id} resolved.`);
    });
  });

// ---------------------------------------------------------------------
// status / resume
// ---------------------------------------------------------------------

function printStatus(store: TaskStore, taskId: string, tokenBudget?: number): void {
  const t = store.getTask(taskId)!;
  console.log(`Task: ${t.title}  (${t.status})`);

  const ctx = buildContext(store, taskId, tokenBudget ? { tokenBudget } : undefined);

  if (ctx.goal) console.log(`Goal: ${ctx.goal}`);

  if (ctx.latestSummary) {
    console.log(`\nLatest checkpoint:`);
    console.log(`  ${ctx.latestSummary}`);
  }

  if (ctx.openQuestions.length > 0) {
    console.log(`\nOpen questions:`);
    for (const q of ctx.openQuestions) console.log(`  - ${q}`);
  }

  if (ctx.unresolvedErrors.length > 0) {
    console.log(`\nUnresolved errors:`);
    for (const e of ctx.unresolvedErrors) console.log(`  - ${e}`);
  }

  if (ctx.decisions.length > 0) {
    console.log(`\nDecisions:`);
    for (const d of ctx.decisions) console.log(`  - ${d}`);
  }

  if (ctx.openTodos.length > 0) {
    console.log(`\nPending todos:`);
    for (const td of ctx.openTodos) console.log(`  - ${td}`);
  }

  if (ctx.recentFiles.length > 0) {
    console.log(`\nRecently touched files:`);
    for (const f of ctx.recentFiles) console.log(`  - (${f.role}) ${f.path}`);
  }

  if (ctx.recentCommits.length > 0) {
    console.log(`\nRecent commits:`);
    for (const c of ctx.recentCommits) console.log(`  - ${c.sha.slice(0, 7)} ${c.message ?? ''}`);
  }

  const truncatedEntries = Object.entries(ctx.truncated);
  if (truncatedEntries.length > 0) {
    const summary = truncatedEntries.map(([category, count]) => `${count} ${category}`).join(', ');
    console.log(`\n(Trimmed to fit token budget — omitted: ${summary}. Use --budget to raise the limit.)`);
  }
}

program
  .command('status')
  .description('Show a ranked, token-budgeted summary of the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-b, --budget <tokens>', 'Token budget for context ranking (default: 2000)', (v) => parseInt(v, 10))
  .action((opts: { task?: string; budget?: number }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      printStatus(store, taskId, opts.budget);
    });
  });

program
  .command('resume')
  .description('Alias of "status" — reload context for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-b, --budget <tokens>', 'Token budget for context ranking (default: 2000)', (v) => parseInt(v, 10))
  .action((opts: { task?: string; budget?: number }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      printStatus(store, taskId, opts.budget);
    });
  });

program
  .command('where')
  .description('Print the resolved workspace root and state db path')
  .action(() => {
    console.log(findWorkspaceRoot());
  });

program
  .command('git-sync')
  .description('Sync the current git branch and any new commits into the current (or --task) task — for CLI-only workflows without VS Code')
  .option('-t, --task <id>', 'Task id')
  .action((opts: { task?: string }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      const result = syncTaskGit(store, taskId, findWorkspaceRoot());
      if (result.branchChanged) {
        console.log(`Branch updated to ${result.newBranch}.`);
      }
      if (result.recordedCommits.length > 0) {
        console.log(`Recorded ${result.recordedCommits.length} commit(s):`);
        for (const c of result.recordedCommits) console.log(`  - ${c.sha.slice(0, 7)} ${c.message}`);
      } else {
        console.log('No new commits.');
      }
    });
  });

program
  .command('export')
  .description('Render a task to Markdown at .ariadne/export/<task-id>.md (opt-in, for sharing/PRs)')
  .option('-t, --task <id>', 'Task id')
  .option('-o, --out <path>', 'Output file path (defaults to .ariadne/export/<task-id>.md)')
  .action((opts: { task?: string; out?: string }) => {
    withStore((store) => {
      const taskId = resolveTaskId(store, opts.task);
      const markdown = exportTaskMarkdown(store, taskId);
      const root = findWorkspaceRoot();
      const outPath = opts.out ?? path.join(root, '.ariadne', 'export', `${taskId}.md`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, markdown, 'utf8');
      console.log(`Exported task ${taskId} to ${outPath}`);
    });
  });

export { program };

if (require.main === module) {
  program.parse(process.argv);
}
