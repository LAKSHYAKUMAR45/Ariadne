import type { TaskStore, CheckpointLevel } from '@ariadne/core';
import { buildContext, searchWorkspace } from '@ariadne/core';

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

/**
 * Builds the /status (and /resume) output as an ordered list of sections, so
 * callers can stream them incrementally. Delegates to @ariadne/core's
 * buildContext — the same ranked, token-budgeted context package the CLI's
 * `status`/`resume` and the MCP server's `get_context` tool use — so all
 * three surfaces show identical "what am I working on" context instead of
 * the chat participant reimplementing its own ad-hoc query/formatting.
 */
export function formatStatusSections(store: TaskStore, taskId: string, tokenBudget?: number): string[] {
  const t = store.getTask(taskId);
  if (!t) return [`No task found with id \`${taskId}\`.`];

  const ctx = buildContext(store, taskId, tokenBudget ? { tokenBudget } : undefined);
  const sections: string[] = [];

  let header = `### ${t.title}  \`${t.status}\``;
  if (ctx.goal) header += `\n**Goal:** ${ctx.goal}`;
  sections.push(header);

  if (ctx.latestSummary) {
    sections.push(`**Latest checkpoint:**\n> ${ctx.latestSummary}`);
  }

  if (ctx.openQuestions.length > 0) {
    sections.push(`**Open questions:**\n${ctx.openQuestions.map((q) => `- ${q}`).join('\n')}`);
  }

  if (ctx.unresolvedErrors.length > 0) {
    sections.push(`**Unresolved errors:**\n${ctx.unresolvedErrors.map((e) => `- ${e}`).join('\n')}`);
  }

  if (ctx.decisions.length > 0) {
    sections.push(`**Decisions:**\n${ctx.decisions.map((d) => `- ${d}`).join('\n')}`);
  }

  if (ctx.openTodos.length > 0) {
    sections.push(`**Pending todos:**\n${ctx.openTodos.map((td) => `- [ ] ${td}`).join('\n')}`);
  }

  if (ctx.recentFiles.length > 0) {
    sections.push(`**Recently touched files:**\n${ctx.recentFiles.map((f) => `- (${f.role}) \`${f.path}\``).join('\n')}`);
  }

  if (ctx.recentCommits.length > 0) {
    sections.push(
      `**Recent commits:**\n${ctx.recentCommits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.message ?? ''}`).join('\n')}`,
    );
  }

  const truncatedEntries = Object.entries(ctx.truncated);
  if (truncatedEntries.length > 0) {
    const summary = truncatedEntries.map(([category, count]) => `${count} ${category}`).join(', ');
    sections.push(`_(Trimmed to fit token budget — omitted: ${summary}.)_`);
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

interface InferredIntent {
  command: string;
  prompt: string;
}

/**
 * Best-effort keyword-based routing for plain `@ariadne` messages that
 * don't use a slash command. Deliberately simple (no LLM calls, per the
 * MVP's rule-based-only decision) — a handful of ordered regexes that map
 * common phrasings onto the existing slash-command handlers. Falls back to
 * `undefined` (status/resume default) when nothing matches.
 */
export function inferIntent(rawPrompt: string): InferredIntent | undefined {
  const text = rawPrompt.trim();
  if (!text) return undefined;

  const patterns: { re: RegExp; build: (m: RegExpMatchArray) => InferredIntent }[] = [
    // "mark todo abc123 done" / "complete todo abc123" / "finish todo abc123"
    {
      re: /^(?:mark|complete|finish)\s+todo\s+(\S+)(?:\s+(?:as\s+)?done)?$/i,
      build: (m) => ({ command: 'todo', prompt: `done ${m[1]}` }),
    },
    // "done with abc123" / "finished abc123"
    {
      re: /^(?:done with|finished)\s+(\S+)$/i,
      build: (m) => ({ command: 'todo', prompt: `done ${m[1]}` }),
    },
    // "add todo: fix the bug" / "todo: fix the bug" / "remind me to fix the bug" / "remember to fix the bug"
    {
      re: /^(?:add\s+(?:a\s+)?todo|todo|remind me to|remember to)\s*[:\-]?\s*(.+)$/i,
      build: (m) => ({ command: 'todo', prompt: `add ${m[1].trim()}` }),
    },
    // "new task: refactor auth" / "start a task refactor auth" / "create task refactor auth"
    {
      re: /^(?:new task|start(?:ing)? (?:a )?task|create (?:a )?task)\s*[:\-]?\s*(.+)$/i,
      build: (m) => ({ command: 'task', prompt: `new ${m[1].trim()}` }),
    },
    // "list tasks" / "show tasks" / "what tasks are there"
    {
      re: /^(?:list tasks|show tasks|what tasks(?: are there)?)\s*\??$/i,
      build: () => ({ command: 'task', prompt: 'list' }),
    },
    // "use task abc123" / "switch to task abc123" / "switch task to abc123"
    {
      re: /^(?:use task|switch to task|switch task to)\s+(\S+)$/i,
      build: (m) => ({ command: 'task', prompt: `use ${m[1]}` }),
    },
    // "decision: use SQLite" / "we decided to use SQLite" / "decided to use SQLite" / "going with SQLite"
    {
      re: /^(?:decision|we decided(?: to)?|decided(?: to)?|going with)\s*[:\-]?\s*(.+)$/i,
      build: (m) => ({ command: 'decision', prompt: m[1].trim() }),
    },
    // "error: build fails" / "bug: build fails" / "got an error: build fails" / "failed with: build fails"
    {
      re: /^(?:error|bug|got an error|failed with)\s*[:\-]?\s*(.+)$/i,
      build: (m) => ({ command: 'error', prompt: m[1].trim() }),
    },
    // "resolve error abc123" / "fixed error abc123"
    {
      re: /^(?:resolve|fixed)\s+error\s+(\S+)$/i,
      build: (m) => ({ command: 'error', prompt: `resolve ${m[1]}` }),
    },
    // "question: does X support Y?" / "open question: ..." / "not sure whether ..." / "unsure if ..."
    {
      re: /^(?:open question|question|not sure (?:whether|if)|unsure (?:whether|if))\s*[:\-]?\s*(.+)$/i,
      build: (m) => ({ command: 'question', prompt: `add ${m[1].trim()}` }),
    },
    // "resolve question abc123" / "answered question abc123"
    {
      re: /^(?:resolve|answered)\s+question\s+(\S+)$/i,
      build: (m) => ({ command: 'question', prompt: `resolve ${m[1]}` }),
    },
    // "list open questions" / "show open questions" / "what questions are open"
    {
      re: /^(?:list|show)\s+open\s+questions|what\s+questions(?: are open)?\??$/i,
      build: () => ({ command: 'question', prompt: 'list' }),
    },
    // "checkpoint: got auth working" / "record checkpoint: got auth working"
    {
      re: /^(?:record\s+)?checkpoint\s*[:\-]?\s*(.+)$/i,
      build: (m) => ({ command: 'checkpoint', prompt: m[1].trim() }),
    },
    // "status" / "what's the status" / "how's it going" / "where are we"
    {
      re: /^(?:status|what'?s the status|how'?s it going|where are we)\??$/i,
      build: () => ({ command: 'status', prompt: '' }),
    },
    // "resume" / "catch me up" / "what was I doing"
    {
      re: /^(?:resume|catch me up|what was i doing)\??$/i,
      build: () => ({ command: 'resume', prompt: '' }),
    },
  ];

  for (const { re, build } of patterns) {
    const match = text.match(re);
    if (match) return build(match);
  }
  return undefined;
}

export function handleChatCommand(store: TaskStore, input: ChatCommandInput): ChatCommandResult {
  let { command, prompt } = input;
  if (!command) {
    const inferred = inferIntent(prompt);
    if (inferred) {
      command = inferred.command;
      prompt = inferred.prompt;
    }
  }
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

    case 'search': {
      if (!prompt.trim()) return { markdown: 'Usage: `/search <query>`.' };
      const results = searchWorkspace(store, prompt.trim());
      if (results.length === 0) return { markdown: `No matches for "${prompt.trim()}".` };
      const lines = results.map((r) => {
        const matchLines = r.matches.map((m) => `  - (${m.category}) ${m.text}`).join('\n');
        return `- ${r.taskId === taskId ? '**' : ''}[${r.taskStatus}] \`${r.taskId}\` ${r.taskTitle}${r.taskId === taskId ? '**' : ''}\n${matchLines}`;
      });
      return { markdown: lines.join('\n') };
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

    case 'question': {
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'add') {
        if (!rest) return { markdown: 'Usage: `/question add <text>`.' };
        const created = store.recordOpenQuestion({ taskId, text: rest });
        return { markdown: `Added open question \`${created.id}\`: ${created.text}` };
      }
      if (sub === 'resolve') {
        if (!rest) return { markdown: 'Usage: `/question resolve <id>`.' };
        store.resolveOpenQuestion(rest);
        return { markdown: `Marked question \`${rest}\` resolved.` };
      }
      if (sub === 'list' || !prompt.trim()) {
        const questions = store.listOpenQuestions(taskId, { resolved: false });
        if (questions.length === 0) return { markdown: 'No open questions found.' };
        return {
          markdown: questions.map((q) => `- \`${q.id}\` ${q.text}`).join('\n'),
        };
      }
      // Bare text with no recognized sub-command is treated as shorthand for "add".
      const created = store.recordOpenQuestion({ taskId, text: prompt.trim() });
      return { markdown: `Added open question \`${created.id}\`: ${created.text}` };
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
    case 'question':
      return 'Updating open questions…';
    case 'search':
      return 'Searching workspace…';
    case 'resume':
      return 'Resuming task context…';
    case 'status':
    default:
      return 'Loading task status…';
  }
}
