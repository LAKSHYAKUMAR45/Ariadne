import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TaskStore } from '@ariadne/core';
import { findWorkspaceRoot, openWorkspaceStore } from './workspace.js';
import * as tools from './tools.js';

/** Wraps a tool result value as the `{ content: [...] }` shape the MCP SDK expects. */
function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Wraps a thrown error as an MCP tool error result instead of letting it propagate as a protocol-level failure. */
function errorResult(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

const TASK_STATUS = z.enum(['active', 'paused', 'done', 'archived']);
const CHECKPOINT_LEVEL = z.enum(['micro', 'session', 'milestone']);
const TODO_STATUS = z.enum(['pending', 'done', 'blocked']);

/**
 * Builds an MCP server exposing Ariadne's task state as tools, per
 * docs/02-ARCHITECTURE.md section 3. Every tool is a thin wrapper over the
 * pure functions in `tools.ts`, which in turn call the same `@ariadne/core`
 * `TaskStore` the CLI and VS Code extension use — one shared implementation,
 * three surfaces.
 *
 * `store` is injectable for tests; defaults to opening the resolved
 * workspace's `.ariadne/state.db`.
 */
export function createAriadneMcpServer(options?: { workspaceRoot?: string; store?: TaskStore }): McpServer {
  const workspaceRoot = options?.workspaceRoot ?? findWorkspaceRoot();
  const store = options?.store ?? openWorkspaceStore(workspaceRoot);

  const server = new McpServer({
    name: 'ariadne',
    version: '0.1.0',
  });

  server.registerTool(
    'task_new',
    {
      title: 'Create a new task',
      description: 'Creates a new task and marks it as the current task for this workspace.',
      inputSchema: { title: z.string(), goal: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.taskNew(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description: 'Lists tasks in this workspace, optionally filtered by status.',
      inputSchema: { status: TASK_STATUS.optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.taskList(store, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'task_use',
    {
      title: 'Switch current task',
      description: 'Sets the given task as the current task (used by other tools when taskId is omitted).',
      inputSchema: { taskId: z.string() },
    },
    async (args) => {
      try {
        return jsonResult(tools.taskUse(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'checkpoint_add',
    {
      title: 'Record a checkpoint',
      description: 'Records a checkpoint summary for the current (or given) task.',
      inputSchema: { summary: z.string(), level: CHECKPOINT_LEVEL.optional(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.checkpointAdd(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'todo_add',
    {
      title: 'Add a todo',
      description: 'Adds a todo to the current (or given) task.',
      inputSchema: { text: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.todoAdd(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'todo_list',
    {
      title: 'List todos',
      description: 'Lists todos for the current (or given) task, optionally filtered by status.',
      inputSchema: { status: TODO_STATUS.optional(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.todoList(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'todo_done',
    {
      title: 'Mark a todo done',
      description: 'Marks the given todo as done.',
      inputSchema: { todoId: z.string() },
    },
    async (args) => {
      try {
        tools.todoDone(store, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'decision_add',
    {
      title: 'Record a decision',
      description: 'Records a decision (with optional rationale) for the current (or given) task.',
      inputSchema: { text: z.string(), rationale: z.string().optional(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.decisionAdd(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_add',
    {
      title: 'Record an error',
      description: 'Records an unresolved error message for the current (or given) task.',
      inputSchema: { message: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.errorAdd(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_resolve',
    {
      title: 'Resolve an error',
      description: 'Marks the given error as resolved, optionally with a resolution note.',
      inputSchema: { errorId: z.string(), resolution: z.string().optional() },
    },
    async (args) => {
      try {
        tools.errorResolve(store, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search tasks',
      description: 'Searches task titles and goals in this workspace for a substring match.',
      inputSchema: { query: z.string() },
    },
    async (args) => {
      try {
        return jsonResult(tools.searchTasks(store, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_context',
    {
      title: 'Get task context',
      description:
        'Returns the current (or given) task\'s ranked, token-budgeted context: goal, latest checkpoint, ' +
        'open questions, unresolved errors, current decisions, pending todos, recent files, and commits ' +
        'since the last checkpoint. Equivalent to the CLI\'s "status"/"resume" commands, as structured JSON.',
      inputSchema: { taskId: z.string().optional(), tokenBudget: z.number().int().positive().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.getContext(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'git_sync',
    {
      title: 'Sync git state',
      description:
        'Syncs the current git branch and any new commits (since what\'s already recorded) into the ' +
        'current (or given) task, by shelling out to `git` directly — works without any editor open.',
      inputSchema: { taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.gitSync(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'export_task',
    {
      title: 'Export task to Markdown',
      description:
        'Renders the current (or given) task\'s full history (goal, checkpoints, todos, decisions, ' +
        'open questions, errors, files, commits, command log) as a Markdown document, for sharing or ' +
        'pasting into a PR description. Equivalent to the CLI\'s "export" command.',
      inputSchema: { taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.exportTask(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
