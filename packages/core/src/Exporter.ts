import type { TaskStore } from './TaskStore.js';

/**
 * Renders a task and its full history to a human-readable Markdown document,
 * per docs/03-DATA-MODEL.md §1 ("Markdown is a generated export, not primary
 * storage... `ariadne export` can render any task to
 * `.ariadne/export/<task-id>.md` for humans, PR descriptions, or opt-in team
 * sharing"). SQLite remains the source of truth; this is a read-only,
 * point-in-time snapshot — re-running export overwrites the file.
 */
export function exportTaskMarkdown(store: TaskStore, taskId: string): string {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const checkpoints = store.listCheckpoints(taskId);
  const todos = store.listTodos(taskId);
  const decisions = store.listDecisions(taskId);
  const errors = store.listErrors(taskId);
  const files = store.listFiles(taskId);
  const commits = store.listCommits(taskId);
  const commands = store.listCommands(taskId);
  const openQuestions = store.listOpenQuestions(taskId);

  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push('');
  lines.push(`- **Status:** ${task.status}`);
  if (task.branch) lines.push(`- **Branch:** ${task.branch}`);
  lines.push(`- **Created:** ${task.createdAt}`);
  lines.push(`- **Updated:** ${task.updatedAt}`);
  lines.push('');
  if (task.goal) {
    lines.push('## Goal');
    lines.push('');
    lines.push(task.goal);
    lines.push('');
  }

  lines.push('## Checkpoints');
  lines.push('');
  if (checkpoints.length === 0) {
    lines.push('_No checkpoints recorded._');
  } else {
    for (const cp of checkpoints) {
      lines.push(`- **[${cp.level}]** ${cp.createdAt} — ${cp.summary}`);
    }
  }
  lines.push('');

  lines.push('## Todos');
  lines.push('');
  if (todos.length === 0) {
    lines.push('_No todos recorded._');
  } else {
    for (const todo of todos) {
      const box = todo.status === 'done' ? '[x]' : '[ ]';
      const suffix = todo.status !== 'pending' && todo.status !== 'done' ? ` (${todo.status})` : '';
      lines.push(`- ${box} ${todo.text}${suffix}`);
    }
  }
  lines.push('');

  lines.push('## Decisions');
  lines.push('');
  if (decisions.length === 0) {
    lines.push('_No decisions recorded._');
  } else {
    for (const d of decisions) {
      const superseded = d.supersedesId ? ' _(supersedes a prior decision)_' : '';
      lines.push(`- ${d.text}${superseded}`);
      if (d.rationale) lines.push(`  - Rationale: ${d.rationale}`);
    }
  }
  lines.push('');

  lines.push('## Open Questions');
  lines.push('');
  if (openQuestions.length === 0) {
    lines.push('_No open questions recorded._');
  } else {
    for (const q of openQuestions) {
      const box = q.resolved ? '[x]' : '[ ]';
      lines.push(`- ${box} ${q.text}`);
    }
  }
  lines.push('');

  lines.push('## Errors');
  lines.push('');
  if (errors.length === 0) {
    lines.push('_No errors recorded._');
  } else {
    for (const err of errors) {
      const status = err.resolved ? `resolved${err.resolution ? `: ${err.resolution}` : ''}` : 'unresolved';
      lines.push(`- **[${status}]** ${err.message}`);
    }
  }
  lines.push('');

  lines.push('## Files Touched');
  lines.push('');
  if (files.length === 0) {
    lines.push('_No files recorded._');
  } else {
    for (const f of files) {
      lines.push(`- \`${f.path}\` (${f.role})`);
    }
  }
  lines.push('');

  lines.push('## Commits');
  lines.push('');
  if (commits.length === 0) {
    lines.push('_No commits recorded._');
  } else {
    for (const c of commits) {
      lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.message ?? ''}`);
    }
  }
  lines.push('');

  lines.push('## Command Log');
  lines.push('');
  if (commands.length === 0) {
    lines.push('_No commands recorded._');
  } else {
    for (const cmd of commands) {
      const exit = cmd.exitCode === null || cmd.exitCode === undefined ? '' : ` (exit ${cmd.exitCode})`;
      lines.push(`- \`${cmd.cmdRedacted}\`${exit}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
