import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TaskStore } from '@ariadne-dev/core';
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
 * pure functions in `tools.ts`, which in turn call the same `@ariadne-dev/core`
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
      description:
        'Lists tasks in this workspace, optionally filtered by status. Pass allWorkspaces: true to list ' +
        'tasks across every workspace Ariadne has ever seen on this machine (each tagged with its workspaceRoot).',
      inputSchema: { status: TASK_STATUS.optional(), allWorkspaces: z.boolean().optional() },
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

  for (const [name, status] of [
    ['task_pause', 'paused'],
    ['task_done', 'done'],
    ['task_archive', 'archived'],
    ['task_reopen', 'active'],
  ] as const) {
    server.registerTool(
      name,
      {
        title: `${status === 'active' ? 'Reopen' : status === 'paused' ? 'Pause' : status === 'done' ? 'Complete' : 'Archive'} a task`,
        description: `Sets the current (or given) task's status to "${status}".` + ' Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
        inputSchema: { taskId: z.string().optional() },
      },
      async (args) => {
        try {
          return jsonResult(tools.taskSetStatus(store, workspaceRoot, { taskId: args.taskId, status }));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  server.registerTool(
    'task_edit',
    {
      title: 'Edit a task',
      description: 'Edits the current (or given) task\'s title and/or goal (curation). Leaves either unchanged if not supplied. Works even if taskId belongs to a different workspace.',
      inputSchema: { taskId: z.string().optional(), title: z.string().optional(), goal: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.taskEdit(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'checkpoint_add',
    {
      title: 'Record a checkpoint',
      description: 'Records a checkpoint summary for the current (or given) task. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
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
      description: 'Adds a todo to the current (or given) task. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
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
      description: 'Lists todos for the current (or given) task, optionally filtered by status. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
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
      description: 'Marks the given todo as done. Pass taskId if the todo belongs to a different workspace than the current one (the cross-workspace registry indexes tasks, not sub-entity ids).',
      inputSchema: { todoId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.todoDone(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'todo_reopen',
    {
      title: 'Reopen a todo',
      description: 'Sets a done/blocked todo back to pending. Pass taskId if the todo belongs to a different workspace than the current one.',
      inputSchema: { todoId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.todoReopen(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'todo_block',
    {
      title: 'Mark a todo blocked',
      description: 'Marks the given todo as blocked. Pass taskId if the todo belongs to a different workspace than the current one.',
      inputSchema: { todoId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.todoBlock(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'todo_edit',
    {
      title: 'Edit a todo',
      description: 'Edits a todo\'s text (curation). Pass taskId if the todo belongs to a different workspace than the current one.',
      inputSchema: { todoId: z.string(), text: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.todoEdit(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'todo_delete',
    {
      title: 'Delete a todo',
      description: 'Permanently deletes a todo (curation). Pass taskId if the todo belongs to a different workspace than the current one.',
      inputSchema: { todoId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.todoDelete(store, workspaceRoot, args);
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
      description: 'Records a decision (with optional rationale) for the current (or given) task. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
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
    'decision_list',
    {
      title: 'List decisions',
      description: 'Lists decisions recorded for the current (or given) task. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
      inputSchema: { taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.decisionList(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'decision_edit',
    {
      title: 'Edit a decision',
      description: 'Edits a decision\'s text and/or rationale (curation). Pass taskId if the decision belongs to a different workspace than the current one.',
      inputSchema: { decisionId: z.string(), text: z.string().optional(), rationale: z.string().optional(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.decisionEdit(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'decision_delete',
    {
      title: 'Delete a decision',
      description: 'Permanently deletes a decision (curation). Pass taskId if the decision belongs to a different workspace than the current one.',
      inputSchema: { decisionId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.decisionDelete(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_add',
    {
      title: 'Record an error',
      description: 'Records an unresolved error message for the current (or given) task. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
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
    'command_log',
    {
      title: 'Log a command run by this MCP client',
      description:
        'Records a command this MCP client already ran (via its own execution tool) against the current (or given) task, along with its exit code — this tool does not run the command itself. ' +
        "Unlike the CLI's `ariadne exec` (which spawns and records in one step) or the VS Code extension's passive background capture of terminal commands, an MCP client's own shell/tool-call activity is otherwise invisible to Ariadne; call this after running a command so it shows up in status/resume/get_context and search the same way. " +
        'A non-zero exitCode also automatically records a matching unresolved error. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
      inputSchema: { command: z.string(), exitCode: z.number().int(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.commandLog(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_list',
    {
      title: 'List errors',
      description: 'Lists errors for the current (or given) task — unresolved only by default, or every error with all:true. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
      inputSchema: { taskId: z.string().optional(), all: z.boolean().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.errorList(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_resolve',
    {
      title: 'Resolve an error',
      description: 'Marks the given error as resolved, optionally with a resolution note. Pass taskId if the error belongs to a different workspace than the current one.',
      inputSchema: { errorId: z.string(), resolution: z.string().optional(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.errorResolve(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_reopen',
    {
      title: 'Reopen an error',
      description: 'Marks a previously-resolved error as unresolved again. Pass taskId if the error belongs to a different workspace than the current one.',
      inputSchema: { errorId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.errorReopen(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_edit',
    {
      title: 'Edit an error',
      description: 'Edits an error\'s message (curation). Pass taskId if the error belongs to a different workspace than the current one.',
      inputSchema: { errorId: z.string(), message: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.errorEdit(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'error_delete',
    {
      title: 'Delete an error',
      description: 'Permanently deletes an error (curation). Pass taskId if the error belongs to a different workspace than the current one.',
      inputSchema: { errorId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.errorDelete(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'question_add',
    {
      title: 'Record an open question',
      description: 'Records an open question for the current (or given) task. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
      inputSchema: { text: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.questionAdd(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'question_list',
    {
      title: 'List open questions',
      description: 'Lists open questions for the current (or given) task, optionally filtered by resolved status. Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
      inputSchema: { taskId: z.string().optional(), resolved: z.boolean().optional() },
    },
    async (args) => {
      try {
        return jsonResult(tools.questionList(store, workspaceRoot, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'question_resolve',
    {
      title: 'Resolve an open question',
      description: 'Marks the given open question as resolved. Pass taskId if the question belongs to a different workspace than the current one.',
      inputSchema: { questionId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.questionResolve(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'question_reopen',
    {
      title: 'Reopen an open question',
      description: 'Marks a previously-resolved open question as unresolved again. Pass taskId if the question belongs to a different workspace than the current one.',
      inputSchema: { questionId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.questionReopen(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'question_edit',
    {
      title: 'Edit an open question',
      description: 'Edits an open question\'s text (curation). Pass taskId if the question belongs to a different workspace than the current one.',
      inputSchema: { questionId: z.string(), text: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.questionEdit(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'question_delete',
    {
      title: 'Delete an open question',
      description: 'Permanently deletes an open question (curation). Pass taskId if the question belongs to a different workspace than the current one.',
      inputSchema: { questionId: z.string(), taskId: z.string().optional() },
    },
    async (args) => {
      try {
        tools.questionDelete(store, workspaceRoot, args);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search workspace',
      description:
        'Cross-entity search over this workspace: task titles/goals, checkpoints, decisions, todos, ' +
        'errors, open questions, files, and commits. Returns tasks ranked by number of matches, each with ' +
        'the matching entities. Pass allWorkspaces: true to search every workspace Ariadne has ever seen ' +
        'on this machine, with each result tagged by its workspaceRoot.',
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional(), allWorkspaces: z.boolean().optional() },
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
        'since the last checkpoint. Equivalent to the CLI\'s "status"/"resume" commands, as structured JSON. ' +
        'Works even if taskId belongs to a different workspace (falls back to the cross-workspace registry).',
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
        'current (or given) task, by shelling out to `git` directly — works without any editor open. ' +
        'Runs against the task\'s actual owning workspace, even if it differs from this server\'s workspace.',
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
        'pasting into a PR description. Equivalent to the CLI\'s "export" command. Works even if taskId ' +
        'belongs to a different workspace (falls back to the cross-workspace registry).',
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

  // Resources: a read-only, URI-addressable alternative to the `get_context` tool.
  // Some MCP hosts auto-attach subscribed/discoverable resources to a conversation
  // without an explicit tool call, so exposing context this way (in addition to the
  // tool) lets those clients pull in Ariadne's task context passively. Both routes
  // delegate to the same `tools.getContext`, so they never drift from the tool.
  server.registerResource(
    'current-task-context',
    'ariadne://task/current/context',
    {
      title: "Current task's context",
      description:
        'The ranked, token-budgeted context package for whichever task is currently active in this workspace.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const context = tools.getContext(store, workspaceRoot, {});
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(context, null, 2) }],
      };
    },
  );

  server.registerResource(
    'task-context',
    new ResourceTemplate('ariadne://task/{taskId}/context', {
      list: async () => ({
        resources: store.listTasks().map((task) => ({
          uri: `ariadne://task/${task.id}/context`,
          name: `${task.title} — context`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: "A specific task's context",
      description: 'The ranked, token-budgeted context package for the task identified by {taskId}.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const taskId = Array.isArray(variables.taskId) ? variables.taskId[0] : variables.taskId;
      const context = tools.getContext(store, workspaceRoot, { taskId });
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(context, null, 2) }],
      };
    },
  );

  return server;
}
