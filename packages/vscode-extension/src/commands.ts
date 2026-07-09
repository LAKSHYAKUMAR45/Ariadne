import type { TaskStore, CheckpointLevel, TaskStatus } from '@ariadne/core';
import { buildContext, searchWorkspace, findTaskWorkspace, openRegistry, listTasksAcrossWorkspaces, searchAcrossWorkspaces, setTaskStatusWithRollup, syncTaskGit, exportTaskMarkdown } from '@ariadne/core';
import { getOrOpenStore } from './storeCache.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  /** This workspace's root, if known — required to resolve a task id that belongs to a different workspace via the cross-workspace registry. */
  workspaceRoot?: string;
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
 * Builds the label/tooltip for the status bar guardrail item that always
 * shows whether a task is currently tracked for this workspace — so it's
 * obvious at a glance if passive capture (file saves, terminal commands,
 * diagnostics) is actually going anywhere, instead of silently doing
 * nothing when the user forgot to start/switch a task.
 */
export function formatStatusBarItem(task: { title: string; status: TaskStatus } | undefined): {
  text: string;
  tooltip: string;
} {
  if (!task) {
    return {
      text: '$(circle-slash) Ariadne: no task',
      tooltip: 'Ariadne: no current task for this workspace. Passive capture is not recording anything. Click to start one.',
    };
  }
  const label = task.title.length > 40 ? `${task.title.slice(0, 37)}...` : task.title;
  return {
    text: `$(compass) Ariadne: ${label}`,
    tooltip: `Ariadne task (${task.status}): ${task.title}\nClick to view status.`,
  };
}

/**
 * Detects a possible "working on the wrong task" situation: the task's
 * last-recorded git branch (set by GitWatcher/passive capture whenever a
 * commit or branch switch was observed) no longer matches the branch
 * that's actually checked out. Returns a warning message, or undefined if
 * there's nothing to warn about (no recorded branch yet, or it matches).
 */
export function branchMismatchWarning(
  task: { title: string; branch: string | null },
  actualBranch: string | undefined,
): string | undefined {
  if (!task.branch || !actualBranch || task.branch === actualBranch) return undefined;
  return (
    `Ariadne: current task "${task.title}" was last tracked on branch "${task.branch}", ` +
    `but this repo is now on "${actualBranch}". If you're working on something else, ` +
    'run `/task use <id>` (or "Ariadne: New Task") to switch to the right task.'
  );
}
/**
 * Resolves an explicit task id that isn't in the current workspace's store
 * by consulting the global cross-workspace registry (the same mechanism
 * the CLI's `withResolvedTask` and the MCP server's `withTaskStore` use),
 * and opens (or reuses, via storeCache's per-root cache) the actual owning
 * workspace's store. Callers should check the current store first — this
 * only handles the "not found locally" fallback. Returns `undefined` if the
 * id isn't a task in any other known workspace.
 */
function resolveCrossWorkspaceTask(
  workspaceRoot: string | undefined,
  taskId: string,
): { store: TaskStore; workspaceRoot: string } | undefined {
  if (!workspaceRoot) return undefined;
  const otherRoot = findTaskWorkspace(openRegistry(), taskId);
  if (!otherRoot || otherRoot === workspaceRoot) return undefined;
  try {
    const otherStore = getOrOpenStore(otherRoot);
    if (!otherStore.getTask(taskId)) return undefined;
    return { store: otherStore, workspaceRoot: otherRoot };
  } catch {
    return undefined;
  }
}

/**
 * Resolves which store a sub-entity mutation (`todo done`, `error resolve`,
 * `question resolve`) should run against, given an optional `--task <id>`
 * hint. Without a hint, operates against the current workspace's store
 * unchanged (backwards compatible). With a hint, checks the current store
 * first, then falls back to the cross-workspace registry so a hinted task
 * that lives in a different workspace resolves to that workspace's store.
 */
function resolveTargetStore(
  store: TaskStore,
  workspaceRoot: string | undefined,
  taskHint: string | undefined,
): { store: TaskStore } | { error: string } {
  if (!taskHint) return { store };
  if (store.getTask(taskHint)) return { store };
  const resolved = resolveCrossWorkspaceTask(workspaceRoot, taskHint);
  if (!resolved) return { error: `No task found with id \`${taskHint}\` in this or any known workspace.` };
  return { store: resolved.store };
}

