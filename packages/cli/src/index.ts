#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskStore, TodoStatus } from '@ariadne/core';
import {
  buildContext,
  syncTaskGit,
  exportTaskMarkdown,
  searchWorkspace,
  listTasksAcrossWorkspaces,
  searchAcrossWorkspaces,
  setTaskStatusWithRollup,
  openRegistry,
  getRegistryPath,
  listWorkspaces,
  forgetWorkspace,
  pruneMissingWorkspaces,
} from '@ariadne/core';
import { openWorkspaceStore, findWorkspaceRoot, stateDbPath } from './workspace.js';
import { readCurrentTaskId, setCurrentTaskId } from './currentTask.js';
import { withResolvedTask, withScopedStore } from './withTask.js';
import { runTaskExec } from './exec.js';

const program = new Command();
program.name('ariadne').description('Chats are disposable, tasks are permanent.').version('0.1.0');

/** Resolves which task id to operate on: explicit --task flag wins, else the workspace's current task. Validates against the CURRENT workspace only — see `withResolvedTask` in withTask.ts for the cross-workspace-aware version used by most commands. */
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
  .option('-a, --all-workspaces', 'List tasks from every known workspace, not just this one')
  .action((opts: { status?: 'active' | 'paused' | 'done' | 'archived'; allWorkspaces?: boolean }) => {
    if (opts.allWorkspaces) {
      const tasks = listTasksAcrossWorkspaces(opts.status ? { status: opts.status } : undefined);
      if (tasks.length === 0) {
        console.log('No tasks found in any known workspace.');
        return;
      }
      const currentRoot = findWorkspaceRoot();
      const current = readCurrentTaskId();
      for (const t of tasks) {
        const marker = t.taskId === current && t.workspaceRoot === currentRoot ? '*' : ' ';
        console.log(`${marker} [${t.status}] ${t.taskId}  ${t.title}  (${t.workspaceRoot})`);
      }
      return;
    }
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

task
  .command('pause [id]')
  .description('Pause the current (or given) task')
  .action((id: string | undefined) => {
    withResolvedTask(id, (store, taskId) => {
      setTaskStatusWithRollup(store, taskId, 'paused');
      console.log(`Task ${taskId} paused.`);
    });
  });

task
  .command('done [id]')
  .description('Mark the current (or given) task done')
  .action((id: string | undefined) => {
    withResolvedTask(id, (store, taskId) => {
      setTaskStatusWithRollup(store, taskId, 'done');
      console.log(`Task ${taskId} marked done.`);
    });
  });

task
  .command('archive [id]')
  .description('Archive the current (or given) task')
  .action((id: string | undefined) => {
    withResolvedTask(id, (store, taskId) => {
      setTaskStatusWithRollup(store, taskId, 'archived');
      console.log(`Task ${taskId} archived.`);
    });
  });

task
  .command('reopen [id]')
  .description('Reopen a paused/done/archived task, marking it active again')
  .action((id: string | undefined) => {
    withResolvedTask(id, (store, taskId) => {
      store.updateTaskStatus(taskId, 'active');
      console.log(`Task ${taskId} reactivated.`);
    });
  });

task
  .command('edit [id]')
  .description('Edit the current (or given) task\'s title and/or goal (curation — fixes bad data without recreating the task)')
  .option('--title <title>', 'New title')
  .option('--goal <goal>', 'New goal (pass an empty string to clear it)')
  .action((id: string | undefined, opts: { title?: string; goal?: string }) => {
    if (opts.title === undefined && opts.goal === undefined) {
      console.error('Nothing to edit — pass --title and/or --goal.');
      process.exit(1);
    }
    withResolvedTask(id, (store, taskId) => {
      if (opts.title !== undefined) store.updateTaskTitle(taskId, opts.title);
      if (opts.goal !== undefined) store.updateTaskGoal(taskId, opts.goal === '' ? null : opts.goal);
      const updated = store.getTask(taskId)!;
      console.log(`Task ${taskId} updated: "${updated.title}"${updated.goal ? ` (goal: ${updated.goal})` : ''}`);
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
    withResolvedTask(opts.task, (store, taskId) => {
      const cp = store.createCheckpoint({ taskId, level: opts.level, summary });
      console.log(`Recorded ${cp.level} checkpoint ${cp.id}.`);
    });
  });

// ---------------------------------------------------------------------
// decision
// ---------------------------------------------------------------------

program
  .command('decision <text>')
  .description('Record a decision for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-r, --rationale <rationale>', 'Why this decision was made')
  .action((text: string, opts: { task?: string; rationale?: string }) => {
    withResolvedTask(opts.task, (store, taskId) => {
      const created = store.recordDecision({ taskId, text, rationale: opts.rationale });
      console.log(`Recorded decision ${created.id}: ${created.text}`);
    });
  });

// `decisions` (plural) is a separate command group from `decision <text>`
// (singular, above) purely to avoid ambiguity — `ariadne decision list`
// would otherwise be indistinguishable from recording a decision whose
// text is literally "list".
const decisions = program
  .command('decisions')
  .description('List, edit, or delete decisions (use "ariadne decision <text>" to add one)');

decisions
  .command('list')
  .description('List decisions for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .action((opts: { task?: string }) => {
    withResolvedTask(opts.task, (store, taskId) => {
      const list = store.listDecisions(taskId);
      if (list.length === 0) {
        console.log('No decisions found.');
        return;
      }
      for (const d of list) {
        console.log(`${d.id}  ${d.text}${d.rationale ? `  (${d.rationale})` : ''}`);
      }
    });
  });

decisions
  .command('edit <id>')
  .description('Edit a decision\'s text and/or rationale (curation)')
  .option('--text <text>', 'New text')
  .option('--rationale <rationale>', 'New rationale (pass an empty string to clear it)')
  .option('-t, --task <id>', 'Task id the decision belongs to, if not in the current workspace')
  .action((id: string, opts: { text?: string; rationale?: string; task?: string }) => {
    if (opts.text === undefined && opts.rationale === undefined) {
      console.error('Nothing to edit — pass --text and/or --rationale.');
      process.exit(1);
    }
    withScopedStore(opts.task, (store) => {
      store.updateDecision(id, {
        text: opts.text,
        rationale: opts.rationale !== undefined ? (opts.rationale === '' ? null : opts.rationale) : undefined,
      });
      console.log(`Decision ${id} updated.`);
    });
  });

decisions
  .command('delete <id>')
  .description('Permanently delete a decision (curation)')
  .option('-t, --task <id>', 'Task id the decision belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.deleteDecision(id);
      console.log(`Decision ${id} deleted.`);
    });
  });

