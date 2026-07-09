import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskStore } from '@ariadne/core';
import { createAriadneMcpServer } from '../src/server.js';

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
          'checkpoint_add',
          'todo_add',
          'todo_list',
          'todo_done',
          'decision_add',
          'error_add',
          'error_resolve',
          'search',
          'get_context',
        ].sort(),
      );
    } finally {
      store.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
