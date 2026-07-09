import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskStore } from '@ariadne/core';
import { createAriadneMcpServer } from '../src/server.js';
import * as tools from '../src/tools.js';

describe('createAriadneMcpServer', () => {
  it('registers every tool the CLI and architecture doc expect', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-mcp-server-test-'));
    const store = new TaskStore(':memory:');
    try {
      const server = createAriadneMcpServer({ workspaceRoot, store });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registered = (server as any)._registeredTools as Record<string, unknown>;
      expect(Object.keys(registered).sort()).toEqual(
        [
          'task_new',
          'task_list',
          'task_use',
          'task_pause',
          'task_done',
          'task_archive',
          'task_reopen',
          'task_edit',
          'checkpoint_add',
          'todo_add',
          'todo_list',
          'todo_done',
          'todo_reopen',
          'todo_block',
          'todo_edit',
          'todo_delete',
          'decision_add',
          'decision_list',
          'decision_edit',
          'decision_delete',
          'error_add',
          'error_list',
          'error_resolve',
          'error_reopen',
          'error_edit',
          'error_delete',
          'question_add',
          'question_list',
          'question_resolve',
          'question_reopen',
          'question_edit',
          'question_delete',
          'search',
          'get_context',
          'git_sync',
          'export_task',
        ].sort(),
      );
    } finally {
      store.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('registers a static resource for the current task context and a templated resource per-task', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-mcp-server-test-'));
    const store = new TaskStore(':memory:');
    try {
      const { taskNew } = tools;
      const task = taskNew(store, workspaceRoot, { title: 'Resource test task', goal: 'Verify MCP resources' });
      const server = createAriadneMcpServer({ workspaceRoot, store });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resources = (server as any)._registeredResources as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const templates = (server as any)._registeredResourceTemplates as Record<
        string,
        { resourceTemplate: { listCallback?: () => Promise<{ resources: unknown[] }> }; readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ uri: string; text: string }> }> }
      >;

      expect(Object.keys(resources)).toContain('ariadne://task/current/context');
      expect(Object.keys(templates)).toContain('task-context');

      const currentResult = await (
        resources['ariadne://task/current/context'] as { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }
      ).readCallback(new URL('ariadne://task/current/context'));
      const currentContext = JSON.parse(currentResult.contents[0].text);
      expect(currentContext.taskId).toBe(task.id);

      const perTaskResult = await templates['task-context'].readCallback(
        new URL(`ariadne://task/${task.id}/context`),
        { taskId: task.id },
      );
      const perTaskContext = JSON.parse(perTaskResult.contents[0].text);
      expect(perTaskContext.taskId).toBe(task.id);

      const list = await templates['task-context'].resourceTemplate.listCallback!();
      expect(list.resources).toHaveLength(1);
    } finally {
      store.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