// ---------------------------------------------------------------------
// error
// ---------------------------------------------------------------------

const errorCmd = program.command('error').description('Manage unresolved errors');

errorCmd
  .command('add <message>')
  .description('Record an error against the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .action((message: string, opts: { task?: string }) => {
    withResolvedTask(opts.task, (store, taskId) => {
      const created = store.recordError({ taskId, message });
      console.log(`Recorded error ${created.id}.`);
    });
  });

errorCmd
  .command('list')
  .description('List errors for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-a, --all', 'Include resolved errors (default: unresolved only)')
  .action((opts: { task?: string; all?: boolean }) => {
    withResolvedTask(opts.task, (store, taskId) => {
      const errors = store.listErrors(taskId, opts.all ? undefined : { resolved: false });
      if (errors.length === 0) {
        console.log('No errors found.');
        return;
      }
      for (const e of errors) {
        console.log(`[${e.resolved ? 'resolved' : 'open'}] ${e.id}  ${e.message}`);
      }
    });
  });

errorCmd
  .command('resolve <id>')
  .description('Mark an error as resolved')
  .option('-r, --resolution <text>', 'Resolution note')
  .option('-t, --task <id>', 'Task id the error belongs to, if not in the current workspace')
  .action((id: string, opts: { resolution?: string; task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.resolveError(id, opts.resolution);
      console.log(`Marked error ${id} resolved.`);
    });
  });

errorCmd
  .command('reopen <id>')
  .description('Reopen a previously-resolved error')
  .option('-t, --task <id>', 'Task id the error belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.unresolveError(id);
      console.log(`Reopened error ${id}.`);
    });
  });