/** Strips a trailing `--all-workspaces`/`-a` flag off a prompt, returning the flag state and the remaining text. */
function extractAllWorkspacesFlag(prompt: string): { allWorkspaces: boolean; rest: string } {
  const re = /\s*(?:--all-workspaces|-a)\b\s*/i;
  if (re.test(prompt)) {
    return { allWorkspaces: true, rest: prompt.replace(re, ' ').trim() };
  }
  return { allWorkspaces: false, rest: prompt };
}

/** Strips a trailing `--budget <n>` flag off a prompt (used by `/status`/`/resume` to cap the token budget, mirroring the CLI's `--budget`). Ignores a malformed/non-numeric value rather than throwing. */
function extractBudgetFlag(prompt: string): { budget: number | undefined; rest: string } {
  const re = /\s*--budget[= ]\s*(\d+)\s*/i;
  const match = prompt.match(re);
  if (!match) return { budget: undefined, rest: prompt };
  return { budget: parseInt(match[1], 10), rest: prompt.replace(re, ' ').trim() };
}

/**
 * Strips a trailing `--task <id>` hint off a prompt (used by sub-entity
 * commands like `/todo done <id> --task <taskId>` to say which task/
 * workspace a raw todo/error/question id belongs to — the cross-workspace
 * registry only indexes task ids, not sub-entity ids, so a bare todo/error/
 * question id from another workspace can't be resolved without this hint).
 */
/**
 * Resolves the task/store/workspaceRoot a command should operate on: an
 * explicit task id (falling back to the cross-workspace registry if it
 * isn't local), or the workspace's current task if no id was given. Used by
 * commands like `/git-sync` and `/export` that need the task's *repo root*
 * (not just its store) to do their work.
 */
function resolveTargetOrCurrent(
  store: TaskStore,
  workspaceRoot: string | undefined,
  currentTaskId: string | undefined,
  explicitId: string | undefined,
): { store: TaskStore; taskId: string; workspaceRoot: string } | { error: string } {
  if (explicitId) {
    if (store.getTask(explicitId)) {
      if (!workspaceRoot) return { error: 'This workspace has no known root.' };
      return { store, taskId: explicitId, workspaceRoot };
    }
    const resolved = resolveCrossWorkspaceTask(workspaceRoot, explicitId);
    if (!resolved) return { error: `No task found with id \`${explicitId}\` in this or any known workspace.` };
    return { store: resolved.store, taskId: explicitId, workspaceRoot: resolved.workspaceRoot };
  }
  if (!currentTaskId) return { error: noCurrentTaskMessage() };
  if (!workspaceRoot) return { error: 'This workspace has no known root.' };
  return { store, taskId: currentTaskId, workspaceRoot };
}

/**
 * Strips a trailing `--task <id>` hint off a prompt (used by sub-entity
 * commands like `/todo done <id> --task <taskId>` to say which task/
 * workspace a raw todo/error/question id belongs to — the cross-workspace
 * registry only indexes task ids, not sub-entity ids, so a bare todo/error/
 * question id from another workspace can't be resolved without this hint).
 */
function extractTaskHint(prompt: string): { taskHint: string | undefined; rest: string } {
  const re = /\s*--task[= ]([^\s]+)\s*/i;
  const match = prompt.match(re);
  if (!match) return { taskHint: undefined, rest: prompt };
  return { taskHint: match[1], rest: prompt.replace(re, ' ').trim() };
}

/**
 * Extracts a `--<flag> <value>` argument whose value may itself contain
 * spaces (e.g. `--text new todo wording`), capturing greedily up to the next
 * `--word` flag or the end of the string. Used by curation commands like
 * `/todo edit <id> --text <new text> [--rationale <r>]`.
 */
function extractFlagValue(prompt: string, flag: string): { value: string | undefined; rest: string } {
  const re = new RegExp(`--${flag}[= ]([\\s\\S]*?)(?=\\s+--[a-zA-Z]|$)`, 'i');
  const match = prompt.match(re);
  if (!match) return { value: undefined, rest: prompt };
  const value = match[1].trim();
  const rest = (prompt.slice(0, match.index!) + prompt.slice(match.index! + match[0].length)).trim();
  return { value, rest };
}

/**
 * Builds the /status (and /resume) output as an ordered list of sections, so
 * callers can stream them incrementally. Delegates to @ariadne/core's
 * buildContext — the same ranked, token-budgeted context package the CLI's
 * `status`/`resume` and the MCP server's `get_context` tool use — so all
 * three surfaces show identical "what am I working on" context instead of
 * the chat participant reimplementing its own ad-hoc query/formatting.
 */
