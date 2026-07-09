import type { TaskStore, CheckpointLevel } from '@ariadne/core';

/**
 * Pure, vscode-independent command logic for the Ariadne chat participant.
 * Kept separate from extension.ts so it can be unit tested with vitest
 * without mocking the `vscode` module.
 */

export interface ChatCommandInput {
  /** The slash command the user invoked (e.g. "status"), or undefined for a plain @ariadne message. */
  command?: string;
  /** Free text following the command (or the whole message, if no command). */
  prompt: string;
  /** The workspace's currently-tracked task id, if any. */
  currentTaskId?: string;
}

export interface ChatCommandResult {
  /** Markdown to stream back to the chat (full text — used by callers that want one block, e.g. the palette "status" command). */
  markdown: string;
  /**
   * When present, callers that support incremental streaming (the chat
   * participant) should render these one at a time instead of `markdown`
   * as a single block, so long status/resume output appears progressively
   * rather than all at once.
   */
  sections?: string[];
  /** Set when the command changed which task is "current" (e.g. `task new`, `task use`). */
  newCurrentTaskId?: string;
}

function requireTask(store: TaskStore, currentTaskId: string | undefined): string | undefined {
  if (!currentTaskId) return undefined;
  return store.getTask(currentTaskId) ? currentTaskId : undefined;
}

/** Builds the /status (and /resume) output as an ordered list of sections, so callers can stream them incrementally. */
export function formatStatusSections(store: TaskStore, taskId: string): string[] {
  const t = store.getTask(taskId);
  if (!t) return [`No task found with id \`${taskId}\`.`];

  const sections: string[] = [];

  let header = `### ${t.title}  \`${t.status}\``;
  if (t.goal) header += `\n**Goal:** ${t.goal}`;
  sections.push(header);

  const latest = store.latestCheckpoint(taskId);
  if (latest) {
    sections.push(`**Latest checkpoint** (${latest.level}, ${latest.createdAt}):\n> ${latest.summary}`);
  }

  const openQuestions = store.listOpenQuestions(taskId, { resolved: false });
  if (openQuestions.length > 0) {
    sections.push(`**Open questions:**\n${openQuestions.map((q) => `- ${q.text}`).join('\n')}`);
  }

  const unresolvedErrors = store.listErrors(taskId, { resolved: false });
  if (unresolvedErrors.length > 0) {
    sections.push(`**Unresolved errors:**\n${unresolvedErrors.map((e) => `- ${e.message}`).join('\n')}`);
  }

  const pendingTodos = store.listTodos(taskId, { status: 'pending' });
  if (pendingTodos.length > 0) {
    sections.push(`**Pending todos:**\n${pendingTodos.map((td) => `- [ ] \`${td.id}\` ${td.text}`).join('\n')}`);
  }

  const recentFiles = store.listFiles(taskId, 10);
  if (recentFiles.length > 0) {
    sections.push(`**Recently touched files:**\n${recentFiles.map((f) => `- (${f.role}) \`${f.path}\``).join('\n')}`);
  }

  const recentCommits = store.listCommits(taskId, 5);
  if (recentCommits.length > 0) {
    sections.push(
      `**Recent commits:**\n${recentCommits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.message ?? ''}`).join('\n')}`,
    );
  }

  return sections;
}

export function formatStatus(store: TaskStore, taskId: string): string {
  return formatStatusSections(store, taskId).join('\n\n');
}

/** Parses "add <text>" / "list" / "done <id>" style sub-commands used by /todo and similar. */
function splitSubcommand(prompt: string): { sub: string; rest: string } {
  const trimmed = prompt.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { sub: trimmed, rest: '' };
  return { sub: trimmed.slice(0, spaceIdx), rest: trimmed.slice(spaceIdx + 1).trim() };
}

export function handleChatCommand(store: TaskStore, input: ChatCommandInput): ChatCommandResult {
  const { command, prompt } = input;
  const taskId = requireTask(store, input.currentTaskId);

  switch (command) {
    case 'task': {
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'new') {
        const created = store.createTask({ title: rest || 'Untitled task' });
        return {
          markdown: `Created task \`${created.id}\`: **${created.title}** and marked it current.`,
          newCurrentTaskId: created.id,
        };
      }
      if (sub === 'list') {
        const tasks = store.listTasks();
        if (tasks.length === 0) return { markdown: 'No tasks found.' };
        const lines = tasks.map(
          (t) => `- ${t.id === taskId ? '**' : ''}[${t.status}] \`${t.id}\` ${t.title}${t.id === taskId ? '**' : ''}`,
        );
        return { markdown: lines.join('\n') };
      }
      if (sub === 'use') {
        const id = rest;
        if (!store.getTask(id)) return { markdown: `No task found with id \`${id}\`.` };
        return { markdown: `Current task set to \`${id}\`.`, newCurrentTaskId: id };
      }
      return { markdown: 'Usage: `/task new <title>`, `/task list`, or `/task use <id>`.' };
    }

    case 'checkpoint': {
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      if (!prompt.trim()) return { markdown: 'Usage: `/checkpoint <summary>`.' };
      const level: CheckpointLevel = 'micro';
      const cp = store.createCheckpoint({ taskId, level, summary: prompt.trim() });
      return { markdown: `Recorded ${cp.level} checkpoint \`${cp.id}\`.` };
    }

    case 'todo': {
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'add') {
        if (!rest) return { markdown: 'Usage: `/todo add <text>`.' };
        const created = store.createTodo({ taskId, text: rest });
        return { markdown: `Added todo \`${created.id}\`: ${created.text}` };
      }
      if (sub === 'done') {
        if (!rest) return { markdown: 'Usage: `/todo done <id>`.' };
        store.updateTodoStatus(rest, 'done');
        return { markdown: `Marked todo \`${rest}\` done.` };
      }
      const todos = store.listTodos(taskId);
      if (todos.length === 0) return { markdown: 'No todos found.' };
      return {
        markdown: todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] \`${t.id}\` ${t.text}`).join('\n'),
      };
    }

    case 'decision': {
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      if (!prompt.trim()) return { markdown: 'Usage: `/decision <text>`.' };
      const decision = store.recordDecision({ taskId, text: prompt.trim() });
      return { markdown: `Recorded decision \`${decision.id}\`: ${decision.text}` };
    }

    case 'error': {
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'resolve') {
        store.resolveError(rest);
        return { markdown: `Marked error \`${rest}\` resolved.` };
      }
      if (!prompt.trim()) return { markdown: 'Usage: `/error <message>` or `/error resolve <id>`.' };
      const err = store.recordError({ taskId, message: prompt.trim() });
      return { markdown: `Recorded error \`${err.id}\`.` };
    }

    case 'resume':
    case 'status':
    default: {
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      const sections = formatStatusSections(store, taskId);
      return { markdown: sections.join('\n\n'), sections };
    }
  }
}

function noCurrentTaskMessage(): string {
  return 'No current task for this workspace. Run `/task new <title>` to start one.';
}

/** A short human-readable phrase describing what's about to happen, shown via stream.progress() before the command runs. */
export function progressMessageFor(command: string | undefined): string {
  switch (command) {
    case 'task':
      return 'Updating task…';
    case 'checkpoint':
      return 'Recording checkpoint…';
    case 'todo':
      return 'Updating todos…';
    case 'decision':
      return 'Recording decision…';
    case 'error':
      return 'Recording error…';
    case 'resume':
      return 'Resuming task context…';
    case 'status':
    default:
      return 'Loading task status…';
  }
}