errorCmd
  .command('edit <id>')
  .description('Edit an error\'s recorded message (curation)')
  .requiredOption('-m, --message <text>', 'New message')
  .option('-t, --task <id>', 'Task id the error belongs to, if not in the current workspace')
  .action((id: string, opts: { message: string; task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.updateError(id, opts.message);
      console.log(`Error ${id} updated.`);
    });
  });

errorCmd
  .command('delete <id>')
  .description('Permanently delete an error (curation)')
  .option('-t, --task <id>', 'Task id the error belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.deleteError(id);
      console.log(`Error ${id} deleted.`);
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
    withResolvedTask(opts.task, (store, taskId) => {
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
    withResolvedTask(opts.task, (store, taskId) => {
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
  .option('-t, --task <id>', 'Task id the todo belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.updateTodoStatus(id, 'done');
      console.log(`Marked todo ${id} done.`);
    });
  });

todo
  .command('reopen <id>')
  .description('Reopen a done todo, setting it back to pending')
  .option('-t, --task <id>', 'Task id the todo belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.updateTodoStatus(id, 'pending');
      console.log(`Reopened todo ${id} (set to pending).`);
    });
  });

todo
  .command('block <id>')
  .description('Mark a todo as blocked')
  .option('-t, --task <id>', 'Task id the todo belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.updateTodoStatus(id, 'blocked');
      console.log(`Marked todo ${id} blocked.`);
    });
  });

todo
  .command('edit <id>')
  .description('Edit a todo\'s text (curation)')
  .requiredOption('--text <text>', 'New text')
  .option('-t, --task <id>', 'Task id the todo belongs to, if not in the current workspace')
  .action((id: string, opts: { text: string; task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.updateTodoText(id, opts.text);
      console.log(`Todo ${id} updated.`);
    });
  });

todo
  .command('delete <id>')
  .description('Permanently delete a todo (curation)')
  .option('-t, --task <id>', 'Task id the todo belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.deleteTodo(id);
      console.log(`Todo ${id} deleted.`);
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
    withResolvedTask(opts.task, (store, taskId) => {
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
    withResolvedTask(opts.task, (store, taskId) => {
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
  .option('-t, --task <id>', 'Task id the question belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.resolveOpenQuestion(id);
      console.log(`Marked question ${id} resolved.`);
    });
  });

question
  .command('reopen <id>')
  .description('Reopen a previously-resolved open question')
  .option('-t, --task <id>', 'Task id the question belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.unresolveOpenQuestion(id);
      console.log(`Reopened question ${id}.`);
    });
  });

question
  .command('edit <id>')
  .description('Edit an open question\'s text (curation)')
  .requiredOption('--text <text>', 'New text')
  .option('-t, --task <id>', 'Task id the question belongs to, if not in the current workspace')
  .action((id: string, opts: { text: string; task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.updateOpenQuestion(id, opts.text);
      console.log(`Question ${id} updated.`);
    });
  });

question
  .command('delete <id>')
  .description('Permanently delete an open question (curation)')
  .option('-t, --task <id>', 'Task id the question belongs to, if not in the current workspace')
  .action((id: string, opts: { task?: string }) => {
    withScopedStore(opts.task, (store) => {
      store.deleteOpenQuestion(id);
      console.log(`Question ${id} deleted.`);
    });
  });

// ---------------------------------------------------------------------
// status / resume
// ---------------------------------------------------------------------

