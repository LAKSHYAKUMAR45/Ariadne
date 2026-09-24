import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, TaskStore } from '@ariadne-dev/core';
import { createAriadneMcpServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function setup() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.knowledge-mcp-test-'));
  const db = openDatabase(path.join(root, 'state.db'));
  const store = new TaskStore(':memory:');
  const server = createAriadneMcpServer({ workspaceRoot: root, store, knowledgeDb: db });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> })._registeredTools;
  return { root, db, store, tools };
}

function cleanup(state: ReturnType<typeof setup>): void {
  state.store.close();
  state.db.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

describe('knowledge MCP tools', () => {
  it('requires explicit authorization for mutations and returns typed citations', async () => {
    const state = setup();
    try {
      const rejected = await state.tools.knowledge_project_create.handler({ name: 'Wiki' });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toMatch(/confirm=true/);

      const created = await state.tools.knowledge_project_create.handler({ name: 'Wiki', confirm: true });
      expect(created.isError).toBeUndefined();
      const payload = JSON.parse(created.content[0].text) as { data: { id: string }; citations: Array<{ kind: string; id: string }> };
      expect(payload.data.name).toBe('Wiki');
      expect(payload.citations).toEqual([{ kind: 'project', id: payload.data.id }]);
    } finally {
      cleanup(state);
    }
  });

  it('round-trips a page and returns citations from search', async () => {
    const state = setup();
    try {
      const projectResult = await state.tools.knowledge_project_create.handler({ name: 'Wiki', confirm: true });
      const projectId = JSON.parse(projectResult.content[0].text).data.id as string;
      const pageResult = await state.tools.knowledge_page_create.handler({
        projectId,
        type: 'concept',
        title: 'SQLite',
        slug: 'sqlite',
        content: 'SQLite is the authoritative local store.',
        confirm: true,
      });
      expect(pageResult.isError).toBeUndefined();

      const searchResult = await state.tools.knowledge_search.handler({ projectId, query: 'SQLite', limit: 1 });
      const search = JSON.parse(searchResult.content[0].text) as { data: { results: Array<{ title: string; citations: unknown[] }> } };
      expect(search.data.results[0].title).toBe('SQLite');
      expect(search.data.results[0].citations).toEqual([]);

      const pageId = JSON.parse(pageResult.content[0].text).data.pageId as string;
      const page = await state.tools.knowledge_page_get.handler({ projectId, pageId });
      expect(JSON.parse(page.content[0].text).data.title).toBe('SQLite');
    } finally {
      cleanup(state);
    }
  });

  it('bounds list results and rejects missing project identifiers', async () => {
    const state = setup();
    try {
      const missing = await state.tools.knowledge_page_list.handler({ projectId: 'missing' });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toMatch(/project not found/i);

      const invalidLimit = await state.tools.knowledge_project_list.handler({});
      expect(invalidLimit.isError).toBeUndefined();
      const bounded = await state.tools.knowledge_source_list.handler({ projectId: 'missing', limit: 101 });
      expect(bounded.isError).toBe(true);
    } finally {
      cleanup(state);
    }
  });
});