export function formatStatusSections(
  store: TaskStore,
  taskId: string,
  tokenBudget?: number,
  workspaceRoot?: string,
): string[] {
  const t = store.getTask(taskId);
  if (!t) return [`No task found with id \`${taskId}\`.`];

  const ctx = buildContext(store, taskId, { workspaceRoot, ...(tokenBudget ? { tokenBudget } : {}) });
  const sections: string[] = [];

  let header = `### ${t.title}  \`${t.status}\``;
  if (ctx.workspaceRoot) header += `\n**Workspace:** \`${ctx.workspaceRoot}\``;
  if (ctx.branch) header += `\n**Branch:** \`${ctx.branch}\``;
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

  if (ctx.blockedTodos.length > 0) {
    sections.push(`**Blocked todos:**\n${ctx.blockedTodos.map((td) => `- ${td}`).join('\n')}`);
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

  if (ctx.recentCommands.length > 0) {
    sections.push(
      `**Recent commands:**\n${ctx.recentCommands.map((c) => `- \`${c.cmd}\`${c.exitCode !== null ? ` (exit ${c.exitCode})` : ''}`).join('\n')}`,
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
    // "list tasks in all workspaces" / "show tasks across all workspaces" / "what tasks are there in every workspace"
    {
      re: /^(?:list|show)\s+tasks\s+(?:in|across)\s+(?:all|every)\s+workspaces?\s*\??$|^what\s+tasks(?: are there)?\s+(?:in|across)\s+(?:all|every)\s+workspaces?\s*\??$/i,
      build: () => ({ command: 'task', prompt: 'list --all-workspaces' }),
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
    // "pause task abc123" / "pause this task" / "pause the task"
    {
      re: /^pause(?: task)?(?:\s+(\S+))?$/i,
      build: (m) => ({ command: 'task', prompt: `pause ${m[1] ?? ''}`.trim() }),
    },
    // "mark task abc123 done" / "finish task abc123" / "complete this task" / "close the task"
    {
      re: /^(?:mark task|finish task|complete task|close task|mark this task done|finish this task|complete this task|close this task)(?:\s+(?!(?:as\s+)?done\b)(\S+))?(?:\s+(?:as\s+)?done)?$/i,
      build: (m) => ({ command: 'task', prompt: `done ${m[1] ?? ''}`.trim() }),
    },
    // "archive task abc123" / "archive this task"
    {
      re: /^archive(?: task| this task)?(?:\s+(\S+))?$/i,
      build: (m) => ({ command: 'task', prompt: `archive ${m[1] ?? ''}`.trim() }),
    },
    // "reopen task abc123" / "reopen this task" / "reopen"
    {
      re: /^reopen(?: task| this task)?(?:\s+(\S+))?$/i,
      build: (m) => ({ command: 'task', prompt: `reopen ${m[1] ?? ''}`.trim() }),
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
        const { allWorkspaces } = extractAllWorkspacesFlag(rest);
        if (allWorkspaces) {
          const tasks = listTasksAcrossWorkspaces();
          if (tasks.length === 0) return { markdown: 'No tasks found in any known workspace.' };
          const lines = tasks.map(
            (t) =>
              `- ${t.taskId === taskId ? '**' : ''}[${t.status}] \`${t.taskId}\` ${t.title}${t.taskId === taskId ? '**' : ''} _(${t.workspaceRoot})_`,
          );
          return { markdown: lines.join('\n') };
        }
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
      if (sub === 'pause' || sub === 'done' || sub === 'archive' || sub === 'reopen') {
        const targetId = rest || taskId;
        if (!targetId) return { markdown: noCurrentTaskMessage() };
        const status: TaskStatus =
          sub === 'reopen' ? 'active' : sub === 'pause' ? 'paused' : sub === 'archive' ? 'archived' : 'done';
        if (store.getTask(targetId)) {
          setTaskStatusWithRollup(store, targetId, status);
          return { markdown: `Task \`${targetId}\` ${sub === 'reopen' ? 'reactivated' : `marked ${status}`}.` };
        }
        const resolved = resolveCrossWorkspaceTask(input.workspaceRoot, targetId);
        if (!resolved) return { markdown: `No task found with id \`${targetId}\`.` };
        setTaskStatusWithRollup(resolved.store, targetId, status);
        return {
          markdown:
            `Task \`${targetId}\` ${sub === 'reopen' ? 'reactivated' : `marked ${status}`} ` +
            `(in workspace \`${resolved.workspaceRoot}\`).`,
        };
      }
      if (sub === 'edit') {
        const { value: title, rest: afterTitle } = extractFlagValue(rest, 'title');
        const { value: goal } = extractFlagValue(afterTitle, 'goal');
        if (title === undefined && goal === undefined) {
          return { markdown: 'Usage: `/task edit [id] --title <t> --goal <g>`.' };
        }
        const targetId = taskId;
        if (!targetId) return { markdown: noCurrentTaskMessage() };
        if (!store.getTask(targetId)) return { markdown: `No task found with id \`${targetId}\`.` };
        if (title !== undefined) store.updateTaskTitle(targetId, title);
        if (goal !== undefined) store.updateTaskGoal(targetId, goal);
        return { markdown: `Task \`${targetId}\` updated.` };
      }
      return {
        markdown:
          'Usage: `/task new <title>`, `/task list [--all-workspaces]`, `/task use <id>`, ' +
          '`/task pause [id]`, `/task done [id]`, `/task archive [id]`, `/task reopen [id]`, or ' +
          '`/task edit --title <t> --goal <g>`.',
      };
    }

    case 'search': {
      const { allWorkspaces, rest: query } = extractAllWorkspacesFlag(prompt);
      if (!query.trim()) return { markdown: 'Usage: `/search <query> [--all-workspaces]`.' };
      if (allWorkspaces) {
        const crossResults = searchAcrossWorkspaces(query.trim(), { allWorkspaces: true });
        if (crossResults.length === 0) return { markdown: `No matches for "${query.trim()}" in any known workspace.` };
        const lines = crossResults.map((r) => {
          const matchLines = r.matches.map((m) => `  - (${m.category}) ${m.text}`).join('\n');
          return (
            `- ${r.taskId === taskId ? '**' : ''}[${r.taskStatus}] \`${r.taskId}\` ${r.taskTitle}${r.taskId === taskId ? '**' : ''} ` +
            `_(${r.workspaceRoot})_\n${matchLines}`
          );
        });
        return { markdown: lines.join('\n') };
      }
      const results = searchWorkspace(store, query.trim());
      if (results.length === 0) return { markdown: `No matches for "${query.trim()}".` };
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
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'done' || sub === 'reopen' || sub === 'block' || sub === 'delete') {
        if (!rest) return { markdown: `Usage: \`/todo ${sub} <id> [--task <taskId>]\`.` };
        const { taskHint, rest: todoId } = extractTaskHint(rest);
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        if (sub === 'done') {
          target.store.updateTodoStatus(todoId, 'done');
          return { markdown: `Marked todo \`${todoId}\` done.` };
        }
        if (sub === 'reopen') {
          target.store.updateTodoStatus(todoId, 'pending');
          return { markdown: `Reopened todo \`${todoId}\` (set to pending).` };
        }
        if (sub === 'block') {
          target.store.updateTodoStatus(todoId, 'blocked');
          return { markdown: `Marked todo \`${todoId}\` blocked.` };
        }
        target.store.deleteTodo(todoId);
        return { markdown: `Deleted todo \`${todoId}\`.` };
      }
      if (sub === 'edit') {
        if (!rest) return { markdown: 'Usage: `/todo edit <id> --text <new text> [--task <taskId>]`.' };
        const { taskHint, rest: afterTask } = extractTaskHint(rest);
        const { value: text, rest: afterText } = extractFlagValue(afterTask, 'text');
        const todoId = afterText.trim();
        if (!todoId || text === undefined) {
          return { markdown: 'Usage: `/todo edit <id> --text <new text> [--task <taskId>]`.' };
        }
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        target.store.updateTodoText(todoId, text);
        return { markdown: `Todo \`${todoId}\` updated.` };
      }
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      if (sub === 'add') {
        if (!rest) return { markdown: 'Usage: `/todo add <text>`.' };
        const created = store.createTodo({ taskId, text: rest });
        return { markdown: `Added todo \`${created.id}\`: ${created.text}` };
      }
      const todos = store.listTodos(taskId);
      if (todos.length === 0) return { markdown: 'No todos found.' };
      return {
        markdown: todos
          .map((t) => {
            const marker = t.status === 'done' ? 'x' : t.status === 'blocked' ? '!' : ' ';
            const suffix = t.status === 'blocked' ? ' _(blocked)_' : '';
            return `- [${marker}] \`${t.id}\` ${t.text}${suffix}`;
          })
          .join('\n'),
      };
    }

    case 'decision': {
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'list') {
        if (!taskId) return { markdown: noCurrentTaskMessage() };
        const decisions = store.listDecisions(taskId);
        if (decisions.length === 0) return { markdown: 'No decisions found.' };
        return { markdown: decisions.map((d) => `- \`${d.id}\` ${d.text}${d.rationale ? ` _(${d.rationale})_` : ''}`).join('\n') };
      }
      if (sub === 'delete') {
        if (!rest) return { markdown: 'Usage: `/decision delete <id> [--task <taskId>]`.' };
        const { taskHint, rest: decisionId } = extractTaskHint(rest);
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        target.store.deleteDecision(decisionId);
        return { markdown: `Deleted decision \`${decisionId}\`.` };
      }
      if (sub === 'edit') {
        if (!rest) return { markdown: 'Usage: `/decision edit <id> --text <t> --rationale <r> [--task <taskId>]`.' };
        const { taskHint, rest: afterTask } = extractTaskHint(rest);
        const { value: text, rest: afterText } = extractFlagValue(afterTask, 'text');
        const { value: rationale, rest: afterRationale } = extractFlagValue(afterText, 'rationale');
        const decisionId = afterRationale.trim();
        if (!decisionId || (text === undefined && rationale === undefined)) {
          return { markdown: 'Usage: `/decision edit <id> --text <t> --rationale <r> [--task <taskId>]`.' };
        }
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        target.store.updateDecision(decisionId, { text, rationale });
        return { markdown: `Decision \`${decisionId}\` updated.` };
      }
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      if (!prompt.trim()) return { markdown: 'Usage: `/decision <text>`.' };
      const decision = store.recordDecision({ taskId, text: prompt.trim() });
      return { markdown: `Recorded decision \`${decision.id}\`: ${decision.text}` };
    }

    case 'error': {
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'resolve' || sub === 'reopen' || sub === 'delete') {
        const { taskHint, rest: errorId } = extractTaskHint(rest);
        if (!errorId) return { markdown: `Usage: \`/error ${sub} <id> [--task <taskId>]\`.` };
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        if (sub === 'resolve') {
          target.store.resolveError(errorId);
          return { markdown: `Marked error \`${errorId}\` resolved.` };
        }
        if (sub === 'reopen') {
          target.store.unresolveError(errorId);
          return { markdown: `Reopened error \`${errorId}\`.` };
        }
        target.store.deleteError(errorId);
        return { markdown: `Deleted error \`${errorId}\`.` };
      }
      if (sub === 'edit') {
        if (!rest) return { markdown: 'Usage: `/error edit <id> --message <text> [--task <taskId>]`.' };
        const { taskHint, rest: afterTask } = extractTaskHint(rest);
        const { value: message, rest: afterMessage } = extractFlagValue(afterTask, 'message');
        const errorId = afterMessage.trim();
        if (!errorId || message === undefined) {
          return { markdown: 'Usage: `/error edit <id> --message <text> [--task <taskId>]`.' };
        }
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        target.store.updateError(errorId, message);
        return { markdown: `Error \`${errorId}\` updated.` };
      }
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      if (!prompt.trim()) return { markdown: 'Usage: `/error <message>` or `/error resolve <id>`.' };
      const err = store.recordError({ taskId, message: prompt.trim() });
      return { markdown: `Recorded error \`${err.id}\`.` };
    }

    case 'question': {
      const { sub, rest } = splitSubcommand(prompt);
      if (sub === 'resolve' || sub === 'reopen' || sub === 'delete') {
        if (!rest) return { markdown: `Usage: \`/question ${sub} <id> [--task <taskId>]\`.` };
        const { taskHint, rest: questionId } = extractTaskHint(rest);
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        if (sub === 'resolve') {
          target.store.resolveOpenQuestion(questionId);
          return { markdown: `Marked question \`${questionId}\` resolved.` };
        }
        if (sub === 'reopen') {
          target.store.unresolveOpenQuestion(questionId);
          return { markdown: `Reopened question \`${questionId}\`.` };
        }
        target.store.deleteOpenQuestion(questionId);
        return { markdown: `Deleted question \`${questionId}\`.` };
      }
      if (sub === 'edit') {
        if (!rest) return { markdown: 'Usage: `/question edit <id> --text <new text> [--task <taskId>]`.' };
        const { taskHint, rest: afterTask } = extractTaskHint(rest);
        const { value: text, rest: afterText } = extractFlagValue(afterTask, 'text');
        const questionId = afterText.trim();
        if (!questionId || text === undefined) {
          return { markdown: 'Usage: `/question edit <id> --text <new text> [--task <taskId>]`.' };
        }
        const target = resolveTargetStore(store, input.workspaceRoot, taskHint);
        if ('error' in target) return { markdown: target.error };
        target.store.updateOpenQuestion(questionId, text);
        return { markdown: `Question \`${questionId}\` updated.` };
      }
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      if (sub === 'add') {
        if (!rest) return { markdown: 'Usage: `/question add <text>`.' };
        const created = store.recordOpenQuestion({ taskId, text: rest });
        return { markdown: `Added open question \`${created.id}\`: ${created.text}` };
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
    case 'status': {
      // An explicit id in the prompt (e.g. `/status abc123`) targets that
      // task even if it belongs to a different workspace, falling back to
      // the cross-workspace registry when it isn't in the local store.
      // Plain NL messages never reach here with a non-empty prompt —
      // inferIntent() always clears the prompt for its status/resume
      // patterns — so this only fires for the explicit slash-command form.
      const { budget, rest: promptWithoutBudget } = extractBudgetFlag(prompt);
      const explicitId = promptWithoutBudget.trim() || undefined;
      if (explicitId) {
        if (store.getTask(explicitId)) {
          const sections = formatStatusSections(store, explicitId, budget, input.workspaceRoot);
          return { markdown: sections.join('\n\n'), sections };
        }
        const resolved = resolveCrossWorkspaceTask(input.workspaceRoot, explicitId);
        if (!resolved) return { markdown: `No task found with id \`${explicitId}\`.` };
        const sections = formatStatusSections(resolved.store, explicitId, budget, resolved.workspaceRoot);
        return { markdown: sections.join('\n\n'), sections };
      }
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      const sections = formatStatusSections(store, taskId, budget, input.workspaceRoot);
      return { markdown: sections.join('\n\n'), sections };
    }

    case 'git-sync': {
      const explicitId = prompt.trim() || undefined;
      const target = resolveTargetOrCurrent(store, input.workspaceRoot, taskId, explicitId);
      if ('error' in target) return { markdown: target.error };
      const result = syncTaskGit(target.store, target.taskId, target.workspaceRoot);
      const lines: string[] = [];
      lines.push(result.branchChanged ? `Branch updated to \`${result.newBranch}\`.` : 'Branch unchanged.');
      if (result.recordedCommits.length > 0) {
        lines.push(`Recorded ${result.recordedCommits.length} commit(s):`);
        for (const c of result.recordedCommits) lines.push(`  - \`${c.sha.slice(0, 7)}\` ${c.message}`);
      } else {
        lines.push('No new commits.');
      }
      return { markdown: lines.join('\n') };
    }

    case 'export': {
      const { value: outFlag, rest: afterOut } = extractFlagValue(prompt, 'out');
      const explicitId = afterOut.trim() || undefined;
      const target = resolveTargetOrCurrent(store, input.workspaceRoot, taskId, explicitId);
      if ('error' in target) return { markdown: target.error };
      const markdown = exportTaskMarkdown(target.store, target.taskId);
      const outPath = outFlag
        ? path.isAbsolute(outFlag)
          ? outFlag
          : path.join(target.workspaceRoot, outFlag)
        : path.join(target.workspaceRoot, '.ariadne', 'export', `${target.taskId}.md`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, markdown, 'utf8');
      return { markdown: `Exported task \`${target.taskId}\` to \`${outPath}\`.\n\n---\n\n${markdown}` };
    }

    default: {
      if (!taskId) return { markdown: noCurrentTaskMessage() };
      const sections = formatStatusSections(store, taskId, undefined, input.workspaceRoot);
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
    case 'git-sync':
      return 'Syncing git branch and commits…';
    case 'export':
      return 'Exporting task to Markdown…';
    case 'resume':
      return 'Resuming task context…';
    case 'status':
    default:
      return 'Loading task status…';
  }
}