function printStatus(store: TaskStore, taskId: string, workspaceRoot: string, tokenBudget?: number): void {
  const t = store.getTask(taskId)!;
  console.log(`Task: ${t.title}  (${t.status})`);
  console.log(`Workspace: ${workspaceRoot}`);
  if (t.branch) console.log(`Branch: ${t.branch}`);

  const ctx = buildContext(store, taskId, { workspaceRoot, ...(tokenBudget ? { tokenBudget } : {}) });

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

  if (ctx.blockedTodos.length > 0) {
    console.log(`\nBlocked todos:`);
    for (const td of ctx.blockedTodos) console.log(`  - ${td}`);
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

  if (ctx.recentCommands.length > 0) {
    console.log(`\nRecent commands:`);
    for (const c of ctx.recentCommands) console.log(`  - ${c.cmd}${c.exitCode !== null ? ` (exit ${c.exitCode})` : ''}`);
  }

  const truncatedEntries = Object.entries(ctx.truncated);
  if (truncatedEntries.length > 0) {
    const summary = truncatedEntries.map(([category, count]) => `${count} ${category}`).join(', ');
    console.log(`\n(Trimmed to fit token budget — omitted: ${summary}. Use --budget to raise the limit.)`);
  }
}

program
  .command('exec <command> [args...]')
  .description('Run a command in the current task context, recording the command and any failure automatically')
  .allowUnknownOption(true)
  .action(async (command: string, args: string[] = []) => {
    await withResolvedTask(undefined, async (store, taskId) => {
      const exitCode = await runTaskExec(store, taskId, command, args);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
  });

program
  .command('status')
  .description('Show a ranked, token-budgeted summary of the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-b, --budget <tokens>', 'Token budget for context ranking (default: 2000)', (v) => parseInt(v, 10))
  .action((opts: { task?: string; budget?: number }) => {
    withResolvedTask(opts.task, (store, taskId, workspaceRoot) => {
      printStatus(store, taskId, workspaceRoot, opts.budget);
    });
  });

program
  .command('resume')
  .description('Alias of "status" — reload context for the current (or --task) task')
  .option('-t, --task <id>', 'Task id')
  .option('-b, --budget <tokens>', 'Token budget for context ranking (default: 2000)', (v) => parseInt(v, 10))
  .action((opts: { task?: string; budget?: number }) => {
    withResolvedTask(opts.task, (store, taskId, workspaceRoot) => {
      printStatus(store, taskId, workspaceRoot, opts.budget);
    });
  });

program
  .command('where')
  .description('Print the resolved workspace root and state db path')
  .action(() => {
    const root = findWorkspaceRoot();
    console.log(`Workspace root: ${root}`);
    console.log(`State db:       ${stateDbPath(root)}`);
  });

program
  .command('search <query>')
  .description('Search this workspace (or, with --all-workspaces, every known workspace) for a substring match across task titles, goals, checkpoints, decisions, todos, errors, open questions, files, and commits')
  .option('-l, --limit <n>', 'Max tasks to show (default: 20)', (v) => parseInt(v, 10))
  .option('-a, --all-workspaces', 'Search every known workspace, not just this one')
  .action((query: string, opts: { limit?: number; allWorkspaces?: boolean }) => {
    if (opts.allWorkspaces) {
      const results = searchAcrossWorkspaces(query, { allWorkspaces: true, ...(opts.limit ? { totalLimit: opts.limit } : {}) });
      if (results.length === 0) {
        console.log('No matches found in any known workspace.');
        return;
      }
      for (const r of results) {
        console.log(`  [${r.taskStatus}] ${r.taskId}  ${r.taskTitle}  (${r.workspaceRoot})`);
        for (const m of r.matches) {
          console.log(`    (${m.category}) ${m.text}`);
        }
      }
      return;
    }
    withStore((store) => {
      const results = searchWorkspace(store, query, opts.limit ? { limit: opts.limit } : undefined);
      if (results.length === 0) {
        console.log('No matches found.');
        return;
      }
      const current = readCurrentTaskId();
      for (const r of results) {
        const marker = r.taskId === current ? '*' : ' ';
        console.log(`${marker} [${r.taskStatus}] ${r.taskId}  ${r.taskTitle}`);
        for (const m of r.matches) {
          console.log(`    (${m.category}) ${m.text}`);
        }
      }
    });
  });

program
  .command('git-sync')
  .description('Sync the current git branch and any new commits into the current (or --task) task — for CLI-only workflows without VS Code')
  .option('-t, --task <id>', 'Task id')
  .action((opts: { task?: string }) => {
    withResolvedTask(opts.task, (store, taskId, workspaceRoot) => {
      const result = syncTaskGit(store, taskId, workspaceRoot);
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
    withResolvedTask(opts.task, (store, taskId, workspaceRoot) => {
      const markdown = exportTaskMarkdown(store, taskId);
      const outPath = opts.out ?? path.join(workspaceRoot, '.ariadne', 'export', `${taskId}.md`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, markdown, 'utf8');
      console.log(`Exported task ${taskId} to ${outPath}`);
    });
  });

const workspace = program.command('workspace').description('Manage the cross-workspace registry (~/.ariadne/registry.db)');

workspace
  .command('list')
  .description('List every workspace root Ariadne has ever seen, most recently used first')
  .action(() => {
    const registryDb = openRegistry();
    const workspaces = listWorkspaces(registryDb);
    if (workspaces.length === 0) {
      console.log('No known workspaces yet.');
      return;
    }
    for (const w of workspaces) {
      const exists = fs.existsSync(w.root) ? '' : '  (missing on disk)';
      console.log(`  ${w.root}  (last seen ${w.lastSeenAt})${exists}`);
    }
  });

workspace
  .command('prune')
  .description('Remove registry entries for workspace roots that no longer exist on disk')
  .action(() => {
    const registryDb = openRegistry();
    const pruned = pruneMissingWorkspaces(registryDb);
    if (pruned.length === 0) {
      console.log('Nothing to prune — every known workspace still exists on disk.');
      return;
    }
    console.log(`Pruned ${pruned.length} workspace(s) whose directory no longer exists:`);
    for (const root of pruned) console.log(`  - ${root}`);
  });

workspace
  .command('forget <root>')
  .description('Remove a workspace root (and its indexed tasks) from the registry outright, without checking whether it still exists on disk')
  .action((root: string) => {
    const registryDb = openRegistry();
    const resolvedRoot = path.resolve(root);
    forgetWorkspace(registryDb, resolvedRoot);
    console.log(`Forgot workspace ${resolvedRoot}. Its own .ariadne/state.db (if it still exists) is untouched.`);
  });

program
  .command('backup')
  .description("Copy the current workspace's state.db (and the shared registry) to a timestamped snapshot")
  .option('-o, --out <dir>', 'Output directory (defaults to <workspace-root>/.ariadne/backups)')
  .action((opts: { out?: string }) => {
    const root = findWorkspaceRoot();
    const dbPath = stateDbPath(root);
    if (!fs.existsSync(dbPath)) {
      console.error(`No state db found at ${dbPath} — nothing to back up.`);
      process.exit(1);
    }
    const outDir = opts.out ?? path.join(root, '.ariadne', 'backups');
    fs.mkdirSync(outDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const statePath = path.join(outDir, `state-${timestamp}.db`);
    fs.copyFileSync(dbPath, statePath);
    console.log(`Backed up workspace state db to ${statePath}`);

    const registryPath = getRegistryPath();
    if (fs.existsSync(registryPath)) {
      const registryBackupPath = path.join(outDir, `registry-${timestamp}.db`);
      fs.copyFileSync(registryPath, registryBackupPath);
      console.log(`Backed up cross-workspace registry to ${registryBackupPath}`);
    }
  });

program
  .command('restore <path>')
  .description('Restore a workspace state db (or registry db) snapshot created by "ariadne backup"')
  .option('--registry', 'Restore into the shared cross-workspace registry instead of this workspace\'s state db')
  .action((snapshotPath: string, opts: { registry?: boolean }) => {
    const resolvedSnapshot = path.resolve(snapshotPath);
    if (!fs.existsSync(resolvedSnapshot)) {
      console.error(`Snapshot not found: ${resolvedSnapshot}`);
      process.exit(1);
    }
    const target = opts.registry ? getRegistryPath() : stateDbPath(findWorkspaceRoot());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const preRestoreBackup = `${target}.pre-restore-${Date.now()}.bak`;
      fs.copyFileSync(target, preRestoreBackup);
      console.log(`Existing db backed up to ${preRestoreBackup} before restoring.`);
    }
    fs.copyFileSync(resolvedSnapshot, target);
    console.log(`Restored ${resolvedSnapshot} to ${target}`);
  });

export { program };

if (require.main === module) {
  void program.parseAsync(process.argv);
}
